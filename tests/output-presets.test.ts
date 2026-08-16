import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate,
  ffprobe,
  sha256File,
  TimelineSchema,
} from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import { cleanupOutputDir, isolatedOutputDir } from './helpers.js';
import {
  getEffectiveEncoding,
  getEncodingArgs,
  OUTPUT_PRESETS,
  resolveOutputPreset,
  type OutputPresetName,
} from '../src/output-presets.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
let outputDir = join(root, 'output');
const fontsDir = join(root, 'fonts');

beforeAll(async () => {
  outputDir = await isolatedOutputDir(root);
  await generateFixtures(root);
}, 60000);

afterAll(async () => {
  await cleanupOutputDir(outputDir);
});

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

async function buildIntegrationTimeline(
  outputPath: string,
  outputPreset?: string,
): Promise<Record<string, unknown>> {
  const fontHash = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));
  const timeline: Record<string, unknown> = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath,
    background: '000000',
    clips: [
      { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
      { type: 'video', source: 'blue.mp4', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      { type: 'image', source: 'black.png', start: 4, end: 6, in: 0, out: 2, fit: 'cover' },
      { type: 'audio', source: 'audio.mp3', start: 0, end: 5, in: 0, out: 5 },
    ],
    bgm: {
      source: 'bgm-880.wav',
      start: 0,
      in: 0,
      out: 2,
      volume: 0.5,
    },
    subtitles: [
      { start: 0.5, end: 1.0, text: 'Hello', x: 540, y: 1500, fontSize: 100 },
      { start: 3.5, end: 4.0, text: 'World', x: 540, y: 1500, fontSize: 100 },
    ],
    font: 'DejaVuSans.ttf',
    fontHash,
    transitions: [
      { type: 'crossfade', duration: 0.5 },
      { type: 'crossfade', duration: 0.5 },
    ],
  };
  if (outputPreset !== undefined) {
    timeline.outputPreset = outputPreset;
  }
  return timeline;
}

async function assertCommonOutput(
  result: Awaited<ReturnType<typeof generate>>,
  expectedPreset: OutputPresetName,
) {
  expect(existsSync(result.outputPath)).toBe(true);
  expect(result.probe.width).toBe(1080);
  expect(result.probe.height).toBe(1920);
  expect(result.probe.fps).toBe(30);
  expect(result.probe.videoCodec).toBe('h264');
  expect(result.probe.audioCodec).toBe('aac');
  expect(result.probe.hasAudio).toBe(true);
  expect(Math.abs(result.probe.duration - 5)).toBeLessThan(
    1 / result.probe.fps! + 0.001,
  );

  expect(result.outputPreset).toBe(expectedPreset);
  expect(result.effectiveEncoding).toEqual({
    outputPreset: expectedPreset,
    ...OUTPUT_PRESETS[expectedPreset],
  });

  const expected = OUTPUT_PRESETS[expectedPreset];
  expect(result.args).toContain('-preset');
  expect(result.args).toContain(expected.x264Preset);
  expect(result.args).toContain('-crf');
  expect(result.args).toContain(String(expected.crf));
  expect(result.args).toContain('-b:a');
  expect(result.args).toContain(expected.audioBitrate);
  expect(result.args).toContain('-c:v');
  expect(result.args).toContain(expected.videoCodec);
  expect(result.args).toContain('-c:a');
  expect(result.args).toContain(expected.audioCodec);
  expect(result.args).toContain('-pix_fmt');
  expect(result.args).toContain(expected.pixelFormat);
}

