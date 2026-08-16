import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  generateCatalog,
  writeCatalog,
  writeJsonAtomic,
  ALLOWED_EXTENSIONS,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} from '../src/catalog.js';
import { computeCatalogDiff } from '../src/catalog-diff.js';
import { verifyThumbnail } from '../src/thumbnails.js';
import { sha256File } from '../src/core.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

async function createVideo(filePath: string, color = 'blue', duration = 2): Promise<void> {
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

async function fixedMtime(filePath: string): Promise<void> {
  const t = new Date(1704067200000);
  await utimes(filePath, t, t);
}

async function copyTree(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true });
}

describe('generateCatalog', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'catalog-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('catalogs image, video and audio with probe fields', async () => {
    await createPng(join(base, 'red.png'));
    await createVideo(join(base, 'blue.mp4'), 'blue', 3);
    await createAudio(join(base, 'tone.mp3'), 4);

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });

    expect(catalog.count).toBe(3);
    expect(catalog.catalogRoot).toBe('test');
    expect(catalog.assets.map((a) => a.relativePath)).toEqual([
      'blue.mp4',
      'red.png',
      'tone.mp3',
    ]);

    const image = catalog.assets.find((a) => a.relativePath === 'red.png');
    expect(image?.probe?.type).toBe('image');
    expect(image?.probe?.width).toBe(1080);
    expect(image?.probe?.height).toBe(1920);
    expect(image?.probe?.videoCodec).toBe('png');
    expect(image?.probe?.hasAudio).toBe(false);

    const video = catalog.assets.find((a) => a.relativePath === 'blue.mp4');
    expect(video?.probe?.type).toBe('video');
    expect(video?.probe?.width).toBe(1080);
    expect(video?.probe?.height).toBe(1920);
    expect(video?.probe?.videoCodec).toBe('h264');
    expect(video?.probe?.fps).toBe(30);
    expect(video?.probe?.duration).toBe(3);

    const audio = catalog.assets.find((a) => a.relativePath === 'tone.mp3');
    expect(audio?.probe?.type).toBe('audio');
    expect(audio?.probe?.hasAudio).toBe(true);
    expect(audio?.probe?.audioCodec).toBe('mp3');
    expect(audio?.probe?.audioStreams?.[0].sampleRate).toBe(44100);
    expect(audio?.probe?.duration).toBeGreaterThan(0);
  });

  it('ignores unsupported extensions', async () => {
    await createPng(join(base, 'valid.png'));
    await writeFile(join(base, 'notes.txt'), 'not media');
    await writeFile(join(base, 'archive.zip'), 'fake zip');

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });

    expect(catalog.assets.map((a) => a.relativePath)).toEqual(['valid.png']);
  });

  it('marks broken media with an error without affecting other assets', async () => {
    await writeFile(join(base, 'broken.mp4'), Buffer.from('this is not a video'));
    await createPng(join(base, 'ok.png'));

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });

    expect(catalog.count).toBe(2);
    const broken = catalog.assets.find((a) => a.relativePath === 'broken.mp4');
    const ok = catalog.assets.find((a) => a.relativePath === 'ok.png');
    expect(broken?.error).toBeTruthy();
    expect(broken?.error?.code).toBe('INVALID_DATA');
    expect(broken?.probe).toBeUndefined();
    expect(ok?.probe?.type).toBe('image');
  });

  it('detects extension spoof', async () => {
    const pngPath = join(base, 'real.png');
    await createPng(pngPath, 'green');
    await copyFile(pngPath, join(base, 'spoof.mp3'));
    await copyFile(pngPath, join(base, 'spoof.mp4'));

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });

    const spoofMp3 = catalog.assets.find((a) => a.relativePath === 'spoof.mp3');
    const spoofMp4 = catalog.assets.find((a) => a.relativePath === 'spoof.mp4');
    expect(spoofMp3?.error?.code).toBe('EXTENSION_MISMATCH');
    expect(spoofMp4?.error?.code).toBe('EXTENSION_MISMATCH');
  });

  it('does not follow symlink files or directories', async () => {
    const outside = await mkdtemp(join(root, 'tests', 'outside-'));
    try {
      await createPng(join(outside, 'outside.png'));
      await createPng(join(base, 'inside.png'));

      await symlink(join(outside, 'outside.png'), join(base, 'link.png'));
      await symlink(outside, join(base, 'linkdir'));

      const catalog = await generateCatalog(base, { catalogRoot: 'test' });
      const paths = catalog.assets.map((a) => a.relativePath);
      expect(paths).toEqual(['inside.png']);
      expect(paths).not.toContain('link.png');
      expect(paths).not.toContain('linkdir/outside.png');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('produces deterministic JSON for identical input', async () => {
    await createPng(join(base, 'a.png'), 'red');
    await createVideo(join(base, 'b.mp4'), 'blue', 1);
    await fixedMtime(join(base, 'a.png'));
    await fixedMtime(join(base, 'b.mp4'));

    const first = JSON.stringify(await generateCatalog(base, { catalogRoot: 'test' }));
    const second = JSON.stringify(await generateCatalog(base, { catalogRoot: 'test' }));
    expect(second).toBe(first);
  });

  it('is deterministic across different absolute root directories', async () => {
    const src = join(base, 'src');
    await mkdir(src, { recursive: true });
    await createPng(join(src, 'same.png'));
    await createAudio(join(src, 'same.mp3'), 2);
    await writeFile(join(src, 'broken.mp4'), Buffer.from('not a video'));
    for (const f of ['same.png', 'same.mp3', 'broken.mp4']) {
      await fixedMtime(join(src, f));
    }

    const rootA = join(base, 'rootA');
    const rootB = join(base, 'rootB');
    await copyTree(src, rootA);
    await copyTree(src, rootB);
    for (const f of ['same.png', 'same.mp3', 'broken.mp4']) {
      await fixedMtime(join(rootA, f));
      await fixedMtime(join(rootB, f));
    }

    const a = await generateCatalog(rootA, { catalogRoot: 'common' });
    const b = await generateCatalog(rootB, { catalogRoot: 'common' });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.catalogRoot).toBe('common');
    expect(a.assets.find((x) => x.relativePath === 'broken.mp4')?.error?.message).toBe(
      'Media data could not be parsed',
    );
  });

  it('generates duplicate groups for identical content under different paths', async () => {
    const src = join(base, 'src');
    await mkdir(src, { recursive: true });
    await createPng(join(src, 'same.png'));
    await mkdir(join(base, 'copy1'), { recursive: true });
    await mkdir(join(base, 'copy2'), { recursive: true });
    await copyFile(join(src, 'same.png'), join(base, 'copy1', 'same.png'));
    await copyFile(join(src, 'same.png'), join(base, 'copy2', 'same.png'));

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });
    expect(catalog.count).toBe(3);
    const ids = catalog.assets.map((a) => a.id).filter(Boolean);
    expect(new Set(ids).size).toBe(1);

    const rep = catalog.assets.find((a) => a.duplicatePaths);
    const dups = catalog.assets.filter((a) => a.duplicateOf);
    expect(rep?.relativePath).toBe('copy1/same.png');
    expect(rep?.duplicatePaths?.sort()).toEqual(['copy2/same.png', 'src/same.png']);
    expect(dups).toHaveLength(2);
    expect(dups.every((d) => d.duplicateOf === rep?.relativePath)).toBe(true);
  });

  it('produces deterministic duplicate metadata for same-hash non-ASCII paths', async () => {
    const src = join(base, 'src');
    await mkdir(src, { recursive: true });
    const seed = join(base, 'seed.png');
    await createPng(seed, 'red');

    const names = ['Á.png', 'A\u0301.png', 'Z.png'];
    for (const name of names) {
      await copyFile(seed, join(src, name));
      await fixedMtime(join(src, name));
    }

    const sorted = [...names].sort((a, b) =>
      Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8')),
    );

    const catalog1 = await generateCatalog(src, {
      catalogRoot: 'test',
      projectRoot: base,
      thumbnailDir: join(base, 'thumbs'),
    });
    const json1 = JSON.stringify(catalog1);
    const sha1 = createHash('sha256').update(json1).digest('hex');

    const catalog2 = await generateCatalog(src, {
      catalogRoot: 'test',
      projectRoot: base,
      thumbnailDir: join(base, 'thumbs'),
    });
    const json2 = JSON.stringify(catalog2);
    expect(json2).toBe(json1);
    expect(createHash('sha256').update(json2).digest('hex')).toBe(sha1);

    const rep = catalog1.assets.find((a) => a.duplicatePaths);
    const dups = catalog1.assets.filter((a) => a.duplicateOf);
    expect(rep).toBeTruthy();
    expect(rep?.relativePath).toBe(sorted[0]);
    expect(rep?.duplicatePaths).toEqual([sorted[1], sorted[2]]);
    expect(dups).toHaveLength(2);
    expect(dups.every((d) => d.duplicateOf === rep?.relativePath)).toBe(true);

    const diff = computeCatalogDiff(catalog1, catalog2);
    expect(diff.unchanged).toHaveLength(3);
    expect(diff.unchanged.map((e) => e.relativePath)).toEqual(sorted);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.moved).toHaveLength(0);
  }, 60000);

  it('keeps source SHA-256 unchanged and matches asset id', async () => {
    const file = join(base, 'keep.png');
    await createPng(file);
    const before = await sha256File(file);

    const catalog = await generateCatalog(base, { catalogRoot: 'test' });

    const after = await sha256File(file);
    expect(after).toBe(before);
    expect(catalog.assets[0].id).toBe(before);
  });

  it('accepts an absolute input directory', async () => {
    await createPng(join(base, 'x.png'));
    const catalog = await generateCatalog(base, { catalogRoot: 'test' });
    expect(catalog.assets[0].relativePath).toBe('x.png');
  });

  it('resolves input paths containing .. to a real directory', async () => {
    const child = join(base, 'child');
    await mkdir(child, { recursive: true });
    await createPng(join(child, 'nested.png'));
    const catalog = await generateCatalog(join(child, '..'), { catalogRoot: 'test' });
    expect(catalog.assets[0].relativePath).toBe('child/nested.png');
  });

  it('rejects an input directory that is itself a symlink', async () => {
    const realDir = await mkdtemp(join(root, 'tests', 'real-'));
    const linkDir = `${realDir}-link`;
    try {
      await createPng(join(realDir, 'img.png'));
      await symlink(realDir, linkDir);
      await expect(generateCatalog(linkDir)).rejects.toThrow('symbolic link');
    } finally {
      await rm(realDir, { recursive: true, force: true });
      try {
        await rm(linkDir, { force: true });
      } catch {}
    }
  });

  it('limits concurrent processing', async () => {
    await mkdir(join(base, 'files'), { recursive: true });
    for (let i = 0; i < 6; i++) {
      await createPng(join(base, 'files', `${i}.png`));
    }
    const catalog = await generateCatalog(base, { catalogRoot: 'test', concurrency: 2 });
    expect(catalog.count).toBe(6);
    expect(catalog.assets[0].relativePath).toBe('files/0.png');
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_CONCURRENCY + 1])(
    'rejects invalid concurrency %s',
    async (value) => {
      await expect(
        generateCatalog(base, { concurrency: value as number }),
      ).rejects.toThrow('concurrency');
    },
  );

  it('accepts boundary concurrency values', async () => {
    await createPng(join(base, 'a.png'));
    const min = await generateCatalog(base, { catalogRoot: 'test', concurrency: 1 });
    expect(min.count).toBe(1);
    const max = await generateCatalog(base, {
      catalogRoot: 'test',
      concurrency: MAX_CONCURRENCY,
    });
    expect(max.count).toBe(1);
  });

  it('reports hash failure via injectable seam without affecting other assets', async () => {
    await createPng(join(base, 'ok.png'));
    await createPng(join(base, 'fail.png'));
    const injected: (path: string) => Promise<string> = async (path) => {
      if (basename(path) === 'fail.png') throw new Error('injected hash failure');
      return sha256File(path);
    };

    const catalog = await generateCatalog(base, {
      catalogRoot: 'test',
      hashFile: injected,
    });

    const failed = catalog.assets.find((a) => a.relativePath === 'fail.png');
    const ok = catalog.assets.find((a) => a.relativePath === 'ok.png');

    expect(failed?.id).toBeUndefined();
    expect(failed?.error?.code).toBe('HASH_FAILED');
    expect(failed?.duplicateOf).toBeUndefined();
    expect(failed?.duplicatePaths).toBeUndefined();
    expect(ok?.probe?.type).toBe('image');
  });

  it('does not merge hash-failed assets into duplicate groups', async () => {
    const src = join(base, 'src');
    await mkdir(src, { recursive: true });
    await createPng(join(src, 'same.png'));
    await mkdir(join(base, 'copy'), { recursive: true });
    await copyFile(join(src, 'same.png'), join(base, 'copy', 'same.png'));

    const calls: string[] = [];
    const injected: (path: string) => Promise<string> = async (path) => {
      calls.push(basename(path));
      if (basename(path) === 'same.png' && path.includes('/copy/')) {
        throw new Error('injected hash failure');
      }
      return sha256File(path);
    };

    const catalog = await generateCatalog(base, {
      catalogRoot: 'test',
      hashFile: injected,
    });

    const srcAsset = catalog.assets.find((a) => a.relativePath === 'src/same.png');
    const copyAsset = catalog.assets.find((a) => a.relativePath === 'copy/same.png');

    expect(srcAsset?.id).toBeTruthy();
    expect(srcAsset?.duplicatePaths).toBeUndefined();
    expect(copyAsset?.id).toBeUndefined();
    expect(copyAsset?.error?.code).toBe('HASH_FAILED');
    expect(copyAsset?.duplicateOf).toBeUndefined();
  });

  it('exports a non-empty allowlist', () => {
    expect(ALLOWED_EXTENSIONS.length).toBeGreaterThan(0);
    expect(ALLOWED_EXTENSIONS).toContain('.png');
    expect(ALLOWED_EXTENSIONS).toContain('.mp4');
    expect(ALLOWED_EXTENSIONS).toContain('.mp3');
  });

  it('has a positive default concurrency', () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });
});

