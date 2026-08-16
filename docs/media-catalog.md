# Media Catalog

The media catalog generator indexes image, video and audio assets under a trusted input root, producing a deterministic JSON catalog with content SHA-256 identifiers, probe metadata, and optional JPG thumbnails. The catalog is meant to be persisted and diffed against later rescans without modifying the source assets.

## Catalog Rescan Diff

`src/catalog-diff.ts` compares a previously generated catalog with the current `generateCatalog()` result and emits a deterministic diff with five candidate categories:

- `unchanged`: same `relativePath` and same content SHA-256 (`id`), or the same `relativePath` with both sides id-less and an identical `{ sizeBytes, mtime, error }` fingerprint.
- `changed`: same `relativePath` but the content SHA-256 differs, or both sides are id-less with different fingerprints.
- `moved`: a valid content SHA-256 (`id`) exists in both catalogs under different paths.
- `added`: a new `relativePath` not present in the previous catalog.
- `removed`: a `relativePath` from the previous catalog no longer present.

Matching is performed in a deterministic UTF-8 byte order:

1. exact `(relativePath, id)` matches become `unchanged`; id-less entries with the same `relativePath` and identical fingerprint also become `unchanged`;
2. remaining entries with the same `relativePath` but different `id` or different id-less fingerprint become `changed`;
3. remaining entries with the same `id` but different `relativePath` are paired in sorted path order as `moved`;
4. everything unmatched is `added` or `removed`.

Duplicate content across multiple paths is supported: same-id entries are paired one-to-one, and any surplus is classified as `added`/`removed`. No previous or current entry is consumed more than once.

### Previous catalog validation

`loadPreviousCatalog()` walks to the previous catalog using directory-fd-relative opens (`/proc/self/fd/<fd>` on Linux, `/dev/fd` on *BSD/macOS, with a documented pathname fallback for platforms without fd-relative support). It opens the leaf with `O_RDONLY | O_NOFOLLOW` and reads it in bounded chunks. It confirms EOF and re-verifies the open fd and the filesystem path still point to the same `size`, `dev`, `ino`, and `mtime` after the read, so sparse growth, truncation, symlink swaps, and atomic replacements after the initial `stat` are rejected. This prevents an ancestor directory from being swapped to an external directory between path resolution and open. The catalog is then validated with fail-closed Zod schema checks:

