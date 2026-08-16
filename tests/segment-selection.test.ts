import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { PathLike, StatOptions } from 'node:fs';

const mockLstatState = vi.hoisted(() => ({ triggerPath: null as string | null, triggered: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: async (path: PathLike, opts?: StatOptions) => {
      const result = await original.lstat(path, opts);
      if (
        mockLstatState.triggerPath &&
        String(path) === mockLstatState.triggerPath &&
        !mockLstatState.triggered
      ) {
        mockLstatState.triggered = true;
        await original.writeFile(path, JSON.stringify({ tampered: true }));
      }
      return result;
    },
  };
});
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  lstat,
  link,
  symlink,
  readdir,
  rename,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog } from '../src/catalog.js';
import { generate, ffprobe, sha256File, type Timeline } from '../src/core.js';
import {
  buildMediaSegmentManifest,
  computeSegmentId,
  MEDIA_SUBRANGE_SCHEMA_VERSION,
  writeMediaSegmentManifest,
  type MediaSegment,
  type MediaSegmentExcludedEntry,
  type MediaSegmentManifest,
} from '../src/media-segments.js';
import {
  buildTimelineFromManifestAndSelection,
  generateAndWriteTimeline,
  normalizeTimelineOutputRel,
  deriveTimelineOutputPath,
  readJsonFileSafe,
} from '../src/segment-selection.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = resolve(root, 'node_modules', '.bin', 'tsx');

async function createVideo(
  filePath: string,
  color = 'blue',
  duration = 2,
): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=1080x1920:r=30:d=${duration}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    filePath,
  ]);
}

async function createAudio(filePath: string, duration = 2): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:duration=${duration}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    filePath,
  ]);
}

function makeSegment(
  segmentId: string,
  relativePath: string,
  mediaType: 'video' | 'audio' = 'video',
  duration = 2,
): MediaSegment {
  return {
    segmentId,
    assetContentId: 'b'.repeat(64),
    relativePath,
    mediaType,
    start: 0,
    end: duration,
    duration,
  };
}

function makeManifest(
  segments: MediaSegment[],
  excluded: MediaSegmentExcludedEntry[] = [],
): MediaSegmentManifest {
  return {
    schemaVersion: 'v1',
    count: segments.length,
    excludedCount: excluded.length,
    excluded,
    segments,
  };
}

function makeSelection(segmentIds: string[]): { segmentIds: string[] } {
  return { segmentIds };
}

