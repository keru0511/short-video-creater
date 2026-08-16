# Transcript Manifest

The transcript manifest generator takes two deterministic inputs:

1. a previously generated media segment manifest (`output/media-segments/manifest.json`)
2. a manually authored transcript source JSON with time-coded utterances

and emits a strictly validated, deterministic transcript manifest under `output/transcripts/`.

## Scope

- **In scope**: bounded reading of both inputs, fatal UTF-8 decoding, duplicate-key detection, strict schema validation, canonical path handling, stable utterance ID derivation, deterministic normalization/sorting, media segment and referenced asset integrity verification (canonical path, SHA-256, media type, duration, segmentId), publish-time re-verification of both inputs and all referenced assets, and atomic no-replace publication of the transcript manifest under `output/transcripts/<file>.json` only.
- **Out of scope**: speech recognition (Whisper), speaker diarization, translation, summarization, scene/shot detection, tags, LLM/generative AI, subtitle rendering, BGM, transitions, output presets, GUI, DB/SQLite, YouTube API, trend analysis, planning generation, and modifying source assets or the input manifests.

## Input contract

### Transcript source (`v1`)

```json
{
  "schemaVersion": "v1",
  "entries": [
    {
      "segmentId": "<segment sha256>",
      "start": 0.5,
      "end": 2.0,
      "text": "Hello",
      "speaker": "A",
      "confidence": 0.95
    }
  ]
}
```

- `schemaVersion`: must be `v1`.
- `entries`: array of utterance entries.
  - `segmentId`: existing video/audio segment ID from the media segment manifest.
  - `start`, `end`: finite seconds with `0 <= start < end <= segment.duration`.
  - `text`: non-empty string, no control characters / NUL / lone surrogates, bounded length.
  - `speaker` (optional): non-empty label.
  - `confidence` (optional): finite number in `[0, 1]`.

### Media segment manifest

A valid `v1` media segment manifest produced by `src/media-segments.ts`. Only `video` and `audio` segments may be referenced; image or error segments are excluded from the manifest already, and any attempt to reference them is rejected.

Before the transcript manifest is built, every referenced segment is verified against the actual asset under `inputRoot`:

- the asset file exists and is a regular file (not a symlink);
- the file's canonical path stays inside `inputRoot`;
- the file's SHA-256 matches `assetContentId`;
- `ffprobe` media type matches `mediaType` (`video` or `audio`);
- `ffprobe` duration matches `duration` (within `1e-6`);
- `computeSegmentId` over the verified fields matches `segmentId`.

`generateAndWriteTranscriptManifest` also accepts an optional `maxBytes` parameter (defaults to `10 MiB`) and validates it as a finite positive safe integer before passing it to the bounded JSON reader.

## Output schema (`v1`)

```json
{
  "schemaVersion": "v1",
  "sourceManifest": {
    "identifier": "fixtures/transcript-source.json",
    "sha256": "<sha256>"
  },
  "mediaSegmentManifest": {
    "identifier": "fixtures/transcript-media-segments.json",
    "sha256": "<sha256>"
  },
  "count": 2,
  "utterances": [
    {
      "utteranceId": "<stable sha256>",
      "segmentId": "<segment sha256>",
      "assetContentId": "<asset sha256>",
      "relativePath": "black.mp4",
      "segmentStart": 0,
      "segmentEnd": 5,
      "segmentDuration": 5,
      "start": 0.5,
      "end": 2,
      "text": "Hello",
      "speaker": "A",
      "confidence": 0.95
    }
  ]
}
```

- `utteranceId`: locale-independent SHA-256 of a canonical JSON payload containing `schemaVersion`, `segmentId`, `start`, `end`, `text`, `speaker` (or `null`), and `confidence` (or `null`).
- `count`: equal to `utterances.length`.
- `utterances`: sorted deterministically by `segmentId`, then `start`, then `end`, then the original input index (source entry order). Overlapping utterances are preserved.

## CLI

```bash
npx tsx src/transcript-manifest-cli.ts \
  <media-segments-manifest-rel.json> \
  <transcript-source-rel.json> \
  <input-dir> \
  [output-relative.json]
```

The optional output path must resolve to `output/transcripts/<file>.json` (the leading `output/` is optional). It rejects absolute paths, Windows drive/UNC paths, empty paths, `.`, `..`, traversal, bare `output`, non-`transcripts` namespaces, and non-`.json` names.

