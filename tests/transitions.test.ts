import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  ffprobe,
  sha256File,
  TimelineSchema,
  MAX_TRANSITION_DURATION_SECONDS,
} from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const outputDir = join(root, 'output');

beforeAll(async () => {
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

function isBlack(rgb: Buffer): boolean {
  return rgb[0] < 20 && rgb[1] < 20 && rgb[2] < 20;
}

describe('TimelineSchema transitions', () => {
  it('accepts a crossfade transition array', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 0.5 }],
    };
    expect(() => TimelineSchema.parse(tl)).not.toThrow();
  });

  it('accepts a transition without explicit type', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ duration: 0.5 }],
    };
    const parsed = TimelineSchema.parse(tl);
    expect(parsed.transitions?.[0].type).toBe('crossfade');
  });

  it('rejects an unsupported transition type', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'wipe', duration: 0.5 }],
    };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a negative transition duration', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: -0.5 }],
    };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a zero transition duration', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 0 }],
    };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a NaN transition duration', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: NaN }],
    };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a transition duration above the absolute maximum', () => {
    const tl = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'test.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: MAX_TRANSITION_DURATION_SECONDS + 0.1 }],
    };
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });
});

describe('crossfade generation', () => {
  it('produces a 1080x1920 h264/aac mp4 with crossfades from the fixture', async () => {
    const timeline = JSON.parse(await readFile(join(fixturesDir, 'transitions.json'), 'utf8'));
    const inputs = ['red.png', 'blue.mp4', 'black.png', 'audio.mp3'];
    const before: Record<string, string> = {};
    for (const source of inputs) {
      before[join(fixturesDir, source)] = await sha256File(join(fixturesDir, source));
    }

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 5)).toBeLessThan(1 / timeline.fps + 0.001);

    for (const source of inputs) {
      const path = join(fixturesDir, source);
      expect(await sha256File(path)).toBe(before[path]);
    }

    // First transition: red -> blue, duration 0.5, starts at 1.5.
    expect(isRed(await extractFrame(result.outputPath, 1.0))).toBe(true);
    const mid1 = await extractFrame(result.outputPath, 1.75);
    expect(!isRed(mid1) && !isBlue(mid1) && mid1[0] > 40 && mid1[2] > 40).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2.25))).toBe(true);

    // Second transition: blue -> black, duration 0.5, starts at 3.0.
    expect(isBlue(await extractFrame(result.outputPath, 2.75))).toBe(true);
    const mid2 = await extractFrame(result.outputPath, 3.25);
    expect(!isBlue(mid2) && !isBlack(mid2) && mid2[2] > 40).toBe(true);
    expect(isBlack(await extractFrame(result.outputPath, 3.75))).toBe(true);
  }, 120000);

  it('crossfades a 2-clip image -> video timeline', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'img-vid-fade.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'video', source: 'blue.mp4', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 3.5, in: 0, out: 3.5 },
      ],
      transitions: [{ type: 'crossfade', duration: 0.5 }],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs(result.probe.duration - 3.5)).toBeLessThan(1 / timeline.fps + 0.001);

    expect(isRed(await extractFrame(result.outputPath, 1.0))).toBe(true);
    const mid = await extractFrame(result.outputPath, 1.75);
    expect(!isRed(mid) && !isBlue(mid) && mid[0] > 40 && mid[2] > 40).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2.25))).toBe(true);
  }, 120000);
});

describe('crossfade frame-grid quantization', () => {
  it('rejects a sub-frame duration that rounds to zero frames', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'subframe-reject.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 0.01 }],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'less than one frame',
    );
  });

  it('handles a 1-frame crossfade at 30fps', async () => {
    const fps = 30;
    const effective = 1 / fps;
    const timeline = {
      width: 1080,
      height: 1920,
      fps,
      outputPath: 'one-frame-30.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: effective }],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(Math.abs(result.probe.duration - (4 - effective))).toBeLessThan(1 / fps + 0.001);
  }, 120000);

  it('handles a 1.5-frame crossfade rounded to 2 frames at 30fps', async () => {
    const fps = 30;
    const raw = 0.05; // 1.5 frames at 30fps
    const effective = 2 / fps;
    const timeline = {
      width: 1080,
      height: 1920,
      fps,
      outputPath: 'one-half-frame-30.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: raw }],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(Math.abs(result.probe.duration - (4 - effective))).toBeLessThan(1 / fps + 0.001);

    // Transition starts at 2 - effective = 1.9333..., ends at 2.0.
    expect(isRed(await extractFrame(result.outputPath, 1.9))).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2 + 1 / fps))).toBe(true);
  }, 120000);

  it('handles a 1-frame crossfade at 60fps', async () => {
    const fps = 60;
    const effective = 1 / fps;
    const timeline = {
      width: 1080,
      height: 1920,
      fps,
      outputPath: 'one-frame-60.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: effective }],
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(Math.abs(result.probe.duration - (4 - effective))).toBeLessThan(1 / fps + 0.001);
  }, 120000);
});

describe('crossfade validation', () => {
  it('rejects too many transitions for the visual clip count', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'too-many-transitions.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [
        { type: 'crossfade', duration: 0.5 },
        { type: 'crossfade', duration: 0.5 },
      ],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'count mismatch',
    );
  });

  it('rejects too few transitions for the visual clip count', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'too-few-transitions.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'black.png', start: 4, end: 6, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 0.5 }],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'count mismatch',
    );
  });

  it('rejects a transition longer than the previous clip', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'prev-too-short.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 1, end: 4, in: 0, out: 3, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 1.5 }],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'previous clip duration',
    );
  });

  it('rejects a transition longer than the next clip', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'next-too-short.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 4, in: 0, out: 4, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 4, end: 5, in: 0, out: 1, fit: 'cover' },
      ],
      transitions: [{ type: 'crossfade', duration: 1.5 }],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'next clip duration',
    );
  });

  it('rejects overlapping transitions around a short middle clip', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'overlap-transitions.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
        { type: 'image', source: 'blue.png', start: 2, end: 3, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: 'black.png', start: 3, end: 5, in: 0, out: 2, fit: 'cover' },
      ],
      transitions: [
        { type: 'crossfade', duration: 0.6 },
        { type: 'crossfade', duration: 0.6 },
      ],
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'overlap',
    );
  });
});