async function writeSelection(project: string, relPath: string, segmentIds: string[]): Promise<string> {
  const selection = makeSelection(segmentIds);
  const fullPath = resolve(project, relPath);
  await mkdir(resolve(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, JSON.stringify(selection, null, 2) + '\n');
  return fullPath;
}

async function writeManifest(
  project: string,
  relPath: string,
  segments: MediaSegment[],
  excluded: MediaSegmentExcludedEntry[] = [],
): Promise<string> {
  const manifest = makeManifest(segments, excluded);
  const fullPath = resolve(project, relPath);
  await mkdir(resolve(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, JSON.stringify(manifest, null, 2) + '\n');
  return fullPath;
}

describe('normalizeTimelineOutputRel', () => {
  it('normalizes and accepts valid timelines/ paths', () => {
    expect(normalizeTimelineOutputRel('output/timelines/selected.json')).toBe('timelines/selected.json');
    expect(normalizeTimelineOutputRel('./output/timelines/selected.json')).toBe('timelines/selected.json');
    expect(normalizeTimelineOutputRel('timelines/selected.json')).toBe('timelines/selected.json');
    expect(normalizeTimelineOutputRel('output\\timelines\\selected.json')).toBe('timelines/selected.json');
    expect(normalizeTimelineOutputRel('timelines\\selected.json')).toBe('timelines/selected.json');
    expect(normalizeTimelineOutputRel('./timelines/selected.json')).toBe('timelines/selected.json');
  });

  it('rejects paths outside timelines/', () => {
    expect(() => normalizeTimelineOutputRel('foo.json')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('other/x.json')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('output/foo.json')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('./foo.json')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('timelines/sub/x.json')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('timelines/selected')).toThrow(/timelines\/.*\.json/);
    expect(() => normalizeTimelineOutputRel('../timelines/x.json')).toThrow(/Path traversal/);
    expect(() => normalizeTimelineOutputRel('C:/timelines/x.json')).toThrow(/Windows drive paths/);
    expect(() => normalizeTimelineOutputRel('\\\\server\\timelines\\x.json')).toThrow(/UNC paths/);
  });

  it('rejects POSIX absolute paths', () => {
    expect(() => normalizeTimelineOutputRel('/timelines/selected.json')).toThrow(/Absolute paths/);
    expect(() => normalizeTimelineOutputRel('/output/timelines/selected.json')).toThrow(/Absolute paths/);
    expect(() => normalizeTimelineOutputRel('/foo.json')).toThrow(/Absolute paths/);
    expect(() => normalizeTimelineOutputRel('\\output\\timelines\\selected.json')).toThrow(/Absolute paths/);
    expect(() => normalizeTimelineOutputRel('\\timelines\\selected.json')).toThrow(/Absolute paths/);
  });
});

describe('deriveTimelineOutputPath', () => {
  it('derives a .mp4 output path from a .json output path', () => {
    expect(deriveTimelineOutputPath('timelines/selected.json')).toBe('timelines/selected.mp4');
    expect(deriveTimelineOutputPath('./output/timelines/selected.json')).toBe('timelines/selected.mp4');
  });

  it('rejects non-timelines output paths', () => {
    expect(() => deriveTimelineOutputPath('timelines/selected')).toThrow(/timelines/);
    expect(() => deriveTimelineOutputPath('foo.json')).toThrow(/timelines/);
    expect(() => deriveTimelineOutputPath('other/x.json')).toThrow(/timelines/);
  });
});

describe('buildTimelineFromManifestAndSelection', () => {
  it('builds a single-segment video timeline', () => {
    const id = 'a'.repeat(64);
    const manifest = makeManifest([makeSegment(id, 'red.mp4', 'video', 2.5)]);
    const selection = makeSelection([id]);

    const timeline = buildTimelineFromManifestAndSelection(
      manifest,
      selection,
      'timelines/selected.mp4',
    );

    expect(timeline.width).toBe(1080);
    expect(timeline.height).toBe(1920);
    expect(timeline.fps).toBe(30);
    expect(timeline.background).toBe('000000');
    expect(timeline.outputPreset).toBe('preview');
    expect(timeline.outputPath).toBe('timelines/selected.mp4');
    expect(timeline.clips).toHaveLength(1);
    expect(timeline.clips[0].type).toBe('video');
    expect(timeline.clips[0].source).toBe('red.mp4');
    expect(timeline.clips[0].start).toBe(0);
    expect(timeline.clips[0].end).toBe(2.5);
    expect(timeline.clips[0].in).toBe(0);
    expect(timeline.clips[0].out).toBe(2.5);
    expect(timeline.clips[0].fit).toBe('cover');
  });

  it('builds a 5-segment sequential timeline', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `${String(i).repeat(64)}`);
    const manifest = makeManifest(
      ids.map((id, i) => makeSegment(id, `clip${i}.mp4`, 'video', i + 1)),
    );
    const selection = makeSelection(ids);

    const timeline = buildTimelineFromManifestAndSelection(
      manifest,
      selection,
      'timelines/selected.mp4',
    );

    expect(timeline.clips).toHaveLength(5);
    let expectedStart = 0;
    for (let i = 0; i < 5; i++) {
      expect(timeline.clips[i].source).toBe(`clip${i}.mp4`);
      expect(timeline.clips[i].start).toBe(expectedStart);
      expect(timeline.clips[i].end).toBe(expectedStart + i + 1);
      expect(timeline.clips[i].in).toBe(0);
      expect(timeline.clips[i].out).toBe(i + 1);
      expectedStart += i + 1;
    }
  });

  it('rejects an unknown segment ID', () => {
    const manifest = makeManifest([makeSegment('a'.repeat(64), 'red.mp4')]);
    const selection = makeSelection(['b'.repeat(64)]);
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, selection, 'timelines/selected.mp4'),
    ).toThrow(/Unknown segment ID/);
  });

  it('rejects an audio segment ID', () => {
    const id = 'a'.repeat(64);
    const manifest = makeManifest([makeSegment(id, 'tone.mp3', 'audio', 2)]);
    const selection = makeSelection([id]);
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, selection, 'timelines/selected.mp4'),
    ).toThrow(/not a video segment/);
  });

  it('rejects duplicate segment IDs in selection', () => {
    const id = 'a'.repeat(64);
    const manifest = makeManifest([makeSegment(id, 'red.mp4')]);
    const selection = makeSelection([id, id]);
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, selection, 'timelines/selected.mp4'),
    ).toThrow(/Duplicate segment ID/);
  });

  it('rejects duplicate segment IDs in manifest', () => {
    const id = 'a'.repeat(64);
    const manifest = makeManifest([
      makeSegment(id, 'red.mp4', 'video', 2),
      makeSegment(id, 'blue.mp4', 'video', 2),
    ]);
    const selection = makeSelection([id]);
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, selection, 'timelines/selected.mp4'),
    ).toThrow(/Duplicate segment ID in manifest/);
  });

  it('rejects an empty selection', () => {
    const manifest = makeManifest([makeSegment('a'.repeat(64), 'red.mp4')]);
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, makeSelection([]), 'timelines/selected.mp4'),
    ).toThrow(/At least one segment ID/);
  });

  it('rejects more than 5 segment IDs', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `${String(i).repeat(64)}`);
    const manifest = makeManifest(ids.map((id, i) => makeSegment(id, `clip${i}.mp4`)));
    expect(() =>
      buildTimelineFromManifestAndSelection(manifest, makeSelection(ids), 'timelines/selected.mp4'),
    ).toThrow(/At most 5 segment IDs/);
  });
});