- file size and asset count limits;
- `assets` is an array and `count` matches its length;
- every `relativePath` is canonicalized to root-relative forward-slash form, with empty, `.`, `..`, absolute, null byte, backslash, Windows-drive (`C:/`, `C:\`, and `C:foo` drive-relative) inputs rejected;
- `id`, when present, is a lowercase 64-character hex SHA-256;
- `probe`, `thumbnail`, and `error` match their expected shapes when present; `thumbnail.identifier` must be a canonical root-relative path (forward slashes only, no `.` or `..` segments, no absolute/backslash/Windows-drive/null-byte forms);
- every entry has either a valid `id` or a structured `error`;
- no duplicate canonical `relativePath` values.

Both `generateCatalog()` and the diff use a deterministic UTF-8 byte comparator for asset ordering and duplicate pairing, so the catalog and diff JSON are stable across locales and runtimes. Malicious or malformed input is rejected before any comparison.

`writeCatalogDiff()` rejects an output path that aliases the previous catalog (same resolved path, same `dev`/`ino`, or same `realpath`), preventing accidental overwrite of the previous catalog.

### CLI usage

Generate a catalog (with thumbnails):

```bash
npx tsx src/catalog-cli.ts <input-dir> <output-relative.json>
```

Generate a rescan diff against a previous catalog:

```bash
npx tsx src/catalog-cli.ts diff <previous-catalog.json> <input-dir> <output-relative.json>
```

Both commands write JSON atomically under `output/` and reject paths that escape the project root, are not `.json`, or overlap the input directory.

## Thumbnail Generation

- Thumbnails are generated with FFmpeg invoked through an argv array, never through shell string concatenation.
- The source file is opened with `O_RDONLY | O_NOFOLLOW`, verified to be a regular file inside the input root, and consumed through a bounded stream. A SHA-256 of the bytes actually sent to FFmpeg is computed and compared to the caller-supplied `sourceHash`.
- Sources at or below `SOURCE_BUFFER_LIMIT` (16 MiB) are read into a bounded `Buffer` of exactly the stat size before FFmpeg; larger sources are streamed in 64 KiB chunks so memory usage stays bounded. In both cases the file is re-checked after the initial `fstat`: a read at `sourceSize` must return EOF and the post-read `fstat` of the still-open fd must still match the original `size`, `mtime`, `dev`, and `ino`. Any append, growth, shrink, or inode replacement is rejected before a thumbnail is produced.
- Sources larger than `MAX_SOURCE_BYTES` (2 GiB) are rejected.
- For videos, FFmpeg is invoked with `-i - -ss <time>` (output seeking) so thumbnails are deterministic even for non-faststart or otherwise non-seekable MP4 inputs delivered through `stdin`.
- The source bytes are streamed to FFmpeg through `stdin`, using `-f image2pipe -` for output. FFmpeg returns a single MJPEG frame on `stdout`, capped at a safe upper bound.
- If FFmpeg exits non-zero, the source pump is stopped immediately through a single `abort` path so the Promise settles without continuing to read and hash a large, broken input. Stdin write errors that occur after the process has exited are swallowed to avoid double settlement.
- The output resolution is capped to a maximum dimension of 480 pixels by default, while preserving the original aspect ratio, using `scale=<max>:<max>:force_original_aspect_ratio=decrease`. The requested `maxDimension` is runtime-validated as a positive finite integer not exceeding `MAX_THUMBNAIL_DIMENSION` (8192).
- The MJPEG output buffer is probed through `ffprobe -i -` and its SHA-256 is computed. The `width`, `height`, and `sha256` therefore all come from the same verified buffer.
- For videos, a single frame is extracted at a deterministic seek time based on the source duration.

## Storage and Naming

- Thumbnail files are stored under the configured thumbnail directory, by default `output/catalog-thumbnails/`.
- Each file is named `v1-<maxDimension>-<source-sha256>.jpg`. This content-addressed name makes duplicate assets share the same thumbnail safely.
- The file name is validated as a single path component: it contains no path separators, traversal (`../`), or null bytes.
- The catalog JSON stores a root-relative `identifier`, the thumbnail SHA-256, and the verified width and height.

## Safety Guarantees and Threat Model

- Input paths are resolved through the catalog's trusted `inputRoot` and `../`, absolute paths, symlinks, and non-regular files are rejected. The output path is verified against `projectRoot`, so a legitimate `inputRoot` outside the project directory is still accepted as long as the source is a regular file inside that input root.
- Source bytes are bounded by an explicit safe limit. Sources are either buffered into a `Buffer` of exactly the stat size up to `SOURCE_BUFFER_LIMIT` or streamed with per-chunk hashing, and always verified against `sourceHash` before any thumbnail is finalized. FFmpeg never receives an unverified or mutable source path. Append/growth races after the initial `fstat` are detected in both the buffered and streamed paths.
- `isInside` rejects directory traversal explicitly and treats `path.isAbsolute(rel)` as outside, so Windows cross-drive, UNC, and junction paths outside the base are never accepted.
- The thumbnail output directory is created and verified component-by-component as a real directory inside `projectRoot`, with no symlinks, using `O_DIRECTORY | O_NOFOLLOW` directory file descriptors.
  - On POSIX platforms that support fd-relative paths (`/proc/self/fd/<fd>` on Linux, `/dev/fd/<fd>` on macOS/*BSD), each parent directory is re-verified through the fd-relative path immediately before a child directory is opened or created, and child operations use that fd-relative path. This is the supported parent-capability abstraction.
  - On platforms without fd-relative paths (e.g. Windows), the code falls back to re-verifying the directory pathname through `lstat`/`realpath`/`isInside` before each operation. This cannot close the remaining path-name race window, so the adversarial same-user contract on those platforms requires the deployment to provide a separate OS identity, an immutable storage boundary, or to accept the cooperative-concurrency threat model only.
- The final content-addressed file is published safely: the verified thumbnail buffer is written to a hidden temporary file in the trusted thumbnail directory. The temporary file is created with `O_CREAT|O_EXCL|O_NOFOLLOW` and is read-only (`0o400`) from the moment of creation. The creator's already-opened write fd can still `write`/`fsync`; after it is closed, no new write opens can succeed. The temporary file is then hard-linked into the final name after a `beforePublishLink` barrier re-verifies the directory. The final inherits the same `0o400` mode. On failure, the function removes only the temporary file it created; the content-addressed final path is never unlinked on failure because a `lstat`/`unlink` pair is not a compare-and-delete primitive and could delete a valid file placed by a concurrent process.
- `0o400` / Windows read-only attributes are **not** treated as an immutable boundary against a hostile same-user process. POSIX owners can restore write permissions, and Windows users can clear the read-only attribute. For deployments that must survive a same-user adversary, the design relies on one or more of the following upper boundaries:
  - Running the thumbnail generator and any untrusted code under separate OS identities.
  - Storing thumbnails on immutable storage (e.g., a read-only filesystem, WORM, or object storage with legal hold).
  - Re-verifying thumbnails at use time with `verifyThumbnail(projectRoot, info)`.
- `verifyFinalFile()` opens the final file, confirms the open fd and the filesystem path point to the same `dev/ino`, validates the real path is inside `projectRoot`, reads the content from the fd, compares it to the verified buffer, and recomputes SHA-256. This check is performed after opening and again after the post-hash hook, so same-inode modifications are detected.
- `verifyThumbnail(projectRoot, info)` is exported for consumers to re-verify a thumbnail on disk before use. It opens the file with `O_RDONLY | O_NOFOLLOW`, bounds the read to `MAX_THUMBNAIL_VERIFY_BYTES` (the same 50 MiB cap used at generation), computes the SHA-256 incrementally, and re-checks that the file descriptor and the filesystem path still point to the same `dev/ino/size` after the read.
- The catalog CLI (`src/catalog-cli.ts`) calls `verifyThumbnail` for every asset that has a `thumbnail` before writing the JSON catalog. `writeCatalogDiff()` performs the same `verifyThumbnail` check on every current-side thumbnail (unchanged/added/changed/moved entries) before writing the diff JSON. These are *pre-write consistency checks* that catch accidental corruption and cooperative races, not an immutable boundary against a same-user attacker who can replace the path between this check and the actual use of the catalog. For adversarial same-user deployments, use separate OS identities, immutable storage, or re-verify thumbnails at the actual point of consumption.
- On failure, the function returns `undefined` and removes only the temporary file it created. The content-addressed final path is never unlinked on failure, even if a directory move before publish placed it outside `projectRoot`. This keeps failure cleanup a single-process operation and avoids a `lstat`/`unlink` TOCTOU race on a shared final.
- Input files are read only; their SHA-256 values are unchanged by thumbnail generation.

## Platform Support and Threat Model

- Fully supported for adversarial same-user protection: POSIX platforms that expose fd-relative path APIs (`/proc/self/fd/<fd>` on Linux, `/dev/fd/<fd>` on macOS/*BSD). On these platforms, `openTrustedDir`, `atPath`, `verifyDirLocation`, and `verifyFileLocation` re-verify parent directory inodes through an open directory fd before every child operation, and child operations reference `/proc/self/fd/<fd>` or `/dev/fd/<fd>` directly.
- Best-effort on Windows and other platforms without fd-relative paths: the code falls back to re-verifying directory pathnames through `lstat`/`realpath`/`isInside` before each operation. This cannot fully close the remaining pathname race window against a hostile same-user process that can rename or junction a parent directory between the check and the operation. On those platforms the same-user adversarial contract is **not** guaranteed; use separate OS identities, immutable storage, or re-verify thumbnails at the actual point of consumption.
- `0o400` / Windows read-only attributes are **not** an immutable boundary against a same-user owner on any platform. The adversarial same-user guarantees above therefore assume a deployment boundary (separate OS identities or immutable storage) rather than relying on mode bits alone.
