import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog } from '../src/catalog.js';
import { sha256File } from '../src/core.js';
import {
  generateMediaPreviews,
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  WAVE_HEIGHT,
  WAVE_WIDTH,
} from '../src/media-preview.js';

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

async function getPngInfo(filePath: string): Promise<{ width: number; height: number; codec: string }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { streams: Array<{ width: number; height: number; codec_name: string }> };
  const stream = parsed.streams[0];
  return { width: stream.width, height: stream.height, codec: stream.codec_name };
}

async function writeCatalog(filePath: string, catalog: unknown): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await writeFile(filePath, JSON.stringify(catalog, null, 2) + '\n');
}

async function writeMinimalCatalog(filePath: string): Promise<void> {
  await writeCatalog(filePath, { catalogRoot: 'assets', count: 0, assets: [] });
}

async function create1x1Png(filePath: string): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=4x4',
    '-frames:v',
    '1',
    filePath,
  ]);
}

async function createFakeFfmpeg(
  dir: string,
  payloadPath: string,
): Promise<string> {
  const script = join(dir, 'fake-ffmpeg.mjs');
  const content = `#!/usr/bin/env node
import { copyFile } from 'node:fs/promises';
const payloadPath = ${JSON.stringify(payloadPath)};
const output = process.argv.at(-1);
await copyFile(payloadPath, output);
`;
  await writeFile(script, content, { mode: 0o755 });
  return script;
}

async function createFakeFfmpegInvalid(dir: string): Promise<string> {
  const script = join(dir, 'fake-ffmpeg-invalid.mjs');
  const content = `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const output = process.argv.at(-1);
await writeFile(output, 'this is not a png');
`;
  await writeFile(script, content, { mode: 0o755 });
  return script;
}

async function createPreviewPng(filePath: string): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}`,
    '-frames:v',
    '1',
    filePath,
  ]);
}

async function createConditionalFakeFfmpeg(
  dir: string,
  badName: string,
  payloadPath: string,
): Promise<string> {
  const script = join(dir, 'conditional-fake-ffmpeg.mjs');
  const content = `#!/usr/bin/env node
import { copyFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const i = args.indexOf('-i');
const input = i >= 0 ? args[i + 1] : '';
const output = args.at(-1);
if (input.includes(${JSON.stringify(badName)})) {
  await writeFile(output, 'invalid');
} else {
  await copyFile(${JSON.stringify(payloadPath)}, output);
}
`;
  await writeFile(script, content, { mode: 0o755 });
  return script;
}

describe('generateMediaPreviews', () => {
  let base: string;
  let assetRoot: string;
  let catalogPath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'preview-'));
    assetRoot = join(base, 'assets');
    catalogPath = join(base, 'catalog.json');
    await mkdir(assetRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('generates previews for image, video and audio', async () => {
    await createPng(join(assetRoot, 'image.png'));
    await createVideo(join(assetRoot, 'video.mp4'), 'blue', 3);
    await createAudio(join(assetRoot, 'audio.mp3'), 4);

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
    });

    expect(manifest.summary.total).toBe(3);
    expect(manifest.summary.succeeded).toBe(3);
    expect(manifest.summary.failed).toBe(0);
    expect(manifest.ffmpegVersion).toBeTruthy();

    const image = manifest.previews.find((p) => p.type === 'image');
    const video = manifest.previews.find((p) => p.type === 'video');
    const audio = manifest.previews.find((p) => p.type === 'audio');

    expect(image?.relativeOutput).toMatch(/^\w+-image\.png$/);
    expect(video?.relativeOutput).toMatch(/^\w+-video\.png$/);
    expect(audio?.relativeOutput).toMatch(/^\w+-audio\.png$/);

    const imagePath = join(base, 'output', 'previews', image!.relativeOutput!);
    const videoPath = join(base, 'output', 'previews', video!.relativeOutput!);
    const audioPath = join(base, 'output', 'previews', audio!.relativeOutput!);

    expect(existsSync(imagePath)).toBe(true);
    expect(existsSync(videoPath)).toBe(true);
    expect(existsSync(audioPath)).toBe(true);

    const imageInfo = await getPngInfo(imagePath);
    const videoInfo = await getPngInfo(videoPath);
    const audioInfo = await getPngInfo(audioPath);

    expect(imageInfo.codec).toBe('png');
    expect(videoInfo.codec).toBe('png');
    expect(audioInfo.codec).toBe('png');

    expect(imageInfo.width).toBe(PREVIEW_WIDTH);
    expect(imageInfo.height).toBe(PREVIEW_HEIGHT);
    expect(videoInfo.width).toBe(PREVIEW_WIDTH);
    expect(videoInfo.height).toBe(PREVIEW_HEIGHT);
    expect(audioInfo.width).toBe(WAVE_WIDTH);
    expect(audioInfo.height).toBe(WAVE_HEIGHT);

    expect(image?.outputSha256).toBe(await sha256File(imagePath));
    expect(video?.outputSha256).toBe(await sha256File(videoPath));
    expect(audio?.outputSha256).toBe(await sha256File(audioPath));
  }, 60000);

  it('produces deterministic output for the same inputs', async () => {
    await createPng(join(assetRoot, 'image.png'));
    await createVideo(join(assetRoot, 'video.mp4'), 'blue', 2);
    await createAudio(join(assetRoot, 'audio.mp3'), 3);

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const first = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    const second = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const firstById = Object.fromEntries(first.previews.map((p) => [p.assetId, p]));
    const secondById = Object.fromEntries(second.previews.map((p) => [p.assetId, p]));

    for (const id of Object.keys(firstById)) {
      expect(secondById[id].outputSha256).toBe(firstById[id].outputSha256);
    }
  }, 60000);

  it('keeps input SHA-256 unchanged', async () => {
    const imagePath = join(assetRoot, 'image.png');
    await createPng(imagePath);

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const before = await sha256File(imagePath);
    await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    const after = await sha256File(imagePath);

    expect(after).toBe(before);
  }, 60000);

  it('continues and writes manifest when one preview fails', async () => {
    await createPng(join(assetRoot, 'ok.png'));
    await writeFile(join(assetRoot, 'broken.mp4'), Buffer.from('not a video'));

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.total).toBe(2);
    expect(manifest.summary.succeeded).toBe(1);
    expect(manifest.summary.failed).toBe(1);

    const broken = manifest.previews.find((p) => p.relativePath === 'broken.mp4');
    const ok = manifest.previews.find((p) => p.relativePath === 'ok.png');

    expect(broken?.error).toBeTruthy();
    expect(ok?.error).toBeUndefined();
    expect(ok?.relativeOutput).toBeTruthy();
  }, 60000);

  it('rejects a relativePath that escapes the asset root', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const outside = join(base, 'outside.png');
    await createPng(outside, 'blue');

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    catalog.assets.push({
      id: 'spoof-id',
      relativePath: '../outside.png',
      sizeBytes: 100,
      mtime: 1,
      probe: { type: 'image', hasAudio: false, audioStreams: [] },
    });
    catalog.count = catalog.assets.length;
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const spoof = manifest.previews.find((p) => p.assetId === 'spoof-id');
    expect(spoof?.error?.code).toBe('PATH_TRAVERSAL');
  }, 60000);

  it('rejects an absolute relativePath', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    catalog.assets.push({
      id: 'abs-id',
      relativePath: '/etc/passwd',
      sizeBytes: 100,
      mtime: 1,
      probe: { type: 'image', hasAudio: false, audioStreams: [] },
    });
    catalog.count = catalog.assets.length;
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const abs = manifest.previews.find((p) => p.assetId === 'abs-id');
    expect(abs?.error?.code).toBe('ABSOLUTE_PATH');
  }, 60000);

  it('rejects a null byte in relativePath', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    catalog.assets.push({
      id: 'null-id',
      relativePath: 'bad\0.png',
      sizeBytes: 100,
      mtime: 1,
      probe: { type: 'image', hasAudio: false, audioStreams: [] },
    });
    catalog.count = catalog.assets.length;
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const nullEntry = manifest.previews.find((p) => p.assetId === 'null-id');
    expect(nullEntry?.error?.code).toBe('NULL_BYTE_PATH');
  }, 60000);

  it('rejects a symlink escape in the asset root', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await createPng(join(outside, 'outside.png'), 'blue');
    await symlink(join(outside, 'outside.png'), join(assetRoot, 'link.png'));

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    catalog.assets.push({
      id: 'link-id',
      relativePath: 'link.png',
      sizeBytes: 100,
      mtime: 1,
      probe: { type: 'image', hasAudio: false, audioStreams: [] },
    });
    catalog.count = catalog.assets.length;
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const link = manifest.previews.find((p) => p.assetId === 'link-id');
    expect(link?.error?.code).toBe('SYMLINK_ESCAPE');
  }, 60000);

  it('rejects a spoofed catalog entry with a mismatched type', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    const entry = catalog.assets[0];
    entry.probe = { type: 'audio', hasAudio: true, audioCodec: 'mp3', audioStreams: [] };
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    expect(manifest.previews[0].error?.code).toBe('TYPE_MISMATCH');
  }, 60000);

  it('reports missing assets as NOT_FOUND', async () => {
    await createPng(join(assetRoot, 'image.png'));
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    catalog.assets.push({
      id: 'missing-id',
      relativePath: 'does-not-exist.mp4',
      sizeBytes: 100,
      mtime: 1,
      probe: { type: 'video', hasAudio: false, duration: 2, audioStreams: [] },
    });
    catalog.count = catalog.assets.length;
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const missing = manifest.previews.find((p) => p.assetId === 'missing-id');
    expect(missing?.error?.code).toBe('NOT_FOUND');
  }, 60000);

  it('uses one output file for duplicate IDs', async () => {
    const src = join(assetRoot, 'same.png');
    await createPng(src);
    await mkdir(join(assetRoot, 'copy'), { recursive: true });
    await copyFile(src, join(assetRoot, 'copy', 'same.png'));

    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.succeeded).toBe(2);
    const relativeOutputs = manifest.previews.map((p) => p.relativeOutput);
    expect(new Set(relativeOutputs).size).toBe(1);
    expect(relativeOutputs[0]).toMatch(/^\w+-image\.png$/);
  }, 60000);

  it('produces identical canonical manifests across different absolute roots and times', async () => {
    const baseA = await mkdtemp(join(root, 'tests', 'preview-a-'));
    const baseB = await mkdtemp(join(root, 'tests', 'preview-b-'));
    try {
      for (const b of [baseA, baseB]) {
        const assets = join(b, 'assets');
        await mkdir(assets, { recursive: true });
        await createPng(join(assets, 'image.png'));
        const catalog = await generateCatalog(assets, { catalogRoot: 'assets' });
        await writeCatalog(join(b, 'catalog.json'), catalog);
        await generateMediaPreviews(join(b, 'catalog.json'), assets, {
          projectRoot: b,
        });
      }

      const manifestA = await readFile(join(baseA, 'output', 'previews', 'manifest.json'), 'utf8');
      const manifestB = await readFile(join(baseB, 'output', 'previews', 'manifest.json'), 'utf8');
      expect(manifestA).toBe(manifestB);
      expect(await sha256File(join(baseA, 'output', 'previews', 'manifest.json'))).toBe(
        await sha256File(join(baseB, 'output', 'previews', 'manifest.json')),
      );
    } finally {
      await rm(baseA, { recursive: true, force: true });
      await rm(baseB, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects asset root that overlaps preview output directory', async () => {
    const overlapRoot = join(base, 'output', 'previews');
    await mkdir(overlapRoot, { recursive: true });
    await writeMinimalCatalog(catalogPath);

    await expect(
      generateMediaPreviews(catalogPath, overlapRoot, { projectRoot: base }),
    ).rejects.toThrow('overlap');
  }, 60000);

  it('rejects asset root that is an ancestor of preview output directory', async () => {
    const overlapRoot = base;
    await writeMinimalCatalog(catalogPath);

    await expect(
      generateMediaPreviews(catalogPath, overlapRoot, { projectRoot: base }),
    ).rejects.toThrow('overlap');
  }, 60000);

  it('rejects preview output directory that overlaps asset root', async () => {
    const nestedAssetRoot = join(base, 'output', 'previews', 'assets');
    await mkdir(nestedAssetRoot, { recursive: true });
    await writeMinimalCatalog(catalogPath);

    await expect(
      generateMediaPreviews(catalogPath, nestedAssetRoot, { projectRoot: base }),
    ).rejects.toThrow('overlap');
  }, 60000);

  it('rejects catalog path overlapping preview output directory', async () => {
    await mkdir(assetRoot, { recursive: true });
    const badCatalog = join(base, 'output', 'previews', 'catalog.json');
    await writeMinimalCatalog(badCatalog);

    await expect(
      generateMediaPreviews(badCatalog, assetRoot, { projectRoot: base }),
    ).rejects.toThrow('overlap');
  }, 60000);

  it('rejects project root that is a symbolic link', async () => {
    const realRoot = await mkdtemp(join(root, 'tests', 'preview-real-'));
    const linkRoot = `${realRoot}-link`;
    await symlink(realRoot, linkRoot);
    await writeMinimalCatalog(catalogPath);
    try {
      await expect(
        generateMediaPreviews(catalogPath, assetRoot, { projectRoot: linkRoot }),
      ).rejects.toThrow('symbolic link');
    } finally {
      await rm(realRoot, { recursive: true, force: true });
      await rm(linkRoot, { force: true }).catch(() => {});
    }
  }, 60000);

  it('rejects output directory symlink escape', async () => {
    const outside = await mkdtemp(join(root, 'tests', 'preview-out-'));
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(base, 'output'));
    await writeMinimalCatalog(catalogPath);
    try {
      await expect(
        generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base }),
      ).rejects.toThrow('symbolic link');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects previews directory symlink escape', async () => {
    const outside = await mkdtemp(join(root, 'tests', 'preview-out-'));
    await mkdir(join(base, 'output'), { recursive: true });
    await symlink(outside, join(base, 'output', 'previews'));
    await writeMinimalCatalog(catalogPath);
    try {
      await expect(
        generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base }),
      ).rejects.toThrow('symbolic link');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects image content with a video extension as EXTENSION_MISMATCH', async () => {
    const src = join(assetRoot, 'tmp.png');
    await createPng(src);
    const dest = join(assetRoot, 'image.mp4');
    await copyFile(src, dest);
    const id = await sha256File(dest);

    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          id,
          relativePath: 'image.mp4',
          sizeBytes: 100,
          mtime: 1,
          probe: { type: 'image', hasAudio: false, audioStreams: [] },
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.previews[0].error?.code).toBe('EXTENSION_MISMATCH');
  }, 60000);

  it('rejects video content with an image extension as EXTENSION_MISMATCH', async () => {
    const src = join(assetRoot, 'tmp.mp4');
    await createVideo(src, 'blue', 1);
    const dest = join(assetRoot, 'video.png');
    await copyFile(src, dest);
    const id = await sha256File(dest);

    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          id,
          relativePath: 'video.png',
          sizeBytes: 100,
          mtime: 1,
          probe: { type: 'video', hasAudio: false, audioStreams: [], duration: 1 },
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.previews[0].error?.code).toBe('EXTENSION_MISMATCH');
  }, 60000);

  it('rejects audio content with an image extension as EXTENSION_MISMATCH', async () => {
    const src = join(assetRoot, 'tmp.mp3');
    await createAudio(src, 1);
    const dest = join(assetRoot, 'audio.png');
    await copyFile(src, dest);
    const id = await sha256File(dest);

    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          id,
          relativePath: 'audio.png',
          sizeBytes: 100,
          mtime: 1,
          probe: { type: 'audio', hasAudio: true, audioCodec: 'mp3', audioStreams: [] },
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.previews[0].error?.code).toBe('EXTENSION_MISMATCH');
  }, 60000);

  it('rejects fake ffmpeg that exits 0 with wrong preview dimensions', async () => {
    const imagePath = join(assetRoot, 'image.png');
    await createPng(imagePath);
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const payload = join(base, '1x1.png');
    await create1x1Png(payload);
    const fake = await createFakeFfmpeg(base, payload);

    const before = await sha256File(imagePath);
    const manifest = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
      ffmpegPath: fake,
    });
    const after = await sha256File(imagePath);

    expect(after).toBe(before);
    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    expect(manifest.previews[0].error?.code).toBe('INVALID_PREVIEW');
    expect(manifest.previews[0].diagnostic).toMatch(/expected.*360x640/);
    expect(manifest.previews[0].relativeOutput).toBeUndefined();
  }, 60000);

  it('rejects fake ffmpeg that exits 0 with an invalid file', async () => {
    const imagePath = join(assetRoot, 'image.png');
    await createPng(imagePath);
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const fake = await createFakeFfmpegInvalid(base);

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
      ffmpegPath: fake,
    });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    expect(manifest.previews[0].error?.code).toBe('INVALID_PREVIEW');
  }, 60000);

  it('rejects catalog path whose parent is a symlink to preview output directory', async () => {
    const outputDir = join(base, 'output');
    const previewDir = join(outputDir, 'previews');
    await mkdir(previewDir, { recursive: true });
    const linkDir = join(outputDir, 'previews-link');
    await symlink(previewDir, linkDir);

    const badCatalog = join(linkDir, 'catalog.json');
    await writeMinimalCatalog(badCatalog);

    await expect(
      generateMediaPreviews(badCatalog, assetRoot, { projectRoot: base }),
    ).rejects.toThrow('symbolic link');
  }, 60000);

  it('rejects catalog path pointing to manifest.json through a symlinked parent', async () => {
    const outputDir = join(base, 'output');
    const previewDir = join(outputDir, 'previews');
    await mkdir(previewDir, { recursive: true });
    const linkDir = join(outputDir, 'previews-link');
    await symlink(previewDir, linkDir);

    const badCatalog = join(linkDir, 'manifest.json');
    await writeMinimalCatalog(badCatalog);

    await expect(
      generateMediaPreviews(badCatalog, assetRoot, { projectRoot: base }),
    ).rejects.toThrow('symbolic link');
  }, 60000);

  it('normalizes untrusted catalog entry errors in canonical manifest', async () => {
    const leakedPath = join(base, 'secret.txt');
    await writeFile(join(assetRoot, 'allowed.mp4'), 'x');
    await writeFile(join(assetRoot, 'unknown.mp4'), 'x');
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 2,
      assets: [
        {
          id: 'allowed-id',
          relativePath: 'allowed.mp4',
          sizeBytes: 1,
          mtime: 1,
          error: { code: 'HASH_FAILED', message: `secret ${leakedPath}` },
        },
        {
          id: 'unknown-id',
          relativePath: 'unknown.mp4',
          sizeBytes: 1,
          mtime: 1,
          error: { code: 'ARBITRARY_CODE', message: `leaked ${leakedPath}` },
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });

    const allowed = manifest.previews.find((p) => p.assetId === 'allowed-id');
    const unknown = manifest.previews.find((p) => p.assetId === 'unknown-id');

    expect(allowed?.error?.code).toBe('HASH_FAILED');
    expect(allowed?.error?.message).toBe('Failed to compute content hash');
    expect(allowed?.diagnostic).toBeUndefined();

    expect(unknown?.error?.code).toBe('CATALOG_ERROR');
    expect(unknown?.error?.message).toBe('Catalog entry contains an invalid error');
    expect(unknown?.diagnostic).not.toContain(leakedPath);
    expect(unknown?.diagnostic).toContain('ARBITRARY_CODE');

    const canonical = JSON.parse(
      await readFile(join(base, 'output', 'previews', 'manifest.json'), 'utf8'),
    );
    const canonicalUnknown = canonical.previews.find((p: { assetId?: string }) => p.assetId === 'unknown-id');
    expect(canonicalUnknown.error.message).toBe('Catalog entry contains an invalid error');
    expect(canonicalUnknown.diagnostic).toBeUndefined();
  }, 60000);

  it('masks absolute paths and truncates diagnostics in run.json', async () => {
    const imagePath = join(assetRoot, 'image.png');
    await createPng(imagePath);
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const fakeScript = join(base, 'fake-ffmpeg-leak.mjs');
    const content = `#!/usr/bin/env node
const base = ${JSON.stringify(base)};
const payload = 'a'.repeat(2000);
process.stderr.write('failed at ' + base + '/assets/image.png and ' + base + '/output/previews/temp.png ' + payload + '\\n');
process.exit(1);
`;
    await writeFile(fakeScript, content, { mode: 0o755 });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
      ffmpegPath: fakeScript,
    });

    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    const preview = manifest.previews[0];
    expect(preview.error?.code).toBe('PROCESS_FAILED');
    expect(preview.diagnostic).not.toContain(base);
    expect(preview.diagnostic).toContain('<projectRoot>');
    expect(preview.diagnostic).toContain('<assetRoot>');
    expect(preview.diagnostic?.endsWith('... [truncated]')).toBe(true);

    const runJson = JSON.parse(await readFile(join(base, 'output', 'previews', 'run.json'), 'utf8'));
    const runPreview = runJson.previews[0];
    expect(runPreview.diagnostic).not.toContain(base);
    expect(runPreview.diagnostic).toContain('<projectRoot>');
    expect(runPreview.diagnostic?.endsWith('... [truncated]')).toBe(true);
  }, 60000);

  it('rejects invalid relativePath before catalog error', async () => {
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          id: 'valid-id',
          relativePath: '/absolute/secret',
          sizeBytes: 1,
          mtime: 1,
          error: { code: 'HASH_FAILED', message: 'catalog says hash failed' },
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    expect(manifest.previews[0].error?.code).toBe('ABSOLUTE_PATH');
  }, 60000);

  it('rejects path traversal before missing ID', async () => {
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          relativePath: '../escape',
          sizeBytes: 1,
          mtime: 1,
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(1);
    expect(manifest.previews[0].error?.code).toBe('PATH_TRAVERSAL');
  }, 60000);

  it('does not overwrite existing valid previews on failed re-generation with fake ffmpeg', async () => {
    const imagePath = join(assetRoot, 'image.png');
    await createPng(imagePath);
    const catalog = await generateCatalog(assetRoot, { catalogRoot: 'assets' });
    await writeCatalog(catalogPath, catalog);

    const first = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(first.summary.succeeded).toBe(1);
    const outputName = first.previews[0].relativeOutput!;
    const outputPath = join(base, 'output', 'previews', outputName);
    expect(existsSync(outputPath)).toBe(true);
    const beforeSha = await sha256File(outputPath);

    const fake = await createFakeFfmpegInvalid(base);
    const second = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
      ffmpegPath: fake,
    });
    expect(second.summary.succeeded).toBe(0);
    expect(second.summary.failed).toBe(1);

    expect(existsSync(outputPath)).toBe(true);
    const afterSha = await sha256File(outputPath);
    expect(afterSha).toBe(beforeSha);
  }, 60000);

  it('isolates duplicate ID failures so one entry failure does not destroy the shared output', async () => {
    const imagePath = join(assetRoot, 'image.png');
    const copyPath = join(assetRoot, 'image.mp4');
    await createPng(imagePath);
    await copyFile(imagePath, copyPath);
    const id = await sha256File(imagePath);

    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 2,
      assets: [
        { id, relativePath: 'image.mp4', sizeBytes: 1, mtime: 1 },
        { id, relativePath: 'image.png', sizeBytes: 1, mtime: 1 },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(manifest.summary.succeeded).toBe(1);
    expect(manifest.summary.failed).toBe(1);

    const failed = manifest.previews.find((p) => p.relativePath === 'image.mp4');
    const success = manifest.previews.find((p) => p.relativePath === 'image.png');
    expect(failed?.error?.code).toBe('EXTENSION_MISMATCH');
    expect(success?.error).toBeUndefined();
    expect(success?.relativeOutput).toBe(`${id}-image.png`);

    const outputPath = join(base, 'output', 'previews', `${id}-image.png`);
    expect(existsSync(outputPath)).toBe(true);
    const png = await getPngInfo(outputPath);
    expect(png.codec).toBe('png');
    expect(png.width).toBe(PREVIEW_WIDTH);
    expect(png.height).toBe(PREVIEW_HEIGHT);
  }, 60000);

  it('does not persist untrusted relativePath into canonical/run manifest when path validation fails', async () => {
    const leaked = 'secret-absolute-escape';
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 2,
      assets: [
        {
          id: 'with-error',
          relativePath: `/etc/${leaked}`,
          sizeBytes: 1,
          mtime: 1,
          error: { code: 'HASH_FAILED', message: 'catalog error' },
        },
        {
          relativePath: `../${leaked}`,
          sizeBytes: 1,
          mtime: 1,
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(manifest.summary.succeeded).toBe(0);
    expect(manifest.summary.failed).toBe(2);

    const canonical = JSON.parse(
      await readFile(join(base, 'output', 'previews', 'manifest.json'), 'utf8'),
    );
    const runJson = JSON.parse(await readFile(join(base, 'output', 'previews', 'run.json'), 'utf8'));

    for (const source of [manifest, canonical, runJson]) {
      const text = JSON.stringify(source);
      expect(text).not.toContain('/etc/');
      expect(text).not.toContain('..');
      expect(text).not.toContain(leaked);
    }

    for (const entry of canonical.previews) {
      expect(entry.relativePath).toBe('<invalid path>');
      expect(['ABSOLUTE_PATH', 'PATH_TRAVERSAL']).toContain(entry.error?.code);
    }
  }, 60000);

  it('rejects control characters in relativePath without leaking them into manifests', async () => {
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 1,
      assets: [
        {
          id: 'ctrl',
          relativePath: 'bad\x01/secret\x02value',
          sizeBytes: 1,
          mtime: 1,
        },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    expect(manifest.previews[0].error?.code).toBe('CONTROL_CHARACTERS');

    const canonical = JSON.parse(
      await readFile(join(base, 'output', 'previews', 'manifest.json'), 'utf8'),
    );
    const text = JSON.stringify(canonical);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('\x01');
    expect(text).not.toContain('\x02');
    expect(canonical.previews[0].relativePath).toBe('<invalid path>');
  }, 60000);

  it('canonical manifest is deterministic for different invalid paths with the same error classification', async () => {
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 2,
      assets: [
        { relativePath: '/etc/secretA', sizeBytes: 1, mtime: 1 },
        { relativePath: '/var/secretB', sizeBytes: 1, mtime: 1 },
      ],
    });

    const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: base });
    const canonical = JSON.parse(
      await readFile(join(base, 'output', 'previews', 'manifest.json'), 'utf8'),
    );

    expect(canonical.previews).toHaveLength(2);
    expect(canonical.previews[0]).toEqual(canonical.previews[1]);
    expect(canonical.previews[0].relativePath).toBe('<invalid path>');
    expect(canonical.previews[0].error?.code).toBe('ABSOLUTE_PATH');
  }, 60000);

  it('falls back to the next duplicate source when the first duplicate producer fails', async () => {
    const aPath = join(assetRoot, 'a.png');
    const bPath = join(assetRoot, 'b.png');
    const payloadPath = join(base, 'valid-preview.png');
    await createPng(aPath);
    await copyFile(aPath, bPath);
    await createPreviewPng(payloadPath);
    const id = await sha256File(aPath);

    const fake = await createConditionalFakeFfmpeg(base, 'a.png', payloadPath);
    await writeCatalog(catalogPath, {
      catalogRoot: 'assets',
      count: 2,
      assets: [
        { id, relativePath: 'a.png', sizeBytes: 1, mtime: 1 },
        { id, relativePath: 'b.png', sizeBytes: 1, mtime: 1 },
      ],
    });

    const beforeA = await sha256File(aPath);
    const beforeB = await sha256File(bPath);
    const manifest = await generateMediaPreviews(catalogPath, assetRoot, {
      projectRoot: base,
      concurrency: 1,
      ffmpegPath: fake,
    });
    const afterA = await sha256File(aPath);
    const afterB = await sha256File(bPath);

    expect(afterA).toBe(beforeA);
    expect(afterB).toBe(beforeB);

    const aEntry = manifest.previews.find((p) => p.relativePath === 'a.png');
    const bEntry = manifest.previews.find((p) => p.relativePath === 'b.png');
    expect(aEntry?.error?.code).toBe('INVALID_PREVIEW');
    expect(bEntry?.error).toBeUndefined();
    expect(bEntry?.relativeOutput).toBe(`${id}-image.png`);

    const outputPath = join(base, 'output', 'previews', `${id}-image.png`);
    expect(existsSync(outputPath)).toBe(true);
    const png = await getPngInfo(outputPath);
    expect(png.codec).toBe('png');
    expect(png.width).toBe(PREVIEW_WIDTH);
    expect(png.height).toBe(PREVIEW_HEIGHT);
  }, 60000);
});