describe('catalog thumbnails', () => {
  let base: string;
  let project: string;
  let inputDir: string;
  let thumbnailDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'catalog-thumbs-'));
    project = base;
    inputDir = join(base, 'input');
    thumbnailDir = join(project, 'output', 'catalog-thumbnails');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('generates JPG thumbnails for image and video entries', async () => {
    await createPng(join(inputDir, 'red.png'));
    await createVideo(join(inputDir, 'blue.mp4'), 'blue', 2);
    await createAudio(join(inputDir, 'tone.mp3'), 2);

    const catalog = await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });

    expect(catalog.count).toBe(3);
    const image = catalog.assets.find((a) => a.relativePath === 'red.png');
    const video = catalog.assets.find((a) => a.relativePath === 'blue.mp4');
    const audio = catalog.assets.find((a) => a.relativePath === 'tone.mp3');

    expect(image?.thumbnail).toBeTruthy();
    expect(image?.thumbnail?.identifier).toMatch(/^output\/catalog-thumbnails\/v1-480-[0-9a-f]{64}\.jpg$/);
    expect(image?.thumbnail?.sha256).toHaveLength(64);
    expect(image?.thumbnail?.width).toBeGreaterThan(0);
    expect(image?.thumbnail?.height).toBeGreaterThan(0);

    expect(video?.thumbnail).toBeTruthy();
    expect(video?.thumbnail?.identifier).toMatch(/^output\/catalog-thumbnails\/v1-480-[0-9a-f]{64}\.jpg$/);
    expect(video?.thumbnail?.width).toBeGreaterThan(0);
    expect(video?.thumbnail?.height).toBeGreaterThan(0);

    expect(audio?.thumbnail).toBeUndefined();
  }, 30000);

  it('reuses the same thumbnail for duplicate content', async () => {
    await createPng(join(inputDir, 'original.png'));
    await copyFile(join(inputDir, 'original.png'), join(inputDir, 'copy.png'));

    const catalog = await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });

    const original = catalog.assets.find((a) => a.relativePath === 'original.png');
    const copy = catalog.assets.find((a) => a.relativePath === 'copy.png');

    expect(original?.thumbnail?.identifier).toBe(copy?.thumbnail?.identifier);
    expect(original?.thumbnail?.sha256).toBe(copy?.thumbnail?.sha256);
    const thumbnailFiles = (await readdir(thumbnailDir).catch(() => [] as string[])).filter((f) =>
      f.endsWith('.jpg'),
    );
    expect(thumbnailFiles.length).toBe(1);
  }, 30000);

  it('does not stop other assets when a thumbnail fails', async () => {
    await writeFile(join(inputDir, 'broken.mp4'), Buffer.from('this is not a video'));
    await createPng(join(inputDir, 'ok.png'));

    const catalog = await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });

    const broken = catalog.assets.find((a) => a.relativePath === 'broken.mp4');
    const ok = catalog.assets.find((a) => a.relativePath === 'ok.png');

    expect(broken?.error).toBeTruthy();
    expect(broken?.thumbnail).toBeUndefined();
    expect(ok?.thumbnail).toBeTruthy();
  }, 30000);

  it('leaves no thumbnail temp files in output directory', async () => {
    await createPng(join(inputDir, 'red.png'));
    await createVideo(join(inputDir, 'blue.mp4'), 'blue', 2);

    await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });

    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 30000);

  it('keeps input SHA-256 unchanged after thumbnail generation', async () => {
    const filePath = join(inputDir, 'keep.png');
    await createPng(filePath);
    const before = await sha256File(filePath);

    await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });

    const after = await sha256File(filePath);
    expect(after).toBe(before);
  }, 30000);

  it('pre-write thumbnail verification does not make the catalog JSON tamper-evident', async () => {
    const filePath = join(inputDir, 'contract.png');
    await createPng(filePath);

    const catalog = await generateCatalog(inputDir, {
      catalogRoot: 'test',
      thumbnailDir,
      projectRoot: project,
    });
    const thumb = catalog.assets[0].thumbnail!;
    expect(await verifyThumbnail(project, thumb)).toBe(true);

    const outPath = await writeCatalog(catalog, project, 'contract-catalog.json', inputDir);

    // Simulate a same-user process tampering with the thumbnail after catalog write.
    const finalPath = resolve(project, thumb.identifier);
    await chmod(finalPath, 0o600);
    await writeFile(finalPath, Buffer.from('tampered'));
    await chmod(finalPath, 0o400);

    // The catalog JSON is now stale; a consumer must re-verify at use time.
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    expect(written.assets[0].thumbnail.sha256).toBe(thumb.sha256);
    expect(await verifyThumbnail(project, written.assets[0].thumbnail)).toBe(false);
  }, 30000);
});

