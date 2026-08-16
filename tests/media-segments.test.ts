import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  rm,
  readdir,
  readFile,
  writeFile,
  symlink,
  link,
  stat,
  lstat,
  readlink,
  open,
  chmod,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog } from '../src/catalog.js';
import type { Catalog, CatalogEntry } from '../src/catalog.js';
import { loadPreviousCatalog } from '../src/catalog-diff.js';
import {
  buildMediaSegmentManifest,
  generateAndWriteMediaSegmentManifest,
  writeMediaSegmentManifest,
  SEGMENT_SCHEMA_VERSION,
  ffprobeFromFd,
} from '../src/media-segments.js';
import { sha256File } from '../src/core.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = resolve(root, 'node_modules', '.bin', 'tsx');

async function createPng(filePath: string, color = 'red'): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=1080x1920`,
    '-frames:v',
    '1',
    filePath,
  ]);
}

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

function entry(
  relativePath: string,
  id: string | undefined,
  extra?: Partial<CatalogEntry>,
): CatalogEntry {
  return {
    relativePath,
    sizeBytes: 0,
    mtime: 0,
    id,
    ...extra,
  };
}

function catalog(assets: CatalogEntry[], catalogRoot = 'test'): Catalog {
  return { catalogRoot, count: assets.length, assets };
}

describe('buildMediaSegmentManifest', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'media-segments-input-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('generates full [0, duration] segments for video and audio fixtures', async () => {
    await createVideo(join(base, 'clip.mp4'), 'blue', 2.5);
    await createAudio(join(base, 'tone.mp3'), 3);

    const c = await generateCatalog(base, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(c);

    expect(manifest.schemaVersion).toBe(SEGMENT_SCHEMA_VERSION);
    expect(manifest.count).toBe(2);
    expect(manifest.excludedCount).toBe(0);
    expect(manifest.excluded).toEqual([]);
    expect(manifest.segments).toHaveLength(2);

    const video = manifest.segments.find((s) => s.mediaType === 'video');
    const audio = manifest.segments.find((s) => s.mediaType === 'audio');

    expect(video).toBeDefined();
    expect(video!.start).toBe(0);
    expect(video!.end).toBe(video!.duration);
    expect(video!.duration).toBeGreaterThan(0);
    expect(video!.relativePath).toBe('clip.mp4');
    expect(video!.assetContentId).toMatch(/^[0-9a-f]{64}$/);
    expect(video!.segmentId).toMatch(/^[0-9a-f]{64}$/);

    expect(audio).toBeDefined();
    expect(audio!.start).toBe(0);
    expect(audio!.end).toBe(audio!.duration);
    expect(audio!.duration).toBeGreaterThan(0);
    expect(audio!.relativePath).toBe('tone.mp3');

    const first = JSON.stringify(manifest);
    const second = JSON.stringify(buildMediaSegmentManifest(c));
    expect(second).toBe(first);
  });

  it('skips image, error entries, and invalid durations', async () => {
    await createPng(join(base, 'image.png'));
    await createVideo(join(base, 'valid.mp4'), 'blue', 2);
    const badPath = join(base, 'broken.mp4');
    await mkdir(resolve(badPath, '..'), { recursive: true });
    await writeFile(badPath, 'not a video');

    const c = await generateCatalog(base, { catalogRoot: 'test' });

    // Mutate the valid video to have a zero duration entry as well.
    const withInvalid = catalog(
      [
        ...c.assets,
        entry('zero.mp4', '0'.repeat(64), {
          probe: {
            type: 'video',
            hasAudio: false,
            audioStreams: [],
            duration: 0,
          },
        }),
      ],
      c.catalogRoot,
    );

    const manifest = buildMediaSegmentManifest(withInvalid);

    expect(manifest.segments).toHaveLength(1);
    expect(manifest.segments[0].relativePath).toBe('valid.mp4');
    expect(manifest.excludedCount).toBe(3);
    expect(manifest.excluded).toEqual([
      { relativePath: 'broken.mp4', reason: 'ERROR_ENTRY' },
      { relativePath: 'image.png', reason: 'UNSUPPORTED_MEDIA_TYPE' },
      { relativePath: 'zero.mp4', reason: 'INVALID_DURATION' },
    ]);
  });

  it('produces deterministic IDs, order, and JSON for duplicate content and non-ASCII paths', async () => {
    const source = join(base, 'source.mp4');
    await createVideo(source, 'blue', 2);
    await execFileAsync('cp', [source, join(base, 'copy.mp4')]);
    await execFileAsync('cp', [source, join(base, '動画.mp4')]);

    const c = await generateCatalog(base, { catalogRoot: 'test' });
    const manifest = buildMediaSegmentManifest(c);

    expect(manifest.segments).toHaveLength(3);
    const paths = manifest.segments.map((s) => s.relativePath);
    expect(new Set(paths).size).toBe(3);

    // UTF-8 byte order: 'copy.mp4' < 'source.mp4' < '動画.mp4'
    const sorted = [...manifest.segments].sort((a, b) =>
      Buffer.from(a.relativePath, 'utf8').compare(Buffer.from(b.relativePath, 'utf8')),
    );
    expect(manifest.segments).toEqual(sorted);

    const ids = new Set(manifest.segments.map((s) => s.segmentId));
    expect(ids.size).toBe(3);
    expect(manifest.excludedCount).toBe(0);
    expect(manifest.excluded).toEqual([]);

    const first = JSON.stringify(manifest);
    const second = JSON.stringify(buildMediaSegmentManifest(c));
    expect(second).toBe(first);
  });

  it('derives identical segment IDs from identical catalog entries', () => {
    const c = catalog([
      entry('a.mp4', 'a'.repeat(64), {
        probe: {
          type: 'video',
          hasAudio: false,
          audioStreams: [],
          duration: 5,
        },
      }),
    ]);
    const manifest = buildMediaSegmentManifest(c);
    const id1 = manifest.segments[0].segmentId;
    const id2 = buildMediaSegmentManifest(c).segments[0].segmentId;
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.excludedCount).toBe(0);
    expect(manifest.excluded).toEqual([]);
  });

  it('records explicit exclusion reasons for missing id and missing probe', () => {
    const c = catalog([
      entry('missing-id.mp4', undefined),
      entry('missing-probe.mp4', 'a'.repeat(64), { probe: undefined }),
    ]);

    const manifest = buildMediaSegmentManifest(c);
    expect(manifest.segments).toHaveLength(0);
    expect(manifest.excludedCount).toBe(2);
    expect(manifest.excluded).toEqual([
      { relativePath: 'missing-id.mp4', reason: 'MISSING_ID' },
      { relativePath: 'missing-probe.mp4', reason: 'MISSING_PROBE' },
    ]);
  });
});

describe('generateAndWriteMediaSegmentManifest', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'media-segments-project-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('writes a manifest atomically under the project output boundary', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const { outputPath, manifest } = await generateAndWriteMediaSegmentManifest(c, {
      projectRoot: project,
      inputRoot: inputDir,
    });

    expect(outputPath).toBe(resolve(project, 'output', 'media-segments', 'manifest.json'));
    const raw = await readFile(outputPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(manifest);
    expect(parsed.schemaVersion).toBe(SEGMENT_SCHEMA_VERSION);
    expect(parsed.excludedCount).toBe(0);
    expect(parsed.excluded).toEqual([]);

    const outputDir = resolve(project, 'output', 'media-segments');
    const files = await readdir(outputDir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output paths that escape or overlap the input directory', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    await expect(
      generateAndWriteMediaSegmentManifest(c, {
        projectRoot: project,
        inputRoot: inputDir,
        outputRel: '../input/manifest.json',
      }),
    ).rejects.toThrow(/traversal|not allowed|Invalid output/i);

    await expect(
      generateAndWriteMediaSegmentManifest(c, {
        projectRoot: project,
        inputRoot: inputDir,
        outputRel: '/tmp/manifest.json',
      }),
    ).rejects.toThrow(/Absolute|not allowed/);
  });

  it('rejects output through a symlinked output directory and leaves no external files', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const outputDir = join(project, 'output');
    const outside = join(project, 'outside');
    await mkdir(outside, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await symlink(outside, outputDir);

    await expect(
      generateAndWriteMediaSegmentManifest(c, {
        projectRoot: project,
        inputRoot: inputDir,
      }),
    ).rejects.toThrow(/symbolic link|not a directory|location does not match/i);

    expect(await readdir(outside)).toHaveLength(0);
  });

  it('cleans up temp files on failure and keeps input assets unchanged', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const before = await sha256File(join(inputDir, 'clip.mp4'));
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });

    await expect(
      generateAndWriteMediaSegmentManifest(c, {
        projectRoot: project,
        inputRoot: inputDir,
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp') || n === 'manifest.json')).toEqual([]);
    expect(await sha256File(join(inputDir, 'clip.mp4'))).toBe(before);
  });

  it('does not overwrite an existing manifest when a failure occurs before rename', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const outputDir = join(project, 'output', 'media-segments');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'manifest.json');
    await writeFile(finalPath, '{"existing":true}\n');

    await expect(
      generateAndWriteMediaSegmentManifest(c, {
        projectRoot: project,
        inputRoot: inputDir,
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    expect(await readFile(finalPath, 'utf8')).toBe('{"existing":true}\n');
    const entries = await readdir(outputDir);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output that is the same file as the previous catalog and leaves catalog bytes unchanged', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const catalogPath = join(project, 'output', 'catalog.json');
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c));
    const beforeSha = await sha256File(catalogPath);
    const beforeStat = await stat(catalogPath);

    await expect(
      writeMediaSegmentManifest(buildMediaSegmentManifest(c), project, 'catalog.json', inputDir, {
        previousCatalogPath: catalogPath,
      }),
    ).rejects.toThrow(/same as/);

    const afterSha = await sha256File(catalogPath);
    const afterStat = await stat(catalogPath);
    expect(afterSha).toBe(beforeSha);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output that is a hard link to the previous catalog and preserves both inodes and bytes', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const catalogPath = join(project, 'output', 'catalog.json');
    const outputPath = join(project, 'output', 'manifest.json');
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c));
    await link(catalogPath, outputPath);

    const beforeCatalogSha = await sha256File(catalogPath);
    const beforeOutputStat = await stat(outputPath);
    const beforeCatalogStat = await stat(catalogPath);
    expect(beforeOutputStat.dev).toBe(beforeCatalogStat.dev);
    expect(beforeOutputStat.ino).toBe(beforeCatalogStat.ino);

    await expect(
      writeMediaSegmentManifest(buildMediaSegmentManifest(c), project, 'manifest.json', inputDir, {
        previousCatalogPath: catalogPath,
      }),
    ).rejects.toThrow(/inode/);

    expect(await sha256File(catalogPath)).toBe(beforeCatalogSha);
    const afterCatalogStat = await stat(catalogPath);
    const afterOutputStat = await stat(outputPath);
    expect(afterCatalogStat.dev).toBe(beforeCatalogStat.dev);
    expect(afterCatalogStat.ino).toBe(beforeCatalogStat.ino);
    expect(afterOutputStat.dev).toBe(beforeOutputStat.dev);
    expect(afterOutputStat.ino).toBe(beforeOutputStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output that is a symlink to the previous catalog and preserves catalog bytes, inodes, and symlink target', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const catalogPath = join(project, 'output', 'catalog.json');
    const outputPath = join(project, 'output', 'manifest.json');
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c));
    await symlink(catalogPath, outputPath);

    const beforeCatalogSha = await sha256File(catalogPath);
    const beforeCatalogStat = await stat(catalogPath);
    const beforeOutputLstat = await lstat(outputPath);

    await expect(
      writeMediaSegmentManifest(buildMediaSegmentManifest(c), project, 'manifest.json', inputDir, {
        previousCatalogPath: catalogPath,
      }),
    ).rejects.toThrow(/resolves to the same file/);

    expect(await sha256File(catalogPath)).toBe(beforeCatalogSha);
    const afterCatalogStat = await stat(catalogPath);
    const afterOutputLstat = await lstat(outputPath);
    expect(afterCatalogStat.dev).toBe(beforeCatalogStat.dev);
    expect(afterCatalogStat.ino).toBe(beforeCatalogStat.ino);
    expect(afterOutputLstat.dev).toBe(beforeOutputLstat.dev);
    expect(afterOutputLstat.ino).toBe(beforeOutputLstat.ino);
    expect(afterOutputLstat.isSymbolicLink()).toBe(true);
    expect(await readlink(outputPath)).toBe(catalogPath);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output that is a ./ alias of the previous catalog and preserves catalog bytes and inodes', async () => {
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);
    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });

    const catalogPath = join(project, 'output', 'catalog.json');
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c));
    const beforeSha = await sha256File(catalogPath);
    const beforeStat = await stat(catalogPath);

    await expect(
      writeMediaSegmentManifest(buildMediaSegmentManifest(c), project, './catalog.json', inputDir, {
        previousCatalogPath: catalogPath,
      }),
    ).rejects.toThrow(/same as/);

    const afterSha = await sha256File(catalogPath);
    const afterStat = await stat(catalogPath);
    expect(afterSha).toBe(beforeSha);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('media-segments-cli', () => {
  let tmpBase: string;
  const outputBoundary = 'media-segments-test';

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(root, 'tests', 'media-segments-cli-'));
  });

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true });
    await rm(resolve(root, 'output', outputBoundary), { recursive: true, force: true });
  });

  it('loads a valid catalog and writes a manifest', async () => {
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);

    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const catalogPath = join(tmpBase, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify(c, null, 2) + '\n');

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');

    const { stdout } = await execFileAsync(tsx, [
      'src/media-segments-cli.ts',
      relCatalog,
      inputDir,
      `output/${outputBoundary}/manifest.json`,
    ]);

    expect(stdout).toContain('Media segment manifest written to');
    expect(stdout).toContain('(1 segments)');

    const outPath = resolve(root, 'output', outputBoundary, 'manifest.json');
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    expect(parsed.schemaVersion).toBe(SEGMENT_SCHEMA_VERSION);
    expect(parsed.count).toBe(1);
    expect(parsed.excludedCount).toBe(0);
    expect(parsed.excluded).toEqual([]);
    expect(parsed.segments[0].relativePath).toBe('clip.mp4');
  });

  it('rejects malformed catalog JSON', async () => {
    const catalogPath = join(tmpBase, 'catalog.json');
    await mkdir(resolve(catalogPath, '..'), { recursive: true });
    await writeFile(catalogPath, 'not json');

    const rel = relative(root, catalogPath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, ['src/media-segments-cli.ts', rel, tmpBase, `output/${outputBoundary}/manifest.json`]),
    ).rejects.toThrow(/not valid JSON|JSON/);
  });

  it('rejects output path that is the same as the catalog input and preserves catalog bytes', async () => {
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);

    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const catalogPath = resolve(root, 'output', outputBoundary, 'catalog.json');
    const outputDir = resolve(root, 'output', outputBoundary);
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c, null, 2) + '\n');
    const beforeSha = await sha256File(catalogPath);
    const beforeStat = await stat(catalogPath);

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/media-segments-cli.ts',
        relCatalog,
        inputDir,
        `output/${outputBoundary}/catalog.json`,
      ]),
    ).rejects.toThrow(/same as/);

    expect(await sha256File(catalogPath)).toBe(beforeSha);
    const afterStat = await stat(catalogPath);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output path that is a hard link to the catalog input and preserves inodes and bytes', async () => {
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);

    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const catalogPath = resolve(root, 'output', outputBoundary, 'catalog.json');
    const outputPath = resolve(root, 'output', outputBoundary, 'manifest.json');
    const outputDir = resolve(root, 'output', outputBoundary);
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c, null, 2) + '\n');
    await link(catalogPath, outputPath);

    const beforeCatalogSha = await sha256File(catalogPath);
    const beforeCatalogStat = await stat(catalogPath);
    const beforeOutputStat = await stat(outputPath);
    expect(beforeOutputStat.dev).toBe(beforeCatalogStat.dev);
    expect(beforeOutputStat.ino).toBe(beforeCatalogStat.ino);

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/media-segments-cli.ts',
        relCatalog,
        inputDir,
        `output/${outputBoundary}/manifest.json`,
      ]),
    ).rejects.toThrow(/inode/);

    expect(await sha256File(catalogPath)).toBe(beforeCatalogSha);
    const afterCatalogStat = await stat(catalogPath);
    const afterOutputStat = await stat(outputPath);
    expect(afterCatalogStat.dev).toBe(beforeCatalogStat.dev);
    expect(afterCatalogStat.ino).toBe(beforeCatalogStat.ino);
    expect(afterOutputStat.dev).toBe(beforeOutputStat.dev);
    expect(afterOutputStat.ino).toBe(beforeOutputStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output path that is a symlink to the catalog input and preserves catalog bytes, inodes, and symlink target', async () => {
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);

    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const catalogPath = resolve(root, 'output', outputBoundary, 'catalog.json');
    const outputPath = resolve(root, 'output', outputBoundary, 'manifest.json');
    const outputDir = resolve(root, 'output', outputBoundary);
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c, null, 2) + '\n');
    await symlink(catalogPath, outputPath);

    const beforeCatalogSha = await sha256File(catalogPath);
    const beforeCatalogStat = await stat(catalogPath);
    const beforeOutputLstat = await lstat(outputPath);

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');

    await expect(
      execFileAsync(tsx, [
        'src/media-segments-cli.ts',
        relCatalog,
        inputDir,
        `output/${outputBoundary}/manifest.json`,
      ]),
    ).rejects.toThrow(/resolves to the same file/);

    expect(await sha256File(catalogPath)).toBe(beforeCatalogSha);
    const afterCatalogStat = await stat(catalogPath);
    const afterOutputLstat = await lstat(outputPath);
    expect(afterCatalogStat.dev).toBe(beforeCatalogStat.dev);
    expect(afterCatalogStat.ino).toBe(beforeCatalogStat.ino);
    expect(afterOutputLstat.dev).toBe(beforeOutputLstat.dev);
    expect(afterOutputLstat.ino).toBe(beforeOutputLstat.ino);
    expect(afterOutputLstat.isSymbolicLink()).toBe(true);
    expect(await readlink(outputPath)).toBe(catalogPath);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects ./ alias catalog path that collides with output and preserves catalog bytes and inodes', async () => {
    const inputDir = join(tmpBase, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 2);

    const c = await generateCatalog(inputDir, { catalogRoot: 'test' });
    const catalogPath = resolve(root, 'output', outputBoundary, 'catalog.json');
    const outputDir = resolve(root, 'output', outputBoundary);
    await mkdir(outputDir, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(c, null, 2) + '\n');
    const beforeSha = await sha256File(catalogPath);
    const beforeStat = await stat(catalogPath);

    await expect(
      execFileAsync(tsx, [
        'src/media-segments-cli.ts',
        `./output/${outputBoundary}/catalog.json`,
        inputDir,
        `output/${outputBoundary}/catalog.json`,
      ]),
    ).rejects.toThrow(/same as/);

    expect(await sha256File(catalogPath)).toBe(beforeSha);
    const afterStat = await stat(catalogPath);
    expect(afterStat.dev).toBe(beforeStat.dev);
    expect(afterStat.ino).toBe(beforeStat.ino);
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ffprobeFromFd option validation', () => {
  let tmp: string;
  let fh: import('node:fs/promises').FileHandle;

  beforeEach(async () => {
    tmp = await mkdtemp(join(root, 'tests', 'ffprobe-validate-'));
    const p = join(tmp, 'clip.mp4');
    await createVideo(p, 'blue', 1);
    fh = await open(p, 'r');
  });

  afterEach(async () => {
    await fh?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects NaN timeoutMs before spawn', async () => {
    await expect(
      (async () => ffprobeFromFd(fh.fd, { timeoutMs: NaN }))(),
    ).rejects.toThrow(/timeoutMs must be a finite positive safe integer/);
  });

  it('rejects Infinity maxStdoutBytes before spawn', async () => {
    await expect(
      (async () => ffprobeFromFd(fh.fd, { maxStdoutBytes: Infinity }))(),
    ).rejects.toThrow(/maxStdoutBytes must be a finite positive safe integer/);
  });

  it('rejects non-positive and non-integer maxStderrBytes before spawn', async () => {
    await expect(
      (async () => ffprobeFromFd(fh.fd, { maxStderrBytes: 0 }))(),
    ).rejects.toThrow(/maxStderrBytes must be a finite positive safe integer/);
    await expect(
      (async () => ffprobeFromFd(fh.fd, { maxStderrBytes: -1 }))(),
    ).rejects.toThrow(/maxStderrBytes must be a finite positive safe integer/);
    await expect(
      (async () => ffprobeFromFd(fh.fd, { maxStderrBytes: 1.5 }))(),
    ).rejects.toThrow(/maxStderrBytes must be a finite positive safe integer/);
  });

  it('uses valid custom limits', async () => {
    const probe = await ffprobeFromFd(fh.fd, {
      timeoutMs: 10_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
    });
    expect(probe.hasVideo).toBe(true);
    expect(probe.duration).toBe(1);
  });
});

describe('ffprobeFromFd bounded subprocess', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(root, 'tests', 'ffprobe-bounded-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function fakeProbe(name: string, body: string): Promise<string> {
    const p = join(tmp, name);
    await writeFile(p, body);
    await chmod(p, 0o755);
    return p;
  }

  async function dummyFd(): Promise<import('node:fs/promises').FileHandle> {
    const p = join(tmp, 'dummy.mp4');
    const fh = await open(p, 'w+');
    await fh.write('x');
    await fh.sync();
    return fh;
  }

  it('parses a valid ffprobe JSON response', async () => {
    const script = await fakeProbe(
      'ffprobe',
      `#!/usr/bin/env python3
