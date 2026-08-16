import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from '../src/core.js';
import { computeSegmentId, type MediaSegment } from '../src/media-segments.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = resolve(root, 'node_modules', '.bin', 'tsx');
const outputRel = 'transcripts/cli-test.json';
const outputPath = resolve(root, 'output', outputRel);

function makeSegment(segmentId: string, relativePath: string, duration: number) {
  return {
    segmentId,
    assetContentId: 'a'.repeat(64),
    relativePath,
    mediaType: 'video' as const,
    start: 0,
    end: duration,
    duration,
  };
}

async function makeRealMediaFile(dir: string, name = 'clip.mp4'): Promise<string> {
  const p = join(dir, name);
  await mkdir(resolve(p, '..'), { recursive: true });
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

function makeMediaSegmentManifest(segments: MediaSegment[]) {
  return {
    schemaVersion: 'v1' as const,
    count: segments.length,
    excludedCount: 0,
    excluded: [] as { relativePath: string; reason: string }[],
    segments,
  };
}

function makeTranscriptSource(
  entries: { segmentId: string; start: number; end: number; text: string; speaker?: string; confidence?: number }[],
) {
  return { schemaVersion: 'v1' as const, entries };
}

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await mkdir(resolve(p, '..'), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

describe('transcript-manifest-cli', () => {
  let tmpBase: string;
  let realSegment: MediaSegment;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(root, 'tests', 'transcript-manifest-cli-'));
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    realSegment = await makeRealSegment(inputDir, 'clip.mp4');
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
    await rm(outputPath, { force: true });
  });

  it('loads valid manifests and writes a transcript manifest', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: 'Hello from CLI' },
    ]);

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', source);

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    const { stdout } = await execFileAsync(tsx, [
      'src/transcript-manifest-cli.ts',
      relMedia,
      relSource,
      inputDir,
      outputRel,
    ]);

    expect(stdout).toContain('Transcript manifest written to');
    expect(stdout).toContain('(1 utterances)');

    const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(parsed.schemaVersion).toBe('v1');
    expect(parsed.count).toBe(1);
    expect(parsed.utterances[0].text).toBe('Hello from CLI');
  });

  it('rejects malformed transcript source JSON', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = join(tmpBase, 'transcript.json');
    await writeFile(sourcePath, 'not json');

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/transcript-manifest-cli.ts',
        relMedia,
        relSource,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/valid JSON|JSON/);
  });

  it('rejects an unknown segment ID', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: '1'.repeat(64), start: 0, end: 2, text: 'Hello' },
    ]);

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', source);

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/transcript-manifest-cli.ts',
        relMedia,
        relSource,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/Unknown segment ID/);
  });

  it('exits with usage when arguments are missing', async () => {
    await expect(
      execFileAsync(tsx, ['src/transcript-manifest-cli.ts']),
    ).rejects.toThrow(/Usage|exit code 1/);
  });

  it('rejects an unknown exclusion reason in the media segment manifest', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media: unknown = makeMediaSegmentManifest([segment]);
    (media as { excluded: { relativePath: string; reason: string }[] }).excluded.push({
      relativePath: 'bad.mp4',
      reason: 'UNKNOWN_REASON',
    });

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', makeTranscriptSource([]));

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/transcript-manifest-cli.ts',
        relMedia,
        relSource,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/UNKNOWN_REASON|Invalid enum value/);
  });

  it('rejects unknown nested fields in the media segment manifest', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment: unknown = realSegment;
    (segment as { unknownField: string }).unknownField = 'x';
    const media = makeMediaSegmentManifest([segment as MediaSegment]);

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', makeTranscriptSource([]));

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/transcript-manifest-cli.ts',
        relMedia,
        relSource,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/Unrecognized key|unknownField|strict/);
  });

  it('accepts emoji and non-BMP Unicode in transcript text and speaker', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media = makeMediaSegmentManifest([segment]);
    const source = makeTranscriptSource([
      { segmentId: segment.segmentId, start: 0, end: 2, text: '\u{1F44B}\u{1F600}', speaker: '\u{1F9D1}\u{1F3FB}' },
    ]);

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', source);

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    const { stdout } = await execFileAsync(tsx, [
      'src/transcript-manifest-cli.ts',
      relMedia,
      relSource,
      inputDir,
      outputRel,
    ]);

    expect(stdout).toContain('Transcript manifest written to');

    const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(parsed.utterances[0].text).toBe('\u{1F44B}\u{1F600}');
    expect(parsed.utterances[0].speaker).toBe('\u{1F9D1}\u{1F3FB}');
  });

  it('rejects a media segment manifest count mismatch', async () => {
    const inputDir = join(tmpBase, 'input');
    const segment = realSegment;
    const media: unknown = makeMediaSegmentManifest([segment]);
    (media as { count: number }).count = 2;

    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const sourcePath = await writeJson(tmpBase, 'transcript.json', makeTranscriptSource([]));

    const relMedia = relative(root, mediaPath).replace(/\\/g, '/');
    const relSource = relative(root, sourcePath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/transcript-manifest-cli.ts',
        relMedia,
        relSource,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/manifest count does not match/);
  });
});