describe('writeCatalog security', () => {
  let project: string;
  let catalog: Awaited<ReturnType<typeof generateCatalog>>;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'project-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'x.png'));
    catalog = await generateCatalog(inputDir, { catalogRoot: 'test' });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('writes a JSON catalog file under project output directory', async () => {
    const outPath = await writeCatalog(catalog, project, 'catalog.json', inputDir);
    expect(outPath).toBe(resolve(project, 'output', 'catalog.json'));
    const content = await readFile(outPath, 'utf8');
    expect(JSON.parse(content).count).toBe(1);
  });

  it('writes atomically and leaves no temporary files', async () => {
    await writeCatalog(catalog, project, 'nested/catalog.json', inputDir);
    const outPath = resolve(project, 'output', 'nested', 'catalog.json');
    expect(await readFile(outPath, 'utf8')).toContain('"catalogRoot"');
    const files = await readdir(dirname(outPath));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not overwrite existing non-JSON output files when writing catalog.json', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const videoPath = join(outputDir, 'video.mp4');
    await writeFile(videoPath, 'existing-video');
    const before = await sha256File(videoPath);

    await writeCatalog(catalog, project, 'catalog.json', inputDir);

    expect(await sha256File(videoPath)).toBe(before);
  });

  it('rejects non-JSON output paths', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const videoPath = join(outputDir, 'video.mp4');
    await writeFile(videoPath, 'existing-video');
    const before = await sha256File(videoPath);

    await expect(writeCatalog(catalog, project, 'video.mp4', inputDir)).rejects.toThrow('.json');

    expect(await sha256File(videoPath)).toBe(before);
  });

  it('rejects output path with .. traversal', async () => {
    await expect(writeCatalog(catalog, project, '../package.json', inputDir)).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects absolute output path', async () => {
    await expect(writeCatalog(catalog, project, '/tmp/catalog.json', inputDir)).rejects.toThrow(
      'Absolute',
    );
  });

  it('rejects output through a symlink output directory', async () => {
    const outside = join(project, 'outside-target');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(project, 'output'));
    await expect(writeCatalog(catalog, project, 'catalog.json', inputDir)).rejects.toThrow(
      'symbolic link',
    );
  });

  it('rejects output path escaping into input directory', async () => {
    await expect(writeCatalog(catalog, project, '../input/catalog.json', inputDir)).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects output path that overlaps input directory or assets', async () => {
    const overlapInput = join(project, 'output');
    await mkdir(overlapInput, { recursive: true });
    await createPng(join(overlapInput, 'asset.png'));
    const overlapCatalog = await generateCatalog(overlapInput, { catalogRoot: 'test' });
    const before = await sha256File(join(overlapInput, 'asset.png'));

    await expect(
      writeCatalog(overlapCatalog, project, 'catalog.json', overlapInput),
    ).rejects.toThrow('input');

    expect(await sha256File(join(overlapInput, 'asset.png'))).toBe(before);
  });
});

