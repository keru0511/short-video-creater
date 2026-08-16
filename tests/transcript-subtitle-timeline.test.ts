import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildTranscriptManifest, computeUtteranceId, type PublishAtomicTestHooks } from '../src/transcript-manifest.js';
import {
  generateFixtures,
  prepareFonts,
  safeReadFinalOutput,
} from '../src/fixtures.js';
import { computeSegmentId, type MediaSegment } from '../src/media-segments.js';
import { generate, ffprobe, sha256File } from '../src/core.js';
import {
  generateAndWriteSubtitleTimeline,
  type SubtitleTimelineTestHooks,
} from '../src/transcript-subtitle-timeline.js';
import { validateCues } from '../src/subtitles.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Project {
  root: string;
  inputDir: string;
  outputDir: string;
  fontsDir: string;
  fontPath: string;
  fontHash: string;
}

async function createVideo(filePath: string, color = 'black', duration = 5): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x240:d=${duration}`,
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

async function makeRealSegment(inputDir: string, name = 'clip.mp4', color = 'black'): Promise<MediaSegment> {
  const p = join(inputDir, name);
  await createVideo(p, color);
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

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  const p = join(dir, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
}

async function setupProject(): Promise<Project> {
  const tmp = await mkdtemp(join(root, 'tmp-tst-'));
  const inputDir = join(tmp, 'input');
  const outputDir = join(tmp, 'output');
  const fontsDir = join(tmp, 'fonts');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  const srcFont = join(root, 'fonts', 'DejaVuSans.ttf');
  const fontPath = join(fontsDir, 'DejaVuSans.ttf');
  await copyFile(srcFont, fontPath);
  const fontHash = await sha256File(fontPath);

  return { root: tmp, inputDir, outputDir, fontsDir, fontPath, fontHash };
}

function makeStyle(fontHash: string): Record<string, unknown> {
  return {
    font: 'DejaVuSans.ttf',
    fontHash,
    x: 540,
    y: 1500,
    fontSize: 100,
  };
}

function makeSelection(segmentIds: string[]): unknown {
  return { segmentIds };
}

async function buildTranscriptManifestFile(
  project: Project,
  segments: MediaSegment[],
  sourceEntries: { segmentId: string; start: number; end: number; text: string; speaker?: string; confidence?: number }[],
): Promise<{ manifestRel: string; manifestPath: string; manifestSha: string }> {
  const media = {
    schemaVersion: 'v1' as const,
    count: segments.length,
    excludedCount: 0,
    excluded: [],
    segments,
  };
  const mediaPath = join(project.root, 'input', 'media-segments.json');
  await writeJson(project.root, 'input/media-segments.json', media);
  const mediaSha = await sha256File(mediaPath);

  const source = {
    schemaVersion: 'v1' as const,
    entries: sourceEntries,
  };
  const sourcePath = join(project.root, 'input', 'transcript-source.json');
  await writeJson(project.root, 'input/transcript-source.json', source);

  const manifest = buildTranscriptManifest({
    mediaSegmentManifest: media,
    mediaSegmentManifestIdentifier: 'input/media-segments.json',
    mediaSegmentManifestSha256: mediaSha,
    transcriptSource: source,
    transcriptSourceIdentifier: 'input/transcript-source.json',
    transcriptSourceSha256: sha256Hex(JSON.stringify(source)),
  });

  const manifestPath = join(project.root, 'output', 'transcripts', 'manifest.json');
  await writeJson(project.root, 'output/transcripts/manifest.json', manifest);
  const manifestSha = await sha256File(manifestPath);
  return { manifestRel: 'output/transcripts/manifest.json', manifestPath, manifestSha };
}

async function runGenerate(
  project: Project,
  segments: MediaSegment[],
  selectionIds: string[],
  sourceEntries: { segmentId: string; start: number; end: number; text: string; speaker?: string; confidence?: number }[],
  outputRel = 'timelines/subtitled.json',
  __testHooks?: SubtitleTimelineTestHooks,
): Promise<ReturnType<typeof generateAndWriteSubtitleTimeline>> {
  const media = {
    schemaVersion: 'v1' as const,
    count: segments.length,
    excludedCount: 0,
    excluded: [],
    segments,
  };
  await writeJson(project.root, 'input/media-segments.json', media);

  const { manifestRel } = await buildTranscriptManifestFile(project, segments, sourceEntries);

  await writeJson(project.root, 'input/selection.json', makeSelection(selectionIds));
  await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

  return generateAndWriteSubtitleTimeline({
    projectRoot: project.root,
    inputRoot: project.inputDir,
    mediaManifestRel: 'input/media-segments.json',
    selectionRel: 'input/selection.json',
    transcriptManifestRel: manifestRel,
    styleRel: 'input/style.json',
    outputRel,
    fontsDir: project.fontsDir,
    __testHooks,
  });
}

describe('generateAndWriteSubtitleTimeline', () => {
  let project: Project;
  let currentTmp: string | undefined;

  beforeAll(async () => {
    await prepareFonts(root);
  });

  beforeEach(async () => {
    project = await setupProject();
    currentTmp = project.root;
  });

  afterEach(async () => {
    if (currentTmp) {
      await rm(currentTmp, { recursive: true, force: true });
      currentTmp = undefined;
    }
  });

  it('generates a renderer-compatible Timeline with absolute subtitle cue times', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const result = await runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0.5, end: 2, text: 'Hello' },
      { segmentId: segment.segmentId, start: 2, end: 4, text: 'world' },
    ]);

    expect(result.timeline.width).toBe(1080);
    expect(result.timeline.height).toBe(1920);
    expect(result.timeline.fps).toBe(30);
    expect(result.timeline.clips).toHaveLength(1);
    expect(result.timeline.clips[0].type).toBe('video');
    expect(result.timeline.subtitles).toHaveLength(2);
    expect(result.timeline.subtitles?.[0]).toMatchObject({
      start: 0.5,
      end: 2,
      text: 'Hello',
      x: 540,
      y: 1500,
      fontSize: 100,
      fontColor: '#FFFFFF',
      fontAlpha: 1,
      borderWidth: 0,
      borderColor: '#000000',
      box: false,
      boxColor: '#000000',
      boxAlpha: 0.5,
      align: 'left',
    });
    expect(result.timeline.subtitles?.[1]).toMatchObject({
      start: 2,
      end: 4,
      text: 'world',
      x: 540,
      y: 1500,
      fontSize: 100,
      fontColor: '#FFFFFF',
      fontAlpha: 1,
      borderWidth: 0,
      borderColor: '#000000',
      box: false,
      boxColor: '#000000',
      boxAlpha: 0.5,
      align: 'left',
    });
    expect(result.timeline.font).toBe('DejaVuSans.ttf');
    expect(result.timeline.fontHash).toBe(project.fontHash);
    expect(result.timeline.outputPath).toBe('timelines/subtitled.mp4');
    expect(existsSync(result.outputPath)).toBe(true);

    const content = await readFile(result.outputPath, 'utf8');
    expect(content).toContain('"text": "Hello"');
    expect(await sha256File(result.outputPath)).toBe(result.timelineSha256);
  });

  it('produces identical JSON and SHA-256 for identical inputs', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const source = [
      { segmentId: segment.segmentId, start: 0.5, end: 2, text: 'Hello' },
    ];

    const first = await runGenerate(project, [segment], [segment.segmentId], source);

    // Remove the first output and regenerate at the same path.
    await rm(first.outputPath, { force: true });
    const second = await runGenerate(project, [segment], [segment.segmentId], source);

    expect(first.timelineSha256).toBe(second.timelineSha256);
    expect(JSON.stringify(first.timeline)).toBe(JSON.stringify(second.timeline));
  });

  it('computes absolute cue times across multiple selected segments in selection order', async () => {
    const segA = await makeRealSegment(project.inputDir, 'a.mp4', 'black');
    const segB = await makeRealSegment(project.inputDir, 'b.mp4', 'red');
    const result = await runGenerate(
      project,
      [segA, segB],
      [segA.segmentId, segB.segmentId],
      [
        { segmentId: segA.segmentId, start: 0, end: 1, text: 'A' },
        { segmentId: segB.segmentId, start: 1, end: 2, text: 'B' },
      ],
    );

    expect(result.timeline.clips).toHaveLength(2);
    expect(result.timeline.clips[0].start).toBe(0);
    expect(result.timeline.clips[1].start).toBe(segA.duration);
    expect(result.timeline.subtitles).toHaveLength(2);
    expect(result.timeline.subtitles?.[0]).toMatchObject({ start: 0, end: 1, text: 'A' });
    expect(result.timeline.subtitles?.[1]).toMatchObject({
      start: segA.duration + 1,
      end: segA.duration + 2,
      text: 'B',
    });
  });

  it('keeps a clip when a selected segment has no utterances', async () => {
    const segA = await makeRealSegment(project.inputDir, 'a.mp4');
    const segB = await makeRealSegment(project.inputDir, 'b.mp4');
    const result = await runGenerate(
      project,
      [segA, segB],
      [segA.segmentId, segB.segmentId],
      [{ segmentId: segA.segmentId, start: 0, end: 1, text: 'Only A' }],
    );

    expect(result.timeline.clips).toHaveLength(2);
    expect(result.timeline.subtitles).toHaveLength(1);
    expect(result.timeline.subtitles?.[0].text).toBe('Only A');
  });

  it('does not output utterances from unselected segments', async () => {
    const segA = await makeRealSegment(project.inputDir, 'a.mp4');
    const segB = await makeRealSegment(project.inputDir, 'b.mp4');
    const result = await runGenerate(
      project,
      [segA, segB],
      [segA.segmentId],
      [
        { segmentId: segA.segmentId, start: 0, end: 1, text: 'A' },
        { segmentId: segB.segmentId, start: 0, end: 1, text: 'B' },
      ],
    );

    expect(result.timeline.clips).toHaveLength(1);
    expect(result.timeline.subtitles).toHaveLength(1);
    expect(result.timeline.subtitles?.[0].text).toBe('A');
  });

  it('rejects a transcript manifest whose media identifier does not match', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const media = {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [segment],
    };
    await writeJson(project.root, 'input/media-segments.json', media);
    const mediaSha = await sha256File(join(project.root, 'input', 'media-segments.json'));

    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: media,
      mediaSegmentManifestIdentifier: 'input/media-segments.json',
      mediaSegmentManifestSha256: mediaSha,
      transcriptSource: {
        schemaVersion: 'v1' as const,
        entries: [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
      },
      transcriptSourceIdentifier: 'input/transcript-source.json',
      transcriptSourceSha256: 'a'.repeat(64),
    });
    manifest.mediaSegmentManifest.identifier = 'input/other.json';
    await writeJson(project.root, 'output/transcripts/manifest.json', manifest);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/identifier mismatch/);
  });

  it('rejects a transcript manifest whose media SHA-256 does not match', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const media = {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [segment],
    };
    await writeJson(project.root, 'input/media-segments.json', media);
    const mediaSha = await sha256File(join(project.root, 'input', 'media-segments.json'));

    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: media,
      mediaSegmentManifestIdentifier: 'input/media-segments.json',
      mediaSegmentManifestSha256: mediaSha,
      transcriptSource: {
        schemaVersion: 'v1' as const,
        entries: [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
      },
      transcriptSourceIdentifier: 'input/transcript-source.json',
      transcriptSourceSha256: 'a'.repeat(64),
    });
    manifest.mediaSegmentManifest.sha256 = '0'.repeat(64);
    await writeJson(project.root, 'output/transcripts/manifest.json', manifest);

    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('rejects a mismatched utterance ID', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    const manifestPath = join(project.root, manifestRel);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.utterances[0].utteranceId = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/utteranceId|Utterance ID mismatch/);
  });

  it('rejects an unknown segment ID in the transcript', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    const manifestPath = join(project.root, manifestRel);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const u = manifest.utterances[0];
    u.segmentId = '0'.repeat(64);
    u.utteranceId = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: u.segmentId,
      start: u.start,
      end: u.end,
      text: u.text,
      speaker: u.speaker ?? null,
      confidence: u.confidence ?? null,
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/Unknown segment ID/);
  });

  it('rejects a transcript utterance whose timestamps exceed the segment range', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const media = {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [segment],
    };
    await writeJson(project.root, 'input/media-segments.json', media);
    const mediaSha = await sha256File(join(project.root, 'input', 'media-segments.json'));

    // Build a valid-looking utterance whose end exceeds the segment end.
    const badUtteranceId = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: segment.segmentId,
      start: 0,
      end: segment.duration + 1,
      text: 'A',
      speaker: null,
      confidence: null,
    });
    const manifest = {
      schemaVersion: 'v1' as const,
      sourceManifest: { identifier: 'input/transcript-source.json', sha256: 'a'.repeat(64) },
      mediaSegmentManifest: { identifier: 'input/media-segments.json', sha256: mediaSha },
      count: 1,
      utterances: [
        {
          utteranceId: badUtteranceId,
          segmentId: segment.segmentId,
          assetContentId: segment.assetContentId,
          relativePath: segment.relativePath,
          segmentStart: segment.start,
          segmentEnd: segment.end,
          segmentDuration: segment.duration,
          start: 0,
          end: segment.duration + 1,
          text: 'A',
        },
      ],
    };
    await writeJson(project.root, 'output/transcripts/manifest.json', manifest);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/segmentStart|segmentEnd|timestamps out of segment range/);
  });

  it('rejects a selection containing a non-video segment', async () => {
    const segment = await makeRealSegment(project.inputDir, 'clip.mp4', 'black');
    const audioSegment: MediaSegment = {
      ...segment,
      mediaType: 'audio',
    };
    const media = {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [audioSegment],
    };
    await writeJson(project.root, 'input/media-segments.json', media);
    const mediaSha = await sha256File(join(project.root, 'input', 'media-segments.json'));

    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: media,
      mediaSegmentManifestIdentifier: 'input/media-segments.json',
      mediaSegmentManifestSha256: mediaSha,
      transcriptSource: { schemaVersion: 'v1' as const, entries: [] },
      transcriptSourceIdentifier: 'input/transcript-source.json',
      transcriptSourceSha256: 'a'.repeat(64),
    });
    await writeJson(project.root, 'output/transcripts/manifest.json', manifest);
    await writeJson(project.root, 'input/selection.json', makeSelection([audioSegment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/not a video segment/);
  });

  it('rejects a style with an invalid font hash', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await writeJson(project.root, 'input/style.json', {
      ...makeStyle(project.fontHash),
      fontHash: '0'.repeat(64),
    });
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/font.*hash|SHA-256|mismatch/);
  });

  it('rejects a style with a non-ttf/non-otf font', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await writeFile(join(project.fontsDir, 'ComicSans.png'), 'not a font');
    await writeJson(project.root, 'input/style.json', {
      font: 'ComicSans.png',
      fontHash: await sha256File(join(project.fontsDir, 'ComicSans.png')),
      x: 540,
      y: 1500,
      fontSize: 100,
    });
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/\.ttf|\.otf|font/);
  });

  it('rejects more than the maximum allowed subtitle cues', async () => {
    const segment = await makeRealSegment(project.inputDir, 'long.mp4', 'black');
    const entries: { segmentId: string; start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const start = i * 0.1;
      const end = start + 0.05;
      entries.push({ segmentId: segment.segmentId, start, end, text: `u${i}` });
    }
    const result = runGenerate(project, [segment], [segment.segmentId], entries);
    await expect(result).rejects.toThrow(/Too many subtitle cues/);
  });

  it('rejects cue text exceeding the maximum length', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const longText = 'a'.repeat(101);
    const result = runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: longText },
    ]);
    await expect(result).rejects.toThrow(/100|max|text/);
  });

  it('rejects a duplicate key in the subtitle style JSON', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeFile(
      join(project.root, 'input', 'style.json'),
      `{\n  "font": "DejaVuSans.ttf",\n  "fontHash": "${project.fontHash}",\n  "x": 540,\n  "x": 540,\n  "y": 1500,\n  "fontSize": 100\n}\n`,
    );

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/Duplicate key/);
  });

  it('rejects an output path that already exists with different content (no-replace)', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'B' },
      ]),
    ).rejects.toThrow(/already exists|Output path already exists/);
  });

  it('rejects an output path that already exists with identical content by default (no-replace)', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    const outputPath = join(project.outputDir, 'timelines', 'subtitled.json');
    const before = await readFile(outputPath);

    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
    ).rejects.toThrow(/OUTPUT_COLLISION|already exists|Output path already exists/);

    expect(await readFile(outputPath)).toEqual(before);
  });

  it('accepts an existing final with identical content when allowExistingFinal is true', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const first = await runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    const statBefore = await lstat(first.outputPath);

    const second = await generateAndWriteSubtitleTimeline({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      mediaManifestRel: 'input/media-segments.json',
      selectionRel: 'input/selection.json',
      transcriptManifestRel: 'output/transcripts/manifest.json',
      styleRel: 'input/style.json',
      outputRel: 'timelines/subtitled.json',
      fontsDir: project.fontsDir,
      allowExistingFinal: true,
    });

    const statAfter = await lstat(second.outputPath);
    expect(second.timelineSha256).toBe(first.timelineSha256);
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);
  });

  it('rejects a selection JSON with a duplicate key', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    const selectionPath = join(project.root, 'input', 'selection.json');
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    const original = await readFile(selectionPath, 'utf8');
    await writeFile(selectionPath, original.replace(/"segmentIds"/, '"segmentIds": [],\n  "segmentIds"'));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/Duplicate key/);
  });

  it('rejects a transcript manifest that is not canonical (reordered utterances)', async () => {
    const segmentA = await makeRealSegment(project.inputDir, 'a.mp4', 'black');
    const segmentB = await makeRealSegment(project.inputDir, 'b.mp4', 'red');

    const { manifestRel } = await buildTranscriptManifestFile(project, [segmentA, segmentB], [
      { segmentId: segmentB.segmentId, start: 0, end: 1, text: 'B' },
      { segmentId: segmentA.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    const manifestPath = join(project.root, manifestRel);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const reordered = { ...manifest, utterances: [...manifest.utterances].reverse() };
    await writeFile(manifestPath, JSON.stringify(reordered, null, 2) + '\n');

    await writeJson(project.root, 'input/selection.json', makeSelection([segmentA.segmentId, segmentB.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/not canonical|canonical/);
  });

  it('rejects a transcript manifest with a duplicate utterance', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    const manifestPath = join(project.root, manifestRel);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.utterances.push({ ...manifest.utterances[0] });
    manifest.count = 2;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/Duplicate|duplicate|not canonical/);
  });

  it('rejects source asset replacement before input snapshot', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const assetPath = join(project.inputDir, segment.relativePath);
    const assetSha = await sha256File(assetPath);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeInputSnapshot: async (label) => {
            if (label === `Asset ${segment.relativePath}`) {
              await writeFile(assetPath, 'tampered');
            }
          },
        },
      ),
    ).rejects.toThrow(/changed|snapshot|content|sha/i);

    expect(await sha256File(assetPath)).not.toBe(assetSha);
  });

  it('rejects source asset replacement before publish commit', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const assetPath = join(project.inputDir, segment.relativePath);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeRename: async () => {
            await writeFile(assetPath, 'tampered');
          },
        },
      ),
    ).rejects.toThrow(/INPUT_CHANGED|changed|commit/);
  });

  it('rejects a symlinked selection file', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);

    const target = join(project.inputDir, 'selection-target.json');
    await writeJson(project.inputDir, 'selection-target.json', makeSelection([segment.segmentId]));
    const selectionPath = join(project.root, 'input', 'selection.json');
    await rm(selectionPath, { force: true });
    await symlink(target, selectionPath);
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/symbolic|symlink|not a regular file/i);
  });

  it('rejects an unknown field in the selection JSON', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', {
      segmentIds: [segment.segmentId],
      extra: true,
    });
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/Unrecognized|unrecognized|strict|Unknown field/);
  });

  it('rejects invalid UTF-8 in a JSON input', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    const selectionPath = join(project.root, 'input', 'selection.json');
    await rm(selectionPath, { force: true });
    // Raw bytes that are not valid UTF-8 (0xFF is a continuation byte start without a leading byte).
    await writeFile(
      selectionPath,
      Buffer.from([0x7b, 0x0a, 0x20, 0x20, 0x22, 0x73, 0x65, 0x67, 0x6d, 0x65, 0x6e, 0x74, 0x49, 0x64, 0x73, 0x22, 0x3a, 0x20, 0x5b, 0x22, 0xff, 0x22, 0x5d, 0x0a, 0x7d, 0x0a]),
    );
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/UTF-8/);
  });

  it('rejects an oversized JSON input', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
        maxBytes: 1,
      }),
    ).rejects.toThrow(/maximum size|exceeds maximum/);
  });

  it('rejects NaN and Infinity in the style JSON', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeFile(
      join(project.root, 'input', 'style.json'),
      `{\n  "font": "DejaVuSans.ttf",\n  "fontHash": "${project.fontHash}",\n  "x": 1e309,\n  "y": 1500,\n  "fontSize": 100\n}\n`,
    );

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/NaN|Infinity|finite/);
  });

  it('rejects control characters in subtitle text', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A\x01B' },
      ]),
    ).rejects.toThrow(/control|disallowed/);
  });

  it('rejects secret-like text in subtitle cue', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'api_key=1234567890abcdef' }, // gitleaks:allow
      ]),
    ).rejects.toThrow(/secret|api_key/);
  });

  it('rejects subtitle cues outside the timeline duration', () => {
    expect(() =>
      validateCues(
        [{ start: 0, end: 10, text: 'A', x: 540, y: 1500, fontSize: 100 }],
        5,
      ),
    ).toThrow(/duration|exceeds/);
  });

  it('keeps a foreign final file unchanged on no-replace failure', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const outputPath = join(project.outputDir, 'timelines', 'subtitled.json');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, '{"foreign":true}\n');

    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
    ).rejects.toThrow(/already exists|Output path already exists|foreign/);

    expect(await readFile(outputPath, 'utf8')).toBe('{"foreign":true}\n');
  });

  it('keeps input file SHA-256 unchanged after successful generation', async () => {
    const segment = await makeRealSegment(project.inputDir);

    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    const inputFiles = [
      join(project.root, 'input', 'media-segments.json'),
      join(project.root, 'input', 'transcript-source.json'),
      join(project.root, 'input', 'selection.json'),
      join(project.root, 'input', 'style.json'),
      join(project.root, manifestRel),
      join(project.inputDir, segment.relativePath),
    ];

    const before = await Promise.all(inputFiles.map((p) => sha256File(p)));
    await runGenerate(project, [segment], [segment.segmentId], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    const after = await Promise.all(inputFiles.map((p) => sha256File(p)));

    expect(after).toEqual(before);
  });

  it(
    'renders a multi-clip subtitle Timeline from the exact published JSON',
    async () => {
      const segA = await makeRealSegment(project.inputDir, 'a.mp4', 'black');
      const segB = await makeRealSegment(project.inputDir, 'b.mp4', 'red');
      const result = await runGenerate(
        project,
        [segA, segB],
        [segA.segmentId, segB.segmentId],
        [
          { segmentId: segA.segmentId, start: 0, end: 1, text: 'A' },
          { segmentId: segB.segmentId, start: 1, end: 2, text: 'B' },
        ],
        'timelines/subtitled-multi.json',
      );

      expect(result.timeline.clips).toHaveLength(2);
      expect(result.timeline.subtitles).toHaveLength(2);

      const timelineJson = await readFile(result.outputPath);
      expect(sha256Hex(timelineJson)).toBe(result.timelineSha256);
      const parsedTimeline = JSON.parse(timelineJson.toString('utf8'));
      expect(parsedTimeline).toEqual(result.timeline);

      const totalDuration = segA.duration + segB.duration;
      const inputFiles = [
        join(project.root, 'input', 'media-segments.json'),
        join(project.root, 'input', 'selection.json'),
        join(project.root, 'input', 'transcript-source.json'),
        join(project.root, 'input', 'style.json'),
        join(project.root, 'output', 'transcripts', 'manifest.json'),
        join(project.inputDir, segA.relativePath),
        join(project.inputDir, segB.relativePath),
        project.fontPath,
        result.outputPath,
      ];
      const inputBefore = await Promise.all(inputFiles.map((p) => sha256File(p)));

      const generated = await generate(parsedTimeline, {
        rootDir: project.root,
        fixturesDir: project.inputDir,
        outputDir: project.outputDir,
        fontsDir: project.fontsDir,
      });

      const inputAfter = await Promise.all(inputFiles.map((p) => sha256File(p)));
      expect(inputAfter).toEqual(inputBefore);

      expect(generated.timelineHash).toMatch(/^[0-9a-f]{64}$/);
      expect(generated.timeline).toEqual(parsedTimeline);
      expect(generated.outputPath).toBe(join(project.outputDir, result.timeline.outputPath));
      expect(generated.probe.width).toBe(1080);
      expect(generated.probe.height).toBe(1920);
      expect(generated.probe.videoCodec).toBe('h264');
      expect(generated.probe.audioCodec).toBe('aac');
      expect(generated.probe.hasAudio).toBe(true);
      expect(generated.probe.duration).toBeCloseTo(totalDuration, 1);
      expect(await sha256File(result.outputPath)).toBe(result.timelineSha256);
    },
    20000,
  );

  it('does not leave a partial output file after a failed publish', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const outputPath = join(project.outputDir, 'timelines', 'subtitled.json');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, '{"foreign":true}\n');

    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
    ).rejects.toThrow();

    expect(await readFile(outputPath, 'utf8')).toBe('{"foreign":true}\n');
    const files = await readdir(project.outputDir);
    expect(files.filter((f) => f.startsWith('.') || f.includes('tmp'))).toHaveLength(0);
  });

  it('rejects a font replaced with the same bytes but a different inode before snapshot', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const fontCopyPath = join(project.fontsDir, 'DejaVuSans-copy.ttf');
    await copyFile(project.fontPath, fontCopyPath);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeInputSnapshot: async (label) => {
            if (label === 'Subtitle font') {
              await rm(project.fontPath, { force: true });
              await copyFile(fontCopyPath, project.fontPath);
            }
          },
        },
      ),
    ).rejects.toThrow(/identity|snapshot|font/i);
  });

  it('rejects a font replaced with different bytes before snapshot', async () => {
    const segment = await makeRealSegment(project.inputDir);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeInputSnapshot: async (label) => {
            if (label === 'Subtitle font') {
              await writeFile(project.fontPath, Buffer.from([0x00, 0x01, 0x02]));
            }
          },
        },
      ),
    ).rejects.toThrow(/identity|snapshot|font|sha/i);
  });

  it('rejects a font replaced after snapshot and before publish', async () => {
    const segment = await makeRealSegment(project.inputDir);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeRename: async () => {
            await writeFile(project.fontPath, Buffer.from([0x00, 0x01, 0x02]));
          },
        },
      ),
    ).rejects.toThrow(/INPUT_CHANGED|font|sha|commit/i);
  });

  it('rejects a symlinked font', async () => {
    const segment = await makeRealSegment(project.inputDir);
    await rm(project.fontPath, { force: true });
    const realFont = join(project.fontsDir, 'real-DejaVuSans.ttf');
    await copyFile(join(root, 'fonts', 'DejaVuSans.ttf'), realFont);
    await symlink(realFont, project.fontPath);

    await expect(
      runGenerate(project, [segment], [segment.segmentId], [
        { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
      ]),
    ).rejects.toThrow(/symbolic|symlink|not a regular file|O_NOFOLLOW/i);
  });

  it('rejects ./-prefixed input and output paths', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    const baseArgs = {
      projectRoot: project.root,
      inputRoot: project.inputDir,
      mediaManifestRel: 'input/media-segments.json',
      selectionRel: 'input/selection.json',
      transcriptManifestRel: manifestRel,
      styleRel: 'input/style.json',
      outputRel: 'timelines/subtitled.json',
      fontsDir: project.fontsDir,
    };

    const cases = [
      { ...baseArgs, mediaManifestRel: './input/media-segments.json' },
      { ...baseArgs, selectionRel: './input/selection.json' },
      { ...baseArgs, transcriptManifestRel: `./${manifestRel}` },
      { ...baseArgs, styleRel: './input/style.json' },
      { ...baseArgs, outputRel: './timelines/subtitled.json' },
    ];

    for (const args of cases) {
      await expect(generateAndWriteSubtitleTimeline(args)).rejects.toThrow(
        /\. or \.\./i,
      );
    }
  });

  it('rejects a hard-linked source asset', async () => {
    const segment = await makeRealSegment(project.inputDir, 'a.mp4', 'black');
    const hardLinkedAsset = join(project.inputDir, 'hard-a.mp4');
    await link(join(project.inputDir, segment.relativePath), hardLinkedAsset);

    const hardSegment = {
      ...segment,
      relativePath: 'hard-a.mp4',
      segmentId: computeSegmentId({
        assetContentId: segment.assetContentId,
        relativePath: 'hard-a.mp4',
        mediaType: 'video',
        start: 0,
        end: segment.duration,
        duration: segment.duration,
      }),
    };

    const source = {
      schemaVersion: 'v1' as const,
      entries: [{ segmentId: hardSegment.segmentId, start: 0, end: 1, text: 'A' }],
    };
    await writeJson(project.root, 'input/transcript-source.json', source);

    await writeJson(project.root, 'input/media-segments.json', {
      schemaVersion: 'v1' as const,
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [hardSegment],
    });
    const mediaSha = await sha256File(join(project.root, 'input', 'media-segments.json'));
    const manifest = buildTranscriptManifest({
      mediaSegmentManifest: {
        schemaVersion: 'v1' as const,
        count: 1,
        excludedCount: 0,
        excluded: [],
        segments: [hardSegment],
      },
      mediaSegmentManifestIdentifier: 'input/media-segments.json',
      mediaSegmentManifestSha256: mediaSha,
      transcriptSource: source,
      transcriptSourceIdentifier: 'input/transcript-source.json',
      transcriptSourceSha256: sha256Hex(JSON.stringify(source)),
    });
    await writeJson(project.root, 'output/transcripts/manifest.json', manifest);
    await writeJson(project.root, 'input/selection.json', { segmentIds: [hardSegment.segmentId] });
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: 'output/transcripts/manifest.json',
        styleRel: 'input/style.json',
        outputRel: 'timelines/subtitled.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/hard link/i);
  });

  it('rejects a hard-linked font', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const hardLinkedFont = join(project.fontsDir, 'hard-DejaVuSans.ttf');
    await link(project.fontPath, hardLinkedFont);
    const fontHash = await sha256File(hardLinkedFont);

    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', {
      font: 'hard-DejaVuSans.ttf',
      fontHash,
      x: 540,
      y: 1500,
      fontSize: 100,
    });

    await expect(
      generateAndWriteSubtitleTimeline({
        projectRoot: project.root,
        inputRoot: project.inputDir,
        mediaManifestRel: 'input/media-segments.json',
        selectionRel: 'input/selection.json',
        transcriptManifestRel: manifestRel,
        styleRel: 'input/style.json',
        outputRel: 'timelines/subtitled.json',
        fontsDir: project.fontsDir,
      }),
    ).rejects.toThrow(/hard link/i);
  });

  it('rejects a font ABA-swapped and restored before snapshot', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const backupFont = join(project.fontsDir, 'original-backup.ttf');
    const maliciousFont = join(project.fontsDir, 'malicious.ttf');
    await writeFile(maliciousFont, Buffer.from([0x00, 0x01, 0x02]));

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontGlyphInspection: async () => {
            await rename(project.fontPath, backupFont);
            await copyFile(maliciousFont, project.fontPath);
          },
          beforeInputSnapshot: async (label) => {
            if (label === 'Subtitle font') {
              await rm(project.fontPath, { force: true });
              await rename(backupFont, project.fontPath);
            }
          },
        } satisfies PublishAtomicTestHooks,
      ),
    ).rejects.toThrow(/identity|snapshot|font|changed/i);
  });

  it('rejects replacement of each JSON input before snapshot', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const { manifestRel } = await buildTranscriptManifestFile(project, [segment], [
      { segmentId: segment.segmentId, start: 0, end: 1, text: 'A' },
    ]);
    await writeJson(project.root, 'input/selection.json', makeSelection([segment.segmentId]));
    await writeJson(project.root, 'input/style.json', makeStyle(project.fontHash));

    const cases: Array<{ rel: string; path: string; label: string }> = [
      { rel: 'input/media-segments.json', path: join(project.root, 'input', 'media-segments.json'), label: 'Media segment manifest' },
      { rel: 'input/selection.json', path: join(project.root, 'input', 'selection.json'), label: 'Segment selection' },
      { rel: manifestRel, path: join(project.root, manifestRel), label: 'Transcript manifest' },
      { rel: 'input/style.json', path: join(project.root, 'input', 'style.json'), label: 'Subtitle style' },
    ];

    for (const { rel, path, label } of cases) {
      const original = await readFile(path);
      await expect(
        generateAndWriteSubtitleTimeline({
          projectRoot: project.root,
          inputRoot: project.inputDir,
          mediaManifestRel: 'input/media-segments.json',
          selectionRel: 'input/selection.json',
          transcriptManifestRel: manifestRel,
          styleRel: 'input/style.json',
          outputRel: 'timelines/subtitled.json',
          fontsDir: project.fontsDir,
          __testHooks: {
            beforeInputSnapshot: async (l) => {
              if (l === label) {
                await writeFile(path, '{"tampered":true}\n');
              }
            },
          },
        }),
      ).rejects.toThrow(/identity|snapshot|content|sha/i);
      await writeFile(path, original);
    }
  });

  it('recovers from a post-link failure and leaves no temp residue', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const outputPath = join(project.outputDir, 'timelines', 'subtitled.json');

    const result = await runGenerate(
      project,
      [segment],
      [segment.segmentId],
      [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
      'timelines/subtitled.json',
      { postLinkFail: true } satisfies PublishAtomicTestHooks,
    );

    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(await sha256File(outputPath)).toBe(result.timelineSha256);
    const entries = await readdir(join(project.outputDir, 'timelines'));
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  });

  it('does not overwrite an existing fixture-like output and leaves no temp residue', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const outputRel = 'timelines/subtitled-multi.json';
    const outputPath = join(project.outputDir, 'timelines', 'subtitled-multi.json');

    const first = await runGenerate(
      project,
      [segment],
      [segment.segmentId],
      [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
      outputRel,
    );
    const firstSha256 = await sha256File(outputPath);
    expect(firstSha256).toBe(first.timelineSha256);

    const foreign = '{"foreign":true}\n';
    await chmod(outputPath, 0o644);
    await writeFile(outputPath, foreign);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        outputRel,
      ),
    ).rejects.toThrow(/already exists|Output path already exists|foreign|no-replace/i);

    expect(await readFile(outputPath, 'utf8')).toBe(foreign);
    const entries = await readdir(join(project.outputDir, 'timelines'));
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  });

  async function findSnapshotDir(projectRoot: string): Promise<string> {
    const dirs = (await readdir(projectRoot)).filter((d) => /^\.font-snap-[^.]+$/.test(d));
    dirs.sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (dirs.length === 0) throw new Error('No font snapshot directory found');
    return dirs[0];
  }

  async function findSnapshotFontFile(projectRoot: string): Promise<string> {
    const snapDir = await findSnapshotDir(projectRoot);
    const files = await readdir(join(projectRoot, snapDir));
    const ttf = files.find((f) => f.endsWith('.ttf'));
    if (!ttf) throw new Error('No .ttf file in font snapshot directory');
    return join(projectRoot, snapDir, ttf);
  }

  it('rejects a snapshot copy replaced with a different valid font during glyph verification', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const ipaFont = join(root, 'fonts', 'IPAGothic.ttf');

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontGlyphInspection: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            await chmod(snapshotFont, 0o644);
            await copyFile(ipaFont, snapshotFont);
          },
        } satisfies SubtitleTimelineTestHooks,
      ),
    ).rejects.toThrow(/snapshot.*hash|hash changed|font snapshot/i);
  });

  it('rejects a snapshot copy ABA-swapped and restored before rehash', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const ipaFont = join(root, 'fonts', 'IPAGothic.ttf');

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontSnapshotRehash: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            const original = await readFile(snapshotFont);
            await chmod(snapshotFont, 0o644);
            await copyFile(ipaFont, snapshotFont);
            await writeFile(snapshotFont, original);
          },
        } satisfies SubtitleTimelineTestHooks,
      ),
    ).rejects.toThrow(/snapshot.*identity|snapshot.*changed|font snapshot/i);
  });

  it('rejects cleanup failure and does not return success', async () => {
    const segment = await makeRealSegment(project.inputDir);
    let snapDirPath: string | undefined;

    try {
      await expect(
        runGenerate(
          project,
          [segment],
          [segment.segmentId],
          [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
          'timelines/subtitled.json',
          {
            afterVerify: async (finalPath) => {
              const projectRoot = dirname(dirname(dirname(finalPath)));
              const dirs = await readdir(projectRoot);
              const snapDir = dirs.find((d) => d.startsWith('.font-snap-'));
              if (snapDir) {
                snapDirPath = join(projectRoot, snapDir);
                await chmod(snapDirPath, 0o555);
              }
            },
          } satisfies SubtitleTimelineTestHooks,
        ),
      ).rejects.toThrow(/Failed to clean up|EACCES|permission denied/i);
    } finally {
      if (snapDirPath) {
        await chmod(snapDirPath, 0o700).catch(() => {});
      }
    }
  });

  it('rejects replacement of the original font between snapshot capture and final link', async () => {
    const segment = await makeRealSegment(project.inputDir);

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeRename: async () => {
            await writeFile(project.fontPath, Buffer.from([0x00, 0x01, 0x02]));
          },
        } satisfies SubtitleTimelineTestHooks,
      ),
    ).rejects.toThrow(/font path changed after snapshot|INPUT_CHANGED|content changed|sha|commit/i);
  });

  it('rejects a snapshot directory replaced during glyph verification', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const ipaFont = join(root, 'fonts', 'IPAGothic.ttf');

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontGlyphInspection: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            const snapDir = dirname(snapshotFont);
            const newDir = snapDir + '-new';
            await chmod(snapDir, 0o700);
            await rename(snapDir, newDir);
            await mkdir(snapDir);
            await copyFile(ipaFont, snapshotFont);
            await chmod(snapDir, 0o500);
          },
        } satisfies SubtitleTimelineTestHooks,
      ),
    ).rejects.toThrow(/snapshot.*identity|snapshot.*changed|font snapshot|parent|fd and pathname/i);
  });

  it('rejects a snapshot leaf swapped and restored before rehash', async () => {
    const segment = await makeRealSegment(project.inputDir);
    const ipaFont = join(root, 'fonts', 'IPAGothic.ttf');

    await expect(
      runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontGlyphInspection: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            const backupFont = snapshotFont + '.bak';
            await chmod(dirname(snapshotFont), 0o700);
            await rename(snapshotFont, backupFont);
            await copyFile(ipaFont, snapshotFont);
          },
          beforeFontSnapshotRehash: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            const backupFont = snapshotFont + '.bak';
            await chmod(dirname(snapshotFont), 0o700);
            await rm(snapshotFont, { force: true });
            await rename(backupFont, snapshotFont);
          },
        } satisfies SubtitleTimelineTestHooks,
      ),
    ).rejects.toThrow(/snapshot.*identity|snapshot.*changed|font snapshot|parent/i);
  });

  it('rejects a snapshot failure and cleanup failure as AggregateError', async () => {
    const segment = await makeRealSegment(project.inputDir);
    let snapDirPath: string | undefined;
    let trapDirPath: string | undefined;

    try {
      await runGenerate(
        project,
        [segment],
        [segment.segmentId],
        [{ segmentId: segment.segmentId, start: 0, end: 1, text: 'A' }],
        'timelines/subtitled.json',
        {
          beforeFontSnapshotRehash: async () => {
            const snapshotFont = await findSnapshotFontFile(project.root);
            snapDirPath = dirname(snapshotFont);
            trapDirPath = join(snapDirPath, 'trap');
            await chmod(snapDirPath, 0o700);
            await mkdir(trapDirPath);
            await writeFile(join(trapDirPath, 'file.txt'), 'trap');
            await chmod(trapDirPath, 0o000);
          },
        } satisfies SubtitleTimelineTestHooks,
      );
      throw new Error('Expected runGenerate to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors.length).toBeGreaterThanOrEqual(2);
      expect(agg.message).toMatch(/snapshot|cleanup|EACCES|permission denied/i);
      expect(agg.errors.some((e) => /identity changed|Font snapshot changed/i.test(String(e)))).toBe(true);
      expect(agg.errors.some((e) => /EACCES|permission denied|scandir|ENOTEMPTY/i.test(String(e)))).toBe(true);
    } finally {
      if (trapDirPath) {
        await chmod(trapDirPath, 0o700).catch(() => {});
      }
      if (snapDirPath) {
        await rm(snapDirPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});

describe('generateFixtures multi-clip subtitle output', () => {
  let fixtureRoot: string;

  beforeAll(async () => {
    const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    fixtureRoot = await mkdtemp('/tmp/ker318-fixtures-');

    const inputDir = join(fixtureRoot, 'fixtures', 'media-subrange-input');
    await mkdir(inputDir, { recursive: true });
    for (const name of ['subranges.json', 'transcript-source.json', 'selection.json', 'style.json']) {
      await copyFile(
        join(repoRoot, 'fixtures', 'media-subrange-input', name),
        join(inputDir, name),
      );
    }

    await generateFixtures(fixtureRoot);
  }, 90000);

  afterAll(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('accepts an existing final that matches the canonical bytes exactly', async () => {
    const outputPath = join(fixtureRoot, 'output', 'timelines', 'subtitled-multi.json');
    const statBefore = await lstat(outputPath);
    const bytesBefore = await readFile(outputPath);
    const shaBefore = sha256Hex(bytesBefore);

    await generateFixtures(fixtureRoot);

    const statAfter = await lstat(outputPath);
    const bytesAfter = await readFile(outputPath);
    expect(sha256Hex(bytesAfter)).toBe(shaBefore);
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);

    const entries = await readdir(join(fixtureRoot, 'output', 'timelines'));
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  }, 90000);

  it('rejects a foreign final and leaves its bytes/inode unchanged', async () => {
    const outputPath = join(fixtureRoot, 'output', 'timelines', 'subtitled-multi.json');
    await rm(outputPath, { force: true });
    const foreign = Buffer.from('{"foreign":true}\n');
    await writeFile(outputPath, foreign);
    const statBefore = await lstat(outputPath);

    await expect(generateFixtures(fixtureRoot)).rejects.toThrow(/collision|different content|already exists/i);

    const statAfter = await lstat(outputPath);
    expect(await readFile(outputPath)).toEqual(foreign);
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);

    const entries = await readdir(join(fixtureRoot, 'output', 'timelines'));
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  }, 90000);

  it('rejects an existing final that is a symlink to matching canonical bytes', async () => {
    const outputPath = join(fixtureRoot, 'output', 'timelines', 'subtitled-multi.json');
    const canonical = await readFile(outputPath);
    await rm(outputPath, { force: true });
    const target = join(fixtureRoot, 'output', 'timelines', '.canonical-target.json');
    await writeFile(target, canonical);
    await symlink(target, outputPath);
    const statBefore = await lstat(outputPath);

    await expect(generateFixtures(fixtureRoot)).rejects.toThrow(/ELOOP|O_NOFOLLOW|not a regular file|single link/i);

    const statAfter = await lstat(outputPath);
    expect(await readFile(outputPath)).toEqual(canonical);
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);

    await rm(target, { force: true });
    await rm(outputPath, { force: true });
    await writeFile(outputPath, canonical);
  }, 90000);

  it('rejects an existing final that is a hard link to matching canonical bytes', async () => {
    const outputPath = join(fixtureRoot, 'output', 'timelines', 'subtitled-multi.json');
    const canonical = await readFile(outputPath);
    const target = join(fixtureRoot, 'output', 'timelines', '.canonical-target.json');
    await rm(outputPath, { force: true });
    await writeFile(target, canonical);
    await link(target, outputPath);
    const statBefore = await lstat(outputPath);

    await expect(generateFixtures(fixtureRoot)).rejects.toThrow(/single link|hard link|nlink/i);

    const statAfter = await lstat(outputPath);
    expect(await readFile(outputPath)).toEqual(canonical);
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.ctimeMs).toBe(statBefore.ctimeMs);

    await rm(target, { force: true });
  }, 90000);

  it('safeReadFinalOutput rejects symlinks and hard links', async () => {
    const tmp = await mkdtemp(join(root, 'tmp-read-final-'));
    const finalPath = join(tmp, 'final.json');
    const target = join(tmp, 'target.json');
    const canonical = Buffer.from('{"canonical":true}\n');
    await mkdir(tmp, { recursive: true });
    await writeFile(target, canonical);
    await symlink(target, finalPath);

    await expect(safeReadFinalOutput(finalPath)).rejects.toThrow(/ELOOP|O_NOFOLLOW|not a regular file|single link/i);

    await rm(finalPath, { force: true });
    await link(target, finalPath);
    await expect(safeReadFinalOutput(finalPath)).rejects.toThrow(/single link|hard link|nlink/i);

    await rm(tmp, { recursive: true, force: true });
  }, 90000);
});
