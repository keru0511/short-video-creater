import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/core.js';
import { sha256File } from '../src/utils.js';
import { generateFixtures } from '../src/fixtures.js';

vi.mock('../src/subtitles.js', async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import('../src/subtitles.js');
  return {
    ...mod,
    writeCueTextFiles: vi.fn().mockRejectedValue(new Error('simulated cue write failure')),
  };
});

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const outputDir = join(root, 'output');
const fontsDir = join(root, 'fonts');

let dejavuHash = '';

beforeAll(async () => {
  await generateFixtures(root);
  dejavuHash = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));
}, 60000);

async function listSubtitleTempDirs(): Promise<string[]> {
  const tmp = tmpdir();
  const entries = await readdir(tmp);
  return entries.filter((e) => e.startsWith('svg-subtitles-')).map((e) => join(tmp, e));
}

describe('subtitle temp cleanup on cue write failure', () => {
  it('removes the temp dir when writing cue text files fails', async () => {
    const before = await listSubtitleTempDirs();

    const timeline = {
      width: 1080 as const,
      height: 1920 as const,
      fps: 30,
      outputPath: 'sub-cue-write-fail.mp4',
      background: '000000',
      font: 'DejaVuSans.ttf',
      fontHash: dejavuHash,
      clips: [
        { type: 'image' as const, source: 'black.png', start: 0, end: 3, in: 0, out: 3, fit: 'cover' as const },
        { type: 'audio' as const, source: 'audio.mp3', start: 0, end: 3, in: 0, out: 3 },
      ],
      subtitles: [{ start: 0.5, end: 1.5, text: 'Hello', x: 540, y: 1500, fontSize: 100 }],
    };

    await expect(generate(timeline, { rootDir: root, fixturesDir, outputDir })).rejects.toThrow(
      'simulated cue write failure',
    );

    const after = await listSubtitleTempDirs();
    expect(after.length).toBe(before.length);
    expect(after).toEqual(expect.arrayContaining(before));
  });
});
