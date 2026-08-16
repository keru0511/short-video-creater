import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, lstat, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 as pathWin32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateThumbnail, verifyThumbnail, DEFAULT_THUMBNAIL_MAX_DIMENSION, MAX_SOURCE_BYTES, SOURCE_BUFFER_LIMIT, THUMBNAIL_SCHEMA_VERSION, isInside } from '../src/thumbnails.js';
import { sha256File } from '../src/core.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function createPng(filePath: string, color = 'red', width = 1080, height = 1920): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}`,
    '-frames:v',
    '1',
    filePath,
  ]);
}

async function createVideo(
  filePath: string,
  color = 'blue',
  width = 1080,
  height = 1920,
  duration = 2,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}:r=30:d=${duration}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    filePath,
  ]);
}

async function ffprobeImage(filePath: string): Promise<{ width: number; height: number; codec: string }> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-of', 'json', filePath],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams.find((s: { codec_type?: string; codec_name?: string; width?: number; height?: number }) => s.codec_type === 'video');
  return { width: stream.width, height: stream.height, codec: stream.codec_name };
}

async function createTestPatternVideo(
  filePath: string,
  width = 320,
  height = 240,
  duration = 5,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${duration}:size=${width}x${height}:rate=30`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    filePath,
  ]);
}

async function ffmpegReferenceThumbnail(
  filePath: string,
  sourceType: 'image' | 'video',
  sourceDuration: number | undefined,
  maxDimension: number,
): Promise<Buffer> {
  const scaleFilter = `scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease`;
  const args: string[] = ['-y', '-i', filePath];
  if (sourceType === 'video' && sourceDuration && sourceDuration > 0) {
    args.push('-ss', String(sourceDuration / 2));
  }
  args.push('-vf', scaleFilter, '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-');
  const { stdout } = await execFileAsync('ffmpeg', args, {
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout as Buffer;
}

async function createSparseFile(filePath: string, size: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const fh = await open(filePath, 'w');
  await fh.truncate(size);
  await fh.close();
}

function buildIdentifier(hash: string, maxDimension = DEFAULT_THUMBNAIL_MAX_DIMENSION): string {
  return `output/thumbnails/${THUMBNAIL_SCHEMA_VERSION}-${maxDimension}-${hash}.jpg`;
}

describe('isInside', () => {
  it('accepts paths below a POSIX base', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('rejects POSIX paths outside the base', () => {
    expect(isInside('/a/b', '/c/d')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
    expect(isInside('/a/b', '/a/b/../..')).toBe(false);
  });

  it('accepts paths below a Windows base', () => {
    expect(isInside('C:\\root', 'C:\\root\\file', pathWin32)).toBe(true);
    expect(isInside('C:\\root', 'C:\\Root\\file', pathWin32)).toBe(true);
    expect(isInside('\\\\server\\share\\root', '\\\\server\\share\\root\\file', pathWin32)).toBe(true);
  });

  it('rejects Windows paths outside the base', () => {
    expect(isInside('C:\\root', 'D:\\outside', pathWin32)).toBe(false);
    expect(isInside('C:\\root', 'C:\\root\\..\\outside', pathWin32)).toBe(false);
    expect(isInside('C:\\root', 'C:\\root\\..\\..\\outside', pathWin32)).toBe(false);
    expect(isInside('\\\\server\\share\\root', '\\\\server\\share\\other\\file', pathWin32)).toBe(false);
    expect(isInside('\\\\server\\share\\root', '\\\\other-server\\share\\file', pathWin32)).toBe(false);
  });
});

describe('generateThumbnail', () => {
  let base: string;
  let project: string;
  let inputDir: string;
  let thumbnailDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'thumbs-'));
    project = base;
    inputDir = join(base, 'input');
    thumbnailDir = join(base, 'output', 'thumbnails');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function sourceHash(filePath: string): Promise<string> {
    return sha256File(filePath);
  }

  it('generates a JPG thumbnail for a PNG image', async () => {
    const filePath = join(inputDir, 'red.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'red.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    expect(info?.identifier).toBe(buildIdentifier(hash));
    expect(info?.sha256).toHaveLength(64);
    expect(info?.width).toBeGreaterThan(0);
    expect(info?.height).toBeGreaterThan(0);
    expect(info?.width).toBeLessThanOrEqual(DEFAULT_THUMBNAIL_MAX_DIMENSION);
    expect(info?.height).toBeLessThanOrEqual(DEFAULT_THUMBNAIL_MAX_DIMENSION);

    const probe = await ffprobeImage(resolve(project, info!.identifier));
    expect(probe.codec).toBe('mjpeg');
    expect(probe.width).toBe(info!.width);
    expect(probe.height).toBe(info!.height);
  });

  it('generates a JPG thumbnail for an MP4 video at a deterministic seek time', async () => {
    const filePath = join(inputDir, 'blue.mp4');
    await createVideo(filePath, 'blue', 1080, 1920, 3);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'blue.mp4',
      sourceHash: hash,
      sourceType: 'video',
      sourceDuration: 3,
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    expect(info?.identifier).toBe(buildIdentifier(hash));
    expect(info?.width).toBeGreaterThan(0);
    expect(info?.height).toBeGreaterThan(0);

    const probe = await ffprobeImage(resolve(project, info!.identifier));
    expect(probe.codec).toBe('mjpeg');
  });

  it('reuses an existing thumbnail and does not regenerate it', async () => {
    const filePath = join(inputDir, 'reuse.png');
    await createPng(filePath, 'green', 800, 800);
    const hash = await sourceHash(filePath);
    const opts = {
      inputRoot: inputDir,
      sourceRelativePath: 'reuse.png',
      sourceHash: hash,
      sourceType: 'image' as const,
      thumbnailDir,
      projectRoot: project,
    };

    const first = await generateThumbnail(opts);
    const firstStat = await lstat(resolve(project, first!.identifier));

    await new Promise((r) => setTimeout(r, 100));

    const second = await generateThumbnail(opts);
    const secondStat = await lstat(resolve(project, second!.identifier));

    expect(second!.sha256).toBe(first!.sha256);
    expect(second!.width).toBe(first!.width);
    expect(second!.height).toBe(first!.height);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it('produces the same thumbnail file for identical content under different paths', async () => {
    const a = join(inputDir, 'a', 'same.png');
    const b = join(inputDir, 'b', 'same.png');
    await mkdir(dirname(a), { recursive: true });
    await mkdir(dirname(b), { recursive: true });
    await createPng(a, 'yellow', 640, 480);
    await writeFile(b, await readFile(a));
    const hash = await sourceHash(a);

    const first = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'a/same.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    const second = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'b/same.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(first?.identifier).toBe(second?.identifier);
    expect(first?.sha256).toBe(second?.sha256);
    expect((await readdir(thumbnailDir)).length).toBe(1);
  });

  it('returns undefined for broken media without leaving files', async () => {
    const filePath = join(inputDir, 'broken.mp4');
    await writeFile(filePath, Buffer.from('this is not a video'));
    const hash = await sha256File(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'broken.mp4',
      sourceHash: hash,
      sourceType: 'video',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });

  it('returns undefined for absolute source paths', async () => {
    const filePath = join(inputDir, 'abs.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: resolve(inputDir, 'abs.png'),
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
  });

  it('returns undefined for source paths with traversal', async () => {
    const filePath = join(inputDir, 'escape.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: '../escape.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
  });

  it('does not follow symlinks for source files', async () => {
    const outside = resolve(base, 'outside');
    await mkdir(outside, { recursive: true });
    const target = join(outside, 'real.png');
    const linkPath = join(inputDir, 'link.png');
    await createPng(target, 'red', 100, 100);
    await symlink(target, linkPath);
    const hash = await sourceHash(target);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'link.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
  });

  it('returns undefined for thumbnail directory outside project root', async () => {
    const filePath = join(inputDir, 'out.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'out.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir: resolve(base, '..', 'escape-thumbs'),
      projectRoot: project,
    });

    expect(info).toBeUndefined();
  });

  it('returns undefined for source paths with special characters without shell issues', async () => {
    const filePath = join(inputDir, 'meta; rm -rf .png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'meta; rm -rf .png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    expect(info?.identifier).not.toContain('meta; rm -rf');
    expect(info?.identifier).toBe(buildIdentifier(hash));
  });

  it('different content produces different thumbnail files', async () => {
    const a = join(inputDir, 'a.png');
    const b = join(inputDir, 'b.png');
    await createPng(a, 'red', 100, 100);
    await createPng(b, 'blue', 100, 100);
    const hashA = await sourceHash(a);
    const hashB = await sourceHash(b);

    const thumbA = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'a.png',
      sourceHash: hashA,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    const thumbB = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'b.png',
      sourceHash: hashB,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(thumbA?.sha256).not.toBe(thumbB?.sha256);
    expect(thumbA?.identifier).not.toBe(thumbB?.identifier);
  });

  it('keeps input file SHA-256 unchanged after thumbnail generation', async () => {
    const filePath = join(inputDir, 'immutable.png');
    await createPng(filePath, 'red', 100, 100);
    const before = await sha256File(filePath);
    const hash = before;

    await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'immutable.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    const after = await sha256File(filePath);
    expect(after).toBe(before);
  });

  it('returns undefined and writes nothing for an invalid source hash format', async () => {
    const filePath = join(inputDir, 'badhash.png');
    await createPng(filePath, 'red', 100, 100);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'badhash.png',
      sourceHash: '../escape000000000000000000000000000000000000000000000000000000000000',
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });

  it('returns undefined when sourceHash does not match source contents', async () => {
    const filePath = join(inputDir, 'mismatch.png');
    await createPng(filePath, 'red', 100, 100);
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'mismatch.png',
      sourceHash: wrongHash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });

  it('does not replace an existing final with a non-mjpeg codec and returns undefined', async () => {
    const filePath = join(inputDir, 'disguised.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const fakeThumbPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(fakeThumbPath), { recursive: true });
    const pngContent = await readFile(filePath);
    await writeFile(fakeThumbPath, pngContent);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'disguised.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    expect(await readFile(fakeThumbPath)).toEqual(pngContent);
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('produces a different thumbnail file when maxDimension changes', async () => {
    const filePath = join(inputDir, 'resize.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const big = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'resize.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      maxDimension: 480,
    });

    const small = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'resize.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      maxDimension: 240,
    });

    expect(big?.identifier).not.toBe(small?.identifier);
    expect(big?.width).toBeGreaterThan(small!.width);
    expect(big?.height).toBeGreaterThan(small!.height);
    expect(small?.width).toBeLessThanOrEqual(240);
    expect(small?.height).toBeLessThanOrEqual(240);
  });

  it('finalizes one thumbnail when two calls run concurrently for the same asset', async () => {
    const filePath = join(inputDir, 'concurrent.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);
    const opts = {
      inputRoot: inputDir,
      sourceRelativePath: 'concurrent.png',
      sourceHash: hash,
      sourceType: 'image' as const,
      thumbnailDir,
      projectRoot: project,
    };

    const [first, second] = await Promise.all([generateThumbnail(opts), generateThumbnail(opts)]);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first?.identifier).toBe(second?.identifier);
    expect(first?.sha256).toBe(second?.sha256);
    expect(first?.width).toBe(second?.width);
    expect(first?.height).toBe(second?.height);

    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('finalizes thumbnails when multiple different assets run concurrently before thumbnailDir exists', async () => {
    const a = join(inputDir, 'a.png');
    const b = join(inputDir, 'b.png');
    await createPng(a, 'red', 100, 100);
    await createPng(b, 'blue', 100, 100);
    const hashA = await sourceHash(a);
    const hashB = await sourceHash(b);

    const [thumbA, thumbB] = await Promise.all([
      generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'a.png',
        sourceHash: hashA,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
      }),
      generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'b.png',
        sourceHash: hashB,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
      }),
    ]);

    expect(thumbA).toBeTruthy();
    expect(thumbB).toBeTruthy();
    expect(thumbA?.identifier).not.toBe(thumbB?.identifier);
    const jpgFiles = (await readdir(thumbnailDir)).filter((f) => f.endsWith('.jpg'));
    expect(jpgFiles.length).toBe(2);
  });

  it('does not replace an existing final that is a symlink to an external file and returns undefined', async () => {
    const filePath = join(inputDir, 'symlink-final.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const external = resolve(base, 'external-thumb.jpg');
    await createPng(external, 'blue', 100, 100);
    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    await symlink(external, finalPath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'symlink-final.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    const finalStat = await lstat(finalPath);
    expect(finalStat.isSymbolicLink()).toBe(true);
    expect(finalStat.isFile()).toBe(false);
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('does not replace an existing final with mismatched content and returns undefined', async () => {
    const a = join(inputDir, 'a.png');
    const b = join(inputDir, 'b.png');
    await createPng(a, 'red', 100, 100);
    await createPng(b, 'blue', 100, 100);
    const hashA = await sourceHash(a);
    const hashB = await sourceHash(b);

    const preplaced = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'b.png',
      sourceHash: hashB,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    const finalAPath = resolve(project, buildIdentifier(hashA));
    await mkdir(dirname(finalAPath), { recursive: true });
    const preplacedContent = await readFile(resolve(project, preplaced!.identifier));
    await unlink(resolve(project, preplaced!.identifier));
    await writeFile(finalAPath, preplacedContent);

    const beforeContent = await readFile(finalAPath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'a.png',
      sourceHash: hashA,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    expect(await readFile(finalAPath)).toEqual(beforeContent);
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('does not replace an existing invalid final and returns undefined', async () => {
    const filePath = join(inputDir, 'invalid-final.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    const invalidContent = Buffer.from('not-a-jpg');
    await writeFile(finalPath, invalidContent);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'invalid-final.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    expect(await readFile(finalPath)).toEqual(invalidContent);
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('reuses a valid final written by another process before the exclusive create', async () => {
    const filePath = join(inputDir, 'barrier-write.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'barrier-write.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs'),
      projectRoot: project,
    });
    expect(reference).toBeTruthy();
    const validContent = await readFile(resolve(project, reference!.identifier));

    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, 'not-a-jpg');

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'barrier-write.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        beforeFinalWrite: async ({ finalPath }) => {
          await writeFile(finalPath, validContent);
        },
      },
    });

    expect(info).toBeTruthy();
    expect(info?.sha256).toBe(reference!.sha256);
    expect(info?.identifier).toBe(buildIdentifier(hash));
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
    const probe = await ffprobeImage(finalPath);
    expect(probe.codec).toBe('mjpeg');
  });

  it('rejects invalid maxDimension values and writes nothing outside the thumbnail directory', async () => {
    const filePath = join(inputDir, 'maxdim.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const invalidValues = [NaN, Infinity, -1, 0, 10000, '../480', '480'];
    for (const maxDimension of invalidValues) {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'maxdim.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        maxDimension: maxDimension as unknown as number,
      });
      expect(info).toBeUndefined();
    }

    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
  });

  it('does not create files outside the project root when thumbnailDir is moved outside after validation', async () => {
    const filePath = join(inputDir, 'dir-replace.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const external = resolve('/tmp', `external-thumbs-${Date.now()}`);
    await mkdir(external, { recursive: true });

    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'dir-replace.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          afterThumbnailDirValidation: async ({ thumbnailDir: td }) => {
            await rm(external, { recursive: true, force: true }).catch(() => {});
            await rename(td, external);
            await symlink(external, td);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (await readdir(external).catch(() => [] as string[])).filter((f) =>
        f.endsWith('.jpg'),
      );
      expect(externalFiles.length).toBe(0);
    } finally {
      await rm(external, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('ignores source file replacement during the ffmpeg read window', async () => {
    const filePath = join(inputDir, 'aba.png');
    await createPng(filePath, 'red', 1080, 1920);
    const originalHash = await sourceHash(filePath);
    const bluePath = join(inputDir, 'blue.png');
    await createPng(bluePath, 'blue', 1080, 1920);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'aba.png',
      sourceHash: originalHash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs'),
      projectRoot: project,
    });
    expect(reference).toBeTruthy();

    let reverted = false;
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'aba.png',
      sourceHash: originalHash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        beforeFfmpeg: async ({ sourcePath }) => {
          const original = await readFile(filePath);
          const blue = await readFile(bluePath);
          setTimeout(async () => {
            await writeFile(sourcePath, blue);
            setTimeout(async () => {
              await writeFile(sourcePath, original);
              reverted = true;
            }, 100);
          }, 0);
        },
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(info).toBeTruthy();
    expect(info?.sha256).toBe(reference!.sha256);
    expect(info?.identifier).toBe(buildIdentifier(originalHash));
    const finalContent = await readFile(resolve(project, info!.identifier));
    const referenceContent = await readFile(resolve(project, reference!.identifier));
    expect(finalContent).toEqual(referenceContent);
    expect(reverted).toBe(true);
    expect(await sha256File(filePath)).toBe(originalHash);
  });

  it('does not accept a final replaced with a different valid MJPEG between lstat and read', async () => {
    const filePath = join(inputDir, 'open-replace.png');
    const decoyPng = join(inputDir, 'open-replace-decoy.png');
    await createPng(filePath, 'red', 1080, 1920);
    await createPng(decoyPng, 'blue', 1080, 1920);
    const hash = await sourceHash(filePath);
    const decoyHash = await sourceHash(decoyPng);

    const decoyRef = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'open-replace-decoy.png',
      sourceHash: decoyHash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs'),
      projectRoot: project,
    });
    expect(decoyRef).toBeTruthy();
    const decoyPath = resolve(project, decoyRef!.identifier);
    const decoyContent = await readFile(decoyPath);

    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, 'not-a-jpg');

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'open-replace.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalOpen: async ({ finalPath }) => {
          await writeFile(finalPath, decoyContent);
        },
      },
    });

    expect(info).toBeUndefined();
    if (info) {
      expect(info.identifier).not.toBe(buildIdentifier(hash));
    }
  });

  it('returns the original thumbnail even if the final path is replaced with a decoy and restored before the final lstat', async () => {
    const filePath = join(inputDir, 'probe-aba.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'probe-aba.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs'),
      projectRoot: project,
    });
    expect(reference).toBeTruthy();

    const decoyPng = join(inputDir, 'probe-aba-decoy.png');
    await createPng(decoyPng, 'blue', 1080, 1920);
    const decoyHash = await sourceHash(decoyPng);
    const decoyRef = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'probe-aba-decoy.png',
      sourceHash: decoyHash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs-decoy'),
      projectRoot: project,
    });
    expect(decoyRef).toBeTruthy();
    const decoyPath = resolve(project, decoyRef!.identifier);
    const decoyContent = await readFile(decoyPath);

    const finalPath = resolve(project, buildIdentifier(hash));
    const backupPath = resolve(dirname(finalPath), 'probe-aba-backup.jpg');

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'probe-aba.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalOpen: async ({ finalPath }) => {
          await link(finalPath, backupPath);
          await rename(decoyPath, finalPath);
        },
        afterFinalHash: async ({ finalPath }) => {
          await rename(backupPath, finalPath);
        },
      },
    });

    expect(info).toBeTruthy();
    expect(info?.sha256).toBe(reference!.sha256);
    expect(info?.identifier).toBe(buildIdentifier(hash));
    expect(await readFile(finalPath)).toEqual(await readFile(resolve(project, reference!.identifier)));
  });

  it('does not accept a final replaced with a copy of itself after hash verification', async () => {
    const filePath = join(inputDir, 'hash-replace.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'hash-replace.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs'),
      projectRoot: project,
    });
    expect(reference).toBeTruthy();
    const referenceContent = await readFile(resolve(project, reference!.identifier));
    const decoyPath = resolve(project, 'hash-replace-decoy.jpg');
    await writeFile(decoyPath, referenceContent);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'hash-replace.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalHash: async ({ finalPath }) => {
          await rename(decoyPath, finalPath);
        },
      },
    });

    expect(info).toBeUndefined();
  });

  it('does not accept poison written through a write fd held before opening', async () => {
    const filePath = join(inputDir, 'write-fd-poison.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const decoyPng = join(inputDir, 'write-fd-decoy.png');
    await createPng(decoyPng, 'blue', 1080, 1920);
    const decoyHash = await sourceHash(decoyPng);
    const decoyRef = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'write-fd-decoy.png',
      sourceHash: decoyHash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs-poison'),
      projectRoot: project,
    });
    expect(decoyRef).toBeTruthy();
    const decoyContent = await readFile(resolve(project, decoyRef!.identifier));

    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, 'placeholder');
    const writeFh = await open(finalPath, 'r+');

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'write-fd-poison.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalOpen: async () => {
          await writeFh.writeFile(decoyContent);
          await writeFh.sync();
        },
      },
    });

    await writeFh.close();

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir);
    expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('streams sources when sourceBufferLimit is 0 and verifies hash', async () => {
    const filePath = join(inputDir, 'streamed.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'streamed.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: { sourceBufferLimit: 0 },
    });

    expect(info).toBeTruthy();
    expect(info?.sha256).toHaveLength(64);
  });

  it('keeps source file SHA-256 unchanged when streaming', async () => {
    const filePath = join(inputDir, 'immutable-stream.png');
    await createPng(filePath, 'red', 100, 100);
    const before = await sha256File(filePath);

    await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'immutable-stream.png',
      sourceHash: before,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: { sourceBufferLimit: 0 },
    });

    const after = await sha256File(filePath);
    expect(after).toBe(before);
  });

  it('fails closed when streamed source hash does not match', async () => {
    const filePath = join(inputDir, 'stream-mismatch.png');
    await createPng(filePath, 'red', 100, 100);
    const wrongHash = '0'.repeat(64);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'stream-mismatch.png',
      sourceHash: wrongHash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: { sourceBufferLimit: 0 },
    });

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });

  it('rejects sources larger than maxSourceBytes without consuming memory', async () => {
    const filePath = join(inputDir, 'huge.bin');
    const maxSourceBytes = 100;
    await createSparseFile(filePath, maxSourceBytes + 1);
    const dummyHash = '0'.repeat(64);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'huge.bin',
      sourceHash: dummyHash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: { maxSourceBytes },
    });

    expect(info).toBeUndefined();
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });

  it('produces deterministic thumbnails for non-faststart MP4 via pipe', async () => {
    const filePath = join(inputDir, 'nonfast.mp4');
    const duration = 5;
    await createTestPatternVideo(filePath, 320, 240, duration);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'nonfast.mp4',
      sourceHash: hash,
      sourceType: 'video',
      sourceDuration: duration,
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    const reference = await ffmpegReferenceThumbnail(filePath, 'video', duration, DEFAULT_THUMBNAIL_MAX_DIMENSION);
    const finalContent = await readFile(resolve(project, info!.identifier));
    expect(finalContent).toEqual(reference);
  });

  it('does not create files outside project root when an ancestor of thumbnailDir is replaced after validation', async () => {
    const filePath = join(inputDir, 'ancestor-replace.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const external = resolve('/tmp', `external-ancestor-${Date.now()}`);
    await mkdir(external, { recursive: true });

    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'ancestor-replace.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          afterThumbnailDirValidation: async () => {
            const outputPath = resolve(project, 'output');
            const externalOutput = resolve(external, 'output');
            await rm(externalOutput, { recursive: true, force: true }).catch(() => {});
            await rename(outputPath, externalOutput);
            await symlink(externalOutput, outputPath);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (
        await readdir(resolve(external, 'output', 'thumbnails')).catch(() => [] as string[])
      ).filter((f) => f.endsWith('.jpg'));
      expect(externalFiles.length).toBe(0);
    } finally {
      const outputPath = resolve(project, 'output');
      const externalOutput = resolve(external, 'output');
      await rm(outputPath, { recursive: true, force: true }).catch(() => {});
      await rename(externalOutput, outputPath).catch(() => {});
      await rm(external, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not create files outside project root when an ancestor is replaced before a child directory is created', async () => {
    const filePath = join(inputDir, 'ancestor-before-child.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const external = resolve('/tmp', `external-before-child-${Date.now()}`);
    await mkdir(external, { recursive: true });

    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'ancestor-before-child.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforeChildDirCreation: async ({ component }) => {
            if (component !== 'thumbnails') return;
            const outputPath = resolve(project, 'output');
            const externalOutput = resolve(external, 'output');
            await rm(externalOutput, { recursive: true, force: true }).catch(() => {});
            await rename(outputPath, externalOutput);
            await symlink(externalOutput, outputPath);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (
        await readdir(resolve(external, 'output', 'thumbnails')).catch(() => [] as string[])
      ).filter((f) => f.endsWith('.jpg'));
      expect(externalFiles.length).toBe(0);
    } finally {
      const outputPath = resolve(project, 'output');
      const externalOutput = resolve(external, 'output');
      await rm(outputPath, { recursive: true, force: true }).catch(() => {});
      await rename(externalOutput, outputPath).catch(() => {});
      await rm(external, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns undefined and leaves no partial final when write fails', async () => {
    const filePath = join(inputDir, 'write-fail.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'write-fail.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforeFinalWrite: async () => {
            await chmod(thumbnailDir, 0o555);
          },
        },
      });

      expect(info).toBeUndefined();
      const files = await readdir(thumbnailDir).catch(() => [] as string[]);
      expect(files.filter((f) => f.endsWith('.jpg')).length).toBe(0);
      expect(files.filter((f) => f.startsWith('.')).length).toBe(0);
    } finally {
      await chmod(thumbnailDir, 0o755);
    }
  });

  it('does not expose a partial final before atomic publish', async () => {
    const filePath = join(inputDir, 'partial.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    let beforeFiles: string[] = [];

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'partial.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        beforeFinalWrite: async () => {
          beforeFiles = await readdir(thumbnailDir);
        },
      },
    });

    expect(info).toBeTruthy();
    expect(beforeFiles.filter((f) => f.endsWith('.jpg')).length).toBe(0);
    const afterFiles = await readdir(thumbnailDir);
    expect(afterFiles.filter((f) => f.endsWith('.jpg')).length).toBe(1);
  });

  it('rejects a final modified through the same inode after publish', async () => {
    const filePath = join(inputDir, 'same-inode.png');
    const decoyFile = join(inputDir, 'same-inode-decoy.png');
    await createPng(filePath, 'red', 100, 100);
    await createPng(decoyFile, 'blue', 100, 100);
    const hash = await sourceHash(filePath);
    const decoyHash = await sourceHash(decoyFile);

    const decoyThumb = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'same-inode-decoy.png',
      sourceHash: decoyHash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-thumbs-same-inode'),
      projectRoot: project,
    });
    expect(decoyThumb).toBeTruthy();
    const decoyContent = await readFile(resolve(project, decoyThumb!.identifier));

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'same-inode.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalHash: async ({ finalPath: f }) => {
          await writeFile(f, decoyContent);
        },
      },
    });

    expect(info).toBeUndefined();
  });

  it('generates a thumbnail when inputRoot is outside projectRoot', async () => {
    const externalInput = await mkdtemp(join(root, 'tests', 'external-input-'));
    try {
      const filePath = join(externalInput, 'external.png');
      await createPng(filePath, 'red', 1080, 1920);
      const hash = await sha256File(filePath);

      const info = await generateThumbnail({
        inputRoot: externalInput,
        sourceRelativePath: 'external.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
      });

      expect(info).toBeTruthy();
      expect(info?.identifier).toBe(buildIdentifier(hash));
      const probe = await ffprobeImage(resolve(project, info!.identifier));
      expect(probe.codec).toBe('mjpeg');
    } finally {
      await rm(externalInput, { recursive: true, force: true });
    }
  });

  it('rejects a source that grows after stat without exceeding the buffer limit', async () => {
    const filePath = join(inputDir, 'grow-after-stat.png');
    await createPng(filePath, 'red', 100, 100);
    const originalHash = await sourceHash(filePath);
    const originalStat = await lstat(filePath);
    const originalSize = Number(originalStat.size);

    const writeFd = await open(filePath, 'r+');
    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'grow-after-stat.png',
        sourceHash: originalHash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforeSourceRead: async ({ sourceSize }) => {
            expect(sourceSize).toBe(originalSize);
            // Expand the same inode to a huge sparse file and overwrite the start
            // so the bytes actually read no longer match the expected hash.
            await writeFd.truncate(1024 * 1024 * 100);
            await writeFd.writeFile(Buffer.from('this is not the source'));
          },
        },
      });

      expect(info).toBeUndefined();
      const files = await readdir(thumbnailDir).catch(() => [] as string[]);
      expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
    } finally {
      await writeFd.close();
    }
  });

  it('prevents a write fd to the temporary file from poisoning the final', async () => {
    const filePath = join(inputDir, 'temp-write-fd.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    let attemptedTemp: string | undefined;
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'temp-write-fd.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        beforePublishLink: async ({ thumbnailDir: td }) => {
          const files = await readdir(td);
          const temp = files.find((f) => f.startsWith('.tmp-') && f.endsWith('.jpg'));
          if (!temp) {
            throw new Error('temporary file not found');
          }
          attemptedTemp = join(td, temp);
          // A temp file with 0o000 permissions must reject write-open attempts.
          try {
            await open(attemptedTemp, 'w');
            throw new Error('temporary file should not be writable');
          } catch (err) {
            if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES')) {
              throw err;
            }
          }
        },
      },
    });

    expect(info).toBeTruthy();
    expect(attemptedTemp).toBeTruthy();
    const finalPath = resolve(project, info!.identifier);
    const finalContent = await readFile(finalPath);
    const finalHash = sha256File(finalPath);
    expect((await finalHash)).toBe(info!.sha256);
    expect(finalContent.length).toBeGreaterThan(0);

    const afterFiles = await readdir(thumbnailDir);
    expect(afterFiles.filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('does not leave a temp or final outside project root when thumbnailDir is moved before publish link', async () => {
    const filePath = join(inputDir, 'dir-move-publish.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const external = resolve('/tmp', `external-publish-${Date.now()}`);
    await mkdir(external, { recursive: true });

    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'dir-move-publish.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforePublishLink: async () => {
            await rename(thumbnailDir, external);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (await readdir(external).catch(() => [] as string[])).filter(
        (f) => f.endsWith('.jpg') || f.startsWith('.tmp-'),
      );
      expect(externalFiles).toEqual([]);
    } finally {
      const movedBack = resolve('/tmp', `external-publish-back-${Date.now()}`);
      await rename(external, movedBack).catch(() => {});
      await rm(movedBack, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('publishes the final as read-only and rejects write-open attempts', async () => {
    const filePath = join(inputDir, 'readonly-final.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'readonly-final.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    const finalPath = resolve(project, info!.identifier);
    const finalStat = await stat(finalPath);
    // Final is published with 0o400; only read opens should succeed.
    expect(finalStat.mode & 0o777).toBe(0o400);
    await expect(open(finalPath, 'w')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(open(finalPath, 'a')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('does not unlink an existing final when EEXIST verification fails', async () => {
    const filePath = join(inputDir, 'eexist-invariant.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const finalPath = resolve(project, buildIdentifier(hash));
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, 'not-a-jpg');
    const beforeStat = await stat(finalPath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'eexist-invariant.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeUndefined();
    const afterStat = await stat(finalPath).catch(() => null);
    expect(afterStat).toBeTruthy();
    expect(afterStat!.ino).toBe(beforeStat.ino);
    expect(await readFile(finalPath, 'utf8')).toBe('not-a-jpg');
  });

  it('does not unlink a valid shared final placed during linked publish failure', async () => {
    const filePath = join(inputDir, 'shared-final.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'shared-final.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    expect(reference).toBeTruthy();
    const finalPath = resolve(project, reference!.identifier);
    const decoyPath = join(base, 'shared-final-decoy.jpg');
    await writeFile(decoyPath, await readFile(finalPath));
    await unlink(finalPath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'shared-final.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalOpen: async ({ finalPath: f }) => {
          await rename(decoyPath, f);
        },
      },
    });

    expect(info).toBeUndefined();
    const afterStat = await stat(finalPath).catch(() => null);
    expect(afterStat).toBeTruthy();
    expect(await verifyThumbnail(project, reference!)).toBe(true);
  });

  it('does not accept a valid copy of the final swapped during afterFinalOpen', async () => {
    const filePath = join(inputDir, 'open-swap.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    const reference = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'open-swap.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir: join(base, 'ref-open-swap'),
      projectRoot: project,
    });
    expect(reference).toBeTruthy();

    const decoyPath = resolve(project, 'open-swap-decoy.jpg');
    const backupPath = resolve(dirname(decoyPath), 'open-swap-backup.jpg');
    await writeFile(decoyPath, await readFile(resolve(project, reference!.identifier)));

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'open-swap.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterFinalOpen: async ({ finalPath }) => {
          await link(finalPath, backupPath);
          await rename(decoyPath, finalPath);
        },
      },
    });

    expect(info).toBeUndefined();
  });

  it('generates a thumbnail when fd-relative paths are unavailable (simulated win32)', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const filePath = join(inputDir, 'win32-fallback.png');
      await createPng(filePath, 'red', 1080, 1920);
      const hash = await sourceHash(filePath);

      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'win32-fallback.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
      });

      expect(info).toBeTruthy();
      expect(info?.identifier).toBe(buildIdentifier(hash));
      const probe = await ffprobeImage(resolve(project, info!.identifier));
      expect(probe.codec).toBe('mjpeg');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('kills ffmpeg and rejects when stderr exceeds the configured bound', async () => {
    const filePath = join(inputDir, 'huge-stderr.raw');
    await createSparseFile(filePath, 1024 * 1024);
    const hash = await sha256File(filePath);

    const start = Date.now();
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'huge-stderr.raw',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        sourceBufferLimit: 0,
        maxStderrBytes: 1024,
      },
    });
    const elapsed = Date.now() - start;

    expect(info).toBeUndefined();
    expect(elapsed).toBeLessThan(5000);
  });

  it('blocks third-party write-open to the temp file from the moment of creation', async () => {
    const filePath = join(inputDir, 'temp-create-block.png');
    await createPng(filePath, 'red', 1080, 1920);
    const hash = await sourceHash(filePath);

    let attemptedTemp: string | undefined;
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'temp-create-block.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        afterTempCreate: async ({ tempPath }) => {
          attemptedTemp = tempPath;
          await expect(open(tempPath, 'w')).rejects.toMatchObject({ code: 'EACCES' });
        },
      },
    });

    expect(info).toBeTruthy();
    expect(attemptedTemp).toBeTruthy();
  });

  it('rejects a buffered source that is appended after fstat while preserving the hash prefix', async () => {
    const filePath = join(inputDir, 'append-after-stat.png');
    await createPng(filePath, 'red', 100, 100);
    const originalHash = await sourceHash(filePath);
    const originalStat = await lstat(filePath);
    const originalSize = Number(originalStat.size);

    const appendFd = await open(filePath, 'r+');
    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'append-after-stat.png',
        sourceHash: originalHash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforeSourceRead: async ({ sourceSize }) => {
            expect(sourceSize).toBe(originalSize);
            const extra = Buffer.from('extra bytes appended after fstat');
            await appendFd.write(extra, 0, extra.length, originalSize);
            await appendFd.sync();
          },
        },
      });

      expect(info).toBeUndefined();
      const files = await readdir(thumbnailDir).catch(() => [] as string[]);
      expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
    } finally {
      await appendFd.close();
    }
  });

  it('rejects a streaming source that is appended after fstat while preserving the hash prefix', async () => {
    const filePath = join(inputDir, 'append-stream.png');
    await createPng(filePath, 'red', 100, 100);
    const originalHash = await sourceHash(filePath);
    const originalStat = await lstat(filePath);
    const originalSize = Number(originalStat.size);

    const appendFd = await open(filePath, 'r+');
    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'append-stream.png',
        sourceHash: originalHash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          sourceBufferLimit: 0,
          beforeFfmpeg: async () => {
            const extra = Buffer.from('extra bytes appended during stream');
            await appendFd.write(extra, 0, extra.length, originalSize);
            await appendFd.sync();
          },
        },
      });

      expect(info).toBeUndefined();
      const files = await readdir(thumbnailDir).catch(() => [] as string[]);
      expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
    } finally {
      await appendFd.close();
    }
  });

  it('does not create files outside project root when an ancestor is replaced on fd-relative-unavailable platforms (simulated win32)', async () => {
    const filePath = join(inputDir, 'win32-ancestor.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const external = resolve('/tmp', `external-win32-ancestor-${Date.now()}`);
    await mkdir(external, { recursive: true });

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'win32-ancestor.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforeChildDirCreation: async ({ component }) => {
            if (component !== 'thumbnails') return;
            const outputPath = resolve(project, 'output');
            const externalOutput = resolve(external, 'output');
            await rm(externalOutput, { recursive: true, force: true }).catch(() => {});
            await rename(outputPath, externalOutput);
            await symlink(externalOutput, outputPath);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (
        await readdir(resolve(external, 'output', 'thumbnails')).catch(() => [] as string[])
      ).filter((f) => f.endsWith('.jpg'));
      expect(externalFiles.length).toBe(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      const outputPath = resolve(project, 'output');
      const externalOutput = resolve(external, 'output');
      await rm(outputPath, { recursive: true, force: true }).catch(() => {});
      await rename(externalOutput, outputPath).catch(() => {});
      await rm(external, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not publish a final outside project root when an ancestor is replaced on fd-relative-unavailable platforms (simulated win32)', async () => {
    const filePath = join(inputDir, 'win32-publish.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);
    const external = resolve('/tmp', `external-win32-publish-${Date.now()}`);
    await mkdir(external, { recursive: true });

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'win32-publish.png',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          beforePublishLink: async () => {
            const outputPath = resolve(project, 'output');
            const externalOutput = resolve(external, 'output');
            await rm(externalOutput, { recursive: true, force: true }).catch(() => {});
            await rename(outputPath, externalOutput);
            await symlink(externalOutput, outputPath);
          },
        },
      });

      expect(info).toBeUndefined();
      const externalFiles = (
        await readdir(resolve(external, 'output', 'thumbnails')).catch(() => [] as string[])
      ).filter((f) => f.endsWith('.jpg'));
      expect(externalFiles.length).toBe(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      const outputPath = resolve(project, 'output');
      const externalOutput = resolve(external, 'output');
      await rm(outputPath, { recursive: true, force: true }).catch(() => {});
      await rename(externalOutput, outputPath).catch(() => {});
      await rm(external, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('verifyThumbnail returns true for a valid final and false after tampering', async () => {
    const filePath = join(inputDir, 'verify-thumb.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'verify-thumb.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });

    expect(info).toBeTruthy();
    expect(await verifyThumbnail(project, info!)).toBe(true);

    const finalPath = resolve(project, info!.identifier);
    const original = await readFile(finalPath);
    // 0o400 is cooperative overwrite prevention, not an immutable boundary,
    // so a same-owner process can chmod and tamper with the file.
    await chmod(finalPath, 0o600);
    await writeFile(finalPath, Buffer.concat([original, Buffer.from('tamper')]));
    await chmod(finalPath, 0o400);

    expect(await verifyThumbnail(project, info!)).toBe(false);
  });

  it('verifyThumbnail returns false for a sparse/huge final that exceeds the thumbnail size bound', async () => {
    const filePath = join(inputDir, 'verify-huge.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'verify-huge.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    expect(info).toBeTruthy();

    const finalPath = resolve(project, info!.identifier);
    const hugeSize = 50 * 1024 * 1024 + 1;
    await unlink(finalPath);
    const sparseFh = await open(finalPath, 'w');
    await sparseFh.truncate(hugeSize);
    await sparseFh.close();

    // Must reject the oversized sparse file without allocating a buffer of its size.
    expect(await verifyThumbnail(project, info!)).toBe(false);
  });

  it('verifyThumbnail detects a final path swapped during the read window', async () => {
    const filePath = join(inputDir, 'verify-swap.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'verify-swap.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    expect(info).toBeTruthy();

    const finalPath = resolve(project, info!.identifier);
    const decoyPath = join(dirname(finalPath), 'verify-swap-decoy.jpg');
    await writeFile(decoyPath, Buffer.from('tampered-content'));

    const result = await verifyThumbnail(project, info!, {
      beforeRead: async () => {
        await rename(decoyPath, finalPath);
      },
    });

    // The fd still points to the original (now unlinked) inode, so the hash
    // would match, but the post-read path re-check must fail because finalPath
    // now names a different inode.
    expect(result).toBe(false);
  });

  it('verifyThumbnail detects a final path swapped after the content is read', async () => {
    const filePath = join(inputDir, 'verify-after-read.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'verify-after-read.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
    });
    expect(info).toBeTruthy();

    const finalPath = resolve(project, info!.identifier);
    const decoyPath = join(dirname(finalPath), 'verify-after-read-decoy.jpg');
    await writeFile(decoyPath, Buffer.from('tampered-content'));

    const result = await verifyThumbnail(project, info!, {
      afterRead: async () => {
        await rename(decoyPath, finalPath);
      },
    });

    expect(result).toBe(false);
  });

  it('rejects within bounded time when ffmpeg stdout exceeds the configured bound', async () => {
    const filePath = join(inputDir, 'stdout-bound.png');
    await createPng(filePath, 'red', 100, 100);
    const hash = await sourceHash(filePath);

    const start = Date.now();
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'stdout-bound.png',
      sourceHash: hash,
      sourceType: 'image',
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        sourceBufferLimit: 0,
        maxOutputBytes: 100,
      },
    });
    const elapsed = Date.now() - start;

    expect(info).toBeUndefined();
    expect(elapsed).toBeLessThan(3000);
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
  });

  it('rejects within bounded time when ffmpeg stderr exceeds the configured bound', async () => {
    const filePath = join(inputDir, 'stderr-bound.mp4');
    await createVideo(filePath, 'blue', 1080, 1920, 5);
    const hash = await sourceHash(filePath);

    const start = Date.now();
    const info = await generateThumbnail({
      inputRoot: inputDir,
      sourceRelativePath: 'stderr-bound.mp4',
      sourceHash: hash,
      sourceType: 'video',
      sourceDuration: 5,
      thumbnailDir,
      projectRoot: project,
      __testHooks: {
        sourceBufferLimit: 0,
        maxStderrBytes: 1,
      },
    });
    const elapsed = Date.now() - start;

    expect(info).toBeUndefined();
    expect(elapsed).toBeLessThan(3000);
    const files = await readdir(thumbnailDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
  });

  it('stops pumping and rejects immediately when ffmpeg exits non-zero early', async () => {
    const binDir = join(base, 'fake-bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'ffmpeg'), '#!/bin/sh\necho "injected failure" >&2\nexit 1\n');
    await chmod(join(binDir, 'ffmpeg'), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    try {
      const filePath = join(inputDir, 'early-fail.raw');
      const sourceSize = 100 * 1024 * 1024;
      await createSparseFile(filePath, sourceSize);
      const hash = await sourceHash(filePath);

      let sourceBytesRead = 0;
      const start = Date.now();
      const info = await generateThumbnail({
        inputRoot: inputDir,
        sourceRelativePath: 'early-fail.raw',
        sourceHash: hash,
        sourceType: 'image',
        thumbnailDir,
        projectRoot: project,
        __testHooks: {
          sourceBufferLimit: 0,
          afterSourceReadChunk: async ({ total }) => {
            sourceBytesRead = total;
          },
        },
      });
      const elapsed = Date.now() - start;

      expect(info).toBeUndefined();
      expect(elapsed).toBeLessThan(2000);
      expect(sourceBytesRead).toBeLessThan(sourceSize);
      expect(sourceBytesRead).toBeLessThanOrEqual(64 * 1024);
      const files = await readdir(thumbnailDir).catch(() => [] as string[]);
      expect(files.filter((f) => f.endsWith('.jpg'))).toEqual([]);
    } finally {
      process.env.PATH = originalPath ?? '';
    }
  });
});
