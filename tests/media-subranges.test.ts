import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  readdir,
  writeFile,
  link,
  symlink,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog } from '../src/catalog.js';
import type { Catalog } from '../src/catalog.js';
import { generate, ffprobe, sha256File, type Timeline } from '../src/core.js';
import { prepareFonts } from '../src/fixtures.js';
import {
  buildMediaSubrangeManifest,
  generateAndWriteMediaSubrangeManifest,
  readMediaSubrangeRequest,
  type MediaSubrange,
  type MediaSubrangeRequest,
} from '../src/media-subranges.js';
import {
  computeSegmentId,
  MEDIA_SUBRANGE_SCHEMA_VERSION,
  type MediaSegment,
} from '../src/media-segments.js';
import { generateAndWriteSubtitleTimeline } from '../src/transcript-subtitle-timeline.js';
import { generateAndWriteTranscriptManifest } from '../src/transcript-manifest.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Project {
  root: string;
  inputDir: string;
  outputDir: string;
  fontsDir: string;
  fontHash: string;
}

async function createVideo(filePath: string, color = 'blue', duration = 5): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
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
    '-t',
    String(duration),
    filePath,
  ]);
}

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

async function setupProject(): Promise<Project> {
  const tmp = await mkdtemp(join(root, 'tests', 'media-subranges-'));
  const inputDir = join(tmp, 'input');
  const outputDir = join(tmp, 'output');
  const fontsDir = join(tmp, 'fonts');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  const srcFont = join(root, 'fonts', 'DejaVuSans.ttf');
  const fontPath = join(fontsDir, 'DejaVuSans.ttf');
  await writeFile(fontPath, await readFile(srcFont));
  const fontHash = await sha256File(fontPath);

  return { root: tmp, inputDir, outputDir, fontsDir, fontHash };
}

function makeRangeRequest(ranges: MediaSubrange[]): MediaSubrangeRequest {
  return { schemaVersion: 'v1', ranges };
}

