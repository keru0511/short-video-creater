import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog } from '../src/catalog.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsx = resolve(root, 'node_modules', '.bin', 'tsx');

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

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  const p = join(dir, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + '\n');
}

describe('media-subranges-cli', () => {
  let base: string;
  const outputBoundary = 'media-subranges-cli-test';

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'media-subranges-cli-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(join(root, 'output', outputBoundary), { recursive: true, force: true });
  });

  it('writes a v2 manifest with the canonical two-range fixture', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await generateCatalog(inputDir, { catalogRoot: 'input' });
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const catalogPath = join(base, 'input', 'catalog.json');
    const requestPath = join(base, 'input', 'request.json');
    await writeJson(base, 'input/catalog.json', catalog);
    await writeJson(base, 'input/request.json', {
      schemaVersion: 'v1',
      ranges: [
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 },
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 2.5, end: 5 },
      ],
    });

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');
    const relRequest = relative(root, requestPath).replace(/\\/g, '/');

    const { stdout } = await execFileAsync(tsx, [
      join(root, 'src', 'media-subranges-cli.ts'),
      relRequest,
      relCatalog,
      inputDir,
      `output/${outputBoundary}/manifest.json`,
    ]);

    expect(stdout).toContain('manifest.json');

    const manifestPath = join(root, 'output', outputBoundary, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe('v2');
    expect(manifest.count).toBe(2);
    expect(manifest.segments).toHaveLength(2);
  });

  it('exits with a non-zero code on an out-of-bounds range', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });

    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await generateCatalog(inputDir, { catalogRoot: 'input' });
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;

    const catalogPath = join(base, 'input', 'catalog.json');
    const requestPath = join(base, 'input', 'request.json');
    await writeJson(base, 'input/catalog.json', catalog);
    await writeJson(base, 'input/request.json', {
      schemaVersion: 'v1',
      ranges: [
        { assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 10 },
      ],
    });

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');
    const relRequest = relative(root, requestPath).replace(/\\/g, '/');

    await expect(execFileAsync(tsx, [
      join(root, 'src', 'media-subranges-cli.ts'),
      relRequest,
      relCatalog,
      inputDir,
      `output/${outputBoundary}/manifest.json`,
    ])).rejects.toEqual(expect.objectContaining({ code: expect.any(Number) }));
  });

  it('exits with a non-zero code when given too many arguments', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await generateCatalog(inputDir, { catalogRoot: 'input' });
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const catalogPath = join(base, 'input', 'catalog.json');
    const requestPath = join(base, 'input', 'request.json');
    await writeJson(base, 'input/catalog.json', catalog);
    await writeJson(base, 'input/request.json', {
      schemaVersion: 'v1',
      ranges: [{ assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 }],
    });

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');
    const relRequest = relative(root, requestPath).replace(/\\/g, '/');

    await expect(execFileAsync(tsx, [
      join(root, 'src', 'media-subranges-cli.ts'),
      relRequest,
      relCatalog,
      inputDir,
      'output/x.json',
      'extra-arg',
    ])).rejects.toEqual(expect.objectContaining({ code: expect.any(Number) }));
  });

  it('exits with a non-zero code for ./ output alias', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createVideo(join(inputDir, 'clip.mp4'), 'blue', 5);
    const catalog = await generateCatalog(inputDir, { catalogRoot: 'input' });
    const asset = catalog.assets.find((a) => a.relativePath === 'clip.mp4')!;
    const catalogPath = join(base, 'input', 'catalog.json');
    const requestPath = join(base, 'input', 'request.json');
    await writeJson(base, 'input/catalog.json', catalog);
    await writeJson(base, 'input/request.json', {
      schemaVersion: 'v1',
      ranges: [{ assetContentId: asset.id!, relativePath: 'clip.mp4', start: 0, end: 2.5 }],
    });

    const relCatalog = relative(root, catalogPath).replace(/\\/g, '/');
    const relRequest = relative(root, requestPath).replace(/\\/g, '/');

    await expect(execFileAsync(tsx, [
      join(root, 'src', 'media-subranges-cli.ts'),
      relRequest,
      relCatalog,
      inputDir,
      'output/./manifest.json',
    ])).rejects.toEqual(expect.objectContaining({ code: expect.any(Number) }));
  });
});
