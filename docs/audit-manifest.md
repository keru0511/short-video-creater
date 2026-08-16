# Audit Manifest

Each CLI or GUI video generation job writes an immutable, schema-versioned audit manifest under `output/audit/<job-id>.json`. The manifest is written atomically so concurrent jobs cannot corrupt or overwrite each other's records.

The actual output video for each job is stored in a job-specific artifact directory under `output/artifacts/<job-id>/<output-file>`. This guarantees that two jobs using the same `outputPath` cannot overwrite each other and that every manifest points to the exact file whose hash was recorded.

## Purpose

The manifest preserves enough information to reconstruct and verify a generation job after the fact:

- **job id**, **source** (`CLI` or `GUI`), **status**, and **timestamps**
- **timeline hash** and the **exact validated timeline** (success) or a sanitized timeline (failure)
- an optional **original timeline hash** taken from the timeline as supplied before source-asset replacement
- **input material** safe relative identifiers and SHA-256 hashes
- **output** safe relative identifier, SHA-256, and ffprobe summary
- **FFmpeg version**, sanitized argv, and output preset
- **failure code** and masked message when a job fails
- **audit job id** and **audit manifest path** are returned by the GUI and printed by the CLI so every artifact can be traced back to its manifest

## Manifest Schema

```json
{
  "schemaVersion": "1.0.0",
  "jobId": "...",
  "source": "CLI",
  "status": "success",
  "startedAt": "2026-07-29T04:44:00.000Z",
  "finishedAt": "2026-07-29T04:44:05.000Z",
  "timelineHash": "<sha256>",
  "originalTimelineHash": "<sha256>",
  "timeline": { /* exact validated timeline used for generation */ },
  "inputs": [
    {
      "role": "visual",
      "identifier": "output/assets/<job-id>/asset-visual-0.png",
      "sha256": "<sha256>",
      "timelineSource": "image.png"
    }
  ],
  "output": {
    "identifier": "output/artifacts/<job-id>/video.mp4",
    "sha256": "<sha256>",
    "probe": { /* ffprobe summary */ }
  },
  "ffmpeg": {
    "version": "ffmpeg version ...",
    "argv": ["-y", "-i", "output/assets/<job-id>/asset-visual-0.png", ...],
    "outputPreset": "preview"
  },
  "error": null
}
```

For a failed job, `status` is `failure`, `output` and `ffmpeg` are `null`, and `error` contains:

```json
{
  "code": "TIMELINE_VALIDATION_ERROR",
  "message": "masked, host-path-free message"
}
```

## Field Semantics

- `timeline` in a **success** manifest is the exact, deep-frozen validated timeline used for generation. `timelineHash` is the SHA-256 of the canonical JSON of that exact timeline.
- `timeline` in a **failure** manifest is a sanitized copy with `../`, absolute paths, API-key-like strings, control characters, and shell metacharacters redacted. `timelineHash` is then the SHA-256 of the sanitized timeline.
- `originalTimelineHash`, when present, is the SHA-256 of the timeline as originally supplied (before source files were copied into the job asset directory). It lets an operator correlate the manifest with the original CLI/GUI input.
- `output.identifier` is the safe, project-root-relative path to the job-specific artifact file (`output/artifacts/<job-id>/...`). It is stable even when multiple jobs use the same `outputPath`.

## Security and Immutability Rules

The audit writer enforces the following rules:

- All filesystem paths are converted to **safe, project-root-relative identifiers**. `../`, absolute paths, and symlinks are rejected or redacted.
- Each job reserves an exclusive output namespace: `output/artifacts/<job-id>/` is created with `mkdir({ recursive: false })` before generation and fails if it already exists. Symlinked parents are rejected.
- The actual output video is written into the job-specific artifact directory and is verified by SHA-256 before the manifest is finalized. The manifest `output.identifier` points to this artifact, not to a shared output path that a later job could overwrite.
- The final manifest file is created exclusively: `link()` from a temp file fails with `EEXIST` if a manifest for the same `jobId` already exists. The audit directory is validated to be a real directory inside `outputDir`; symlinked directories outside the boundary are rejected.
- `ffmpeg.argv` is sanitized: known absolute input/output paths are replaced by their relative identifiers, and any remaining absolute/traversal paths are replaced with `[REDACTED_PATH]`.
- API-key-like strings and control characters are **rejected before generation** (subtitle text is validated in `validateCues`) and are masked in failure manifest text fields and error messages.
- Shell metacharacters in path identifiers are replaced so malicious filenames cannot be interpreted as commands. Shell metacharacters in subtitle text are allowed and preserved in the success manifest because FFmpeg `textfile` renders them safely.
- Raw stack traces and host-specific paths are never recorded.

## Integration

- **CLI**: `src/cli.ts` starts a `jobId` and `startedAt` before reading the timeline, validates the timeline path with `resolveSafePath` (rejecting `../`, absolute paths, symlinks, and non-regular files), writes a failure manifest for missing or malformed input, reserves `output/artifacts/<jobId>/`, and prints `Audit job ID:` and `Audit manifest:` after every run.
- **GUI**: `src/gui/server.ts` returns `auditJobId` and `auditManifestPath` in both success and failure responses from `/api/generate`. It reserves `gui/output/artifacts/<jobId>/` before generation. If audit writing itself fails, it returns a stable 500 state with `auditManifestPath: null`. Output files are served from `gui/output/artifacts/<jobId>/...`.

## Reproducibility

- The exact `timeline` in a success manifest plus the recorded input SHA-256 values and `ffmpeg.argv` allow independent verification of the source files and encoding parameters.
- The artifact directory is per-job and immutable, so the `output.identifier` in the manifest always resolves to the same MP4 file that produced the recorded hash and probe summary.
