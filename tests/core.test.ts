import { beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFfmpegCommand,
  ffprobe,
  generate,
  resolveSafePath,
  sha256File,
  TimelineSchema,
  ClipSchema,
} from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';

const execFileAsync = promisify(execFile);

let miseAvailable = false;
try {
  execFileSync('mise', ['--version'], { stdio: 'ignore' });
  miseAvailable = true;
} catch {}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const outputDir = join(root, 'output');
const unsafeDir = join(root, 'unsafe');

beforeAll(async () => {
  await mkdir(outputDir, { recursive: true });
  await mkdir(unsafeDir, { recursive: true });
  await generateFixtures(root);
}, 60000);

async function extractFrame(videoPath: string, timeSec: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss',
      String(timeSec),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );
  return stdout as Buffer;
}

function isRed(rgb: Buffer): boolean {
  return rgb[0] > 200 && rgb[1] < 50 && rgb[2] < 50;
}

function isBlue(rgb: Buffer): boolean {
  return rgb[0] < 50 && rgb[1] < 50 && rgb[2] > 200;
}

const baseTimeline = () => ({
  width: 1080 as const,
  height: 1920 as const,
  fps: 30,
  outputPath: 'test.mp4',
  background: '1a1a2e',
  clips: [
    { type: 'image', source: 'image.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
    { type: 'audio', source: 'audio.mp3', start: 0, end: 2, in: 0, out: 2 },
  ],
});

describe('TimelineSchema', () => {
  it('accepts a valid timeline', () => {
    expect(() => TimelineSchema.parse(baseTimeline())).not.toThrow();
  });

  it('accepts 720x1280 dimensions', () => {
    const tl = { ...baseTimeline(), width: 720, height: 1280 };
    expect(() => TimelineSchema.parse(tl)).not.toThrow();
  });

  it('rejects empty clips', () => {
    const tl = { ...baseTimeline(), clips: [] };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects negative start', () => {
    const tl = baseTimeline();
    tl.clips[0].start = -1;
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects in >= out', () => {
    const tl = baseTimeline();
    tl.clips[0].in = 2;
    tl.clips[0].out = 2;
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects unsupported dimensions', () => {
    const tl = { ...baseTimeline(), width: 800, height: 600 };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects 720x1920 dimensions', () => {
    const tl = { ...baseTimeline(), width: 720, height: 1920 };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects 1080x1280 dimensions', () => {
    const tl = { ...baseTimeline(), width: 1080, height: 1280 };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });
});

describe('ClipSchema', () => {
  it('parses a source string with shell metacharacters', () => {
    const clip = ClipSchema.parse({
      source: 'test;$(echo pwned).png',
      type: 'image',
      start: 0,
      end: 1,
      in: 0,
      out: 1,
    });
    expect(clip.source).toBe('test;$(echo pwned).png');
  });
});

describe('resolveSafePath', () => {
  it('resolves a normal relative path', () => {
    const p = resolveSafePath(fixturesDir, 'image.png');
    expect(existsSync(p)).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath(fixturesDir, '/etc/passwd')).toThrow('Absolute');
  });

  it('rejects path traversal with ..', () => {
    expect(() => resolveSafePath(fixturesDir, '../package.json')).toThrow('traversal');
  });

  it('rejects symlinks', async () => {
    const linkPath = join(fixturesDir, 'link-to-unsafe');
    try {
      await rm(linkPath);
    } catch {}
    await symlink(resolve(unsafeDir, 'outside.png'), linkPath);
    expect(() => resolveSafePath(fixturesDir, 'link-to-unsafe')).toThrow('Symbolic');
    await rm(linkPath);
  });

  it('allows output paths within output directory', () => {
    const p = resolveSafePath(outputDir, 'video.mp4', { allowNonexistent: true });
    expect(p).toBe(resolve(outputDir, 'video.mp4'));
  });
});

describe('buildFfmpegCommand', () => {
  it('builds argv with source path as a separate argument', async () => {
    const timeline = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8'));
    const res = await generate(
      { ...timeline, outputPath: 'build.mp4' },
      { rootDir: root, fixturesDir, outputDir },
    );
    const args = res.args;

    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args).toContain(res.outputPath);
    // Ensure we did not concatenate shell metacharacters into a single shell string
    expect(args.join(' ')).not.toContain('&&');
  });
});

