# Transcript Subtitle Timeline

Connects the transcript manifest pipeline (KER-317) to the existing renderer by producing a deterministic, subtitle-bearing `Timeline` JSON from four strict inputs:

1. a media segment manifest (`output/media-segments/manifest.json` or equivalent)
2. a KER-314 explicit segment selection JSON
3. a KER-317 transcript manifest (`output/transcripts/manifest.json`)
4. a subtitle style JSON

The output is written to `output/timelines/<file>.json` and can be rendered directly with `npm run generate:video -- output/timelines/<file>.json`.

## Scope

- **In scope**: bounded reading of all four inputs, fatal UTF-8 decoding, duplicate-key detection, strict schema validation, re-verification of the transcript manifest against the actual media segment manifest and assets, mapping of selected-video-segment utterances to absolute-time subtitle cues, application of a fixed subtitle style, enforcement of the existing subtitle contract (max cues, max text length, control characters, secret-like text, timeline range), font path/hash verification, deterministic JSON serialization, and atomic no-replace publication of the Timeline JSON.
- **Out of scope**: speech recognition, automatic segment selection, caption wrapping/translation/summarization, scene detection, renderer/FFmpeg changes, BGM, transitions, output presets, GUI, catalog/approval/audit/release-readiness production code, and modifying input manifests or assets.

## Input contract

### Media segment manifest (`v1`)

A valid media segment manifest produced by `src/media-segments.ts`. Only `video` segments may be selected; `audio`/`image`/unknown/duplicate IDs in the selection are rejected.

### Segment selection (`v1`)

```json
{
  "segmentIds": [
    "<segment sha256>",
    "<segment sha256>"
  ]
}
```

- `segmentIds`: ordered array of 1 to 5 video segment IDs.
- Order defines clip order and absolute cue time offsets.

### Transcript manifest (`v1`)

A transcript manifest produced by `src/transcript-manifest.ts`.

```json
{
  "schemaVersion": "v1",
  "sourceManifest": { "identifier": "<canonical path>", "sha256": "<sha256>" },
  "mediaSegmentManifest": { "identifier": "<canonical path>", "sha256": "<sha256>" },
  "count": 2,
  "utterances": [
    {
      "utteranceId": "<sha256>",
      "segmentId": "<segment sha256>",
      "assetContentId": "<sha256>",
      "relativePath": "<asset path>",
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

The generator re-validates:

- `mediaSegmentManifest.identifier` and `sha256` match the provided media segment manifest.
- each utterance's `segmentId` exists in the media manifest.
- each utterance's `assetContentId`, `relativePath`, `segmentStart`, `segmentEnd`, and `segmentDuration` match the segment.
- each utterance's `start`/`end` lie within the segment range and `start < end`.
- each `utteranceId` equals `computeUtteranceId` over `schemaVersion`, `segmentId`, `start`, `end`, `text`, `speaker` (or `null`), and `confidence` (or `null`).

### Subtitle style (`v1`)

```json
{
  "font": "DejaVuSans.ttf",
  "fontHash": "<sha256>",
  "x": 540,
  "y": 1500,
  "fontSize": 100
}
```

- `font`: a single-face `.ttf` or `.otf` file under the approved font root (`fonts/` by default).
- `fontHash`: SHA-256 of the resolved font file.
- `x`, `y`: integer pixel coordinates.
- `fontSize`: integer in `[1, 200]`.

No other fields, implicit defaults, or optional fields are allowed.

## Cue mapping

Clips are built from the explicit selection in order. For each selected video segment, the generator iterates the transcript manifest utterances belonging to that segment in their deterministic order and emits one cue per utterance:

- `start = clipStart + (utterance.start - segment.start)`
- `end = clipStart + (utterance.end - segment.start)`
- `text`, `x`, `y`, `fontSize` from the style.

Overlaps are preserved. Utterances from unselected segments are not emitted. A selected segment with no utterances still produces a clip.

The resulting `subtitles` array is validated with the existing `validateCues()`:

- at most 20 cues;
- each `text` at most 100 characters;
- no control characters, NUL, or secret-like values;
- all cue times within the total timeline duration.

## Output

A `Timeline` JSON under `output/timelines/<file>.json`:

```json
{
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "outputPath": "timelines/<file>.mp4",
  "background": "000000",
  "outputPreset": "preview",
  "clips": [...],
  "subtitles": [
    { "start": 0.5, "end": 2, "text": "Hello", "x": 540, "y": 1500, "fontSize": 100 }
  ],
  "font": "DejaVuSans.ttf",
  "fontHash": "<sha256>"
}
```

Keys are serialized in deterministic order so identical inputs produce identical JSON and SHA-256.

## CLI usage

```bash
npx tsx src/transcript-subtitle-timeline-cli.ts \
  <media-manifest-rel.json> \
  <selection-rel.json> \
  <transcript-manifest-rel.json> \
  <style-rel.json> \
  <input-dir> \
  [output-rel.json]