describe('writeJsonAtomic fd-relative output', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'fd-out-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('rejects an output directory swapped to an external symlink before temp creation and leaves no external files', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const outside = join(project, 'outside');
    await mkdir(outside, { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await symlink(outside, outputDir);

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir),
    ).rejects.toThrow(/symbolic link|not a directory|location does not match/i);

    expect(await readdir(outside)).toHaveLength(0);
  });

  it('rejects an output directory swapped to an external symlink before rename and cleans up the temp', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const outside = join(project, 'outside');
    await mkdir(outside, { recursive: true });

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async ({ dirPath }) => {
            await rm(dirPath, { recursive: true, force: true });
            await symlink(outside, dirPath);
          },
        },
      }),
    ).rejects.toThrow(/symbolic link|not a directory|location does not match/i);

    expect(await readdir(outside)).toHaveLength(0);
  });

  it('creates missing output subdirectories inside the project root', async () => {
    const outPath = await writeJsonAtomic({ x: 1 }, project, 'nested/sub/catalog.json', inputDir);
    expect(outPath).toBe(resolve(project, 'output', 'nested', 'sub', 'catalog.json'));
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual({ x: 1 });
  });

  it('creates the temp file with mode 0o600 so partial JSON is not world-readable', async () => {
    const outPath = await writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir);
    const mode = (await stat(outPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects Windows drive-relative and drive-absolute output paths', async () => {
    const cases = [
      'C:catalog.json',
      'C:dir/catalog.json',
      'C:/catalog.json',
      'C:' + '\\' + 'catalog.json',
      '\\\\' + 'server' + '\\' + 'share' + '\\' + 'catalog.json',
    ];
    for (const rel of cases) {
      await expect(writeJsonAtomic({ x: 1 }, project, rel, inputDir)).rejects.toThrow(
        /Windows drive|UNC paths|not allowed/,
      );
      // No stray temp/final should appear under the project root.
      const candidates = await readdir(project).catch(() => [] as string[]);
      expect(candidates.filter((n) => n.toLowerCase().startsWith('c:') || n.startsWith('\\\\'))).toEqual([]);
    }
  });

  it('rejects an output directory renamed outside project root and cleans up the temp', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const outside = await mkdtemp(join(dirname(project), 'outside-'));
    const movedDir = join(outside, 'output');

    try {
      await expect(
        writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir, {
          __testHooks: {
            beforeRename: async ({ dirPath }) => {
              await rename(dirPath, movedDir);
            },
          },
        }),
      ).rejects.toThrow(/location does not match|not a directory|symbolic link|outside project root/);

      // The temp file created before the move must have been removed.
      expect(await readdir(movedDir)).toHaveLength(0);
      // The moved output directory itself is left untouched; only the temp this
      // execution created is removed.
      expect(await readdir(outside)).toEqual(['output']);
      // No catalog.json or temp file remains in the project path.
      expect(await readdir(project)).not.toContain('output');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes the temp file when a failure occurs before rename', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    const outputEntries = await readdir(outputDir).catch(() => [] as string[]);
    expect(outputEntries.filter((n) => n.endsWith('.tmp') || n === 'catalog.json')).toEqual([]);
  });

  it('keeps a pre-existing final file unchanged when a failure occurs before rename', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'catalog.json');
    await writeFile(finalPath, '{"existing":true}\n');

    await expect(
      writeJsonAtomic({ x: 2 }, project, 'catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    expect(await readFile(finalPath, 'utf8')).toBe('{"existing":true}\n');
    const outputEntries = await readdir(outputDir).catch(() => [] as string[]);
    expect(outputEntries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a pre-existing empty output directory on failure', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    const outputStat = await stat(outputDir);
    expect(outputStat.isDirectory()).toBe(true);
    expect(await readdir(outputDir)).toHaveLength(0);
  });

  it('keeps a pre-existing nested output directory on failure', async () => {
    const nestedDir = join(project, 'output', 'nested');
    await mkdir(nestedDir, { recursive: true });

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'nested/catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    expect((await stat(nestedDir)).isDirectory()).toBe(true);
    expect(await readdir(nestedDir)).toHaveLength(0);
  });

  it('cleans up only newly created nested directories on failure', async () => {
    const outputDir = join(project, 'output');
    await mkdir(outputDir, { recursive: true });

    await expect(
      writeJsonAtomic({ x: 1 }, project, 'nested/catalog.json', inputDir, {
        __testHooks: {
          beforeRename: async () => {
            throw new Error('injected failure');
          },
        },
      }),
    ).rejects.toThrow('injected failure');

    expect((await stat(outputDir)).isDirectory()).toBe(true);
    expect(await readdir(outputDir)).toHaveLength(0);
  });
});

