# Release Readiness Verifier

`src/release-readiness.ts` and `src/release-readiness-cli.ts` verify that a final 9:16 MP4, its generation audit manifest, and a `publish` `APPROVED` approval decision are all consistent before any publishing side effect is performed. No actual publishing, deletion, network call, or YouTube API use occurs.

## Scope

- Verify only `ready=true|false` and write a deterministic readiness report.
- Inputs: project-root-relative paths to a final MP4, an audit manifest, and an approval decision.
- Outputs: a single JSON file under `output/readiness/` written atomically, without overwriting an existing file.
- Non-scope: publishing, deletion, external-send, YouTube API, UI, DB, renderer, retry/resume.

## Report contract

The report is deterministic JSON with a fixed schema and fixed key order:

- `action`: always `"publish"` when ready.
- `audit`: manifest identifier, `jobId`, `output` (identifier, probe, sha256), `schemaVersion`, manifest sha256, `status`.
- `decision`: the full decision record plus `identifier` (project-relative path) and `sha256`.
- `mp4`: the canonical MP4 identifier, computed sha256, and ffprobe-derived probe.
- `ready`: `true` when all checks pass, otherwise the call throws and no report is written.
- `reasonCode`: `"READY"` when `ready=true`.
- `schemaVersion`: `"1.0.0"`.
- `verifiedAt`: ISO-8601 timestamp from `--now` or the current time. `--now` must be a strict RFC 3339 string with a valid calendar date and a stable round-trip.

Probe fields are recorded in fixed key order and `undefined` values are emitted as `null` so the JSON schema is stable.

## Library API

```typescript
import { verifyReleaseReadiness } from './release-readiness.js';

const { report, reportPath, reportSha256, mp4Sha256 } = await verifyReleaseReadiness(
  projectRoot,
  'output/video.mp4',
  'output/audit/<jobId>.json',
  'output/approvals/<requestSha256>.json',
  { now: '2026-07-31T12:00:00.000Z' },
);
```

## CLI usage

```bash
npx tsx src/release-readiness-cli.ts \
  --project-root . \
  --mp4 output/video.mp4 \
  --audit output/audit/<jobId>.json \
  --decision output/approvals/<requestSha256>.json \
  --now 2026-07-31T12:00:00.000Z \
  --output-rel readiness/report.json \
  [--max-json-bytes 10485760] \
  [--max-artifact-bytes 524288000]
```

On success the CLI prints the JSON `ReadinessResult` and exits `0`. On failure it prints `{ ready: false, error, message }` to stderr and exits `1`.

## Verification performed

1. Strict read of approval decision and audit manifest via a readiness-specific bounded `BigIntStats` reader and `assertNoDuplicateKeys`. The parent directory is opened with `O_DIRECTORY | O_NOFOLLOW` and its `dev/ino` plus realpath are captured in the input snapshot.
2. Schema validation via `ApprovalDecisionRecordSchema` and `AuditManifestSchema` (`.strict()` rejects unknown fields at every nested level: `output`, `output.probe`, `inputs`, `ffmpeg`, and `error`).
3. Decision must be `decision=approved`, `reasonCode=APPROVED`, `action=publish`, with a non-empty approver and a canonical artifact identifier that exactly matches the MP4 path.
4. Audit must have `status=success` and a canonical `output.identifier`.
5. The audit `output.identifier` is resolved as an independent artifact. It is hashed and ffprobed, and its sha256/probe must exactly match `audit.output.sha256` and `audit.output.probe`.
6. Each media artifact is opened through its parent directory file descriptor (`/proc/self/fd/<dirFd>/<basename>`) after stat and open barriers on the parent directory. The file's canonical realpath and `dev/ino/size/mtime` (using `mtimeNs` when `BigIntStats` is available) are compared with the expected snapshot from `resolveArtifact` to bind the canonical location to the bytes that are consumed.
7. The file is read once into an in-process `Buffer`. ffprobe and SHA-256 both consume this exact `Buffer`, so rewriting the original inode between probe and hash cannot make them observe different content. The original file is stat-checked before and after the read to detect shrink/grow or inode swaps.
8. The final MP4 sha256/probe must equal the audit output artifact sha256/probe, and the MP4 sha256 must equal both `decision.artifactSha256` and `audit.output.sha256`.
9. All four inputs (MP4, audit output artifact, audit manifest, approval decision) must be distinct files (no same path, hard-link, or symlink collision).
10. The output path is validated component-by-component to reject `.`, `..`, empty, absolute, and null-byte components, and the resolved path is confirmed to be under `output/readiness/`. It must not already exist and must not collide with any input.
11. Immediately before publish, Node re-checks the four input snapshots for stat/realpath mismatches and verifies the output directory is still under `projectRoot`. It then launches a short-lived Python helper inheriting the output directory fd, the report temp fd, and each input parent fd via `stdio`.
12. The Python helper opens each input through its parent directory fd with `O_RDONLY | O_NOFOLLOW`, verifies `dev/ino/size/mode/mtimeNs/ctimeNs` and canonical realpath, and copies the bytes into a sealed `memfd_create` file descriptor (`F_ADD_SEALS`). This copy is the immutable in-memory snapshot for that input. The input fd is closed once the copy is sealed.
13. After all four inputs and the report temp are sealed, the helper **re-opens each original input** through its inherited parent directory fd and re-verifies parent directory identity, file stat (`dev/ino/size/mode/mtimeNs/ctimeNs`), canonical realpath, and SHA-256. Any rewrite, replacement, truncation, growth, or parent-directory swap of an original canonical path after the sealed copy is caught here as `INPUT_CHANGED`. This is the final pre-link check and runs immediately before `os.link`.
14. The helper seals the report temp into a second `memfd_create` and creates an `O_TMPFILE` anonymous inode in the bound output directory. It copies the sealed report snapshot, `fsync`s, `fchmod`s to `0o400`, and performs a single `os.link("/proc/self/fd/<tmp>", final_name, dst_dir_fd=output_dir_fd, follow_symlinks=True)` to publish the report atomically without replacement. `FileExistsError` is returned as `OUTPUT_COLLISION`.
15. On a successful `os.link` the helper emits a `linked` JSON status containing the final file's `dev/ino/size/mtimeNs/ctimeNs`. The TypeScript caller **always** runs `verifyFinalCommit` for the linked path, whether the helper exits cleanly, fails, or produces malformed output. `verifyFinalCommit` opens the final path through the bound output directory fd with `O_NOFOLLOW`, performs pre-read `fstat`, bounded read of the expected size, post-read `fstat`, an EOF extra read, dir-fd-relative `lstat` path-identity check, and linked-inode provenance comparison. This rejects same-content foreign replacements, post-link growth, and path swaps. The helper never `stat`s or `unlink`s the final path after linking, so a post-link failure cannot roll back the committed report or destroy a foreign replacement.
16. On non-Linux platforms, or when `memfd_create` / `O_TMPFILE` / `link` primitives are missing, the publish is rejected with `UNSUPPORTED_PLATFORM` and no final path is created.
17. JSON inputs and media artifacts have independent size limits. `maxJsonBytes` (default 10 MiB) applies to the decision and audit manifest reads; `maxArtifactBytes` (default 500 MiB) applies to the MP4 and audit output artifact. `maxBytes` is retained as a legacy alias that sets both limits. All limits are validated to be finite, positive, safe integers at the library and CLI entry points; `NaN`, `Infinity`, `0`, negatives, decimals, and unsafe integers are rejected fail-closed.