describe('generateAndWriteTimeline', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegmentIds: string[];
  let audioSegmentId: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-project-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);
    await createVideo(join(inputDir, 'blue.mp4'), 'blue', 2);
    await createAudio(join(inputDir, 'tone.mp3'), 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );

    videoSegmentIds = manifest.segments
      .filter((s) => s.mediaType === 'video')
      .map((s) => s.segmentId);
    audioSegmentId = manifest.segments.find((s) => s.mediaType === 'audio')!.segmentId;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('writes a valid timeline JSON for one selected video segment', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentIds[0]]);

    const result = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    expect(result.outputPath).toBe(resolve(project, 'output', 'timelines', 'selected.json'));
    const raw = await readFile(result.outputPath, 'utf8');
    const parsed: Timeline = JSON.parse(raw);
    expect(parsed.width).toBe(1080);
    expect(parsed.height).toBe(1920);
    expect(parsed.fps).toBe(30);
    expect(parsed.background).toBe('000000');
    expect(parsed.outputPreset).toBe('preview');
    expect(parsed.outputPath).toBe('timelines/selected.mp4');
    expect(parsed.clips).toHaveLength(1);
    expect(parsed.clips[0].type).toBe('video');
    expect(parsed.clips[0].source).toMatch(/\.mp4$/);
    expect(parsed.clips[0].start).toBe(0);
    expect(parsed.clips[0].end).toBeGreaterThan(0);
    expect(result.manifestSha256).toBe(await sha256File(manifestPath));
    expect(result.selectionSha256).toBe(await sha256File(selectionPath));
    expect(result.timelineSha256).toBe(await sha256File(result.outputPath));
  }, 60000);

  it('connects 1-5 video segments sequentially with no gaps or overlaps', async () => {
    const ids = videoSegmentIds.slice(0, 2);
    await writeSelection(project, 'selection.json', ids);

    const result = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    const parsed: Timeline = JSON.parse(await readFile(result.outputPath, 'utf8'));
    expect(parsed.clips).toHaveLength(2);
    expect(parsed.clips[0].start).toBe(0);
    expect(parsed.clips[0].end).toBe(parsed.clips[0].out - parsed.clips[0].in);
    expect(parsed.clips[1].start).toBe(parsed.clips[0].end);
    expect(parsed.clips[1].end).toBe(parsed.clips[1].start + (parsed.clips[1].out - parsed.clips[1].in));
  }, 60000);

  it('rejects an audio segment ID', async () => {
    await writeSelection(project, 'selection.json', [audioSegmentId]);
    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/not a video segment/);
  });

  it('rejects an unknown segment ID', async () => {
    await writeSelection(project, 'selection.json', ['a'.repeat(64)]);
    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/Unknown segment ID/);
  });

  it('rejects a duplicate segment ID', async () => {
    await writeSelection(project, 'selection.json', [videoSegmentIds[0], videoSegmentIds[0]]);
    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/Duplicate segment ID/);
  });

  it('rejects more than 5 segment IDs', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `${String(i).repeat(64)}`);
    await writeSelection(project, 'selection.json', ids);
    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/At most 5 segment IDs/);
  });

  it('rejects an empty selection', async () => {
    await writeSelection(project, 'selection.json', []);
    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/At least one segment ID/);
  });

  it('rejects a manifest with duplicate segment IDs', async () => {
    const id = 'a'.repeat(64);
    const manifestRel = 'duplicate-manifest.json';
    await writeManifest(project, manifestRel, [
      makeSegment(id, 'red.mp4', 'video', 2),
      makeSegment(id, 'blue.mp4', 'video', 2),
    ]);
    await writeSelection(project, 'selection.json', [id]);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel,
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/Duplicate segment ID/);
  });

  it('produces the same SHA-256 for the same manifest and selection', async () => {
    await writeSelection(project, 'selection.json', [videoSegmentIds[0]]);

    const first = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    const second = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    expect(first.timelineSha256).toBe(second.timelineSha256);
    expect(first.timelineSha256).toBe(await sha256File(first.outputPath));
  }, 60000);

  it('renders the generated timeline to a 1080x1920 MP4', async () => {
    await writeSelection(project, 'selection.json', [videoSegmentIds[0]]);

    const { outputPath: timelinePath } = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    const timeline: Timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
    const outputDir = join(project, 'output');
    const result = await generate(timeline, {
      rootDir: project,
      fixturesDir: inputDir,
      outputDir,
      fontsDir: join(project, 'fonts'),
    });

    const probe = await ffprobe(result.outputPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.fps).toBe(30);
    expect(probe.hasVideo).toBe(true);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe('aac');

    const videoSha = await sha256File(result.outputPath);
    expect(videoSha).toMatch(/^[0-9a-f]{64}$/);
  }, 120000);

  it('selects two v2 sub-ranges of the same video in order and renders a 1080x1920 MP4', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 5);
    const assetContentId = await sha256File(join(inputDir, 'clip.mp4'));

    const segA = computeSegmentId({
      assetContentId,
      relativePath: 'clip.mp4',
      mediaType: 'video',
      start: 0,
      end: 2.5,
      duration: 5,
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    });
    const segB = computeSegmentId({
      assetContentId,
      relativePath: 'clip.mp4',
      mediaType: 'video',
      start: 2.5,
      end: 5,
      duration: 5,
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    });

    const v2Manifest: MediaSegmentManifest = {
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
      count: 2,
      excludedCount: 0,
      excluded: [],
      segments: [
        { segmentId: segA, assetContentId, relativePath: 'clip.mp4', mediaType: 'video', start: 0, end: 2.5, duration: 5 },
        { segmentId: segB, assetContentId, relativePath: 'clip.mp4', mediaType: 'video', start: 2.5, end: 5, duration: 5 },
      ],
    };
    const manifestPath = await writeManifest(project, 'v2-manifest.json', v2Manifest.segments);
    await writeFile(manifestPath, JSON.stringify(v2Manifest, null, 2) + '\n');
    await writeSelection(project, 'v2-selection.json', [segA, segB]);

    const result = await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'v2-manifest.json',
      selectionRel: 'v2-selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/v2-subranges.json',
    });

    const timeline: Timeline = JSON.parse(await readFile(result.outputPath, 'utf8'));
    expect(timeline.clips).toHaveLength(2);
    expect(timeline.clips[0].source).toBe('clip.mp4');
    expect(timeline.clips[0].in).toBe(0);
    expect(timeline.clips[0].out).toBe(2.5);
    expect(timeline.clips[0].start).toBe(0);
    expect(timeline.clips[0].end).toBe(2.5);
    expect(timeline.clips[1].source).toBe('clip.mp4');
    expect(timeline.clips[1].in).toBe(2.5);
    expect(timeline.clips[1].out).toBe(5);
    expect(timeline.clips[1].start).toBe(2.5);
    expect(timeline.clips[1].end).toBe(5);

    const outputDir = join(project, 'output');
    const generated = await generate(timeline, {
      rootDir: project,
      fixturesDir: inputDir,
      outputDir,
      fontsDir: join(project, 'fonts'),
    });

    const probe = await ffprobe(generated.outputPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.fps).toBe(30);
    expect(probe.hasVideo).toBe(true);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.duration).toBeCloseTo(5, 1);
  }, 120000);
});