describe('generate', () => {
  it('produces a 1080x1920 h264 mp4 with audio from fixtures', async () => {
    const timeline = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8'));
    const imageBefore = await sha256File(join(fixturesDir, 'image.png'));
    const audioBefore = await sha256File(join(fixturesDir, 'audio.mp3'));

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);

    const imageAfter = await sha256File(join(fixturesDir, 'image.png'));
    const audioAfter = await sha256File(join(fixturesDir, 'audio.mp3'));
    expect(imageAfter).toBe(imageBefore);
    expect(audioAfter).toBe(audioBefore);
  });

  it('handles source paths containing shell metacharacters safely', async () => {
    const weird = 'test;echo pwned.png';
    const original = await readFile(join(fixturesDir, 'image.png'));
    await writeFile(join(fixturesDir, weird), original);

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'metachar.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: weird, start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
      ],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.videoCodec).toBe('h264');
    await rm(join(fixturesDir, weird));
  });

  it('rejects output path escaping output directory', async () => {
    const timeline = { ...baseTimeline(), outputPath: '../unsafe/out.mp4' };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Path traversal',
    );
  });

  it('rejects 0-second output', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].end = 0;
    timeline.clips[0].out = 0;
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
  });

  it('rejects in >= out', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].in = 2;
    timeline.clips[0].out = 1;
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
  });

  it('rejects audio out exceeding source duration', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].end = 10;
    timeline.clips[0].out = 10;
    timeline.clips[1].end = 10;
    timeline.clips[1].out = 10;
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects absolute source path', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].source = '/etc/passwd';
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Absolute',
    );
  });

  it('rejects path traversal source', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].source = '../package.json';
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects negative times via schema', async () => {
    const timeline = baseTimeline();
    timeline.clips[0].start = -1;
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
  });

  it('creates output directory if it does not exist', async () => {
    await rm(outputDir, { recursive: true, force: true });
    const timeline = baseTimeline();
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    expect(existsSync(outputDir)).toBe(true);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  it('rejects output path with symlink parent escape and does not write outside', async () => {
    const outside = join(unsafeDir, 'outside');
    await mkdir(outside, { recursive: true });
    const linkPath = join(outputDir, 'escape');
    try {
      await rm(linkPath, { force: true });
    } catch {}
    await symlink(outside, linkPath);
    const timeline = { ...baseTimeline(), outputPath: 'escape/pwn.mp4' };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
    const files = await readdir(outside);
    expect(files).toEqual([]);
    await rm(linkPath, { force: true });
  });

  it('rejects fixture source path with symlink parent escape', async () => {
    const outside = join(unsafeDir, 'outside-src');
    await mkdir(outside, { recursive: true });
    const linkPath = join(fixturesDir, 'escape-src');
    try {
      await rm(linkPath, { force: true });
    } catch {}
    await symlink(outside, linkPath);
    await writeFile(join(outside, 'img.png'), Buffer.from('not-a-png'));
    const timeline = baseTimeline();
    timeline.clips[0].source = 'escape-src/img.png';
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
    await rm(linkPath, { force: true });
  });
});