import json, sys
print(json.dumps({
  "streams": [{"codec_type": "video", "width": 1080, "height": 1920, "avg_frame_rate": "30/1", "duration": "5"}],
  "format": {"duration": "5"}
}))
`,
    );
    const fh = await dummyFd();
    try {
      const probe = await ffprobeFromFd(fh.fd, { command: script, timeoutMs: 5000 });
      expect(probe.hasVideo).toBe(true);
      expect(probe.width).toBe(1080);
      expect(probe.duration).toBe(5);
    } finally {
      await fh.close();
    }
  });

  it('rejects on non-zero early exit and captures stderr', async () => {
    const script = await fakeProbe(
      'ffprobe',
      `#!/usr/bin/env python3
import sys
print('ffprobe failed', file=sys.stderr)
sys.exit(1)
`,
    );
    const fh = await dummyFd();
    await expect(
      ffprobeFromFd(fh.fd, { command: script, timeoutMs: 5000 }).finally(() => fh.close()),
    ).rejects.toThrow(/ffprobe failed with 1/);
  });

  it('terminates on stdout flood and waits for child close', async () => {
    const script = await fakeProbe(
      'ffprobe',
      `#!/usr/bin/env python3
import sys
sys.stdout.write('x' * (2 * 1024 * 1024))
sys.stdout.flush()
`,
    );
    const fh = await dummyFd();
    await expect(
      ffprobeFromFd(fh.fd, { command: script, timeoutMs: 5000, maxStdoutBytes: 1024 }).finally(() =>
        fh.close(),
      ),
    ).rejects.toThrow(/stdout exceeded/);
  });

  it('terminates on stderr flood', async () => {
    const script = await fakeProbe(
      'ffprobe',
      `#!/usr/bin/env python3
