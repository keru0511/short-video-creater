import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, sha256File, TimelineSchema } from '../src/core.js';
import {
  buildSubtitleFilter,
  SUBTITLE_MAX_CUES,
  SUBTITLE_MAX_TEXT_LENGTH,
  type SubtitleCue,
  validateCues,
} from '../src/subtitles.js';
import { generateFixtures } from '../src/fixtures.js';
import { cleanupOutputDir, isolatedOutputDir } from './helpers.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
let outputDir = join(root, 'output');
const fontsDir = join(root, 'fonts');

let dejavuHash = '';
let ipagothicHash = '';

beforeAll(async () => {
  outputDir = await isolatedOutputDir(root);
  await generateFixtures(root);
  dejavuHash = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));
  ipagothicHash = await sha256File(join(fontsDir, 'IPAGothic.ttf'));
}, 60000);

afterAll(async () => {
  await cleanupOutputDir(outputDir);
});

async function extractRegion(
  videoPath: string,
  timeSec: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss',
      String(timeSec),
      '-i',
      videoPath,
      '-vf',
      `crop=${w}:${h}:${x}:${y}`,
      '-frames:v',
      '1',
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

function averageBrightness(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  return sum / buffer.length;
}

async function listSubtitleTempDirs(): Promise<string[]> {
  const tmp = tmpdir();
  const entries = await readdir(tmp);
  return entries.filter((e) => e.startsWith('svg-subtitles-')).map((e) => join(tmp, e));
}

const baseTimeline = () => ({
  width: 1080 as const,
  height: 1920 as const,
  fps: 30,
  outputPath: 'sub-base.mp4',
  background: '000000',
  font: 'DejaVuSans.ttf',
  fontHash: dejavuHash,
  clips: [
    { type: 'image' as const, source: 'black.png', start: 0, end: 3, in: 0, out: 3, fit: 'cover' as const },
    { type: 'audio' as const, source: 'audio.mp3', start: 0, end: 3, in: 0, out: 3 },
  ],
  subtitles: [
    { start: 0.5, end: 1.0, text: 'Hello', x: 540, y: 1500, fontSize: 100 },
    { start: 1.5, end: 2.0, text: 'World', x: 540, y: 1500, fontSize: 100 },
  ],
});

describe('TimelineSchema with subtitles', () => {
  it('accepts a valid timeline with subtitles', () => {
    expect(() => TimelineSchema.parse(baseTimeline())).not.toThrow();
  });

  it('rejects an empty subtitle text', () => {
    const tl = baseTimeline();
    tl.subtitles[0].text = '';
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a subtitle text that is too long', () => {
    const tl = baseTimeline();
    tl.subtitles[0].text = 'a'.repeat(SUBTITLE_MAX_TEXT_LENGTH + 1);
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a negative subtitle start', () => {
    const tl = baseTimeline();
    tl.subtitles[0].start = -1;
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects start >= end', () => {
    const tl = baseTimeline();
    tl.subtitles[0].start = 1.5;
    tl.subtitles[0].end = 1.5;
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects too many subtitle cues', () => {
    const tl = baseTimeline();
    tl.subtitles = [];
    for (let i = 0; i < SUBTITLE_MAX_CUES + 1; i++) {
      tl.subtitles.push({
        start: i * 0.1,
        end: i * 0.1 + 0.05,
        text: 'x',
        x: 0,
        y: 0,
        fontSize: 10,
      });
    }
    expect(() => TimelineSchema.parse(tl)).toThrow();
  });

  it('rejects a cue end that exceeds total duration', async () => {
    const tl = baseTimeline();
    tl.subtitles[0].end = 4;
    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });

  it('rejects a cue start that exceeds total duration', async () => {
    const tl = baseTimeline();
    tl.subtitles[0].start = 4;
    tl.subtitles[0].end = 5;
    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'exceeds',
    );
  });
});

