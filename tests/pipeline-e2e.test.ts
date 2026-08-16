import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, ffprobe, sha256File, type Timeline } from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import { getEncodingArgs, OUTPUT_PRESETS } from '../src/output-presets.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const outputDir = join(root, 'output');
const fontsDir = join(root, 'fonts');

beforeAll(async () => {
  await generateFixtures(root);
}, 120000);

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

async function extractSubtitleRegion(videoPath: string, timeSec: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss',
      String(timeSec),
      '-i',
      videoPath,
      '-vf',
      'crop=680:250:200:1400',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 },
  );
  return stdout as Buffer;
}

function regionLuma(buf: Buffer): number {
  let sum = 0;
  const N = buf.length / 3;
  for (let i = 0; i < N; i++) {
    const r = buf[i * 3];
    const g = buf[i * 3 + 1];
    const b = buf[i * 3 + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sum / N;
}

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
  mNoise: number;
}

async function audioStats(
  videoPath: string,
  startSec: number,
  durationSec: number,
): Promise<AudioStats> {
  const samples = await extractMono16(videoPath, startSec, durationSec);
  const sumSq = samples.reduce((acc, x) => acc + x * x, 0);
  const rms = Math.sqrt(sumSq / samples.length);
  const peak = samples.reduce((acc, x) => Math.max(acc, Math.abs(x)), 0);
  return {
    rms,
    peak,
    m440: magnitude(samples, 48000, 440),
    m880: magnitude(samples, 48000, 880),
    mNoise: magnitude(samples, 48000, 1000),
  };
}

async function loadPipelineTimeline(outputPath?: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(fixturesDir, 'pipeline-e2e.json'), 'utf8');
  const timeline = JSON.parse(raw) as Record<string, unknown>;
  if (outputPath !== undefined) {
    timeline.outputPath = outputPath;
  }
  return timeline;
}

const INPUT_SOURCES = [
  'red.png',
  'blue.mp4',
  'black.png',
  'audio-440.wav',
  'bgm-880.wav',
] as const;

async function inputHashes(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const source of INPUT_SOURCES) {
    map[join(fixturesDir, source)] = await sha256File(join(fixturesDir, source));
  }
  map[join(fontsDir, 'DejaVuSans.ttf')] = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));
  return map;
}