describe('generateAndWriteTimeline adversarial safety', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegmentId: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-adversarial-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );
    videoSegmentId = manifest.segments.find((s) => s.mediaType === 'video')!.segmentId;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects output that is the same path as the selection file', async () => {
    const selectionRel = 'output/timelines/selection.json';
    const selectionPath = await writeSelection(project, selectionRel, [videoSegmentId]);
    const beforeSha = await sha256File(selectionPath);
    const beforeStat = await lstat(selectionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel,
        inputRoot: inputDir,
        outputRel: 'output/timelines/selection.json',
      }),
    ).rejects.toThrow(/same as/);

    const afterStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSha);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
  });

  it('rejects output that is a hard link to the selection file', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentId]);
    const outputPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await link(selectionPath, outputPath);

    const beforeSha = await sha256File(selectionPath);
    const beforeStat = await lstat(selectionPath);
    const outputStat = await lstat(outputPath);
    expect(outputStat.isSymbolicLink()).toBe(false);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/inode|same as/);

    expect(await sha256File(selectionPath)).toBe(beforeSha);
    const afterStat = await lstat(selectionPath);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
  });

  it('rejects output that is a symlink to the selection file', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentId]);
    const outputPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await symlink(selectionPath, outputPath);

    const beforeSha = await sha256File(selectionPath);
    const beforeStat = await lstat(selectionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/resolves to the same file|same as/);

    expect(await sha256File(selectionPath)).toBe(beforeSha);
    const afterStat = await lstat(selectionPath);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
  });

  it('rejects a ./ alias output path that collides with the selection file', async () => {
    const selectionRel = 'output/timelines/selection.json';
    const selectionPath = await writeSelection(project, selectionRel, [videoSegmentId]);
    const beforeSha = await sha256File(selectionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: `./${selectionRel}`,
        inputRoot: inputDir,
        outputRel: 'output/timelines/selection.json',
      }),
    ).rejects.toThrow(/same as/);

    expect(await sha256File(selectionPath)).toBe(beforeSha);
  });

  it('rejects output that is the same path as the manifest file', async () => {
    const id = 'a'.repeat(64);
    const collisionRel = 'output/timelines/collision.json';
    const collisionPath = await writeManifest(project, collisionRel, [makeSegment(id, 'red.mp4', 'video', 2)]);
    const selectionPath = await writeSelection(project, 'selection.json', [id]);
    const beforeManifestSha = await sha256File(collisionPath);
    const beforeManifestStat = await lstat(collisionPath);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: collisionRel,
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/collision.json',
      }),
    ).rejects.toThrow(/same as/);

    const afterManifestStat = await lstat(collisionPath);
    expect(await sha256File(collisionPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);
  });

  it('rejects output that is a hard link to the manifest file', async () => {
    const outputPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await link(manifestPath, outputPath);

    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/inode|same as/);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    const outputStat = await lstat(outputPath);
    expect(outputStat.isSymbolicLink()).toBe(false);
    expect(outputStat.dev).toBe(beforeManifestStat.dev);
    expect(outputStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects output that is a symlink to the manifest file', async () => {
    const outputPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await symlink(manifestPath, outputPath);

    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/resolves to the same file|same as/);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects a ./ alias output path that collides with the manifest file', async () => {
    const id = 'a'.repeat(64);
    const collisionRel = 'output/timelines/collision.json';
    const collisionPath = await writeManifest(project, collisionRel, [makeSegment(id, 'red.mp4', 'video', 2)]);
    const selectionPath = await writeSelection(project, 'selection.json', [id]);
    const beforeManifestSha = await sha256File(collisionPath);
    const beforeManifestStat = await lstat(collisionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: `./${collisionRel}`,
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: collisionRel,
      }),
    ).rejects.toThrow(/same as/);

    const afterManifestStat = await lstat(collisionPath);
    expect(await sha256File(collisionPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('cleans up temp files when a write failure occurs', async () => {
    await writeSelection(project, 'selection.json', [videoSegmentId]);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            beforeRename: async () => {
              throw new Error('injected failure');
            },
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);
  });

  it('preserves manifest and selection bytes and inodes after a successful write', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);

    await generateAndWriteTimeline({
      projectRoot: project,
      manifestRel: 'output/media-segments/manifest.json',
      selectionRel: 'selection.json',
      inputRoot: inputDir,
      outputRel: 'timelines/selected.json',
    });

    const afterManifestStat = await lstat(manifestPath);
    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);
  });

  it('rejects invalid UTF-8 in the selection file', async () => {
    const selectionPath = resolve(project, 'selection.json');
    await writeFile(selectionPath, Buffer.concat([Buffer.from('{ "segmentIds": ["'), Buffer.from([0x80]), Buffer.from('"] }')]));

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/not valid UTF-8/);
  });

  it('rejects malformed JSON in the selection file', async () => {
    await writeSelection(project, 'selection.json', [videoSegmentId]);
    await writeFile(resolve(project, 'bad-selection.json'), 'not json');

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'bad-selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('rejects an oversized selection file', async () => {
    const selectionPath = resolve(project, 'huge-selection.json');
    await writeFile(selectionPath, 'x'.repeat(20 * 1024 * 1024));

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'huge-selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/exceeds maximum size/);
  });
});