## Threat model

The verifier is designed for cooperative concurrency on a single Linux host. The publisher's own process guarantees:

- The `memfd_create` + `F_ADD_SEALS` snapshot guarantees that the bytes copied into the helper cannot be modified by the helper itself or by a same-process same-UID thread *after* the seal is applied.
- The per-input `copy_fd_to_memfd` produces an immutable in-memory snapshot of the bytes that will be published. If the original file changes **after** the copy but **before** the final pre-link re-verification, the helper catches the change as `INPUT_CHANGED` when it re-opens the canonical path and compares stat/realpath/SHA-256. Tests exercise rewrite, same-content replacement, truncation, growth, and parent-directory swap for each input in this window.
- If the original file changes **after** the final pre-link re-verification and before `os.link`, the helper may publish bytes that no longer match the current original path (a TOCTOU window bounded by the final re-verify pass). The final re-verify runs immediately before `os.link` and is the best-effort fail-closed check available without OS-level immutability or a producer lock/lease covering all four inputs. Adopting filesystem-level immutability or an explicit producer lock is a longer-term architectural decision.
- `pythonStallAfterInputCopy` and `pythonStallBeforeFinalLink` test hooks demonstrate that tampering in the copy-to-final window is detected, not ignored.
- The report is copied into a sealed memfd and then into an `O_TMPFILE` anonymous inode. The anonymous inode is `fchmod`ed to `0o400` and linked to the final read-only path with a single `os.link`. The writable file descriptor is closed immediately after the link, leaving no writable alias in the publisher's process.
- `os.link` is the final commit. After it succeeds, the helper does not `stat` or `unlink` the final path, so a post-link failure cannot roll back the final or destroy a foreign replacement. `OUTPUT_COLLISION` is returned when the final path already exists before the link, preserving the existing file.
- `verifyFinalCommit` is the single acceptance gate for a successful publish. It verifies the opened file and the path point to the same linked inode, that the size matches, that no extra bytes follow the expected size, and that the content SHA-256 matches the sealed report. `postLinkForeignReplace`, `postLinkReplaceSameBytes`, `postLinkGrow`, `postLinkFail`, and `postLinkMalformed` tests exercise this gate on the success path and after adversarial mutations.
- After the publish commits, the final file is a regular read-only file. The verifier protects the commit boundary and leaves no writable alias in the publisher; filesystem DAC enforcement and process isolation are the caller's responsibility for any post-publish access-control concerns.

## Reproducible evidence

`npm run generate:fixtures && npm run generate:video -- fixtures/<route>.json` is used to generate the 9:16 MP4 and audit manifest, and a `publish` APPROVED decision is placed under `output/approvals/`. With a fixed `--now` the readiness report SHA-256 is reproducible across two consecutive runs. The latest exact-head verification evidence (exact head, run_id, test count, report SHA-256s, ffprobe output, input immutability, and adversarial test results) is recorded in PR #18 body/comments and is intentionally not embedded here, to avoid stale SHA references.

## Reuse

- `src/approval.ts`: `ApprovalDecisionRecordSchema`, `assertNoDuplicateKeys`, `resolveArtifact`, `validateArtifactIdentifier`, `canonicalSha256`, `parseIsoTimestamp`.
- `src/audit.ts`: `AuditManifestSchema`.
- `src/catalog.ts`: `resolveOutputPath` only.
- `src/catalog-diff.ts`: `verifyOutputNotSameAsInput`.
- `src/core.ts`: `ProbeInfo` type.
- JSON reading and atomic writing are implemented inside `src/release-readiness.ts`; the final no-replace publish is performed by a short-lived Python helper that uses `O_TMPFILE` + `os.link` from `/proc/self/fd` because Node does not expose `O_TMPFILE` or `linkat` bindings.