async function buildCatalog(inputDir: string): Promise<Catalog> {
  return generateCatalog(inputDir, { catalogRoot: 'input' });
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('media-subranges', () => {
  beforeAll(async () => {
    await prepareFonts(root);
  });

  let project: Project;
  let currentTmp: string | undefined;

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

  it('generates a canonical v2 manifest for two explicit ranges of the same video', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const rangeA: MediaSubrange = {
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    };
    const rangeB: MediaSubrange = {
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 2.5,
      end: 5,
    };

    const { manifest } = await buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([rangeA, rangeB]),
    });

    expect(manifest.schemaVersion).toBe(MEDIA_SUBRANGE_SCHEMA_VERSION);
    expect(manifest.count).toBe(2);
    expect(manifest.excludedCount).toBe(0);
    expect(manifest.segments).toHaveLength(2);

    const idA = computeSegmentId({
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      mediaType: 'video',
      start: 0,
      end: 2.5,
      duration: asset.probe!.duration as number,
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    });
    const idB = computeSegmentId({
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      mediaType: 'video',
      start: 2.5,
      end: 5,
      duration: asset.probe!.duration as number,
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    });

    const ids = manifest.segments.map((s) => s.segmentId);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);

    const first = JSON.stringify(manifest);
    const reversed = await buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([rangeB, rangeA]),
    });
    expect(JSON.stringify(reversed.manifest)).toBe(first);
  });

  it('deduplicates the canonical asset snapshot for multiple ranges of the same file', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const { verifiedAssets } = await buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 2.5, end: 5 },
      ]),
    });

    expect(verifiedAssets.size).toBe(1);
  });

  it('writes the manifest atomically with the default output path', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const rangeRequestRel = 'input/subranges.json';
    const catalogRel = 'input/catalog.json';

    await writeJson(project.root, rangeRequestRel, makeRangeRequest([
      { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
      { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 2.5, end: 5 },
    ]));
    await writeJson(project.root, catalogRel, catalog);

    const { outputPath } = await generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel,
      rangeRequestRel,
    });

    expect(outputPath).toBe(join(project.root, 'output', 'media-subranges', 'manifest.json'));
    const written = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(written.schemaVersion).toBe('v2');
    expect(written.count).toBe(2);
  });

  it('rejects out-of-bounds ranges and exact duplicates', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 6 },
      ]),
    })).rejects.toThrow(/exceeds source duration/);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
      ]),
    })).rejects.toThrow(/Duplicate range/);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 2.5, end: 2.5 },
      ]),
    })).rejects.toThrow(/start must be less than end/);
  });

  it('rejects unknown asset, SHA mismatch, and hard links', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    await link(join(project.inputDir, 'clip.mp4'), join(project.inputDir, 'alias.mp4'));
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const alias = catalog.assets.find((a) => a.relativePath === 'alias.mp4')!;

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'missing.mp4', start: 0, end: 2.5 },
      ]),
    })).rejects.toThrow(/Unknown asset/);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: '0'.repeat(64), relativePath: 'clip.mp4', start: 0, end: 2.5 },
      ]),
    })).rejects.toThrow(/assetContentId mismatch|SHA-256 mismatch/);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: alias.id!, relativePath: 'alias.mp4', start: 0, end: 2.5 },
      ]),
    })).rejects.toThrow(/hard link|multiple links/);
  });

  it('rejects malformed range request input', async () => {
    const badJsonPath = join(project.root, 'input', 'bad.json');
    await mkdir(dirname(badJsonPath), { recursive: true });
    await writeFile(badJsonPath, '{ invalid');
    await expect(readMediaSubrangeRequest(project.root, 'input/bad.json')).rejects.toThrow(/valid JSON/);

    const dupKeyPath = join(project.root, 'input', 'dupkey.json');
    await writeFile(
      dupKeyPath,
      '{"ranges":[{"assetContentId":"a","relativePath":"x.mp4","start":0,"end":1}],"schemaVersion":"v1","schemaVersion":"v1"}',
    );
    await expect(readMediaSubrangeRequest(project.root, 'input/dupkey.json')).rejects.toThrow(/duplicate key|Duplicate key/i);

    const unknownFieldPath = join(project.root, 'input', 'unknown.json');
    await writeFile(
      unknownFieldPath,
      '{"schemaVersion":"v1","ranges":[{"assetContentId":"a","relativePath":"x.mp4","start":0,"end":1,"unknown":true}]}',
    );
    await expect(readMediaSubrangeRequest(project.root, 'input/unknown.json')).rejects.toThrow();

    const badUtf8Path = join(project.root, 'input', 'badutf8.json');
    await writeFile(badUtf8Path, Buffer.concat([Buffer.from('{"schemaVersion":"v1","ranges":['), Buffer.from([0x80])]));
    await expect(readMediaSubrangeRequest(project.root, 'input/badutf8.json')).rejects.toThrow(/UTF-8/);
  });

  it('rejects traversal and dot-alias paths', async () => {
    const dummyId = 'a'.repeat(64);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog: { catalogRoot: 'input', count: 0, assets: [] },
      request: makeRangeRequest([
        { assetContentId: dummyId, relativePath: '../x.mp4', start: 0, end: 1 },
      ]),
    })).rejects.toThrow(/Invalid relativePath/);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog: { catalogRoot: 'input', count: 0, assets: [] },
      request: makeRangeRequest([
        { assetContentId: dummyId, relativePath: './clip.mp4', start: 0, end: 1 },
      ]),
    })).rejects.toThrow(/Invalid relativePath/);
  });

  it('produces a renderer-compatible subtitled Timeline from two ranges of the same video', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const mediaManifest = (await buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 2.5, end: 5 },
      ]),
    })).manifest;

    const segA = mediaManifest.segments.find((s) => s.start === 0)!;
    const segB = mediaManifest.segments.find((s) => s.start === 2.5)!;

    await writeJson(project.root, 'input/media-subranges.json', mediaManifest);

    const transcriptSource = {
      schemaVersion: 'v1' as const,
      entries: [
        { segmentId: segA.segmentId, start: 0, end: 1, text: 'First' },
        { segmentId: segB.segmentId, start: 3, end: 4, text: 'Second' },
      ],
    };
    await writeJson(project.root, 'input/transcript-source.json', transcriptSource);

    const { outputPath: transcriptPath } = await generateAndWriteTranscriptManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      mediaSegmentManifestRel: 'input/media-subranges.json',
      transcriptSourceRel: 'input/transcript-source.json',
      outputRel: 'transcripts/manifest.json',
    });

    const selection = { segmentIds: [segA.segmentId, segB.segmentId] };
    await writeJson(project.root, 'input/selection.json', selection);

    const style = { font: 'DejaVuSans.ttf', fontHash: project.fontHash, x: 540, y: 1500, fontSize: 100 };
    await writeJson(project.root, 'input/style.json', style);

    const result = await generateAndWriteSubtitleTimeline({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      mediaManifestRel: 'input/media-subranges.json',
      selectionRel: 'input/selection.json',
      transcriptManifestRel: relative(project.root, transcriptPath),
      styleRel: 'input/style.json',
      outputRel: 'timelines/subranges.json',
      fontsDir: project.fontsDir,
    });

    expect(result.timeline.width).toBe(1080);
    expect(result.timeline.height).toBe(1920);
    expect(result.timeline.fps).toBe(30);
    expect(result.timeline.clips).toHaveLength(2);
    expect(result.timeline.clips[0].type).toBe('video');
    expect(result.timeline.clips[0].in).toBe(0);
    expect(result.timeline.clips[0].out).toBe(2.5);
    expect(result.timeline.clips[0].start).toBe(0);
    expect(result.timeline.clips[0].end).toBe(2.5);
    expect(result.timeline.clips[1].in).toBe(2.5);
    expect(result.timeline.clips[1].out).toBe(5);
    expect(result.timeline.clips[1].start).toBe(2.5);
    expect(result.timeline.clips[1].end).toBe(5);

    expect(result.timeline.subtitles).toHaveLength(2);
    expect(result.timeline.subtitles?.[0]).toMatchObject({ start: 0, end: 1, text: 'First' });
    expect(result.timeline.subtitles?.[1]).toMatchObject({ start: 3, end: 4, text: 'Second' });

    const timelineBytes = await readFile(result.outputPath, 'utf8');
    const publishedSha = sha256Hex(timelineBytes);
    expect(publishedSha).toBe(result.timelineSha256);

    const publishedTimeline = JSON.parse(timelineBytes) as Timeline;
    expect(publishedTimeline).toEqual(result.timeline);

    const generated = await generate(publishedTimeline, {
      rootDir: project.root,
      fixturesDir: project.inputDir,
      outputDir: project.outputDir,
      fontsDir: project.fontsDir,
    });

    const probe = await ffprobe(generated.outputPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.duration).toBeCloseTo(5, 1);

    const videoSha = await sha256File(generated.outputPath);
    expect(videoSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an oversized range request', async () => {
    const big = JSON.stringify({
      schemaVersion: 'v1',
      ranges: Array.from({ length: 10 }, () => ({
        assetContentId: 'a'.repeat(64),
        relativePath: 'clip.mp4',
        start: 0,
        end: 1,
      })),
    });
    const p = join(project.root, 'input', 'big.json');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, big);
    await expect(
      readMediaSubrangeRequest(project.root, 'input/big.json', { maxBytes: 1 }),
    ).rejects.toThrow(/exceeds maximum size/);
  });

  it('rejects NaN, Infinity, and negative range bounds', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const base = { assetContentId: asset.id!, relativePath: 'clip.mp4' };

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([{ ...base, start: NaN, end: 1 }]),
    })).rejects.toThrow(/finite|number/i);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([{ ...base, start: 0, end: Infinity }]),
    })).rejects.toThrow(/finite|number/i);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([{ ...base, start: -0.5, end: 1 }]),
    })).rejects.toThrow(/greater than or equal to 0|non-negative|nonnegative/i);
  });

  it('rejects a range whose end exceeds the probed source duration', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([{
        assetContentId: asset.id!,
        relativePath: 'clip.mp4',
        start: 0,
        end: asset.probe!.duration as number + 0.5,
      }]),
    })).rejects.toThrow(/duration|exceeds.*duration|duration mismatch/i);
  });

  it('rejects a symlinked source', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const realAsset = await buildCatalog(project.inputDir);
    const asset = realAsset.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const linkPath = join(project.inputDir, 'symlink.mp4');
    await symlink(resolve(project.inputDir, 'clip.mp4'), linkPath);

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog: {
        catalogRoot: 'input',
        count: 1,
        assets: [{ ...asset, relativePath: 'symlink.mp4' }],
      } as Catalog,
      request: makeRangeRequest([{
        assetContentId: asset.id!,
        relativePath: 'symlink.mp4',
        start: 0,
        end: 1,
      }]),
    })).rejects.toThrow(/symbolic link|not a regular file/i);
  });

  it('rejects a symlink alias even when the real path is already verified', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const realCatalog = await buildCatalog(project.inputDir);
    const clipAsset = realCatalog.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const aliasAsset = { ...clipAsset, relativePath: 'alias.mp4' };
    await symlink(resolve(project.inputDir, 'clip.mp4'), join(project.inputDir, 'alias.mp4'));

    const catalog: Catalog = {
      catalogRoot: 'input',
      count: 2,
      assets: [clipAsset, aliasAsset],
    };

    await expect(buildMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalog,
      request: makeRangeRequest([
        { assetContentId: clipAsset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
        { assetContentId: clipAsset.id!, relativePath: 'alias.mp4', start: 2.5, end: 5 },
      ]),
    })).rejects.toThrow(/symbolic link|not a regular file|symlink/i);
  });

  it('rejects an output path that is a hard link to the catalog or request', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const requestPath = join(project.root, 'input', 'subranges.json');
    const request: MediaSubrangeRequest = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    const outputPath = join(project.root, 'output', 'media-subranges', 'manifest.json');
    await mkdir(dirname(outputPath), { recursive: true });
    await link(requestPath, outputPath);

    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
    })).rejects.toThrow(/same inode|same file|Output path/);
  });

  it('rejects a foreign final collision at the output path', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const request = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    const outputPath = join(project.root, 'output', 'media-subranges', 'manifest.json');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ foreign: true }) + '\n');

    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
    })).rejects.toThrow(/OUTPUT_COLLISION|already exists|foreign/i);
  });

  it('binds the same catalog bytes to the publish input and detects replacement before publish', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const request = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    let tampered = false;
    const catalogPath = join(project.root, 'input', 'catalog.json');
    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
      __testHooks: {
        beforeCatalogParse: async () => {
          if (tampered) return;
          tampered = true;
          await writeFile(catalogPath, JSON.stringify({ schemaVersion: 'v1', assets: [] }));
        },
      },
    })).rejects.toThrow(/changed|mismatch|INPUT_CHANGED|not.*regular/i);
  });

  it('survives an ABA restore of the catalog between read and publish', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const request = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    const catalogPath = join(project.root, 'input', 'catalog.json');
    const originalCatalogText = await readFile(catalogPath, 'utf8');
    const tamperedCatalog = JSON.stringify({ schemaVersion: 'v1', assets: [] });

    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
      __testHooks: {
        beforeCatalogParse: async () => {
          await writeFile(catalogPath, tamperedCatalog);
        },
        beforePublish: async () => {
          await writeFile(catalogPath, originalCatalogText);
        },
      },
    })).rejects.toThrow(/Catalog identity changed before snapshot|changed before snapshot/);
  });

  it('rejects a post-link foreign replacement of the published manifest', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const request = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
      __testHooks: {
        postLinkForeignReplace: true,
      },
    })).rejects.toThrow();

    const outputPath = join(project.root, 'output', 'media-subranges', 'manifest.json');
    const final = await readFile(outputPath, 'utf8').catch(() => null);
    if (final) {
      // The post-link hook replaced the committed file; verifying that the
      // function rejected the corrupted final is the important part.
      expect(final).toBe('foreign replacement');
    }
  });

  it('leaves no temp or residue after a publish failure', async () => {
    await createVideo(join(project.inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await buildCatalog(project.inputDir);
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const request = makeRangeRequest([{
      assetContentId: asset.id!,
      relativePath: 'clip.mp4',
      start: 0,
      end: 2.5,
    }]);
    await writeJson(project.root, 'input/subranges.json', request);
    await writeJson(project.root, 'input/catalog.json', catalog);

    // Foreign final at the output path forces the publish to fail with a collision.
    const outputPath = join(project.root, 'output', 'media-subranges', 'manifest.json');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ foreign: true }) + '\n');

    await expect(generateAndWriteMediaSubrangeManifest({
      projectRoot: project.root,
      inputRoot: project.inputDir,
      catalogRel: 'input/catalog.json',
      rangeRequestRel: 'input/subranges.json',
      outputRel: 'media-subranges/manifest.json',
    })).rejects.toThrow();

    const parent = dirname(outputPath);
    const leftover = await readdir(parent).catch(() => []);
    expect(leftover.filter((n) => /tmp|temp|\.\.\./i.test(n))).toEqual([]);
    const final = await readFile(outputPath, 'utf8');
    expect(JSON.parse(final)).toEqual({ foreign: true });
  });
});