describe('selected source integrity', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let baseSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-integrity-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );
    baseSegment = manifest.segments.find((s) => s.mediaType === 'video')!;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function writeTamperedManifest(
    segments: MediaSegment[],
    relPath = 'manifest-tampered.json',
  ): Promise<string> {
    const manifest: MediaSegmentManifest = {
      schemaVersion: 'v1',
      count: segments.length,
      excludedCount: 0,
      excluded: [],
      segments,
    };
    const fullPath = resolve(project, relPath);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, JSON.stringify(manifest, null, 2) + '\n');
    return fullPath;
  }

  it('rejects a tampered segmentId', async () => {
    const tampered = { ...baseSegment, segmentId: 'a'.repeat(64) };
    const tamperedManifestPath = await writeTamperedManifest([tampered]);
    const selectionPath = await writeSelection(project, 'selection.json', [tampered.segmentId]);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeManifestSha = await sha256File(tamperedManifestPath);
    const beforeManifestStat = await lstat(tamperedManifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'manifest-tampered.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/invalid segmentId/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);

    const afterManifestStat = await lstat(tamperedManifestPath);
    expect(await sha256File(tamperedManifestPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects a non-zero start', async () => {
    const tampered: MediaSegment = {
      ...baseSegment,
      start: 100,
      end: 102,
      duration: 2,
      segmentId: computeSegmentId({
        assetContentId: baseSegment.assetContentId,
        relativePath: baseSegment.relativePath,
        mediaType: baseSegment.mediaType,
        start: 100,
        end: 102,
        duration: 2,
      }),
    };
    const tamperedManifestPath = await writeTamperedManifest([tampered]);
    const selectionPath = await writeSelection(project, 'selection.json', [tampered.segmentId]);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeManifestSha = await sha256File(tamperedManifestPath);
    const beforeManifestStat = await lstat(tamperedManifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'manifest-tampered.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/segment start must be 0/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);

    const afterManifestStat = await lstat(tamperedManifestPath);
    expect(await sha256File(tamperedManifestPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects an end/duration mismatch', async () => {
    const tampered: MediaSegment = {
      ...baseSegment,
      start: 0,
      end: 5,
      duration: 2,
      segmentId: computeSegmentId({
        assetContentId: baseSegment.assetContentId,
        relativePath: baseSegment.relativePath,
        mediaType: baseSegment.mediaType,
        start: 0,
        end: 5,
        duration: 2,
      }),
    };
    const tamperedManifestPath = await writeTamperedManifest([tampered]);
    const selectionPath = await writeSelection(project, 'selection.json', [tampered.segmentId]);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeManifestSha = await sha256File(tamperedManifestPath);
    const beforeManifestStat = await lstat(tamperedManifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'manifest-tampered.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/segment duration must equal end - start|segment end must equal duration/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);

    const afterManifestStat = await lstat(tamperedManifestPath);
    expect(await sha256File(tamperedManifestPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects a manifest duration that exceeds the actual source duration', async () => {
    const tampered: MediaSegment = {
      ...baseSegment,
      start: 0,
      end: 5,
      duration: 5,
      segmentId: computeSegmentId({
        assetContentId: baseSegment.assetContentId,
        relativePath: baseSegment.relativePath,
        mediaType: baseSegment.mediaType,
        start: 0,
        end: 5,
        duration: 5,
      }),
    };
    const tamperedManifestPath = await writeTamperedManifest([tampered]);
    const selectionPath = await writeSelection(project, 'selection.json', [tampered.segmentId]);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeManifestSha = await sha256File(tamperedManifestPath);
    const beforeManifestStat = await lstat(tamperedManifestPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'manifest-tampered.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/duration mismatch|exceeds source duration/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);

    const afterSelectionStat = await lstat(selectionPath);
    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);

    const afterManifestStat = await lstat(tamperedManifestPath);
    expect(await sha256File(tamperedManifestPath)).toBe(beforeManifestSha);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);
  });

  it('rejects a replaced source file', async () => {
    const originalSegment = baseSegment;
    const selectionPath = await writeSelection(project, 'selection.json', [originalSegment.segmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));

    // Replace the source with a different video, keeping the same relative path.
    await createVideo(join(inputDir, 'red.mp4'), 'blue', 2);
    expect(await sha256File(join(inputDir, 'red.mp4'))).not.toBe(beforeSourceSha);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/assetContentId mismatch/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    const afterSelectionStat = await lstat(selectionPath);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);
  });

  it('rejects a shortened source file', async () => {
    const originalSegment = baseSegment;
    const selectionPath = await writeSelection(project, 'selection.json', [originalSegment.segmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);

    // Replace the source with a shorter video; both assetContentId and duration will differ.
    await createVideo(join(inputDir, 'red.mp4'), 'red', 1);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
      }),
    ).rejects.toThrow(/assetContentId mismatch|duration mismatch/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    const afterSelectionStat = await lstat(selectionPath);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);
  });
});

describe('publish boundary input verification', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-boundary-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );
    videoSegment = manifest.segments.find((s) => s.mediaType === 'video')!;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects a source file swapped by the beforeRename hook', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            beforeRename: async () => {
              await createVideo(join(inputDir, 'red.mp4'), 'blue', 2);
            },
          },
        },
      }),
    ).rejects.toThrow(/Selected source .* changed before publish|changed after write|stat changed after write|content changed after write/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    const afterSelectionStat = await lstat(selectionPath);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);
  }, 60000);

  it('rejects a manifest file swapped by the beforeRename hook', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const beforeSelectionSha = await sha256File(selectionPath);
    const beforeSelectionStat = await lstat(selectionPath);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            beforeRename: async () => {
              const tamperedManifest: MediaSegmentManifest = {
                schemaVersion: 'v1',
                count: 1,
                excludedCount: 0,
                excluded: [],
                segments: [{ ...videoSegment, segmentId: 'a'.repeat(64) }],
              };
              await writeFile(manifestPath, JSON.stringify(tamperedManifest, null, 2) + '\n');
            },
          },
        },
      }),
    ).rejects.toThrow(/Media segment manifest .* changed before publish|changed after write|stat changed after write|content changed after write/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    expect(await sha256File(selectionPath)).toBe(beforeSelectionSha);
    const afterSelectionStat = await lstat(selectionPath);
    expect(afterSelectionStat.dev).toBe(beforeSelectionStat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelectionStat.ino);

    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);
  }, 60000);

  it('rejects a selection file swapped by the beforeRename hook', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const beforeManifestSha = await sha256File(manifestPath);
    const beforeManifestStat = await lstat(manifestPath);
    const beforeSourceSha = await sha256File(join(inputDir, 'red.mp4'));
    const beforeSourceStat = await lstat(join(inputDir, 'red.mp4'));

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            beforeRename: async () => {
              await writeFile(selectionPath, JSON.stringify({ segmentIds: ['a'.repeat(64)] }, null, 2) + '\n');
            },
          },
        },
      }),
    ).rejects.toThrow(/Segment selection .* changed before publish|changed after write|stat changed after write|content changed after write/);

    expect(existsSync(resolve(project, 'output', 'timelines', 'selected.json'))).toBe(false);
    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json')).toEqual([]);

    expect(await sha256File(manifestPath)).toBe(beforeManifestSha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifestStat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifestStat.ino);

    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSourceSha);
    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(afterSourceStat.dev).toBe(beforeSourceStat.dev);
    expect(afterSourceStat.ino).toBe(beforeSourceStat.ino);
  }, 60000);
});

