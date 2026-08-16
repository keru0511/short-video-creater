import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildTranscriptManifest,
  computeUtteranceId,
  generateAndWriteTranscriptManifest,
  normalizeTranscriptOutputRel,
  readMediaSegmentManifest,
  readTranscriptSource,
  TRANSCRIPT_SCHEMA_VERSION,
  verifyMediaSegmentManifest,
  verifySegmentIntegrity,
  writeTranscriptManifest,
  type PublishAtomicTestHooks,
  type TranscriptSource,
} from '../src/transcript-manifest.js';
import { sha256File } from '../src/core.js';
import { computeSegmentId, type MediaSegment, type MediaSegmentManifest } from '../src/media-segments.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function makeRealMediaFile(dir: string, name = 'clip.mp4', type: 'video' | 'audio' = 'video'): Promise<string> {
  const p = join(dir, name);
  await mkdir(resolve(p, '..'), { recursive: true });
  if (type === 'audio') {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-t',
      '5',
      p,
    ]);
  } else {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:d=5',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '5',
      p,
    ]);
  }
  return p;
}

async function probeDuration(p: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    p,
  ]);
  const num = Number(stdout.trim());
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Could not probe duration for ${p}`);
  }
  return num;
}

async function makeRealSegment(inputDir: string, name = 'clip.mp4'): Promise<MediaSegment> {
  const p = await makeRealMediaFile(inputDir, name);
  const relativePath = name;
  const duration = await probeDuration(p);
  const assetContentId = await sha256File(p);
  const segmentId = computeSegmentId({
    assetContentId,
    relativePath,
    mediaType: 'video',
    start: 0,
    end: duration,
    duration,
  });
  return {
    segmentId,
    assetContentId,
    relativePath,
    mediaType: 'video',
    start: 0,
    end: duration,
    duration,
  };
}

function makeSegment(
  segmentId: string,
  relativePath: string,
  duration: number,
  mediaType: 'video' | 'audio' = 'video',
): {
  segmentId: string;
  assetContentId: string;
  relativePath: string;
  mediaType: 'video' | 'audio';
  start: number;
  end: number;
  duration: number;
} {
  return {
    segmentId,
    assetContentId: 'a'.repeat(64),
    relativePath,
    mediaType,
    start: 0,
    end: duration,
    duration,
  };
}

function makeMediaSegmentManifest(segments: unknown[]): MediaSegmentManifest {
  return {
    schemaVersion: 'v1',
    count: segments.length,
    excludedCount: 0,
    excluded: [],
    segments,
  } as MediaSegmentManifest;
}

function makeTranscriptSource(entries: TranscriptSource['entries']): TranscriptSource {
  return { schemaVersion: 'v1', entries };
}

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await mkdir(resolve(p, '..'), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

describe('buildTranscriptManifest', () => {
  it('generates a deterministic manifest from valid video/audio segments and transcript entries', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0.5, end: 2, text: 'Hello' },
    ]);
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    expect(manifest.schemaVersion).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(manifest.count).toBe(1);
    expect(manifest.utterances).toHaveLength(1);

    const u = manifest.utterances[0];
    expect(u.utteranceId).toMatch(/^[0-9a-f]{64}$/);
    expect(u.segmentId).toBe(segment.segmentId);
    expect(u.assetContentId).toBe(segment.assetContentId);
    expect(u.relativePath).toBe('clip.mp4');
    expect(u.segmentStart).toBe(0);
    expect(u.segmentEnd).toBe(5);
    expect(u.segmentDuration).toBe(5);
    expect(u.start).toBe(0.5);
    expect(u.end).toBe(2);
    expect(u.text).toBe('Hello');
    expect(u.speaker).toBeUndefined();
    expect(u.confidence).toBeUndefined();
  });

  it('produces identical JSON and SHA-256 for identical inputs', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello world' },
      { segmentId: segment.segmentId, start: 2, end: 4, text: 'Goodbye', speaker: 'B', confidence: 0.9 },
    ]);
    const inputs = {
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    };
    const first = buildTranscriptManifest(inputs);
    const second = buildTranscriptManifest(inputs);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(sha256Hex(JSON.stringify(second))).toBe(sha256Hex(JSON.stringify(first)));
  });

  it('derives stable utterance IDs from schema fields and preserves locale independence', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const id1 = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: segment.segmentId,
      start: 1,
      end: 2,
      text: 'Test',
      speaker: null,
      confidence: null,
    });
    const id2 = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: segment.segmentId,
      start: 1,
      end: 2,
      text: 'Test',
      speaker: null,
      confidence: null,
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts utterances by segmentId, start, end, preserving input order for overlaps', () => {
    const segA = makeSegment('a'.repeat(64), 'a.mp4', 5);
    const segB = makeSegment('b'.repeat(64), 'b.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segB.segmentId, start: 0, end: 2, text: 'B-first' },
      { segmentId: segA.segmentId, start: 1, end: 3, text: 'A-overlap-1' },
      { segmentId: segA.segmentId, start: 1, end: 3, text: 'A-overlap-2' },
      { segmentId: segA.segmentId, start: 0, end: 1, text: 'A-first' },
    ]);
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segA, segB]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const texts = manifest.utterances.map((u) => u.text);
    expect(texts).toEqual(['A-first', 'A-overlap-1', 'A-overlap-2', 'B-first']);
  });

  it('uses input index, not text order, as the tie-break for same segment/start/end', () => {
    const segA = makeSegment('a'.repeat(64), 'a.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segA.segmentId, start: 1, end: 3, text: 'Z-last-input-first' },
      { segmentId: segA.segmentId, start: 1, end: 3, text: 'A-first-input-second' },
      { segmentId: segA.segmentId, start: 0, end: 1, text: 'A-before' },
    ]);
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segA]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const texts = manifest.utterances.map((u) => u.text);
    expect(texts).toEqual(['A-before', 'Z-last-input-first', 'A-first-input-second']);
  });

  it('preserves optional speaker and confidence', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A', speaker: 'Alice', confidence: 0.95 },
    ]);
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });
    expect(manifest.utterances[0].speaker).toBe('Alice');
    expect(manifest.utterances[0].confidence).toBe(0.95);
  });

  it('rejects duplicate transcript entries', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/Duplicate transcript entry/);
  });

  it('rejects an unknown segment ID', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: '1'.repeat(64), start: 0, end: 1, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/Unknown segment ID/);
  });

  it('rejects an image segment reference', () => {
    const imageSegment = { ...makeSegment('0'.repeat(64), 'image.png', 5), mediaType: 'image' as const };
    const source = makeTranscriptSource([
      { segmentId: imageSegment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([imageSegment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/not a video or audio segment|mediaType/);
  });

  it('rejects timestamps outside the segment range', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 2);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 3, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/exceeds/);
  });

  it('rejects start >= end', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 2, end: 2, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/start must be less than end/);
  });

  it('rejects empty text', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: '' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/String must contain at least 1|empty|control|NUL|oversized/);
  });

  it('rejects control characters and NUL in text', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'Hello\nworld' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/control/);
  });

  it('rejects lone surrogates in text', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const brokenPairs = [
      'Hello\uD800world',
      '\uDC00world',
      '\uD800\uD800',
      '\uDC00\uDC00',
    ];
    for (const text of brokenPairs) {
      const source = makeTranscriptSource([{ segmentId: segment.segmentId, start: 0, end: 1, text }]);
      expect(() =>
        buildTranscriptManifest({
          mediaSegmentManifest: makeMediaSegmentManifest([segment]),
          mediaSegmentManifestIdentifier: 'media.json',
          mediaSegmentManifestSha256: 'b'.repeat(64),
          transcriptSource: source,
          transcriptSourceIdentifier: 'source.json',
          transcriptSourceSha256: 'c'.repeat(64),
        }),
      ).toThrow(/surrogate/);
    }
  });

  it('accepts valid non-BMP Unicode and emoji in text and speaker', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      {
        segmentId: segment.segmentId,
        start: 0,
        end: 1,
        text: 'Hello \u{1F44B}\u{1F600} \u{1D11E}',
        speaker: '\u{1F9D1}\u{1F3FB}',
      },
    ]);

    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: source,
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(roundTripped.utterances[0].text).toBe(source.entries[0].text);
    expect(roundTripped.utterances[0].speaker).toBe(source.entries[0].speaker);

    const id1 = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: segment.segmentId,
      start: 0,
      end: 1,
      text: source.entries[0].text,
      speaker: source.entries[0].speaker ?? null,
      confidence: null,
    });
    const id2 = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: segment.segmentId,
      start: 0,
      end: 1,
      text: source.entries[0].text,
      speaker: source.entries[0].speaker ?? null,
      confidence: null,
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects oversized text', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'a'.repeat(200_000) },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/oversized/);
  });

  it('rejects NaN/Infinity timestamps', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: Infinity, text: 'A' },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/finite|Infinity/);
  });

  it('rejects out-of-range confidence', () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A', confidence: 1.5 },
    ]);
    expect(() =>
      buildTranscriptManifest({
        mediaSegmentManifest: makeMediaSegmentManifest([segment]),
        mediaSegmentManifestIdentifier: 'media.json',
        mediaSegmentManifestSha256: 'b'.repeat(64),
        transcriptSource: source,
        transcriptSourceIdentifier: 'source.json',
        transcriptSourceSha256: 'c'.repeat(64),
      }),
    ).toThrow(/confidence|0|1/);
  });
});

describe('readMediaSegmentManifest / readTranscriptSource', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'transcript-manifest-read-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects oversized source files', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const mediaPath = await writeJson(project, 'media.json', makeMediaSegmentManifest([segment]));
    await expect(readMediaSegmentManifest(project, 'media.json', { maxBytes: 1 })).rejects.toThrow(/exceeds maximum size/);
  });

  it('rejects duplicate keys', async () => {
    const path = join(project, 'dup.json');
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, '{"schemaVersion": "v1", "entries": [], "entries": []}');
    await expect(readTranscriptSource(project, 'dup.json')).rejects.toThrow(/Duplicate key/);
  });

  it('rejects malformed JSON', async () => {
    const path = join(project, 'bad.json');
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, 'not json');
    await expect(readTranscriptSource(project, 'bad.json')).rejects.toThrow(/valid JSON/);
  });

  it('rejects invalid UTF-8', async () => {
    const path = join(project, 'bad.json');
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, Buffer.from([0x80, 0x81, 0x82]));
    await expect(readTranscriptSource(project, 'bad.json')).rejects.toThrow(/UTF-8/);
  });

  it('rejects an unknown exclusion reason in the media segment manifest', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const media: unknown = makeMediaSegmentManifest([segment]);
    (media as { excluded: { relativePath: string; reason: string }[] }).excluded.push({
      relativePath: 'bad.mp4',
      reason: 'UNKNOWN_REASON',
    });
    await writeJson(project, 'media-unknown-reason.json', media);
    await expect(readMediaSegmentManifest(project, 'media-unknown-reason.json')).rejects.toThrow(
      /UNKNOWN_REASON|Invalid enum value/,
    );
  });

  it('rejects unknown nested fields in the media segment manifest', async () => {
    const segment: unknown = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    (segment as { unknownField: string }).unknownField = 'x';
    const media = makeMediaSegmentManifest([segment as MediaSegment]);
    await writeJson(project, 'media-unknown-field.json', media);
    await expect(readMediaSegmentManifest(project, 'media-unknown-field.json')).rejects.toThrow(
      /Unrecognized key|unknownField|strict/,
    );
  });

  it('rejects a media segment manifest count mismatch', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const media: unknown = makeMediaSegmentManifest([segment]);
    (media as { count: number }).count = 2;
    await writeJson(project, 'media-count-mismatch.json', media);
    await expect(readMediaSegmentManifest(project, 'media-count-mismatch.json')).rejects.toThrow(
      /manifest count does not match/,
    );
  });

  it('rejects a media segment manifest excludedCount mismatch', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const media: unknown = makeMediaSegmentManifest([segment]);
    (media as { excludedCount: number }).excludedCount = 1;
    await writeJson(project, 'media-excluded-count-mismatch.json', media);
    await expect(readMediaSegmentManifest(project, 'media-excluded-count-mismatch.json')).rejects.toThrow(
      /excludedCount does not match/,
    );
  });
});

describe('generateAndWriteTranscriptManifest', () => {
  let project: string;
  let inputDir: string;
  let realSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'transcript-manifest-project-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
    realSegment = await makeRealSegment(inputDir, 'clip.mp4');
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('writes a transcript manifest atomically under output/transcripts', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(project, 'output/media-segments/manifest.json', media);
    const sourcePath = await writeJson(project, 'transcript.json', source);
    const beforeSourceSha = sha256Hex(await readFile(sourcePath));

    const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
    });

    expect(outputPath).toBe(resolve(project, 'output', 'transcripts', 'manifest.json'));
    const raw = await readFile(outputPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(manifest);
    expect(parsed.count).toBe(1);
    expect(parsed.utterances[0].text).toBe('Hello');

    // Source unchanged.
    expect(sha256Hex(await readFile(sourcePath))).toBe(beforeSourceSha);
  });

  it('rejects output that aliases the transcript source', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(project, 'output/media-segments/manifest.json', media);
    const sourcePath = await writeJson(project, 'output/transcripts/source.json', source);
    const beforeSourceSha = sha256Hex(await readFile(sourcePath));

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'output/transcripts/source.json',
        outputRel: 'output/transcripts/source.json',
      }),
    ).rejects.toThrow(/same as|Output path is the same as|resolves to the same file/);

    expect(sha256Hex(await readFile(sourcePath))).toBe(beforeSourceSha);
  });

  it('rejects output that is a hard link to the media manifest and preserves both files', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(project, 'output/media-segments/manifest.json', media);
    const sourcePath = await writeJson(project, 'transcript.json', source);
    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'manifest.json');
    await link(mediaPath, outputPath);

    const beforeMediaSha = sha256Hex(await readFile(mediaPath));
    const beforeOutputStat = await stat(outputPath);
    const beforeMediaStat = await stat(mediaPath);
    expect(beforeOutputStat.dev).toBe(beforeMediaStat.dev);
    expect(beforeOutputStat.ino).toBe(beforeMediaStat.ino);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
      }),
    ).rejects.toThrow(/inode/);

    expect(sha256Hex(await readFile(mediaPath))).toBe(beforeMediaSha);
    const afterMediaStat = await stat(mediaPath);
    const afterOutputStat = await stat(outputPath);
    expect(afterMediaStat.dev).toBe(beforeMediaStat.dev);
    expect(afterMediaStat.ino).toBe(beforeMediaStat.ino);
    expect(afterOutputStat.dev).toBe(beforeOutputStat.dev);
    expect(afterOutputStat.ino).toBe(beforeOutputStat.ino);
  });

  it('rejects output that is a symlink to the transcript source and preserves the symlink', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(project, 'output/media-segments/manifest.json', media);
    const sourcePath = await writeJson(project, 'transcript.json', source);
    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'manifest.json');
    await symlink(sourcePath, outputPath);

    const beforeSourceSha = sha256Hex(await readFile(sourcePath));
    const beforeSourceStat = await stat(sourcePath);
    const beforeOutputLstat = await lstat(outputPath);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
      }),
    ).rejects.toThrow(/resolves to the same file/);

    expect(sha256Hex(await readFile(sourcePath))).toBe(beforeSourceSha);
    const afterSourceStat = await stat(sourcePath);
    const afterOutputLstat = await lstat(outputPath);
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);
    expect(afterOutputLstat.isSymbolicLink()).toBe(true);
    expect(afterOutputLstat.dev).toBe(beforeOutputLstat.dev);
    expect(afterOutputLstat.ino).toBe(beforeOutputLstat.ino);
  });

  it('cleans up temp files on failure and keeps the existing foreign final unchanged', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'manifest.json');
    await writeFile(finalPath, '{"existing":true}\n');

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    expect(await readFile(finalPath, 'utf8')).toBe('{"existing":true}\n');
    const entries = await readDir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output through a symlinked output directory and leaves no external files', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'media-segments.json', media);
    await writeJson(project, 'transcript.json', source);

    const outputDir = join(project, 'output');
    const outside = join(project, 'outside');
    await mkdir(outside, { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await symlink(outside, outputDir);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'media-segments.json',
        transcriptSourceRel: 'transcript.json',
      }),
    ).rejects.toThrow(/symbolic link|not a directory|location does not match|Output directory is a symbolic link/);

    expect(await readDir(outside)).toHaveLength(0);
  });

  it('produces identical output files for identical inputs', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const first = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      outputRel: 'transcripts/first.json',
    });
    const firstBytes = await readFile(first.outputPath);

    const second = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      outputRel: 'transcripts/second.json',
    });
    const secondBytes = await readFile(second.outputPath);

    expect(secondBytes.toString()).toBe(firstBytes.toString());
    expect(sha256Hex(secondBytes)).toBe(sha256Hex(firstBytes));
  });
});

describe('writeTranscriptManifest', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'transcript-manifest-write-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects output paths that escape the project root or overlap the input directory', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    await expect(
      writeTranscriptManifest(manifest, project, '../escaped.json', inputDir),
    ).rejects.toThrow(/traversal|not allowed|Invalid output path component/);

    await expect(
      writeTranscriptManifest(manifest, project, 'transcripts/manifest.json', project),
    ).rejects.toThrow(/inside input directory/);
  });

  it('rejects an invalid manifest before writing and leaves no side effects', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const valid = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const finalPath = join(project, 'transcripts', 'manifest.json');
    const foreign = '{"foreign":true}\n';
    await mkdir(join(project, 'transcripts'), { recursive: true });
    await writeFile(finalPath, foreign);

    const countMismatch = { ...valid, count: 99 };
    await expect(writeTranscriptManifest(countMismatch as unknown as typeof valid, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/count does not match/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);

    const unknownField = { ...valid, unknownField: true };
    await expect(writeTranscriptManifest(unknownField as unknown as typeof valid, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/strict|Unrecognized key|unknownField/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);

    const badUtteranceId = JSON.parse(JSON.stringify(valid));
    badUtteranceId.utterances[0].utteranceId = 'not-hex';
    await expect(writeTranscriptManifest(badUtteranceId, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/utteranceId|regex|hex/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);

    const controlText = JSON.parse(JSON.stringify(valid));
    controlText.utterances[0].text = 'Hello\nworld';
    await expect(writeTranscriptManifest(controlText, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/control|NUL|surrogate|oversized/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });

  it('serializes the parsed canonical object regardless of caller property order', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const valid = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    function shuffleKeys<T>(value: T): T {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          return value.map(shuffleKeys) as unknown as T;
        }
        const entries = Object.entries(value as Record<string, unknown>);
        const reversed = [...entries].reverse();
        return Object.fromEntries(reversed.map(([k, v]) => [k, shuffleKeys(v)])) as T;
      }
      return value;
    }

    const shuffled = shuffleKeys(JSON.parse(JSON.stringify(valid)));

    await mkdir(join(project, 'transcripts'), { recursive: true });

    await writeTranscriptManifest(valid, project, 'transcripts/manifest-a.json', inputDir);
    await writeTranscriptManifest(shuffled as typeof valid, project, 'transcripts/manifest-b.json', inputDir);

    const bytesA = await readFile(join(project, 'output', 'transcripts', 'manifest-a.json'));
    const bytesB = await readFile(join(project, 'output', 'transcripts', 'manifest-b.json'));
    expect(bytesB.toString('utf8')).toBe(bytesA.toString('utf8'));
    expect(sha256Hex(bytesB)).toBe(sha256Hex(bytesA));
  });

  it('rejects an arbitrary valid-looking hex utteranceId and leaves the foreign final', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const valid = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const finalPath = join(project, 'transcripts', 'manifest.json');
    await mkdir(join(project, 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    const badId = JSON.parse(JSON.stringify(valid));
    badId.utterances[0].utteranceId = '1'.repeat(64);
    await expect(writeTranscriptManifest(badId, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/utteranceId does not match computed id|computed id/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });

  it('rejects out-of-range utterance timestamps and leaves the foreign final', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const valid = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const finalPath = join(project, 'transcripts', 'manifest.json');
    await mkdir(join(project, 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    const outOfRange = JSON.parse(JSON.stringify(valid));
    outOfRange.utterances[0].end = 99;
    await expect(writeTranscriptManifest(outOfRange, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/utterance timestamps must satisfy|segmentEnd|segmentDuration/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });

  it('rejects an unknown/invalid runtime object and leaves the foreign final', async () => {
    const segment = makeSegment('0'.repeat(64), 'clip.mp4', 5);
    const valid = buildTranscriptManifest({
      mediaSegmentManifest: makeMediaSegmentManifest([segment]),
      mediaSegmentManifestIdentifier: 'media.json',
      mediaSegmentManifestSha256: 'b'.repeat(64),
      transcriptSource: makeTranscriptSource([
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
      transcriptSourceIdentifier: 'source.json',
      transcriptSourceSha256: 'c'.repeat(64),
    });

    const finalPath = join(project, 'transcripts', 'manifest.json');
    await mkdir(join(project, 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    await expect(writeTranscriptManifest({ ...valid, unknownField: true } as typeof valid, project, 'transcripts/manifest.json', inputDir)).rejects.toThrow(/strict|Unrecognized key|unknownField/);
    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });
});

describe('normalizeTranscriptOutputRel', () => {
  it('accepts output/transcripts/<file>.json and transcripts/<file>.json', () => {
    expect(normalizeTranscriptOutputRel('output/transcripts/manifest.json')).toBe('transcripts/manifest.json');
    expect(normalizeTranscriptOutputRel('transcripts/manifest.json')).toBe('transcripts/manifest.json');
    expect(normalizeTranscriptOutputRel('output\\transcripts\\manifest.json')).toBe('transcripts/manifest.json');
  });

  it('rejects paths outside output/transcripts/<file>.json', () => {
    const cases = [
      '',
      '.',
      'output',
      'output/manifest.json',
      'manifest.json',
      'transcripts',
      'transcripts/foo/bar.json',
      'transcripts/foo.txt',
      '../transcripts/manifest.json',
      '/transcripts/manifest.json',
      'C:transcripts/manifest.json',
      '\\\\server\\share\\transcripts\\manifest.json',
      'output//transcripts/manifest.json',
      'output/./transcripts/manifest.json',
      'output/transcripts/manifest.json/',
      'output/transcripts/.json',
    ];
    for (const c of cases) {
      expect(() => normalizeTranscriptOutputRel(c)).toThrow(/transcripts\/|Output path must be|not allowed|traversal|Absolute|Windows|UNC|Null|Invalid output path component|Double separators/);
    }
  });
});

describe('verifySegmentIntegrity / verifyMediaSegmentManifest', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'transcript-manifest-integrity-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('verifies a real video segment and returns resolved path/stat/hash', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    const verified = await verifySegmentIntegrity(segment, inputDir, project);
    expect(verified.assetResolved).toBe(resolve(inputDir, 'clip.mp4'));
    expect(verified.assetSha256).toBe(segment.assetContentId);
    expect(verified.probeDuration).toBe(segment.duration);
  });

  it('rejects a missing asset', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.relativePath = 'missing.mp4';
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/File not found|escaped|not found/);
  });

  it('rejects an asset whose SHA-256 does not match', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.assetContentId = '0'.repeat(64);
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/SHA-256 mismatch|Asset SHA-256 mismatch/);
  });

  it('rejects an asset whose duration does not match', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.duration = 99;
    segment.end = 99;
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/Duration mismatch/);
  });

  it('rejects an asset whose media type does not match', async () => {
    const p = await makeRealMediaFile(inputDir, 'audio.wav', 'audio');
    const duration = await probeDuration(p);
    const assetContentId = await sha256File(p);
    const segmentId = computeSegmentId({
      assetContentId,
      relativePath: 'audio.wav',
      mediaType: 'audio',
      start: 0,
      end: duration,
      duration,
    });
    const segment: MediaSegment = {
      segmentId,
      assetContentId,
      relativePath: 'audio.wav',
      mediaType: 'video',
      start: 0,
      end: duration,
      duration,
    };
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/Media type mismatch/);
  });

  it('rejects an asset whose segment ID does not match', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.segmentId = '0'.repeat(64);
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/Segment ID mismatch/);
  });

  it('rejects a symlinked asset that escapes the input root', async () => {
    const outside = join(project, 'outside.mp4');
    await makeRealMediaFile(resolve(outside, '..'), 'outside.mp4');
    const linkPath = join(inputDir, 'escape.mp4');
    await symlink(outside, linkPath);
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.relativePath = 'escape.mp4';
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/symbolic link|Symbolic link/);
  });

  it('rejects path traversal', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    segment.relativePath = '../outside.mp4';
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/Path escapes|traversal|escaped/);
  });

  it('rejects a symlinked asset inside the input root', async () => {
    const real = await makeRealSegment(inputDir, 'clip.mp4');
    await symlink(join(inputDir, 'clip.mp4'), join(inputDir, 'link.mp4'));
    const segment: MediaSegment = {
      ...real,
      relativePath: 'link.mp4',
      segmentId: computeSegmentId({
        assetContentId: real.assetContentId,
        relativePath: 'link.mp4',
        mediaType: 'video',
        start: 0,
        end: real.duration,
        duration: real.duration,
      }),
    };
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/symbolic link|Symbolic link|not a regular file/);
  });

  it('rejects a non-regular file asset', async () => {
    const segment = await makeRealSegment(inputDir, 'clip.mp4');
    const fakePath = join(inputDir, 'clip.mp4');
    await rm(fakePath, { force: true });
    await mkdir(fakePath, { recursive: true });
    await expect(verifySegmentIntegrity(segment, inputDir, project)).rejects.toThrow(/not a regular file|is not a regular file/);
  });
});

describe('generateAndWriteTranscriptManifest adversarial publish', () => {
  let project: string;
  let inputDir: string;
  let realSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'transcript-manifest-publish-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
    realSegment = await makeRealSegment(inputDir, 'clip.mp4');
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('refuses to overwrite a pre-existing foreign final and leaves it unchanged', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'manifest.json');
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
      }),
    ).rejects.toThrow(/already exists|Output path already exists/);

    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
    const entries = await readDir(outputDir);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('validates maxBytes as a finite positive safe integer', async () => {
    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'foo.json',
        transcriptSourceRel: 'bar.json',
        maxBytes: Infinity,
      }),
    ).rejects.toThrow(/finite positive safe integer/);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'foo.json',
        transcriptSourceRel: 'bar.json',
        maxBytes: 0,
      }),
    ).rejects.toThrow(/finite positive safe integer/);
  });

  it('rejects an input manifest tampered with after the initial read', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: {
          beforeRename: async () => {
            const tampered: unknown = makeMediaSegmentManifest([segment]);
            (tampered as { count: number }).count = 99;
            await writeJson(project, 'output/media-segments/manifest.json', tampered);
          },
        },
      }),
    ).rejects.toThrow(/Media segment manifest.*changed|content changed|manifest count does not match/);

    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects an asset tampered with after the initial read', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: {
          beforeRename: async () => {
            await writeFile(join(inputDir, 'clip.mp4'), 'tampered content');
          },
        },
      }),
    ).rejects.toThrow(/assetContentId mismatch|SHA-256 mismatch|Asset.*changed|content changed/);

    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects a final that is a hard link to the media manifest and leaves no alias', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'manifest.json');
    await link(mediaPath, finalPath);

    const beforeMediaStat = await stat(mediaPath);
    const beforeFinalStat = await stat(finalPath);
    expect(beforeFinalStat.dev).toBe(beforeMediaStat.dev);
    expect(beforeFinalStat.ino).toBe(beforeMediaStat.ino);

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
      }),
    ).rejects.toThrow(/already exists|Output path already exists|same inode|resolves to the same file/);

    const afterFinalStat = await stat(finalPath);
    expect(afterFinalStat.dev).toBe(beforeFinalStat.dev);
    expect(afterFinalStat.ino).toBe(beforeFinalStat.ino);
    const entries = await readDir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('leaves no writable temp alias and does not call afterRename on success', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    let afterRenameCalled = false;
    const { outputPath } = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        afterRename: async () => {
          afterRenameCalled = true;
        },
      },
    });

    expect(afterRenameCalled).toBe(false);
    expect(existsSync(outputPath)).toBe(true);
    const outputDir = dirname(outputPath);
    const entries = await readDir(outputDir);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
    expect(entries).toContain('manifest.json');
  });

  it('rejects a foreign final placed after the barrier and leaves no temp alias', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const outputDir = join(project, 'output', 'transcripts');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'manifest.json');

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: {
          beforeRename: async () => {
            await writeFile(finalPath, '{"foreign":true}\n');
          },
        },
      }),
    ).rejects.toThrow(/already exists|Output path already exists/);

    expect(existsSync(finalPath)).toBe(true);
    expect(await readFile(finalPath, 'utf8')).toBe('{"foreign":true}\n');
    const entries = await readDir(outputDir);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects the media manifest modified after the barrier passes', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'signal');
    await writeFile(signalPath, '');

    const promise = generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        stallBeforeFinalLink: signalPath,
      },
    });

    const ackPath = signalPath + '.ack';
    while (!existsSync(ackPath)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const tampered: unknown = makeMediaSegmentManifest([segment]);
    (tampered as { count: number }).count = 99;
    await writeJson(project, 'output/media-segments/manifest.json', tampered);

    await rm(signalPath);

    await expect(promise).rejects.toThrow(/Media segment manifest.*changed|content changed/);
    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects an asset modified after the barrier passes', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'signal');
    await writeFile(signalPath, '');

    const promise = generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        stallBeforeFinalLink: signalPath,
      },
    });

    const ackPath = signalPath + '.ack';
    while (!existsSync(ackPath)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await writeFile(join(inputDir, 'clip.mp4'), 'tampered content');

    await rm(signalPath);

    await expect(promise).rejects.toThrow(/Asset.*changed|content changed/);
    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('recovers from a post-link helper failure and keeps the committed final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: { postLinkFail: true } satisfies PublishAtomicTestHooks,
    });

    const expected = JSON.stringify(manifest, null, 2) + '\n';
    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toBe(expected);
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('recovers from post-link malformed output and keeps the committed final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: { postLinkMalformed: true } satisfies PublishAtomicTestHooks,
    });

    const expected = JSON.stringify(manifest, null, 2) + '\n';
    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toBe(expected);
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects a foreign replacement after the link and leaves the foreign final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { postLinkForeignReplace: true } satisfies PublishAtomicTestHooks,
      }),
    ).rejects.toThrow();

    expect(existsSync(finalPath)).toBe(true);
    expect(await readFile(finalPath, 'utf8')).toBe('foreign replacement');
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects a same-bytes inode replacement and leaves the replacement final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const mediaRead = await readMediaSegmentManifest(project, 'output/media-segments/manifest.json');
    const sourceRead = await readTranscriptSource(project, 'transcript.json');
    const expectedManifest = buildTranscriptManifest({
      mediaSegmentManifest: mediaRead.manifest,
      mediaSegmentManifestIdentifier: mediaRead.identifier,
      mediaSegmentManifestSha256: mediaRead.sha256,
      transcriptSource: sourceRead.source,
      transcriptSourceIdentifier: sourceRead.identifier,
      transcriptSourceSha256: sourceRead.sha256,
    });
    const expected = JSON.stringify(expectedManifest, null, 2) + '\n';

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { postLinkReplaceSameBytes: true } satisfies PublishAtomicTestHooks,
      }),
    ).rejects.toThrow();

    expect(existsSync(finalPath)).toBe(true);
    expect(await readFile(finalPath, 'utf8')).toBe(expected);
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects a grown final and leaves the corrupted own final unchanged', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const mediaRead = await readMediaSegmentManifest(project, 'output/media-segments/manifest.json');
    const sourceRead = await readTranscriptSource(project, 'transcript.json');
    const expectedManifest = buildTranscriptManifest({
      mediaSegmentManifest: mediaRead.manifest,
      mediaSegmentManifestIdentifier: mediaRead.identifier,
      mediaSegmentManifestSha256: mediaRead.sha256,
      transcriptSource: sourceRead.source,
      transcriptSourceIdentifier: sourceRead.identifier,
      transcriptSourceSha256: sourceRead.sha256,
    });
    const expected = JSON.stringify(expectedManifest, null, 2) + '\n';

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { postLinkGrow: true } satisfies PublishAtomicTestHooks,
      }),
    ).rejects.toThrow();

    expect(existsSync(finalPath)).toBe(true);
    expect(await readFile(finalPath, 'utf8')).toBe(expected + 'extra');
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('leaves a foreign final injected after verify at the same pathname', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    const transcriptPath = join(project, 'transcript.json');
    const transcriptBefore = await readFile(transcriptPath);
    let foreignIno: number | null = null;

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: {
          postLinkFail: true,
          afterVerify: async (path, verified) => {
            if (verified.ok) {
              await rm(path, { force: true });
              await writeFile(path, 'foreign final');
              foreignIno = (await lstat(path)).ino;
            }
          },
        } satisfies PublishAtomicTestHooks,
      }),
    ).rejects.toThrow();

    expect(existsSync(finalPath)).toBe(true);
    expect(await readFile(finalPath, 'utf8')).toBe('foreign final');
    const finalStat = await lstat(finalPath);
    expect(finalStat.ino).toBe(foreignIno);
    expect(await readFile(transcriptPath)).toEqual(transcriptBefore);

    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.startsWith('.cleanup-'))).toHaveLength(0);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('recovers from a post-link helper timeout and keeps the committed final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'post-link-stall');
    await writeFile(signalPath, '');

    const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        postLinkStall: signalPath,
        publishHelperTimeoutMs: 100,
      } satisfies PublishAtomicTestHooks,
    });

    const expected = JSON.stringify(manifest, null, 2) + '\n';
    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toBe(expected);
    const entries = await readDir(join(project, 'output', 'transcripts'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
  }, 10_000);

  it('rejects a leaf file replaced under the same name before the final link', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'leaf-replace');
    await writeFile(signalPath, '');

    const promise = generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        stallBeforeFinalLink: signalPath,
      },
    });

    const ackPath = signalPath + '.ack';
    while (!existsSync(ackPath)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const transcriptPath = join(project, 'transcript.json');
    await rm(transcriptPath);
    await writeFile(transcriptPath, JSON.stringify({ schemaVersion: 'v1', entries: [] }) + '\n');
    await rm(signalPath);

    await expect(promise).rejects.toThrow(/INPUT_CHANGED|changed at commit|stat mismatch|path identity changed|realpath mismatch/);
    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects a symlink replacement of an input leaf before the final link', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'symlink-replace');
    await writeFile(signalPath, '');

    const promise = generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        stallBeforeFinalLink: signalPath,
      },
    });

    const ackPath = signalPath + '.ack';
    while (!existsSync(ackPath)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const transcriptPath = join(project, 'transcript.json');
    await rm(transcriptPath);
    await symlink(join(project, 'output', 'media-segments', 'manifest.json'), transcriptPath);
    await rm(signalPath);

    await expect(promise).rejects.toThrow(/INPUT_CHANGED|changed at commit|stat mismatch|path identity changed|realpath mismatch|symbolic link/);
    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects a parent directory replacement with a hard-linked leaf before the final link', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const signalPath = join(project, 'parent-replace');
    await writeFile(signalPath, '');

    const promise = generateAndWriteTranscriptManifest({
      projectRoot: project,
      inputRoot: inputDir,
      mediaSegmentManifestRel: 'output/media-segments/manifest.json',
      transcriptSourceRel: 'transcript.json',
      __testHooks: {
        stallBeforeFinalLink: signalPath,
      },
    });

    const ackPath = signalPath + '.ack';
    while (!existsSync(ackPath)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const originalParent = join(project, 'output', 'media-segments');
    const newParent = join(project, 'output', 'media-segments-new');
    const originalManifest = join(originalParent, 'manifest.json');
    const newManifest = join(newParent, 'manifest.json');

    await mkdir(newParent, { recursive: true });
    await link(originalManifest, newManifest);
    await rename(originalParent, join(project, 'output', 'media-segments-old'));
    await rename(newParent, originalParent);
    await rm(signalPath);

    await expect(promise).rejects.toThrow(/INPUT_CHANGED|changed at commit|stat mismatch|realpath mismatch|directory changed/);
    expect(existsSync(join(project, 'output', 'transcripts', 'manifest.json'))).toBe(false);
  });

  it('rejects a same-bytes media manifest replacement before snapshot and leaves the foreign final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await mkdir(join(project, 'output', 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    const mediaPath = join(project, 'output', 'media-segments', 'manifest.json');
    const beforeInputSnapshot: PublishAtomicTestHooks['beforeInputSnapshot'] = async (label) => {
      if (label !== 'Media segment manifest') return;
      const bytes = await readFile(mediaPath);
      const tmp = `${mediaPath}.tmp`;
      await writeFile(tmp, bytes);
      await rm(mediaPath);
      await rename(tmp, mediaPath);
    };

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { beforeInputSnapshot },
      }),
    ).rejects.toThrow(/identity changed before snapshot|INPUT_CHANGED/);

    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });

  it('rejects a same-bytes transcript source replacement before snapshot and leaves the foreign final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await mkdir(join(project, 'output', 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    const sourcePath = join(project, 'transcript.json');
    const beforeInputSnapshot: PublishAtomicTestHooks['beforeInputSnapshot'] = async (label) => {
      if (label !== 'Transcript source') return;
      const bytes = await readFile(sourcePath);
      const tmp = `${sourcePath}.tmp`;
      await writeFile(tmp, bytes);
      await rm(sourcePath);
      await rename(tmp, sourcePath);
    };

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { beforeInputSnapshot },
      }),
    ).rejects.toThrow(/identity changed before snapshot|INPUT_CHANGED/);

    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });

  it('rejects a same-bytes asset replacement before snapshot and leaves the foreign final', async () => {
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello' },
    ]);

    await writeJson(project, 'output/media-segments/manifest.json', media);
    await writeJson(project, 'transcript.json', source);

    const finalPath = join(project, 'output', 'transcripts', 'manifest.json');
    await mkdir(join(project, 'output', 'transcripts'), { recursive: true });
    const foreign = '{"foreign":true}\n';
    await writeFile(finalPath, foreign);

    const assetPath = join(inputDir, 'clip.mp4');
    const beforeInputSnapshot: PublishAtomicTestHooks['beforeInputSnapshot'] = async (label) => {
      if (label !== `Asset ${segment.relativePath}`) return;
      const bytes = await readFile(assetPath);
      const tmp = `${assetPath}.tmp`;
      await writeFile(tmp, bytes);
      await rm(assetPath);
      await rename(tmp, assetPath);
    };

    await expect(
      generateAndWriteTranscriptManifest({
        projectRoot: project,
        inputRoot: inputDir,
        mediaSegmentManifestRel: 'output/media-segments/manifest.json',
        transcriptSourceRel: 'transcript.json',
        __testHooks: { beforeInputSnapshot },
      }),
    ).rejects.toThrow(/identity changed before snapshot|INPUT_CHANGED/);

    expect(await readFile(finalPath, 'utf8')).toBe(foreign);
  });
});

// Helper used by tests that read directories; typed to avoid vitest global issues.
async function readDir(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(dir);
}