describe('multiclip generate', () => {
  it('concatenates image -> image and verifies boundary frames', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'img-img.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 1, end: 2, in: 0, out: 1, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 2, in: 0, out: 2 },
      ],
    };
    const before = {
      red: await sha256File(join(fixturesDir, 'red.png')),
      blue: await sha256File(join(fixturesDir, 'blue.png')),
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 2)).toBeLessThan(0.5);
    expect(isRed(await extractFrame(result.outputPath, 0.5))).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 1.5))).toBe(true);
    expect(await sha256File(join(fixturesDir, 'red.png'))).toBe(before.red);
    expect(await sha256File(join(fixturesDir, 'blue.png'))).toBe(before.blue);
  });

  it('concatenates image -> video and verifies boundary frames', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'img-vid.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'video', source: 'blue.mp4', start: 1, end: 3, in: 0, out: 2, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 3, in: 0, out: 3 },
      ],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 3)).toBeLessThan(0.5);
    expect(isRed(await extractFrame(result.outputPath, 0.5))).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 1.5))).toBe(true);
  });

  it('concatenates video -> image and verifies boundary frames', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'vid-img.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'video', source: 'red.mp4', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 3, in: 0, out: 1, fit: 'contain' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 3, in: 0, out: 3 },
      ],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 3)).toBeLessThan(0.5);
    expect(isRed(await extractFrame(result.outputPath, 0.5))).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2.5))).toBe(true);
  });

  it('concatenates video -> video with non-zero in points and verifies boundary frames', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'vid-vid.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'video', source: 'red.mp4', start: 0, end: 2, in: 1, out: 3, fit: 'cover' },
        { type: 'video', source: 'blue.mp4', start: 2, end: 4, in: 1, out: 3, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 4, in: 0, out: 4 },
      ],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 4)).toBeLessThan(0.5);
    expect(isRed(await extractFrame(result.outputPath, 0.5))).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2.5))).toBe(true);
  });

  it('preserves source SHA-256 for all visual and audio inputs', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'hash-multi.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'video', source: 'blue.mp4', start: 1, end: 3, in: 0, out: 2, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 3, in: 0, out: 3 },
      ],
    };

    const sources = ['red.png', 'blue.mp4', 'audio.mp3'];
    const before: Record<string, string> = {};
    for (const source of sources) {
      before[join(fixturesDir, source)] = await sha256File(join(fixturesDir, source));
    }

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    for (const source of sources) {
      const path = join(fixturesDir, source);
      expect(result.sourceHashes).toHaveProperty(path);
      expect(await sha256File(path)).toBe(result.sourceHashes[path]);
      expect(await sha256File(path)).toBe(before[path]);
    }
  });

  it('rejects a gap between visual clips', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'gap.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 1.5, end: 2.5, in: 0, out: 1, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 2.5, in: 0, out: 2.5 },
      ],
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Gap',
    );
  });

  it('rejects an overlap between visual clips', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'overlap.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1.5, in: 0, out: 1.5, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 1, end: 2.5, in: 0, out: 1.5, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 2.5, in: 0, out: 2.5 },
      ],
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'overlap',
    );
  });

  it('rejects reversed visual clip order', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'reverse.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 1, end: 2, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 2, in: 0, out: 2 },
      ],
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      /start must be 0|out of order|overlap/,
    );
  });

  it('rejects visual clip out exceeding source duration', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'video-too-long.mp4',
      background: '1a1a2e',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'video', source: 'video.mp4', start: 1, end: 5, in: 0, out: 4, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 5, in: 0, out: 5 },
      ],
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects more than 5 visual clips', async () => {
    const clips = [];
    for (let i = 0; i < 6; i++) {
      clips.push({
        type: 'image',
        source: 'red.png',
        start: i,
        end: i + 1,
        in: 0,
        out: 1,
        fit: 'cover',
      });
    }
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'too-many.mp4',
      background: '1a1a2e',
      clips,
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'at most 5 visual clips',
    );
  });
});

describe('integration', () => {
  it.skipIf(!miseAvailable)('mise run generate succeeds from a clean state', async () => {
    await rm(outputDir, { recursive: true, force: true });
    // Preserve the tracked canonical media-subrange inputs; the command must
    // regenerate all other fixtures from these canonical inputs.
    const canonicalBackup = join(root, '.tmp-canonical-backup');
    await rm(canonicalBackup, { recursive: true, force: true });
    await cp(join(fixturesDir, 'media-subrange-input'), canonicalBackup, { recursive: true });
    await rm(fixturesDir, { recursive: true, force: true });
    await mkdir(join(fixturesDir, 'media-subrange-input'), { recursive: true });
    await cp(canonicalBackup, join(fixturesDir, 'media-subrange-input'), { recursive: true });
    await rm(canonicalBackup, { recursive: true, force: true });
    await execFileAsync('mise', ['run', 'generate'], { cwd: root, env: process.env });
    const videoPath = join(outputDir, 'video.mp4');
    expect(existsSync(videoPath)).toBe(true);
    const probe = await ffprobe(videoPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(Math.abs(probe.duration - 5)).toBeLessThan(0.5);
  }, 180000);
});