describe('readJsonFileSafe identity barrier', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'read-json-safe-'));
  });

  afterEach(async () => {
    mockLstatState.triggerPath = null;
    mockLstatState.triggered = false;
    await rm(project, { recursive: true, force: true });
  });

  it('rejects a file replaced between lstat and open', async () => {
    const relPath = 'manifest.json';
    const fullPath = resolve(project, relPath);
    await mkdir(resolve(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, JSON.stringify({ ok: true }));

    mockLstatState.triggerPath = fullPath;
    mockLstatState.triggered = false;

    await expect(readJsonFileSafe(project, relPath)).rejects.toThrow(/was replaced between lstat and open/);
  });
});

describe('canonical path and rollback boundary', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-canonical-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );
    videoSegment = manifest.segments.find((s) => s.mediaType === 'video')!;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  interface FileSnapshot {
    sha: string;
    stat: Stats;
  }

  async function capture(path: string): Promise<FileSnapshot> {
    return { sha: await sha256File(path), stat: await lstat(path) };
  }

  async function assertUnchanged(path: string, snapshot: FileSnapshot): Promise<void> {
    const stat = await lstat(path);
    expect(stat.dev).toBe(snapshot.stat.dev);
    expect(stat.ino).toBe(snapshot.stat.ino);
    expect(stat.size).toBe(snapshot.stat.size);
    expect(stat.mtimeMs).toBe(snapshot.stat.mtimeMs);
    expect(await sha256File(path)).toBe(snapshot.sha);
  }

  async function assertNoFinalOrTemp(outputRel = 'timelines/selected.json'): Promise<void> {
    const finalPath = resolve(project, 'output', outputRel);
    expect(existsSync(finalPath)).toBe(false);
    const dir = resolve(project, 'output', 'timelines');
    const entries = await readdir(dir).catch(() => [] as string[]);
    const offenders = entries.filter((n) => n.endsWith('.tmp') || n === 'selected.json');
    expect(offenders).toEqual([]);
  }

  it('preserves an existing final when inputs change in the beforeRename hook', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const finalPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(finalPath, '..'), { recursive: true });
    await writeFile(finalPath, JSON.stringify({ existing: true }, null, 2) + '\n');

    const beforeFinal = await capture(finalPath);
    const beforeSelection = await capture(selectionPath);
    const beforeSource = await capture(join(inputDir, 'red.mp4'));

    const tamperedManifest: MediaSegmentManifest = {
      schemaVersion: 'v1',
      count: 1,
      excludedCount: 0,
      excluded: [],
      segments: [{ ...videoSegment, segmentId: 'a'.repeat(64) }],
    };

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            beforeRename: async () => {
              await writeFile(manifestPath, JSON.stringify(tamperedManifest, null, 2) + '\n');
            },
          },
        },
      }),
    ).rejects.toThrow(/Media segment manifest .* changed before publish|stat changed before publish|content changed before publish|canonical path changed/);

    // The pre-existing final must survive the failed publish.
    await assertUnchanged(finalPath, beforeFinal);

    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    await assertUnchanged(selectionPath, beforeSelection);
    await assertUnchanged(join(inputDir, 'red.mp4'), beforeSource);
  }, 60000);

  it('rejects a manifest whose parent directory was swapped to an external symlink', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const sourcePath = join(inputDir, 'red.mp4');
    const beforeSelection = await capture(selectionPath);
    const beforeSource = await capture(sourcePath);

    // Evil root outside the project: hard-link the manifest there, then swap
    // project/output for a symlink to evil root. The inode matches, but the
    // canonical realpath escapes projectRoot.
    const evilRoot = await mkdtemp(resolve(root, '..', 'short-video-evil-XXXXXX'));
    const evilManifestDir = resolve(evilRoot, 'media-segments');
    await mkdir(evilManifestDir, { recursive: true });
    const evilManifestPath = resolve(evilManifestDir, 'manifest.json');
    await link(manifestPath, evilManifestPath);

    try {
      await expect(
        generateAndWriteTimeline({
          projectRoot: project,
          manifestRel: 'output/media-segments/manifest.json',
          selectionRel: 'selection.json',
          inputRoot: inputDir,
          outputRel: 'timelines/selected.json',
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await rm(resolve(project, 'output'), { recursive: true, force: true });
                await symlink(evilRoot, resolve(project, 'output'));
              },
            },
          },
        }),
      ).rejects.toThrow(/Media segment manifest escaped trusted root|canonical path changed/);

      await assertNoFinalOrTemp();
      await assertUnchanged(selectionPath, beforeSelection);
      await assertUnchanged(sourcePath, beforeSource);
    } finally {
      await rm(evilRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 60000);

  it('rejects a source whose parent directory was swapped to an external symlink', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const sourcePath = join(inputDir, 'red.mp4');
    const beforeSelection = await capture(selectionPath);
    const beforeManifest = await capture(manifestPath);

    const evilRoot = await mkdtemp(resolve(root, '..', 'short-video-evil-XXXXXX'));
    const evilSourcePath = resolve(evilRoot, 'red.mp4');
    await fsPromises.copyFile(sourcePath, evilSourcePath);

    try {
      await expect(
        generateAndWriteTimeline({
          projectRoot: project,
          manifestRel: 'output/media-segments/manifest.json',
          selectionRel: 'selection.json',
          inputRoot: inputDir,
          outputRel: 'timelines/selected.json',
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await rm(inputDir, { recursive: true, force: true });
                await symlink(evilRoot, inputDir);
              },
            },
          },
        }),
      ).rejects.toThrow(/Selected source escaped trusted root|canonical path changed/);

      await assertNoFinalOrTemp();
      await assertUnchanged(selectionPath, beforeSelection);
      await assertUnchanged(manifestPath, beforeManifest);
    } finally {
      await rm(evilRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 60000);

  it('rejects an absolute output path before any write and preserves existing final', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const finalPath = resolve(project, 'output', 'timelines', 'selected.json');
    await mkdir(resolve(finalPath, '..'), { recursive: true });
    await writeFile(finalPath, JSON.stringify({ existing: true }, null, 2) + '\n');
    const beforeFinal = await capture(finalPath);
    const beforeSelection = await capture(selectionPath);
    const beforeManifest = await capture(manifestPath);
    const beforeSource = await capture(join(inputDir, 'red.mp4'));

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: '/timelines/selected.json',
      }),
    ).rejects.toThrow(/Absolute paths are not allowed/);

    await assertUnchanged(finalPath, beforeFinal);

    const outputDir = resolve(project, 'output', 'timelines');
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    await assertUnchanged(selectionPath, beforeSelection);
    await assertUnchanged(manifestPath, beforeManifest);
    await assertUnchanged(join(inputDir, 'red.mp4'), beforeSource);
  }, 60000);
});