Example using the committed fixtures (input dir `fixtures`, asset `black.mp4` is relative to `fixtures`):

```bash
npx tsx src/transcript-manifest-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-source.json \
  fixtures \
  output/transcripts/manifest.json
```

The default output path is `output/transcripts/manifest.json`.

With the committed fixtures this produces a deterministic manifest whose SHA-256 is:

```
f4750dc6eebed688a3ddd0841b232acffc5cbeaff285033e80c9e84c51c22b8d  output/transcripts/manifest.json
```

## Library API

```ts
import { generateAndWriteTranscriptManifest } from './src/transcript-manifest.js';

const { manifest, outputPath } = await generateAndWriteTranscriptManifest({
  projectRoot: process.cwd(),
  inputRoot: `${process.cwd()}/fixtures`,
  mediaSegmentManifestRel: 'fixtures/transcript-media-segments.json',
  transcriptSourceRel: 'fixtures/transcript-source.json',
  outputRel: 'transcripts/manifest.json',
  maxBytes: 10 * 1024 * 1024,
});
```

## Safety

The implementation reuses the existing bounded JSON reader, canonical path resolver, duplicate-key detector, strict Zod schemas, and the KER-314 `computeSegmentId` / `MediaSegment` contracts. Publication uses a KER-317-specific atomic no-replace writer:

- output path is normalized to `transcripts/<file>.json` before `output/` is prepended, with strict rejection of absolute, drive, UNC, traversal, empty, non-JSON, and non-`transcripts` paths;
- the output directory is opened with `O_DIRECTORY | O_NOFOLLOW` and its location is verified by `fstat`/`lstat` comparison plus `realpath` containment;
- an anonymous `O_TMPFILE` inode is created in the output directory, the manifest bytes are written and `fsync`ed, then the inode is sealed to `0400` before publication;
- a single dirfd-bound `os.link('/proc/self/fd/<tmpFd>', finalName, dst_dir_fd=...)` performs the no-replace commit, so a pre-existing foreign final causes `EEXIST` and the anonymous inode is discarded; no named temporary file or writable alias is ever published;
- the commit, the input barrier, and the output hash check run in one helper process with no intermediate Node event-loop yields between the pre-link checks and the `os.link` call, so there is no window for partial failure before the link;
- after the helper returns, the TypeScript parent opens the linked final with `O_NOFOLLOW` via the bound output directory fd and runs `verifyFinalCommit` against the still-held `O_TMPFILE` fd. It compares `dev`/`ino`, re-reads the file to recompute SHA-256, checks the file size before and after the read, and confirms the path still resolves to the same inode. Only if every check passes is the publish considered successful.

Before the commit, the helper opens each input with `O_NOFOLLOW` under its parent directory fd, acquires a shared advisory `flock` on the file descriptor, verifies the file is a regular file (not a symlink), and checks `dev`/`ino`/`size`/`mtime`/`ctime`/`sha256` against the values captured at first read. A final re-verify of `dev`/`ino`/`size`/`mtime`/`ctime` runs immediately before `os.link`, binding the input barrier to the commit. On any error, no final is created and existing foreign finals and all inputs are left untouched.

`generateAndWriteTranscriptManifest` captures the parent directory identity, canonical realpath, file `dev`/`ino`/`size`/`mtime`/`ctime`, and SHA-256 at first read for the media manifest, transcript source, and each referenced asset. `captureInputSnapshot` reopens the input with `O_NOFOLLOW` through a bound parent dirfd, compares the opened fd stat and recomputes SHA-256 against the first-read baseline, re-stat to detect changes during the capture, and confirms the canonical path is still directly inside the same parent. A same-bytes replacement with a different inode is therefore rejected before the snapshot is bound to the publish barrier.

`writeTranscriptManifest` always serializes the canonical parsed manifest object, not the caller's original object, so JSON bytes and SHA-256 are stable regardless of input property order. `TranscriptUtterance` schema validation recomputes `utteranceId` from the `schemaVersion`/`segmentId`/`start`/`end`/`text`/`speaker`/`confidence` payload and rejects any mismatch. It also enforces `segmentStart <= start < end <= segmentEnd` and `segmentEnd === segmentDuration`.

`verifySelectedSegmentIntegrity` opens the asset with `O_NOFOLLOW`, computes its SHA-256 and runs `ffprobe` through the same file descriptor, and verifies the file is a regular file and remains unchanged between the hash read and the probe.