describe('subtitle rendering', () => {
  it('generates a 9:16 h264 mp4 from a fixture with two cues', async () => {
    const raw = await readFile(join(fixturesDir, 'subtitles.json'), 'utf8');
    const timeline = JSON.parse(raw);

    const before = {
      black: await sha256File(join(fixturesDir, 'black.png')),
      audio: await sha256File(join(fixturesDir, 'audio.mp3')),
    };

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(Math.abs(result.probe.duration - 3)).toBeLessThan(0.5);
    expect(result.timelineHash).toHaveLength(64);
    expect(result.ffmpegVersion).toContain('ffmpeg version');
    expect(result.fontFile).toBeTruthy();
    expect(result.fontHash).toHaveLength(64);
    expect(result.fontFamily).toBe('DejaVu Sans');
    expect(result.sourceHashes[result.fontFile!]).toBe(result.fontHash);

    expect(await sha256File(join(fixturesDir, 'black.png'))).toBe(before.black);
    expect(await sha256File(join(fixturesDir, 'audio.mp3'))).toBe(before.audio);
  });

  it('draws each cue only during its specified interval', async () => {
    const timeline = baseTimeline();
    timeline.outputPath = 'sub-render.mp4';
    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    const cropX = 200;
    const cropY = 1300;
    const cropW = 700;
    const cropH = 400;

    const cue1Frame = await extractRegion(result.outputPath, 0.75, cropX, cropY, cropW, cropH);
    const cue2Frame = await extractRegion(result.outputPath, 1.75, cropX, cropY, cropW, cropH);
    const beforeCue = await extractRegion(result.outputPath, 0.2, cropX, cropY, cropW, cropH);
    const betweenCues = await extractRegion(result.outputPath, 1.25, cropX, cropY, cropW, cropH);
    const afterCues = await extractRegion(result.outputPath, 2.5, cropX, cropY, cropW, cropH);

    const bright1 = averageBrightness(cue1Frame);
    const bright2 = averageBrightness(cue2Frame);
    const dark1 = averageBrightness(beforeCue);
    const dark2 = averageBrightness(betweenCues);
    const dark3 = averageBrightness(afterCues);

    expect(bright1).toBeGreaterThan(3);
    expect(bright2).toBeGreaterThan(3);
    expect(dark1).toBeLessThan(3);
    expect(dark2).toBeLessThan(3);
    expect(dark3).toBeLessThan(3);

    // The two cues should produce different rendered pixels.
    expect(cue1Frame.toString('base64')).not.toBe(cue2Frame.toString('base64'));
  });

  it('renders Japanese text with a font that contains the glyphs', async () => {
    const timeline = baseTimeline();
    timeline.outputPath = 'sub-japanese.mp4';
    timeline.font = 'IPAGothic.ttf';
    timeline.fontHash = ipagothicHash;
    timeline.subtitles = [
      { start: 0.5, end: 1.5, text: '日本語テロップ', x: 540, y: 1500, fontSize: 100 },
    ];

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(result.fontFamily).toBe('IPAGothic');

    const cropW = 700;
    const cropH = 400;
    const cropX = (1080 - cropW) / 2;
    const cropY = 1300;
    const during = await extractRegion(result.outputPath, 1.0, cropX, cropY, cropW, cropH);
    const before = await extractRegion(result.outputPath, 0.2, cropX, cropY, cropW, cropH);

    expect(averageBrightness(during)).toBeGreaterThan(3);
    expect(averageBrightness(before)).toBeLessThan(3);
  });

  it('renders multiline text with an actual newline', async () => {
    const timeline = baseTimeline();
    timeline.outputPath = 'sub-multiline.mp4';
    timeline.subtitles = [
      { start: 0.5, end: 1.5, text: 'line1\nline2', x: 200, y: 1400, fontSize: 80 },
    ];

    const result = await generate(timeline, { rootDir: root, fixturesDir, outputDir });
    expect(result.probe.videoCodec).toBe('h264');

    const cropW = 700;
    const cropH = 120;
    const cropX = 200;
    const top = await extractRegion(result.outputPath, 1.0, cropX, 1360, cropW, cropH);
    const bottom = await extractRegion(result.outputPath, 1.0, cropX, 1460, cropW, cropH);
    const before = await extractRegion(result.outputPath, 0.2, cropX, 1360, cropW, cropH);

    expect(averageBrightness(top)).toBeGreaterThan(3);
    expect(averageBrightness(bottom)).toBeGreaterThan(3);
    expect(averageBrightness(before)).toBeLessThan(3);
  });

  it('renders styled text with border, box, and center alignment', async () => {
    const tl = baseTimeline() as any;
    tl.outputPath = 'sub-styled.mp4';
    tl.subtitles = [
      {
        start: 0.5,
        end: 1.5,
        text: 'Styled',
        x: 0,
        y: 1500,
        fontSize: 100,
        fontColor: '#FF0000',
        borderWidth: 2,
        borderColor: '#000000',
        box: true,
        boxColor: '#FFFFFF',
        boxAlpha: 1,
        align: 'center',
      },
    ];

    const result = await generate(tl, { rootDir: root, fixturesDir, outputDir });
    expect(result.probe.videoCodec).toBe('h264');

    // The centered text should appear near the horizontal center (x ~ 420-660).
    const left = await extractRegion(result.outputPath, 1.0, 100, 1300, 300, 400);
    const right = await extractRegion(result.outputPath, 1.0, 680, 1300, 300, 400);
    const center = await extractRegion(result.outputPath, 1.0, 390, 1300, 300, 400);
    expect(averageBrightness(center)).toBeGreaterThan(3);
  });
});

