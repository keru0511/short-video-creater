import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, link, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  sha256File,
  TimelineSchema,
  resolveSafePath,
  type Bgm,
} from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import { cleanupOutputDir, isolatedOutputDir } from './helpers.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
let outputDir = join(root, 'output');

beforeAll(async () => {
  outputDir = await isolatedOutputDir(root);
  await generateFixtures(root);
}, 60000);

afterAll(async () => {
  await cleanupOutputDir(outputDir);
});

async function extractMono16(
  videoPath: string,
  startSec: number,
  durationSec: number,
): Promise<Float64Array> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss',
      String(startSec),
      '-i',
      videoPath,
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-f',
      's16le',
      '-t',
      String(durationSec),
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
  );
  const buf = stdout as Buffer;
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const samples = new Float64Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    samples[i] = int16[i];
  }
  return samples;
}

function magnitude(samples: Float64Array, sampleRate: number, freq: number): number {
  const N = samples.length;
  if (N === 0) return 0;
  const k = Math.max(1, Math.round((N * freq) / sampleRate));
  const omega = (2 * Math.PI * k) / N;
  const c = Math.cos(omega);
  const s = Math.sin(omega);
  const coeff = 2 * c;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * c;
  const imag = q2 * s;
  return Math.sqrt(real * real + imag * imag);
}

interface AudioStats {
  rms: number;
  peak: number;
  m440: number;
  m880: number;
  m1320: number;
  mNoise: number;
}

async function audioStats(videoPath: string, startSec: number, durationSec: number): Promise<AudioStats> {
  const samples = await extractMono16(videoPath, startSec, durationSec);
  const sumSq = samples.reduce((acc, x) => acc + x * x, 0);
  const rms = Math.sqrt(sumSq / samples.length);
  const peak = samples.reduce((acc, x) => Math.max(acc, Math.abs(x)), 0);
  return {
    rms,
    peak,
    m440: magnitude(samples, 48000, 440),
    m880: magnitude(samples, 48000, 880),
    m1320: magnitude(samples, 48000, 1320),
    mNoise: magnitude(samples, 48000, 1000),
  };
}

async function extractFloat(
  videoPath: string,
  startSec: number,
  durationSec: number,
): Promise<Float32Array> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss',
      String(startSec),
      '-i',
      videoPath,
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'f32le',
      '-t',
      String(durationSec),
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
}

interface FloatStats {
  peak: number;
  saturationCount: number;
  hasNaN: boolean;
}

async function floatStats(videoPath: string, startSec: number, durationSec: number): Promise<FloatStats> {
  const samples = await extractFloat(videoPath, startSec, durationSec);
  let peak = 0;
  let saturationCount = 0;
  let hasNaN = false;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (Number.isNaN(v)) {
      hasNaN = true;
      continue;
    }
    if (v > peak) peak = v;
    if (v > 0.99) saturationCount++;
  }
  return { peak, saturationCount, hasNaN };
}

function baseBgmTimeline(bgmOverrides: Partial<Bgm> = {}): Record<string, unknown> {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'bgm-test.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: 'audio-440.wav',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
      },
    ],
    bgm: {
      source: 'bgm-880.wav',
      start: 0,
      in: 0,
      out: 2,
      volume: 0.5,
      ...bgmOverrides,
    },
  };
}

function baseLoudBgmTimeline(bgmOverrides: Partial<Bgm> = {}): Record<string, unknown> {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'loud-bgm-test.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: 'loud-main.wav',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
      },
    ],
    bgm: {
      source: 'loud-bgm.wav',
      start: 0,
      in: 0,
      out: 2,
      volume: 1,
      ...bgmOverrides,
    },
  };
}

function baseSegmentTimeline(
  mainSource: string,
  mainIn: number,
  mainOut: number,
  bgmSource: string,
  bgmIn: number,
  bgmOut: number,
  bgmVolume = 1,
): Record<string, unknown> {
  const duration = mainOut - mainIn;
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'segment-bgm-test.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: duration,
        in: 0,
        out: duration,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: mainSource,
        start: 0,
        end: duration,
        in: mainIn,
        out: mainOut,
      },
    ],
    bgm: {
      source: bgmSource,
      start: 0,
      in: bgmIn,
      out: bgmOut,
      volume: bgmVolume,
    },
  };
}