describe('catalog-cli', () => {
  let base: string;
  const outputName = () => `cli-${basename(base)}`;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'catalog-cli-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(join(root, 'output', outputName()), { recursive: true, force: true }).catch(() => {});
  });

  it('writes a JSON catalog file under output/ via CLI', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'cli.png'));
    const outputRel = `${outputName()}/catalog.json`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', inputDir, outputRel],
      { cwd: root },
    );

    expect(stderr).toBeFalsy();
    expect(stdout).toMatch(/Catalog written/);
    const outPath = join(root, 'output', outputRel);
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    expect(parsed.count).toBe(1);
    expect(parsed.assets[0].relativePath).toBe('cli.png');
  }, 60000);

  it('does not duplicate an output/ prefix when passed by the user', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'cli.png'));
    const outputRel = `output/${outputName()}/catalog.json`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', inputDir, outputRel],
      { cwd: root },
    );

    expect(stderr).toBeFalsy();
    expect(stdout).toMatch(/Catalog written/);
    const outPath = join(root, 'output', outputName(), 'catalog.json');
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    expect(parsed.count).toBe(1);
    expect(parsed.assets[0].relativePath).toBe('cli.png');
  }, 60000);

  it('rejects an output argument that escapes output/ or is not .json', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'cli.png'));

    await expect(
      execFileAsync('npx', ['tsx', 'src/catalog-cli.ts', inputDir, '../package.json'], {
        cwd: root,
      }),
    ).rejects.toThrow();

    await expect(
      execFileAsync('npx', ['tsx', 'src/catalog-cli.ts', inputDir, 'catalog.mp4'], {
        cwd: root,
      }),
    ).rejects.toThrow();
  }, 60000);

  it('treats output/catalog.json and output\\\\catalog.json as the same canonical path', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'cli.png'));

    const slashRel = `${outputName()}/slash.json`;

    const slashOut = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', inputDir, `output/${slashRel}`],
      { cwd: root },
    );
    expect(slashOut.stderr).toBeFalsy();

    const backslashOut = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', inputDir, `output\\${outputName()}\\backslash.json`],
      { cwd: root },
    );
    expect(backslashOut.stderr).toBeFalsy();

    const slashPath = join(root, 'output', outputName(), 'slash.json');
    const backslashPath = join(root, 'output', outputName(), 'backslash.json');
    expect(JSON.parse(await readFile(slashPath, 'utf8')).count).toBe(1);
    expect(JSON.parse(await readFile(backslashPath, 'utf8')).count).toBe(1);
    // The backslash variant must not have created an extra output/output/... path.
    await expect(
      stat(join(root, 'output', 'output', outputName(), 'backslash.json')),
    ).rejects.toThrow();
  }, 60000);

  it('does not strip a leading outputting/ prefix', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'cli.png'));

    const outputRel = `outputting/${outputName()}/catalog.json`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', inputDir, outputRel],
      { cwd: root },
    );

    expect(stderr).toBeFalsy();
    expect(stdout).toMatch(/Catalog written/);
    const outPath = join(root, 'output', 'outputting', outputName(), 'catalog.json');
    expect(JSON.parse(await readFile(outPath, 'utf8')).count).toBe(1);
    // It must not have been written as if outputting/ were output/.
    await expect(stat(join(root, 'output', outputName(), 'catalog.json'))).rejects.toThrow();

    await rm(join(root, 'output', 'outputting'), { recursive: true, force: true });
  }, 60000);
});