```

Exactly five or six arguments are accepted; any other count fails closed. `output-rel.json` defaults to `timelines/subtitled.json` and is normalized to `timelines/<file>.json`.

### Full E2E example from fixtures

```bash
npm run generate:fixtures
npx tsx src/transcript-manifest-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-source.json \
  fixtures \
  output/transcripts/manifest.json

# Create a subtitle style JSON (or use fixtures/transcript-subtitle-style.json)
cat > fixtures/transcript-subtitle-style.json <<EOF
{
  "font": "DejaVuSans.ttf",
  "fontHash": "$(sha256sum fonts/DejaVuSans.ttf | cut -d' ' -f1)",
  "x": 540,
  "y": 1500,
  "fontSize": 100
}
EOF

cat > fixtures/transcript-selection.json <<EOF
{
  "segmentIds": [
    "a69fe3794649e952e6f8bf26faa17e365ad1a9e6c30ec493ccb3b3be94b15385"
  ]
}
EOF

npx tsx src/transcript-subtitle-timeline-cli.ts \
  fixtures/transcript-media-segments.json \
  fixtures/transcript-selection.json \
  output/transcripts/manifest.json \
  fixtures/transcript-subtitle-style.json \
  fixtures \
  timelines/subtitled.json

npm run generate:video -- output/timelines/subtitled.json
```

The generated MP4 is 1080x1920, H.264/AAC, with burned-in subtitles. Re-running with identical inputs produces an identical `output/timelines/subtitled.json` SHA-256 and, when rendered, the same output MP4 SHA-256.

## Publication safety

The Timeline JSON is published with the same fd-relative, atomic no-replace protocol used by `src/transcript-manifest.ts` (`publishAtomicNoReplace`). Input snapshots for the four JSON inputs, the selected source video assets, and the resolved font file are captured before publication and re-verified by a Python helper during the final `os.link` barrier. A pre-existing final, hard link, symlink, or output collision is rejected without replacing the existing file.

Font identity is bound from the first `resolveFont()` verification through glyph checking, snapshot, and the final publish: the captured `dev/ino/size/mtime/ctime/realpath` and SHA-256 are reused as the expected values for `captureInputSnapshot` and the Python helper, so a same-bytes/different-inode or different-bytes replacement after verification is rejected.

## Library API

```ts
import { generateAndWriteSubtitleTimeline } from './transcript-subtitle-timeline.js';

const result = await generateAndWriteSubtitleTimeline({
  projectRoot: '.',
  inputRoot: 'fixtures',
  mediaManifestRel: 'fixtures/transcript-media-segments.json',
  selectionRel: 'fixtures/transcript-selection.json',
  transcriptManifestRel: 'output/transcripts/manifest.json',
  styleRel: 'fixtures/transcript-subtitle-style.json',
  outputRel: 'timelines/subtitled.json',
});

console.log(result.timelineSha256);
console.log(result.outputPath);
```

`generateAndWriteSubtitleTimeline` accepts an optional `__testHooks?: PublishAtomicTestHooks` for adversarial tests, mirroring the `transcript-manifest.ts` publication test hooks.