describe('subtitle filter construction', () => {
  it('includes color, border, box, and center alignment in the filter string', () => {
    const cues: SubtitleCue[] = [
      {
        start: 0,
        end: 1,
        text: 'A',
        x: 0,
        y: 100,
        fontSize: 50,
        fontColor: '#FF0000',
        fontAlpha: 1,
        borderWidth: 2,
        borderColor: '#00FF00',
        box: true,
        boxColor: '#000000',
        boxAlpha: 0.5,
        align: 'center',
      },
    ];
    const filter = buildSubtitleFilter(cues, ['/tmp/cue-0.txt'], ['/tmp/font.ttf']);
    expect(filter).toContain('fontcolor=0xFF0000');
    expect(filter).toContain('borderw=2');
    expect(filter).toContain('bordercolor=0x00FF00');
    expect(filter).toContain('box=1');
    expect(filter).toContain('boxcolor=0x000000@0.5');
    expect(filter).toContain('x=(w-text_w)/2');
  });

  it('omits border and box when disabled', () => {
    const cues: SubtitleCue[] = [
      {
        start: 0,
        end: 1,
        text: 'A',
        x: 10,
        y: 100,
        fontSize: 50,
        fontColor: '#FFFFFF',
        fontAlpha: 0.8,
        borderWidth: 0,
        borderColor: '#000000',
        box: false,
        boxColor: '#000000',
        boxAlpha: 0.5,
        align: 'left',
      },
    ];
    const filter = buildSubtitleFilter(cues, ['/tmp/cue-0.txt'], ['/tmp/font.ttf']);
    expect(filter).toContain('alpha=0.8');
    expect(filter).not.toContain('borderw=');
    expect(filter).not.toContain('box=');
    expect(filter).toContain('x=10');
  });
});