describe('OUTPUT_PRESETS immutability', () => {
  it('is deeply frozen', () => {
    expect(Object.isFrozen(OUTPUT_PRESETS)).toBe(true);
    expect(Object.isFrozen(OUTPUT_PRESETS.preview)).toBe(true);
    expect(Object.isFrozen(OUTPUT_PRESETS.final)).toBe(true);
  });

  it('keeps encoding args and effective settings fixed when mutation is attempted', () => {
    const beforeArgs = getEncodingArgs('preview', 30);
    const beforeEffective = getEffectiveEncoding('preview');
    expect(Reflect.set(OUTPUT_PRESETS.preview, 'crf', 0)).toBe(false);
    expect(Reflect.set(OUTPUT_PRESETS.preview, 'x264Preset', 'ultrafast')).toBe(false);
    expect(Reflect.set(OUTPUT_PRESETS.preview, 'audioBitrate', '320k')).toBe(false);
    expect(Reflect.set(OUTPUT_PRESETS, 'preview', { ...OUTPUT_PRESETS.preview, crf: 0 })).toBe(false);
    expect(getEncodingArgs('preview', 30)).toEqual(beforeArgs);
    expect(getEffectiveEncoding('preview')).toEqual(beforeEffective);
  });
});

describe('getEncodingArgs', () => {
  it('returns the exact legacy preview argv order', () => {
    expect(getEncodingArgs('preview', 30)).toEqual([
      '-c:v', 'libx264', '-r', '30', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    ]);
  });

  it('replaces only x264 preset, crf, and audio bitrate for final while keeping placement', () => {
    expect(getEncodingArgs('final', 30)).toEqual([
      '-c:v', 'libx264', '-r', '30', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    ]);
  });
});

describe('resolveOutputPreset', () => {
  it('defaults undefined to preview', () => {
    expect(resolveOutputPreset(undefined)).toBe('preview');
  });

  it('accepts preview and final', () => {
    expect(resolveOutputPreset('preview')).toBe('preview');
    expect(resolveOutputPreset('final')).toBe('final');
  });

  it('rejects unknown presets', () => {
    expect(() => resolveOutputPreset('ultra')).toThrow('Unknown output preset');
  });

  it('rejects non-string presets', () => {
    expect(() => resolveOutputPreset(123)).toThrow('outputPreset must be a string');
  });
});

describe('TimelineSchema outputPreset', () => {
  const baseTimeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'test.mp4',
    background: '000000',
    clips: [
      { type: 'image', source: 'image.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
      { type: 'audio', source: 'audio.mp3', start: 0, end: 2, in: 0, out: 2 },
    ],
  };

  it('accepts no outputPreset (undefined defaults to preview at encode time)', () => {
    const parsed = TimelineSchema.parse(baseTimeline);
    expect(parsed.outputPreset).toBeUndefined();
  });

  it('accepts preview', () => {
    const parsed = TimelineSchema.parse({ ...baseTimeline, outputPreset: 'preview' });
    expect(parsed.outputPreset).toBe('preview');
  });

  it('accepts final', () => {
    const parsed = TimelineSchema.parse({ ...baseTimeline, outputPreset: 'final' });
    expect(parsed.outputPreset).toBe('final');
  });

  it('rejects unknown preset strings before ffmpeg', () => {
    expect(() =>
      TimelineSchema.parse({ ...baseTimeline, outputPreset: 'high' }),
    ).toThrow();
  });

  it('rejects non-string preset values', () => {
    expect(() =>
      TimelineSchema.parse({ ...baseTimeline, outputPreset: 123 }),
    ).toThrow();
  });

  it('rejects arbitrary ffmpeg option injection via preset', () => {
    expect(() =>
      TimelineSchema.parse({ ...baseTimeline, outputPreset: 'final -i evil.mp4' }),
    ).toThrow();
  });
});