describe('pipeline E2E', () => {
  it(
    'generates an integration 9:16 MP4 via the public API and verifies all features',
    async () => {
      const before = await inputHashes();
      const timeline = await loadPipelineTimeline('pipeline-e2e-api.mp4');

      const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

      const after = await inputHashes();
      expect(after).toEqual(before);

      expect(existsSync(result.outputPath)).toBe(true);
      const outputSha = await sha256File(result.outputPath);

      expect(result.probe.width).toBe(1080);
      expect(result.probe.height).toBe(1920);
      expect(result.probe.fps).toBe(30);
      expect(result.probe.videoCodec).toBe('h264');
      expect(result.probe.audioCodec).toBe('aac');
      expect(result.probe.hasAudio).toBe(true);
      expect(Math.abs(result.probe.duration - 5)).toBeLessThan(1 / 30 + 0.001);

      expect(result.outputPreset).toBe('final');
      expect(result.effectiveEncoding).toEqual({
        outputPreset: 'final',
        videoCodec: 'libx264',
        x264Preset: 'medium',
        crf: 18,
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
        audioBitrate: '192k',
      });

      const expectedArgs = getEncodingArgs('final', 30);
      const start = result.args.indexOf('-c:v');
      expect(start).toBeGreaterThan(-1);
      expect(result.args.slice(start, start + expectedArgs.length)).toEqual(expectedArgs);

      for (const source of INPUT_SOURCES) {
        const path = join(fixturesDir, source);
        expect(result.sourceHashes).toHaveProperty(path, before[path]);
      }
      expect(result.fontHash).toBe(before[join(fontsDir, 'DejaVuSans.ttf')]);

      // Crossfade verification.
      expect(isRed(await extractFrame(result.outputPath, 1.0))).toBe(true);
      const mid1 = await extractFrame(result.outputPath, 1.75);
      expect(!isRed(mid1) && !isBlue(mid1) && mid1[0] > 40 && mid1[2] > 40).toBe(true);
      expect(isBlue(await extractFrame(result.outputPath, 2.25))).toBe(true);

      expect(isBlue(await extractFrame(result.outputPath, 2.75))).toBe(true);
      const mid2 = await extractFrame(result.outputPath, 3.25);
      expect(!isBlue(mid2) && !isBlack(mid2) && mid2[2] > 40).toBe(true);
      expect(isBlack(await extractFrame(result.outputPath, 3.75))).toBe(true);

      // Subtitle verification: inside vs outside cue on the same background.
      const redNoCue = regionLuma(await extractSubtitleRegion(result.outputPath, 0.2));
      const redCue = regionLuma(await extractSubtitleRegion(result.outputPath, 0.7));
      expect(redCue).toBeGreaterThan(redNoCue + 5);

      const blackCue = regionLuma(await extractSubtitleRegion(result.outputPath, 3.7));
      const blackNoCue = regionLuma(await extractSubtitleRegion(result.outputPath, 4.2));
      expect(blackCue).toBeGreaterThan(blackNoCue + 3);

      // PCM verification: main 440Hz and BGM 880Hz both present.
      const stats = await audioStats(result.outputPath, 0, 4.5);
      expect(stats.m440 / stats.mNoise).toBeGreaterThan(1000);
      expect(stats.m880 / stats.mNoise).toBeGreaterThan(1000);
      expect(stats.m880 / stats.m440).toBeGreaterThan(0.05);
      expect(stats.m880 / stats.m440).toBeLessThan(0.9);

      // Report key verification data for the PR description.
      const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      const report = {
        headSha,
        command: 'npm run generate:fixtures && npm run generate:video -- fixtures/pipeline-e2e.json',
        outputPath: result.outputPath,
        outputSha,
        ffprobe: result.probe,
        effectiveEncoding: result.effectiveEncoding,
        argsTail: result.args.slice(start),
        sourceHashes: result.sourceHashes,
        timelineHash: result.timelineHash,
        ffmpegVersion: result.ffmpegVersion,
        crossfadeFrames: {
          redAt1_0: isRed(await extractFrame(result.outputPath, 1.0)),
          midRedBlueAt1_75: !isRed(mid1) && !isBlue(mid1) && mid1[0] > 40 && mid1[2] > 40,
          blueAt2_25: isBlue(await extractFrame(result.outputPath, 2.25)),
          blueAt2_75: isBlue(await extractFrame(result.outputPath, 2.75)),
          midBlueBlackAt3_25: !isBlue(mid2) && !isBlack(mid2) && mid2[2] > 40,
          blackAt3_75: isBlack(await extractFrame(result.outputPath, 3.75)),
        },
        subtitleLuma: {
          redNoCue0_2: redNoCue,
          redCue0_7: redCue,
          blackCue3_7: blackCue,
          blackNoCue4_2: blackNoCue,
        },
        audioMagnitudes: {
          m440: stats.m440,
          m880: stats.m880,
          mNoise: stats.mNoise,
        },
      };
      console.log(JSON.stringify(report, null, 2));
    },
    240000,
  );

  it(
    'generates the same integration MP4 through the CLI',
    async () => {
      await loadPipelineTimeline();
      const { stdout, stderr } = await execFileAsync('npm', ['run', 'generate:video', '--', 'fixtures/pipeline-e2e.json'], {
        cwd: root,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = stdout + stderr;
      expect(output).toContain('Generated:');
      expect(output).toContain('pipeline-e2e.mp4');
      expect(output).toContain('Output preset: final');

      const cliOutput = join(outputDir, 'pipeline-e2e.mp4');
      expect(existsSync(cliOutput)).toBe(true);

      const probe = await ffprobe(cliOutput);
      expect(probe.width).toBe(1080);
      expect(probe.height).toBe(1920);
      expect(probe.fps).toBe(30);
      expect(probe.videoCodec).toBe('h264');
      expect(probe.audioCodec).toBe('aac');
      expect(probe.hasAudio).toBe(true);
      expect(Math.abs(probe.duration - 5)).toBeLessThan(1 / 30 + 0.001);
    },
    240000,
  );

  it(
    'produces reproducible output and metadata when run twice in the same environment',
    async () => {
      const before = await inputHashes();

      const timeline = await loadPipelineTimeline('pipeline-e2e-repro.mp4');

      const result1 = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
      const sha1 = await sha256File(result1.outputPath);
      const argsStart1 = result1.args.indexOf('-c:v');
      const encodingArgs1 = result1.args.slice(argsStart1, argsStart1 + getEncodingArgs('final', 30).length);

      const result2 = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
      const sha2 = await sha256File(result2.outputPath);
      const argsStart2 = result2.args.indexOf('-c:v');
      const encodingArgs2 = result2.args.slice(argsStart2, argsStart2 + getEncodingArgs('final', 30).length);

      const after = await inputHashes();
      expect(after).toEqual(before);

      expect(sha2).toBe(sha1);
      expect(result2.timelineHash).toBe(result1.timelineHash);
      expect(result2.effectiveEncoding).toEqual(result1.effectiveEncoding);
      expect(encodingArgs2).toEqual(encodingArgs1);
      expect(result2.sourceHashes).toEqual(result1.sourceHashes);
      expect(result2.probe).toEqual(result1.probe);
      expect(result2.outputPreset).toBe(result1.outputPreset);
    },
    360000,
  );
});