describe('subtitle safety and validation', () => {
  it('renders text containing shell metacharacters and filter special chars safely', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-safety.mp4';
    tl.subtitles = [
      {
        start: 0.5,
        end: 1.5,
        text: "Hello; && | $ ` : \\n ' \" World",
        x: 540,
        y: 1500,
        fontSize: 100,
      },
    ];

    const before = await sha256File(join(fixturesDir, 'black.png'));

    const result = await generate(tl, { rootDir: root, fixturesDir, outputDir });

    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.hasAudio).toBe(true);
    expect(existsSync(result.outputPath)).toBe(true);
    // The source image must not have been touched by shell metacharacters.
    expect(await sha256File(join(fixturesDir, 'black.png'))).toBe(before);
    // Text must not leak into argv as a shell string.
    expect(result.args.join(' ')).not.toContain('&&');
  });

  it('does not execute commands embedded in subtitle text', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-exec.mp4';
    tl.subtitles = [
      {
        start: 0.5,
        end: 1.5,
        text: "'; touch /tmp/svg-pwned-12345; #",
        x: 540,
        y: 1500,
        fontSize: 100,
      },
    ];

    const result = await generate(tl, { rootDir: root, fixturesDir, outputDir });
    expect(result.probe.videoCodec).toBe('h264');
    expect(existsSync('/tmp/svg-pwned-12345')).toBe(false);
  });

  it('rejects a font that does not contain glyphs required by the cue text', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-glyph-missing.mp4';
    tl.subtitles = [
      { start: 0.5, end: 1.5, text: '日本語テロップ', x: 540, y: 1500, fontSize: 100 },
    ];

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Font does not contain glyph',
    );
  });

  it('rejects an arbitrary absolute font path', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-absolute.mp4';
    tl.font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Absolute font paths are not allowed',
    );
  });

  it('rejects a font hash mismatch deterministically', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-hash.mp4';
    tl.fontHash = 'a'.repeat(64);

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'Font hash mismatch',
    );
  });

  it('rejects an unsupported font extension', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-ext.mp4';
    tl.font = 'foo.bar';
    tl.fontHash = 'a'.repeat(64);

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'single-face TrueType/OpenType',
    );
  });

  it('rejects TrueType/OpenType Collection fonts', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-ttc.mp4';
    tl.font = 'font.ttc';
    tl.fontHash = 'a'.repeat(64);

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'single-face TrueType/OpenType',
    );
  });

  it('rejects a font path outside the approved font root', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-escape.mp4';
    tl.font = '../etc/passwd.ttf';
    tl.fontHash = 'a'.repeat(64);

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();
  });

  it('rejects disallowed control characters in subtitle text', async () => {
    const tl = baseTimeline();
    tl.outputPath = 'sub-control.mp4';
    tl.subtitles[0].text = 'Hello\x00World';

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'disallowed control',
    );
  });
});

describe('subtitle temp cleanup', () => {
  it('does not create temp dirs on font resolution failure', async () => {
    const before = await listSubtitleTempDirs();
    const tl = baseTimeline();
    tl.outputPath = 'sub-font-fail.mp4';
    tl.font = 'ThisFontDoesNotExist.ttf';

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();

    const after = await listSubtitleTempDirs();
    expect(after.length).toBe(before.length);
    expect(after).toEqual(expect.arrayContaining(before));
  });

  it('cleans up temp dirs when ffmpeg fails', async () => {
    const before = await listSubtitleTempDirs();
    const tl = baseTimeline();
    tl.outputPath = 'sub-ffmpeg-fail';
    const failDir = join(outputDir, tl.outputPath);
    await mkdir(failDir);

    await expect(generate(tl, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow();

    await rm(failDir, { recursive: true, force: true });

    const after = await listSubtitleTempDirs();
    expect(after.length).toBe(before.length);
    expect(after).toEqual(expect.arrayContaining(before));
  });
});

describe('validateCues', () => {
  it('throws for a cue with an empty string', () => {
    expect(() =>
      validateCues([{ start: 0, end: 1, text: '', x: 0, y: 0, fontSize: 10 }], 2),
    ).toThrow();
  });

  it('throws for a cue that exceeds the total duration', () => {
    expect(() =>
      validateCues([{ start: 1, end: 4, text: 'x', x: 0, y: 0, fontSize: 10 }], 3),
    ).toThrow('exceeds');
  });

  it('throws for disallowed control characters', () => {
    expect(() =>
      validateCues([{ start: 0, end: 1, text: 'a\x00b', x: 0, y: 0, fontSize: 10 }], 3),
    ).toThrow('disallowed control');
  });

  it('allows LF, CR and TAB as layout controls', () => {
    expect(() =>
      validateCues(
        [{ start: 0, end: 1, text: 'line1\nline2\r\n\ttab', x: 0, y: 0, fontSize: 10 }],
        3,
      ),
    ).not.toThrow();
  });
});