import sys
sys.stderr.write('e' * (128 * 1024))
sys.stderr.flush()
`,
    );
    const fh = await dummyFd();
    await expect(
      ffprobeFromFd(fh.fd, { command: script, timeoutMs: 5000, maxStderrBytes: 1024 }).finally(() =>
        fh.close(),
      ),
    ).rejects.toThrow(/stderr exceeded/);
  });

  it('sends SIGKILL when the child ignores SIGTERM', async () => {
    const script = await fakeProbe(
      'ffprobe',
      `#!/usr/bin/env python3
import signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(100)
`,
    );
    const fh = await dummyFd();
    const start = Date.now();
    await expect(
      ffprobeFromFd(fh.fd, { command: script, timeoutMs: 100 }).finally(() => fh.close()),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});

describe('catalog validation reuse', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'media-segments-catval-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects malformed JSON, invalid UTF-8, and absolute/traversal relativePaths', async () => {
    const badCatalogPath = join(project, 'bad.json');
    await mkdir(resolve(badCatalogPath, '..'), { recursive: true });

    await writeFile(badCatalogPath, 'not json');
    await expect(loadPreviousCatalog(project, 'bad.json')).rejects.toThrow(/not valid JSON/);

    const traversalCatalog = {
      catalogRoot: 'x',
      count: 1,
      assets: [
        {
          relativePath: '../escape.mp4',
          sizeBytes: 0,
          mtime: 0,
          id: '0'.repeat(64),
        },
      ],
    };
    await writeFile(badCatalogPath, JSON.stringify(traversalCatalog));
    await expect(loadPreviousCatalog(project, 'bad.json')).rejects.toThrow(/Invalid relativePath/);

    const validCatalog = {
      catalogRoot: 'x',
      count: 1,
      assets: [
        {
          relativePath: 'a.mp4',
          sizeBytes: 0,
          mtime: 0,
          id: '0'.repeat(64),
        },
      ],
    };
    await writeFile(
      badCatalogPath,
      Buffer.concat([Buffer.from(JSON.stringify(validCatalog)), Buffer.from([0x80])]),
    );
    await expect(loadPreviousCatalog(project, 'bad.json')).rejects.toThrow(/UTF-8/);
  });

  it('rejects oversized catalogs with resource bounds', async () => {
    const badCatalogPath = join(project, 'bad.json');
    await mkdir(resolve(badCatalogPath, '..'), { recursive: true });

    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      relativePath: `a${i}.mp4`,
      sizeBytes: 0,
      mtime: 0,
      id: '0'.repeat(64),
    }));
    await writeFile(
      badCatalogPath,
      JSON.stringify({ catalogRoot: 'x', count: 11, assets: tooMany }),
    );
    await expect(
      loadPreviousCatalog(project, 'bad.json', { maxAssets: 10 }),
    ).rejects.toThrow(/too many assets/);

    await writeFile(badCatalogPath, 'x'.repeat(101));
    await expect(
      loadPreviousCatalog(project, 'bad.json', { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds maximum size/);
  });
});
