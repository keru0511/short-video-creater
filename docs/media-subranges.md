# Media Subrange Manifest

The media subrange manifest generator takes a strictly validated v1 range request and a previously validated media catalog, then emits a deterministic `v2` `MediaSegmentManifest` containing explicit `[start, end]` sub-ranges. It is the foundation for treating user-specified sub-ranges of the same source video as distinct deterministic segments while preserving the v1 full-range semantics used by the rest of the pipeline.

## Scope

- **In scope**: reading a strict v1 range request, validating each range against the catalog and the source file, producing a canonical `v2` `MediaSegmentManifest` with deterministic segment IDs, and publishing the manifest atomically under `output/`.
- **Out of scope**: speech recognition, transcription, scene detection, video rendering, subtitle styling, DB/SQLite, UI, YouTube API, catalog generation, and v1 full-range segment generation.

## Range Request Schema (v1)

```json
{
  "schemaVersion": "v1",
  "ranges": [
    {
      "assetContentId": "<catalog id>",
      "relativePath": "clip.mp4",
      "start": 0,
      "end": 2.5
    },
    {
      "assetContentId": "<catalog id>",
      "relativePath": "clip.mp4",
      "start": 2.5,
      "end": 5
    }
  ]
}
```

- `schemaVersion`: request schema version (`v1`).
- `ranges`: ordered list of one or more explicit ranges to materialize as segments.
  - `assetContentId`: the catalog entry `id` (content SHA-256) of the source file.
  - `relativePath`: canonical catalog-relative path. Path traversal, `.` components, absolute paths, Windows drive paths, and UNC paths are rejected.
  - `start`: range start in seconds, `0 <= start < end`.
  - `end`: range end in seconds, `start < end <= source duration`.

Two ranges that have the same canonical `(relativePath, start, end)` are rejected as duplicates. Overlapping or adjacent ranges of the same asset are allowed and produce independent segments.

## Manifest Schema (v2)

The `v2` manifest keeps the same top-level shape as `v1` for structural compatibility:

```json
{
  "schemaVersion": "v2",
  "count": 2,
  "excludedCount": 0,
  "excluded": [],
  "segments": [
    {
      "segmentId": "<sha256>",
      "assetContentId": "<catalog id>",
      "relativePath": "clip.mp4",
      "mediaType": "video",
      "start": 0,
      "end": 2.5,
      "duration": 5
    },
    {
      "segmentId": "<sha256>",
      "assetContentId": "<catalog id>",
      "relativePath": "clip.mp4",
      "mediaType": "video",
      "start": 2.5,
      "end": 5,
      "duration": 5
    }
  ]
}
```

- `schemaVersion`: manifest schema version (`v2`).
- `count`: number of segments, equal to `segments.length`.
- `excludedCount`: number of excluded catalog entries, equal to `excluded.length`.
- `excluded`: retained for structural compatibility with `v1` but populated only by catalog-derived unsegmentable entries (e.g. images, error entries, invalid durations, missing probes). Invalid range requests fail the whole request closed; they are not silently dropped into `excluded`.
- `segments`: sorted by deterministic `segmentId` in UTF-8 byte order.
  - `segmentId`: deterministic SHA-256 of the stable payload (see below).
  - `assetContentId`: the catalog entry `id` (content SHA-256).
  - `relativePath`: canonical catalog-relative path.
  - `mediaType`: `video` or `audio`.
  - `start`: explicit range start in seconds.
  - `end`: explicit range end in seconds.
  - `duration`: the full probed source duration from the catalog entry.

## Segment ID Derivation

```
segmentId = sha256(UTF8(stableJSON))
```

The stable JSON object has alphabetically sorted keys:

```json
{
  "assetContentId": "<catalog id>",
  "duration": 5,
  "end": 2.5,
  "mediaType": "video",
  "relativePath": "clip.mp4",
  "schemaVersion": "v2",
  "start": 0
}
```

Because the payload includes `schemaVersion`, `start`, and `end`, a full-range `v2` segment has a different `segmentId` from a `v1` full-range segment, and different sub-ranges of the same asset have different deterministic IDs.

## CLI

```bash
npx tsx src/media-subranges-cli.ts <range-request-rel.json> <catalog-rel.json> <input-dir> [output-rel.json]
```

- `range-request-rel.json`: root-relative path to a v1 range request JSON under the project root.
- `catalog-rel.json`: root-relative path to a previously generated catalog JSON.
- `input-dir`: trusted source media directory (the same directory used to generate the catalog).
- `output-rel.json`: optional target path under `output/` (default `media-subranges/manifest.json`). A leading `output/` is stripped automatically.

Example:

```bash
npx tsx src/catalog-cli.ts fixtures output/catalog.json
npx tsx src/media-subranges-cli.ts \
  input/ranges.json \
  output/catalog.json \
  fixtures \
  output/media-subranges/manifest.json
```

This writes `output/media-subranges/manifest.json`.

## Safety and Determinism

- `readMediaSubrangeRequest()` reuses `readJsonFileSafe()` from `src/segment-selection.ts` for bounded, strict JSON parsing and `assertNoDuplicateKeys()` from `src/transcript-manifest.ts` to reject duplicate object keys.
- Range bounds are validated against the catalog entry and independently verified by opening the source file, recomputing its SHA-256, and re-probing it with ffprobe.
- Exact duplicate ranges are rejected.
- Canonical assets are deduplicated by `(dev, ino, realpath)` for the input snapshot barrier, but multiple ranges of the same file still produce independent segments.
- Hard links (`nlink > 1`) and multi-inode aliases are rejected.
- `publishAtomicNoReplace()` from `src/transcript-manifest.ts` is reused for atomic no-replace publication with input snapshots, preserving the same guarantees used by `v1` manifest publication.
- Invalid range requests fail the whole request closed and are not silently placed in `excluded`.
- Source assets, the input catalog, the range request file, and existing v1/v2 outputs are never modified.

## Downstream Compatibility

- `src/segment-selection.ts`, `src/transcript-manifest.ts`, and `src/transcript-subtitle-timeline.ts` accept both `v1` and `v2` manifests because `MediaSegmentManifestSchema` is a union of the two versions.
- `Clip.in` and `Clip.out` are set to `segment.start` and `segment.end`, so sub-range segments render the requested portion of the source video.
- Subtitle cue times are mapped with `clipStart + (utterance.start - segment.start)`, producing absolute timeline timestamps for each sub-range.
