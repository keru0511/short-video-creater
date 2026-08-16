# Segment Selection to Timeline

Generates a deterministic 9:16 `Timeline` JSON from an explicit, ordered list of video segment IDs taken from a previously generated media segment manifest.

## Scope

- **In scope**: reading a strict media segment manifest, validating an ordered selection of 1-5 video segment IDs, and producing a `Timeline` JSON that conforms to the existing `TimelineSchema` for the renderer.
- **Out of scope**: automatic segment selection, ranking, transcription, scene detection, subtitles, BGM, transitions, output presets, UI/DB, source asset conversion, and modifying the renderer.

## Selection JSON schema

```json
{
  "segmentIds": [
    "<sha256>",
    "<sha256>"
  ]
}
```

- `segmentIds`: ordered array of 1 to 5 `segmentId` values from the media segment manifest. Only video segments are allowed; audio or unknown IDs are rejected. Duplicate IDs in the selection, and duplicate `segmentId` values inside the manifest, are rejected.

## CLI

```bash
npx tsx src/segment-selection-cli.ts <manifest-relative.json> <selection-relative.json> <input-dir> [output-relative.json]
```

- `manifest-relative.json`: root-relative path to a previously generated media segment manifest (e.g. `output/media-segments/manifest.json`).
- `selection-relative.json`: root-relative path to a selection JSON file.
- `input-dir`: trusted source media directory used to generate the catalog/manifest. The output cannot overlap this directory or the input files.
- `output-relative.json`: optional target path under `output/` (default `timelines/selection.json`). Only `timelines/<file>.json` is allowed; a leading `output/` or `./output/` is normalized and stripped. Paths like `foo.json`, `other/x.json`, `output/foo.json`, or traversal/`./` aliases outside `timelines/` are rejected before any write.

Example:

```bash
npx tsx src/catalog-cli.ts fixtures output/catalog.json
npx tsx src/media-segments-cli.ts output/catalog.json fixtures
npx tsx src/segment-selection-cli.ts output/media-segments/manifest.json selection.json fixtures
```

This writes `output/timelines/selection.json` with `outputPath` set to `timelines/selection.mp4`.

## Output timeline defaults

- `width`: 1080
- `height`: 1920
- `fps`: 30
- `background`: `000000`
- `fit`: `cover`
- `outputPreset`: `preview`

Clips are connected sequentially from `0` with no gaps or overlaps. Each clip uses the manifest's canonical `relativePath`, `start`, `end`, `in`, and `out` values.

## Safety

- The manifest and selection files are read with bounded size, UTF-8, and inode-stability checks.
- The output cannot be the same file, a hard link, a symbolic link, or a `./` alias of either input file. Input SHA-256, device, and inode are verified to be unchanged after the write.
- The timeline is validated with the existing `TimelineSchema` before being written.
- The JSON is written atomically under `output/timelines/` using `writeJsonAtomic`, with temporary files cleaned up on failure.