function baseNoBgmTimeline(mainSource = 'audio-440.wav'): Record<string, unknown> {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'no-bgm-test.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: mainSource,
        start: 0,
        end: 5,
        in: 0,
        out: 5,
      },
    ],
  };
}

describe('BGM mix', () => {
  it('generates a 1080x1920 h264/aac mp4 from the bgm fixture', async () => {
    const timeline = JSON.parse(await readFile(join(fixturesDir, 'bgm.json'), 'utf8'));
    const before = {
      black: await sha256File(join(fixturesDir, 'black.png')),
      main: await sha256File(join(fixturesDir, 'audio-440.wav')),
      bgm: await sha256File(join(fixturesDir, 'bgm-880.wav')),
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);

    expect(await sha256File(join(fixturesDir, 'black.png'))).toBe(before.black);
    expect(await sha256File(join(fixturesDir, 'audio-440.wav'))).toBe(before.main);
    expect(await sha256File(join(fixturesDir, 'bgm-880.wav'))).toBe(before.bgm);

    const stats = await audioStats(result.outputPath, 0, 5);
    expect(stats.m440 / stats.mNoise).toBeGreaterThan(1000);
    expect(stats.m880 / stats.mNoise).toBeGreaterThan(1000);
    expect(stats.m880 / stats.m440).toBeGreaterThan(0.05);
    expect(stats.m880 / stats.m440).toBeLessThan(0.5);
  });

  it('loops short BGM to the end and across loop boundaries', async () => {
    const timeline = baseBgmTimeline({ out: 2, volume: 1 });
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    const whole = await audioStats(result.outputPath, 0, 5);
    expect(whole.m440 / whole.mNoise).toBeGreaterThan(1000);
    expect(whole.m880 / whole.mNoise).toBeGreaterThan(1000);
    expect(whole.m880 / whole.m440).toBeGreaterThan(0.05);

    const end = await audioStats(result.outputPath, 4.5, 0.5);
    expect(end.m440 / end.mNoise).toBeGreaterThan(1000);
    expect(end.m880 / end.m440).toBeGreaterThan(0.05);

    const boundary = await audioStats(result.outputPath, 1.9, 0.2);
    expect(boundary.m440 / boundary.mNoise).toBeGreaterThan(1000);
    expect(boundary.m880 / boundary.m440).toBeGreaterThan(0.05);
  });

  it('delays BGM start and only mixes it after the specified time', async () => {
    const timeline = baseBgmTimeline({ start: 1, out: 2, volume: 1 });
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    const before = await audioStats(result.outputPath, 0, 0.5);
    expect(before.m440 / before.mNoise).toBeGreaterThan(1000);
    expect(before.m880 / before.m440).toBeLessThan(0.05);

    const during = await audioStats(result.outputPath, 1, 3);
    expect(during.m440 / during.mNoise).toBeGreaterThan(1000);
    expect(during.m880 / during.mNoise).toBeGreaterThan(1000);
    expect(during.m880 / during.m440).toBeGreaterThan(0.05);
  });

  it('preserves main audio gain when BGM volume is 0', async () => {
    const noBgmResult = await generate(baseNoBgmTimeline(), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const noBgm = await audioStats(noBgmResult.outputPath, 0, 5);

    const vol0Result = await generate(baseBgmTimeline({ volume: 0 }), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const vol0 = await audioStats(vol0Result.outputPath, 0, 5);

    expect(vol0.m440 / vol0.mNoise).toBeGreaterThan(1000);
    expect(vol0.m880 / vol0.m440).toBeLessThan(0.05);

    expect(vol0.peak).toBe(noBgm.peak);
    expect(Math.abs(vol0.rms - noBgm.rms)).toBeLessThan(1);
    expect(Math.abs(vol0.m440 - noBgm.m440) / noBgm.m440).toBeLessThan(0.001);
  });

  it('handles silent BGM and silent main audio', { timeout: 30000 }, async () => {
    const silentAudioClip = { type: 'audio', source: 'silent.wav', start: 0, end: 5, in: 0, out: 5 };

    const silentBgm = baseBgmTimeline({ source: 'silent.wav', in: 0, out: 5, volume: 1 });
    const r1 = await generate(silentBgm, { rootDir: root, fixturesDir, outputDir });
    const s1 = await audioStats(r1.outputPath, 0, 5);
    expect(s1.m440 / s1.mNoise).toBeGreaterThan(1000);
    expect(s1.m880 / s1.mNoise).toBeLessThan(10);

    const silentMain = {
      ...baseBgmTimeline({ source: 'bgm-880.wav', in: 0, out: 5, volume: 1 }),
      clips: [
        { type: 'image', source: 'black.png', start: 0, end: 5, in: 0, out: 5, fit: 'cover' },
        silentAudioClip,
      ],
    };
    const r2 = await generate(silentMain, { rootDir: root, fixturesDir, outputDir });
    const s2 = await audioStats(r2.outputPath, 0, 5);
    expect(s2.m880 / s2.mNoise).toBeGreaterThan(1000);
    expect(s2.m440 / s2.mNoise).toBeLessThan(10);

    const bothSilent = {
      ...silentBgm,
      clips: [
        { type: 'image', source: 'black.png', start: 0, end: 5, in: 0, out: 5, fit: 'cover' },
        silentAudioClip,
      ],
    };
    const r3 = await generate(bothSilent, { rootDir: root, fixturesDir, outputDir });
    const s3 = await audioStats(r3.outputPath, 0, 5);
    expect(s3.rms).toBe(0);
    expect(s3.peak).toBe(0);
    expect(r3.probe.audioCodec).toBe('aac');
  });

  it('scales only BGM volume while keeping main gain invariant', { timeout: 30000 }, async () => {
    const noBgmResult = await generate(baseNoBgmTimeline(), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const noBgm = await audioStats(noBgmResult.outputPath, 0, 5);

    const volHalfResult = await generate(baseBgmTimeline({ volume: 0.5 }), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const volHalf = await audioStats(volHalfResult.outputPath, 0, 5);

    const vol1Result = await generate(baseBgmTimeline({ volume: 1 }), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const vol1 = await audioStats(vol1Result.outputPath, 0, 5);

    for (const stats of [volHalf, vol1]) {
      expect(stats.m440 / stats.mNoise).toBeGreaterThan(1000);
      expect(stats.m880 / stats.mNoise).toBeGreaterThan(1000);
      expect(Math.abs(stats.m440 - noBgm.m440) / noBgm.m440).toBeLessThan(0.001);
      expect(stats.m880 / stats.m440).toBeGreaterThan(0.05);
    }

    expect(volHalf.m880 / noBgm.m440).toBeGreaterThan(0.3);
    expect(volHalf.m880 / noBgm.m440).toBeLessThan(0.7);

    expect(vol1.m880 / noBgm.m440).toBeGreaterThan(0.7);
    expect(vol1.m880 / noBgm.m440).toBeLessThan(1.3);

    expect(vol1.m880 / volHalf.m880).toBeGreaterThan(1.5);
    expect(vol1.m880 / volHalf.m880).toBeLessThan(2.5);
  });

  it('prevents clipping for near-full-scale main and BGM at volume 1', async () => {
    const noBgmResult = await generate(baseNoBgmTimeline('loud-main.wav'), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    const noBgm = await audioStats(noBgmResult.outputPath, 0, 5);

    const result = await generate(baseLoudBgmTimeline(), {
      rootDir: root,
      fixturesDir,
      outputDir,
    });
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');

    const audio = await audioStats(result.outputPath, 0, 5);
    const float = await floatStats(result.outputPath, 0, 5);
    expect(float.hasNaN).toBe(false);
    expect(float.peak).toBeLessThan(0.99);
    expect(float.saturationCount).toBe(0);

    expect(audio.m440 / audio.mNoise).toBeGreaterThan(1000);
    expect(audio.m880 / audio.mNoise).toBeGreaterThan(1000);
    expect(Math.abs(audio.m440 - noBgm.m440) / noBgm.m440).toBeLessThan(0.01);
    expect(audio.m880 / audio.m440).toBeGreaterThan(0.4);
    expect(audio.m880 / audio.m440).toBeLessThan(1.2);
  });

  it('loops non-48kHz BGM using source sample rate and preserves segment boundaries', async () => {
    const result = await generate(
      baseBgmTimeline({ source: '96k-bgm.wav', in: 0, out: 2, volume: 1 }),
      { rootDir: root, fixturesDir, outputDir },
    );
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);

    const whole = await audioStats(result.outputPath, 0, 5);
    expect(whole.m440 / whole.mNoise).toBeGreaterThan(1000);
    expect(whole.m880 / whole.mNoise).toBeGreaterThan(100);
    expect(whole.m1320 / whole.mNoise).toBeGreaterThan(100);

    // 4.5s-5.0s is the first half of the loop (880 Hz)
    const tail = await audioStats(result.outputPath, 4.5, 0.5);
    expect(tail.m880 / tail.mNoise).toBeGreaterThan(100);
    expect(tail.m1320 / tail.mNoise).toBeLessThan(10);

    // 1.5s-2.5s and 3.5s-4.5s cross loop boundaries and contain both halves
    for (const [start, end] of [
      [1.5, 1.0],
      [3.5, 1.0],
    ]) {
      const boundary = await audioStats(result.outputPath, start, end);
      expect(boundary.m880 / boundary.mNoise).toBeGreaterThan(100);
      expect(boundary.m1320 / boundary.mNoise).toBeGreaterThan(100);
    }
  });

  it('keeps existing no-BGM timelines working', async () => {
    const timeline = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8'));
    const result = await generate(
      { ...timeline, outputPath: 'no-bgm.mp4' },
      { rootDir: root, fixturesDir, outputDir },
    );
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);
  });

  it('passes BGM source filenames containing shell metacharacters as argv elements', async () => {
    const weird = "bgm'; echo pwned.wav";
    await copyFile(join(fixturesDir, 'bgm-880.wav'), join(fixturesDir, weird));
    try {
      const timeline = baseBgmTimeline({ source: weird, volume: 1 });
      const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
      expect(existsSync(result.outputPath)).toBe(true);
      expect(result.args.join(' ')).not.toContain('&&');
      const stats = await audioStats(result.outputPath, 0, 5);
      expect(stats.m440 / stats.mNoise).toBeGreaterThan(1000);
      expect(stats.m880 / stats.mNoise).toBeGreaterThan(1000);
      expect(stats.m880 / stats.m440).toBeGreaterThan(0.05);
    } finally {
      await rm(join(fixturesDir, weird), { force: true });
    }
  });

  it('rejects output path that overlaps a BGM input source', async () => {
    const timeline = {
      ...baseBgmTimeline(),
      outputPath: 'bgm-880.wav',
    };
    await expect(
      generate(timeline, {
        rootDir: root,
        fixturesDir,
        outputDir: fixturesDir,
      }),
    ).rejects.toThrow('overlap');
  });

  it('rejects BGM start that quantizes into a loud main transient', async () => {
    const tl = baseSegmentTimeline('transient-main.wav', 0, 5, 'loud-bgm.wav', 0, 0.5, 1);
    const timeline = {
      ...tl,
      outputPath: 'bgm-start-reject.mp4',
      bgm: { ...((tl as { bgm: object }).bgm), start: 0.0003 },
    };
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'full scale',
    );
  });

  it('handles sub-ms BGM start rounded away from a transient without clipping', async () => {
    const tl = baseSegmentTimeline('transient-main.wav', 0, 5, 'loud-bgm.wav', 0, 0.5, 1);
    const timeline = {
      ...tl,
      outputPath: 'bgm-start-pass.mp4',
      bgm: { ...((tl as { bgm: object }).bgm), start: 0.00049 },
    };
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    const stats = await audioStats(result.outputPath, 0, 5);
    expect(stats.peak).toBeLessThan(32000);
    expect(stats.rms).toBeGreaterThan(0);
  });

  it('includes BGM when start is near the end of the video', async () => {
    const tl = baseSegmentTimeline('audio-440.wav', 0, 5, 'loud-bgm.wav', 0, 0.000396, 1);
    const timeline = {
      ...tl,
      outputPath: 'bgm-end-start.mp4',
      bgm: { ...((tl as { bgm: object }).bgm), start: 4.9996 },
    };
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    expect(result.probe.hasVideo).toBe(true);
    expect(result.probe.hasAudio).toBe(true);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.duration).toBeCloseTo(5, 1);
  });
});

describe('BGM validation', () => {
  it('rejects negative BGM start', () => {
    expect(() => TimelineSchema.parse(baseBgmTimeline({ start: -1 }))).toThrow();
  });

  it('rejects BGM in >= out', () => {
    expect(() => TimelineSchema.parse(baseBgmTimeline({ in: 2, out: 2 }))).toThrow();
  });

  it('rejects negative BGM volume', () => {
    expect(() => TimelineSchema.parse(baseBgmTimeline({ volume: -0.1 }))).toThrow();
  });

  it('rejects BGM volume above maximum', () => {
    expect(() => TimelineSchema.parse(baseBgmTimeline({ volume: 1.1 }))).toThrow();
  });

  it('rejects NaN BGM volume', () => {
    expect(() => TimelineSchema.parse(baseBgmTimeline({ volume: NaN }))).toThrow();
  });

  it('rejects BGM source that is an absolute path', async () => {
    const timeline = baseBgmTimeline({ source: '/etc/passwd' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Absolute',
    );
  });

  it('rejects BGM source with path traversal', async () => {
    const timeline = baseBgmTimeline({ source: '../package.json' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects BGM source with null bytes', async () => {
    const timeline = baseBgmTimeline({ source: 'bgm\0evil.wav' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Null',
    );
  });

  it('rejects BGM out exceeding source duration', async () => {
    const timeline = baseBgmTimeline({ in: 0, out: 10 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects BGM end exceeding video duration', async () => {
    const timeline = baseBgmTimeline({ start: 4, in: 0, out: 2 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects BGM start exceeding video duration', async () => {
    const timeline = baseBgmTimeline({ start: 6, in: 0, out: 1 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects BGM selection shorter than one audio sample (48kHz)', async () => {
    const timeline = baseBgmTimeline({ source: 'bgm-880.wav', in: 0, out: 0.000001 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'one audio sample',
    );
  });

  it('rejects BGM selection shorter than one audio sample (96kHz)', async () => {
    const timeline = baseBgmTimeline({ source: '96k-bgm.wav', in: 0, out: 0.000001 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'one audio sample',
    );
  });

  it('rejects BGM selection shorter than one audio sample (44.1kHz)', async () => {
    const timeline = baseBgmTimeline({ source: '44100-bgm.wav', in: 0, out: 0.000001 });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'one audio sample',
    );
  });

  it('allows and generates output for a one-sample BGM selection with volume 0', async () => {
    const timeline = baseBgmTimeline({ source: 'bgm-880.wav', in: 0, out: 1 / 48000, volume: 0 });
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    expect(result.probe.hasVideo).toBe(true);
    expect(result.probe.hasAudio).toBe(true);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.duration).toBeCloseTo(5, 1);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
  });

  it('rejects BGM source through a symlink ancestor', async () => {
    const linkPath = join(fixturesDir, 'link-bgm');
    await rm(linkPath, { force: true });
    await symlink('/dev/null', linkPath);
    try {
      expect(() => resolveSafePath(fixturesDir, 'link-bgm/file.wav')).toThrow('Symbolic');
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  it('rejects BGM source without an audio stream', async () => {
    const timeline = baseBgmTimeline({ source: 'video.mp4' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'audio stream',
    );
  });

  it('rejects BGM source that is an image', async () => {
    const timeline = baseBgmTimeline({ source: 'black.png' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'audio stream',
    );
  });

  it('rejects BGM source with no usable duration', async () => {
    const timeline = baseBgmTimeline({ source: 'black.mp4' });
    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      /audio stream|duration/,
    );
  });

  it('uses format duration when stream duration is missing', async () => {
    const path = join(fixturesDir, 'format-duration.mkv');
    await rm(path, { force: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=5',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      path,
    ]);
    try {
      const valid = baseBgmTimeline({ source: 'format-duration.mkv', in: 0, out: 5 });
      const result = await generate(valid, { rootDir: root, fixturesDir, outputDir });
      expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);

      const invalid = baseBgmTimeline({ source: 'format-duration.mkv', in: 0, out: 10 });
      await expect(generate(invalid, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
        'exceeds',
      );
    } finally {
      await rm(path, { force: true });
    }
  });

  it('rejects BGM mix that would exceed full scale', async () => {
    const louderBgm = join(fixturesDir, 'louder-bgm.wav');
    await rm(louderBgm, { force: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.6*sin(2*PI*880*t):s=48000:c=stereo:d=5',
      louderBgm,
    ]);
    try {
      const timeline = baseLoudBgmTimeline({ source: 'louder-bgm.wav', volume: 1 });
      await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
        'full scale',
      );
    } finally {
      await rm(louderBgm, { force: true });
    }
  });

  it('uses selected audioClip/BGM segment for peak validation', async () => {
    const quiet = baseSegmentTimeline(
      'loud-quiet-main.wav',
      1,
      2,
      'loud-quiet-bgm.wav',
      1,
      2,
      1,
    );
    const quietResult = await generate(quiet, { rootDir: root, fixturesDir, outputDir });
    expect(quietResult.probe.videoCodec).toBe('h264');
    expect(quietResult.probe.audioCodec).toBe('aac');
    expect(Math.abs(quietResult.probe.duration - 1)).toBeLessThan(0.5);
    const quietStats = await audioStats(quietResult.outputPath, 0, 1);
    expect(quietStats.m440 / quietStats.mNoise).toBeGreaterThan(100);
    expect(quietStats.m880 / quietStats.mNoise).toBeGreaterThan(100);

    await expect(
      generate(
        baseSegmentTimeline('audio-440.wav', 0, 1, 'loud-quiet-bgm.wav', 0, 1, 1),
        { rootDir: root, fixturesDir, outputDir },
      ),
    ).rejects.toThrow('full scale');

    await expect(
      generate(
        baseSegmentTimeline('loud-quiet-main.wav', 0, 1, 'bgm-880.wav', 0, 1, 1),
        { rootDir: root, fixturesDir, outputDir },
      ),
    ).rejects.toThrow('full scale');
  });

  it('limits main peak to the segment overlapping with BGM start', async () => {
    // loud main at the beginning, but BGM starts later when main is quiet -> should pass
    const delayedBgm = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'delayed-bgm-test.mp4',
      background: '000000',
      clips: [
        {
          type: 'image',
          source: 'black.png',
          start: 0,
          end: 2,
          in: 0,
          out: 2,
          fit: 'cover',
        },
        {
          type: 'audio',
          source: 'loud-quiet-main.wav',
          start: 0,
          end: 2,
          in: 0,
          out: 2,
        },
      ],
      bgm: {
        source: 'bgm-880.wav',
        start: 1,
        in: 0,
        out: 1,
        volume: 1,
      },
    };
    const delayedResult = await generate(delayedBgm, { rootDir: root, fixturesDir, outputDir });
    expect(delayedResult.probe.videoCodec).toBe('h264');
    expect(delayedResult.probe.audioCodec).toBe('aac');
    expect(Math.abs(delayedResult.probe.duration - 2)).toBeLessThan(0.5);

    // quiet main at the beginning, but BGM starts later when main is loud -> should reject
    const loudOverlap = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'loud-overlap-test.mp4',
      background: '000000',
      clips: [
        {
          type: 'image',
          source: 'black.png',
          start: 0,
          end: 5,
          in: 0,
          out: 5,
          fit: 'cover',
        },
        {
          type: 'audio',
          source: 'quiet-loud-main.wav',
          start: 0,
          end: 5,
          in: 0,
          out: 5,
        },
      ],
      bgm: {
        source: 'bgm-880.wav',
        start: 1,
        in: 0,
        out: 1,
        volume: 1,
      },
    };
    await expect(
      generate(loudOverlap, { rootDir: root, fixturesDir, outputDir }),
    ).rejects.toThrow('full scale');
  });

  it('validates main peak over all BGM loop cycles, not just the first cycle', async () => {
    const baseTimeline = (mainSource: string) => ({
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'loop-overlap-test.mp4',
      background: '000000',
      clips: [
        {
          type: 'image',
          source: 'black.png',
          start: 0,
          end: 5,
          in: 0,
          out: 5,
          fit: 'cover',
        },
        {
          type: 'audio',
          source: mainSource,
          start: 0,
          end: 5,
          in: 0,
          out: 5,
        },
      ],
      bgm: {
        source: 'bgm-880.wav',
        start: 1,
        in: 0,
        out: 1,
        volume: 1,
      },
    });

    // BGM starts at 1s and loops; main is quiet for the whole BGM overlap -> pass
    const quietAfterStart = baseTimeline('loud-quiet-5s.wav');
    const quietResult = await generate(quietAfterStart, { rootDir: root, fixturesDir, outputDir });
    expect(quietResult.probe.videoCodec).toBe('h264');
    expect(quietResult.probe.audioCodec).toBe('aac');
    expect(Math.abs(quietResult.probe.duration - 5)).toBeLessThan(0.5);
    const quietStats = await audioStats(quietResult.outputPath, 2.5, 2);
    expect(quietStats.m440 / quietStats.mNoise).toBeGreaterThan(100);
    expect(quietStats.m880 / quietStats.mNoise).toBeGreaterThan(100);

    // BGM loops, but main only becomes loud after the first cycle -> must reject
    await expect(
      generate(baseTimeline('quiet-loud-5s.wav'), { rootDir: root, fixturesDir, outputDir }),
    ).rejects.toThrow('full scale');
  });

  it('validates short segment of a long source without loading the whole file', async () => {
    const longBgm = join(fixturesDir, 'long-bgm.wav');
    await rm(longBgm, { force: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=120',
      '-ar',
      '48000',
      '-ac',
      '2',
      longBgm,
    ]);
    try {
      const before = await sha256File(longBgm);
      const timeline = baseBgmTimeline({ source: 'long-bgm.wav', in: 60, out: 61, volume: 1 });
      const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
      expect(result.probe.videoCodec).toBe('h264');
      expect(result.probe.audioCodec).toBe('aac');
      expect(Math.abs(result.probe.duration - 5)).toBeLessThan(0.5);
      expect(await sha256File(longBgm)).toBe(before);
    } finally {
      await rm(longBgm, { force: true });
    }
  });
});

describe('BGM hard link safety', () => {
  it('rejects output that is a hard link to the BGM source', async () => {
    const outPath = join(outputDir, 'bgm-hardlink.mp4');
    await rm(outPath, { force: true });
    await link(join(fixturesDir, 'bgm-880.wav'), outPath);
    try {
      const timeline = { ...baseBgmTimeline(), outputPath: 'bgm-hardlink.mp4' };
      await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
        'hard link',
      );
      const hash = await sha256File(join(fixturesDir, 'bgm-880.wav'));
      expect(hash).toBe('ac228406dbf3614818f00960c2a617cbaf61269855aed95e2319a2909fe25f1c');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it('rejects output that is a hard link to the main audio source', async () => {
    const outPath = join(outputDir, 'main-hardlink.mp4');
    await rm(outPath, { force: true });
    await link(join(fixturesDir, 'audio-440.wav'), outPath);
    try {
      const timeline = { ...baseBgmTimeline(), outputPath: 'main-hardlink.mp4' };
      await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
        'hard link',
      );
      const hash = await sha256File(join(fixturesDir, 'audio-440.wav'));
      expect(hash).toBe('b1eae1584256376d6c0b004a012c8971099d44a8163eb64de987fb733e8985a5');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it('rejects output that is a hard link to the visual source', async () => {
    const outPath = join(outputDir, 'visual-hardlink.mp4');
    await rm(outPath, { force: true });
    await link(join(fixturesDir, 'black.png'), outPath);
    try {
      const timeline = { ...baseBgmTimeline(), outputPath: 'visual-hardlink.mp4' };
      await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
        'hard link',
      );
      const hash = await sha256File(join(fixturesDir, 'black.png'));
      expect(hash).toBe('fde4d83b6ed25fe64549af47d0cbe98fa0c81c54792b3b080388ffb9c19561a2');
    } finally {
      await rm(outPath, { force: true });
    }
  });
});
