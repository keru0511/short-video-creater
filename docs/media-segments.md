# Media Segment Manifest

The media segment manifest generator takes a strictly validated media catalog and emits a deterministic JSON manifest of full-duration `[0, duration]` segments for every video and audio asset. This is the foundation for later transcription, scene detection, and planning stages.

## Scope

- **In scope**: reading a validated catalog, generating one full-duration segment per valid video/audio asset, recording explicit exclusion reasons for skipped entries, and writing the manifest atomically under `output/`.
- **Out of scope**: transcription, speech recognition, scene/shot detection, person/object/place/topic tags, assigning virtual durations to image assets, timeline schema or renderer changes, DB/SQLite, UI, YouTube API, trend analysis, and planning generation.

## Schema

```json
{
  "schemaVersion": "v1",
  "count": 2,
  "excludedCount": 1,
  "excluded": [
    {
      "relativePath": "image.png",
      "reason": "UNSUPPORTED_MEDIA_TYPE"
    }
  ],
  "segments": [
    {
      "segmentId": "<sha256>",
      "assetContentId": "<catalog id>",
      "relativePath": "clip.mp4",
      "mediaType": "video",
      "start": 0,
      "end": 2.5,
      "duration": 2.5
    }
  ]
}
```

- `schemaVersion`: manifest schema version (`v1`).
- `count`: number of segments, equal to `segments.length`.
- `excludedCount`: number of excluded entries, equal to `excluded.length`.
- `excluded`: sorted by canonical `relativePath` then by `reason` in deterministic UTF-8 byte order.
  - `relativePath`: canonical root-relative path from the catalog.
  - `reason`: fixed exclusion reason code.
- `segments`: sorted by canonical `relativePath` in deterministic UTF-8 byte order.
  - `segmentId`: deterministic SHA-256 of a stable JSON payload.
  - `assetContentId`: the catalog entry `id` (content SHA-256).
  - `relativePath`: canonical root-relative path from the catalog.
  - `mediaType`: `video` or `audio`.
  - `start`: always `0`.
  - `end`: always equal to `duration`.
  - `duration`: the probed duration from the catalog entry.

### Exclusion reason codes

| Reason | Meaning |
|--------|---------|
| `ERROR_ENTRY` | The catalog entry has a structured error (e.g. probe/hash failed). |
| `MISSING_ID` | The entry has no stable content id and no error. |
| `MISSING_PROBE` | The entry has an id but no probe metadata. |
| `UNSUPPORTED_MEDIA_TYPE` | The probed type is not `video` or `audio` (e.g. an image). |
| `INVALID_DURATION` | The probed duration is missing, non-finite, or not positive. |

All exclusion reasons are deterministic and sorted so the manifest JSON and SHA-256 are stable for the same catalog.

## Segment ID Derivation

```
segmentId = sha256(UTF8(stableJSON))
```

The stable JSON object has alphabetically sorted keys:

```json
{
  "assetContentId": "<catalog id>",
  "duration": 2.5,
  "end": 2.5,
  "mediaType": "video",
  "relativePath": "clip.mp4",
  "schemaVersion": "v1",
  "start": 0
}
```

Because the payload includes `relativePath` and `assetContentId`, duplicate content under different paths produces distinct but stable segment IDs, and the hash is independent of runtime locale or scan order.

## CLI

```bash
npx tsx src/media-segments-cli.ts <catalog-relative.json> <input-dir> [output-relative.json]
```

- `catalog-relative.json`: root-relative path to a previously generated catalog JSON under the project root.
- `input-dir`: trusted source media directory (the same directory used to generate the catalog). The output cannot overlap this directory or the catalog input file.
- `output-relative.json`: optional target path under `output/` (default `media-segments/manifest.json`). A leading `output/` is stripped automatically.

Example:

```bash
npx tsx src/catalog-cli.ts fixtures output/catalog.json
npx tsx src/media-segments-cli.ts output/catalog.json fixtures
```

This writes `output/media-segments/manifest.json`.

## Safety

The CLI and library reuse existing components:

- `loadPreviousCatalog()` from `src/catalog-diff.ts` performs strict catalog validation, fail-closed parsing, bounded file reads, and rejects malformed JSON, invalid UTF-8, oversized catalogs, absolute/traversal/alias relative paths, and non-canonical paths.
- `resolveSafePath()` from `src/core.ts` is used to resolve the catalog input path before writing, so the same path, `./` alias, symlink, or hard-link output is detected and rejected.
- `verifyOutputNotSameAsInput()` from `src/catalog-diff.ts` rejects an output that aliases the input catalog by string path, device/inode, or realpath.
- `writeJsonAtomic()` from `src/catalog.ts` performs atomic JSON publication under `output/`, rejects output paths that escape the project root, overlap the input directory, or traverse symlinks, and cleans up temporary files on failure.

Source assets, the input catalog, existing video outputs, and other project files are never modified.