describe('generate output presets', () => {
  it('preserves the exact legacy argv order for no preset and preview', async () => {
    const noneTimeline = await buildIntegrationTimeline('preset-argv-none.mp4');
    const noneResult = await generate(noneTimeline, { rootDir: root, fixturesDir, outputDir });
    const previewTimeline = await buildIntegrationTimeline('preset-argv-preview.mp4', 'preview');
    const previewResult = await generate(previewTimeline, { rootDir: root, fixturesDir, outputDir });

    const expected = [
      '-c:v', 'libx264', '-r', '30', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    ];
    const extract = (args: string[]) =>
      args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + expected.length);

    expect(extract(noneResult.args)).toEqual(expected);
    expect(extract(previewResult.args)).toEqual(expected);
    expect(noneResult.outputPreset).toBe('preview');
    expect(previewResult.outputPreset).toBe('preview');
  }, 180000);

  it('preserves argv placement for final and only changes x264 preset, crf, and audio bitrate', async () => {
    const finalTimeline = await buildIntegrationTimeline('preset-argv-final.mp4', 'final');
    const finalResult = await generate(finalTimeline, { rootDir: root, fixturesDir, outputDir });

    const expected = [
      '-c:v', 'libx264', '-r', '30', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    ];
    const start = finalResult.args.indexOf('-c:v');
    expect(finalResult.args.slice(start, start + expected.length)).toEqual(expected);
    expect(finalResult.outputPreset).toBe('final');
  }, 180000);

  it('produces preview-compatible output when no preset is specified', async () => {
    const timeline = await buildIntegrationTimeline('preset-none.mp4');
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    await assertCommonOutput(result, 'preview');

    // Verify crossfade and subtitle integration.
    expect(isRed(await extractFrame(result.outputPath, 1.0))).toBe(true);
    const mid1 = await extractFrame(result.outputPath, 1.75);
    expect(!isRed(mid1) && !isBlue(mid1) && mid1[0] > 40 && mid1[2] > 40).toBe(true);
    expect(isBlue(await extractFrame(result.outputPath, 2.25))).toBe(true);

    expect(isBlue(await extractFrame(result.outputPath, 2.75))).toBe(true);
    const mid2 = await extractFrame(result.outputPath, 3.25);
    expect(!isBlue(mid2) && !isBlack(mid2) && mid2[2] > 40).toBe(true);
    expect(isBlack(await extractFrame(result.outputPath, 3.75))).toBe(true);
  }, 180000);

  it('produces preview output when outputPreset is preview', async () => {
    const timeline = await buildIntegrationTimeline('preset-preview.mp4', 'preview');
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    await assertCommonOutput(result, 'preview');
  }, 180000);

  it('produces final output with fixed higher-quality encoding', async () => {
    const timeline = await buildIntegrationTimeline('preset-final.mp4', 'final');
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    await assertCommonOutput(result, 'final');

    // final should use a slower x264 preset and lower CRF than preview.
    expect(OUTPUT_PRESETS.final.crf).toBeLessThan(OUTPUT_PRESETS.preview.crf);
    expect(result.effectiveEncoding.x264Preset).not.toBe(OUTPUT_PRESETS.preview.x264Preset);
  }, 180000);

  it('does not modify any source files when generating with a preset', async () => {
    const timeline = await buildIntegrationTimeline('preset-hash.mp4', 'final');
    const sources = ['red.png', 'blue.mp4', 'black.png', 'audio.mp3', 'bgm-880.wav'];
    const before: Record<string, string> = {};
    for (const source of sources) {
      before[join(fixturesDir, source)] = await sha256File(join(fixturesDir, source));
    }
    const fontPath = join(fontsDir, 'DejaVuSans.ttf');
    before[fontPath] = await sha256File(fontPath);

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    for (const source of sources) {
      const path = join(fixturesDir, source);
      expect(await sha256File(path)).toBe(before[path]);
      expect(result.sourceHashes).toHaveProperty(path);
    }
    expect(await sha256File(fontPath)).toBe(before[fontPath]);
  }, 180000);
});

describe('ffprobe output for final preset', () => {
  it('reports fps, dimensions, codec, audio stream, and expected duration', async () => {
    const timeline = await buildIntegrationTimeline('preset-final-probe.mp4', 'final');
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    const probe = await ffprobe(result.outputPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.fps).toBe(30);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.hasAudio).toBe(true);
    expect(Math.abs(probe.duration - 5)).toBeLessThan(1 / 30 + 0.001);
  }, 180000);
});
