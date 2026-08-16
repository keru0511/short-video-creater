import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildTranscriptManifest } from '../src/transcript-manifest.js';
import { prepareFonts } from '../src/fixtures.js';
import { computeSegmentId, type MediaSegment } from '../src/media-segments.js';
import { sha256File } from '../src/core.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = resolve(root, 'node_modules', '.bin', 'tsx');
const cli = resolve(root, 'src', 'transcript-subtitle-timeline-cli.ts');
const outputRel = 'timelines/subtitled.json';
const outputPath = resolve(root, 'output', outputRel);

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function createVideo(filePath: string, duration = 5): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=320x240:d=${duration}`,
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-t',
    String(duration),
    filePath,
  ]);
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    filePath,
  ]);
  const num = Number(stdout.trim());
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Could not probe duration for ${filePath}`);
  }
  return num;
}

async function makeRealSegment(inputDir: string, name = 'clip.mp4'): Promise<MediaSegment> {
  const p = join(inputDir, name);
  await createVideo(p);
  const duration = await probeDuration(p);
  const relativePath = name;
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

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

describe('transcript-subtitle-timeline-cli', () => {
  let tmpBase: string;
  let currentTmp: string | undefined;
  let inputDir: string;
  let fontsDir: string;
  let realSegment: MediaSegment;

  beforeAll(async () => {
    await prepareFonts(root);
  });

  beforeEach(async () => {
    await rm(outputPath, { force: true });
    tmpBase = await mkdtemp(join(root, 'tests', 'transcript-subtitle-timeline-cli-'));
    currentTmp = tmpBase;
    inputDir = join(tmpBase, 'input');
    fontsDir = join(tmpBase, 'fonts');
    await mkdir(inputDir, { recursive: true });
    await mkdir(fontsDir, { recursive: true });
    await copyFile(join(root, 'fonts', 'DejaVuSans.ttf'), join(fontsDir, 'DejaVuSans.ttf'));
    realSegment = await makeRealSegment(inputDir);
  });

  afterEach(async () => {
    if (currentTmp) {
      await rm(currentTmp, { recursive: true, force: true });
      currentTmp = undefined;
    }
    await rm(outputPath, { force: true });
  });

  async function prepareInputs(): Promise<{
    relMedia: string;
    relSelection: string;
    relManifest: string;
    relStyle: string;
  }> {
    const media = {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [realSegment],
    };
    const mediaPath = await writeJson(tmpBase, 'media-segments.json', media);
    const mediaSha = await sha256File(mediaPath);

    const source = {
      schemaVersion: 'v1' as const,
      entries: [
        { segmentId: realSegment.segmentId, start: 0.5, end: 2, text: 'Hello' },
        { segmentId: realSegment.segmentId, start: 2, end: 4, text: 'world' },
      ],
    };
    const sourcePath = await writeJson(tmpBase, 'transcript-source.json', source);

    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: media,
      mediaSegmentManifestIdentifier: relative(root, mediaPath).replace(/\\/g, '/'),
      mediaSegmentManifestSha256: mediaSha,
      transcriptSource: source,
      transcriptSourceIdentifier: relative(root, sourcePath).replace(/\\/g, '/'),
      transcriptSourceSha256: sha256Hex(JSON.stringify(source)),
    });
    const manifestPath = await writeJson(tmpBase, 'output/transcripts/manifest.json', manifest);

    const selectionPath = await writeJson(tmpBase, 'selection.json', {
      segmentIds: [realSegment.segmentId],
    });

    const fontHash = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));
    const stylePath = await writeJson(tmpBase, 'style.json', {
      font: 'DejaVuSans.ttf',
      fontHash,
      x: 540,
      y: 1500,
      fontSize: 100,
    });

    return {
      relMedia: relative(root, mediaPath).replace(/\\/g, '/'),
      relSelection: relative(root, selectionPath).replace(/\\/g, '/'),
      relManifest: relative(root, manifestPath).replace(/\\/g, '/'),
      relStyle: relative(root, stylePath).replace(/\\/g, '/'),
    };
  }

  it('writes a deterministic subtitle Timeline JSON', async () => {
    const { relMedia, relSelection, relManifest, relStyle } = await prepareInputs();

    const { stdout } = await execFileAsync(tsx, [
      cli,
      relMedia,
      relSelection,
      relManifest,
      relStyle,
      inputDir,
      outputRel,
    ]);

    expect(stdout).toMatch(/Subtitle Timeline JSON written to/);
    expect(stdout).toMatch(/Timeline SHA-256:/);

    expect(existsSync(outputPath)).toBe(true);
    const timeline = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(timeline.width).toBe(1080);
    expect(timeline.height).toBe(1920);
    expect(timeline.subtitles).toHaveLength(2);
    expect(timeline.subtitles[0].text).toBe('Hello');
    expect(timeline.subtitles[1].text).toBe('world');
  });

  it('exits with an error on insufficient arguments', async () => {
    await expect(execFileAsync(tsx, [cli, 'a.json', 'b.json', 'c.json'])).rejects.toThrow();
  });

  it('exits with an error on extra arguments', async () => {
    await expect(
      execFileAsync(tsx, [cli, 'a.json', 'b.json', 'c.json', 'd.json', 'input', 'out.json', 'extra']),
    ).rejects.toThrow();
  });

  it('refuses to overwrite an existing output', async () => {
    const { relMedia, relSelection, relManifest, relStyle } = await prepareInputs();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, '{"foreign":true}\n');

    await expect(
      execFileAsync(tsx, [
        cli,
        relMedia,
        relSelection,
        relManifest,
        relStyle,
        inputDir,
        outputRel,
      ]),
    ).rejects.toThrow(/already exists|Output path already exists|foreign/);

    expect(await readFile(outputPath, 'utf8')).toBe('{"foreign":true}\n');
  });
});