describe('post-publish final swap safety', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegment: MediaSegment;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'segment-selection-post-swap-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    manifestPath = await writeMediaSegmentManifest(
      manifest,
      project,
      'media-segments/manifest.json',
      inputDir,
    );
    videoSegment = manifest.segments.find((s) => s.mediaType === 'video')!;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects a final swapped after the atomic rename and leaves it untouched', async () => {
    const selectionPath = await writeSelection(project, 'selection.json', [videoSegment.segmentId]);
    const outputDir = resolve(project, 'output', 'timelines');
    await mkdir(outputDir, { recursive: true });

    const outputPath = resolve(outputDir, 'selected.json');
    const swappedPath = resolve(outputDir, 'swapped.json');
    const swappedContent = JSON.stringify({ swapped: true }) + '\n';
    await writeFile(swappedPath, swappedContent);

    const beforeSource = { sha: await sha256File(join(inputDir, 'red.mp4')), stat: await lstat(join(inputDir, 'red.mp4')) };
    const beforeManifest = { sha: await sha256File(manifestPath), stat: await lstat(manifestPath) };
    const beforeSelection = { sha: await sha256File(selectionPath), stat: await lstat(selectionPath) };

    await expect(
      generateAndWriteTimeline({
        projectRoot: project,
        manifestRel: 'output/media-segments/manifest.json',
        selectionRel: 'selection.json',
        inputRoot: inputDir,
        outputRel: 'timelines/selected.json',
        __testHooks: {
          writeJsonAtomic: {
            afterRename: async (ctx) => {
              await rename(swappedPath, ctx.outputPath);
            },
          },
        },
      }),
    ).rejects.toThrow(/Committed output|does not match expected/);

    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toBe(swappedContent);

    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    expect(await sha256File(manifestPath)).toBe(beforeManifest.sha);
    const afterManifestStat = await lstat(manifestPath);
    expect(afterManifestStat.dev).toBe(beforeManifest.stat.dev);
    expect(afterManifestStat.ino).toBe(beforeManifest.stat.ino);

    expect(await sha256File(selectionPath)).toBe(beforeSelection.sha);
    const afterSelectionStat = await lstat(selectionPath);
    expect(afterSelectionStat.dev).toBe(beforeSelection.stat.dev);
    expect(afterSelectionStat.ino).toBe(beforeSelection.stat.ino);

    expect(await sha256File(join(inputDir, 'red.mp4'))).toBe(beforeSource.sha);
    const afterSourceStat = await lstat(join(inputDir, 'red.mp4'));
    expect(afterSourceStat.dev).toBe(beforeSource.stat.dev);
    expect(afterSourceStat.ino).toBe(beforeSource.stat.ino);
  }, 60000);
});

describe('segment-selection-cli', () => {
  let project: string;
  let inputDir: string;
  let manifestPath: string;
  let videoSegmentId: string;

  beforeEach(async () => {
    const outputRoot = join(root, 'output');
    await mkdir(outputRoot, { recursive: true });
    project = await mkdtemp(join(outputRoot, 'segment-selection-cli-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'red.mp4'), 'red', 2);

    const catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(catalog);
    const relFromOutput = relative(outputRoot, project).replace(/\\/g, '/');
    const manifestRel = `${relFromOutput}/media-segments/manifest.json`;
    manifestPath = await writeMediaSegmentManifest(manifest, root, manifestRel, inputDir);
    videoSegmentId = manifest.segments.find((s) => s.mediaType === 'video')!.segmentId;
  }, 60000);

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects an absolute output path before any write and preserves existing final', async () => {
    const selectionPath = join(project, 'selection.json');
    await writeFile(selectionPath, JSON.stringify({ segmentIds: [videoSegmentId] }, null, 2) + '\n');

    const finalPath = resolve(root, 'output', 'timelines', 'cli-absolute-test.json');
    await mkdir(resolve(finalPath, '..'), { recursive: true });
    await writeFile(finalPath, JSON.stringify({ existing: true }, null, 2) + '\n');
    const beforeFinal = { sha: await sha256File(finalPath), stat: await lstat(finalPath) };

    const manifestRel = relative(root, manifestPath).replace(/\\/g, '/');
    const selectionRel = relative(root, selectionPath).replace(/\\/g, '/');

    try {
      await expect(
        execFileAsync(tsx, [
          'src/segment-selection-cli.ts',
          manifestRel,
          selectionRel,
          inputDir,
          '/timelines/cli-absolute-test.json',
        ], { cwd: root }),
      ).rejects.toThrow(/Absolute paths are not allowed/);

      expect(await sha256File(finalPath)).toBe(beforeFinal.sha);
      const afterFinalStat = await lstat(finalPath);
      expect(afterFinalStat.dev).toBe(beforeFinal.stat.dev);
      expect(afterFinalStat.ino).toBe(beforeFinal.stat.ino);

      const outputDir = resolve(root, 'output', 'timelines');
      const entries = await readdir(outputDir).catch(() => [] as string[]);
      expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(finalPath, { force: true }).catch(() => {});
    }
  }, 60000);
});
