import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, type Timeline } from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import {
  buildProjectTimeline,
  importTranscriptSubtitles,
  listProjectAssets,
  loadProjectConfig,
  removeProjectClip,
  saveProjectAsset,
  saveProjectConfig,
  splitProjectClip,
} from '../src/gui/project.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = resolve(root, 'fixtures');
const projectId = `test-project-${Date.now()}`;

let imagePath: string;
let audioPath: string;
let videoPath: string;

beforeAll(async () => {
  await rm(resolve(root, 'gui', 'projects', projectId), { recursive: true, force: true });
  await generateFixtures(root);
  imagePath = resolve(fixturesDir, 'image.png');
  audioPath = resolve(fixturesDir, 'audio.mp3');
  videoPath = resolve(fixturesDir, 'blue.mp4');
}, 120000);

afterAll(async () => {
  await rm(resolve(root, 'gui', 'projects', projectId), { recursive: true, force: true });
});

describe('Project catalog and trim API', () => {
  it('saves and lists media assets', async () => {
    const imageData = await readFile(imagePath);
    const asset = await saveProjectAsset(root, projectId, 'image.png', imageData);
    expect(asset.name).toBe('image.png');
    expect(asset.type).toBe('image');
    expect(asset.previewUrl).toBeTruthy();

    const assets = await listProjectAssets(root, projectId);
    expect(assets.length).toBe(1);
    expect(assets[0].assetId).toBe(asset.assetId);
  });

  it('builds a trimmed timeline from project assets and renders a valid MP4', async () => {
    const audioData = await readFile(audioPath);
    const audioAsset = await saveProjectAsset(root, projectId, 'audio.mp3', audioData);

    const assets = await listProjectAssets(root, projectId);
    const imageAsset = assets.find((a) => a.type === 'image');
    if (!imageAsset) throw new Error('image asset not found');

    const config = await loadProjectConfig(root, projectId);
    config.clips = [{ assetId: imageAsset.assetId, in: 0, out: 2, fit: 'cover' }];
    config.mainAudio = { assetId: audioAsset.assetId, in: 0, out: 2 };

    const timeline = await buildProjectTimeline(root, projectId, config);
    expect(timeline.clips.length).toBe(2);
    expect(timeline.clips[0].in).toBe(0);
    expect(timeline.clips[0].out).toBe(2);

    const projectRoot = resolve(root, 'gui', 'projects', projectId);
    const result = await generate(timeline, {
      rootDir: projectRoot,
      fixturesDir: resolve(projectRoot, 'input'),
      outputDir: resolve(root, 'gui', 'output', 'project-test'),
      fontsDir: resolve(projectRoot, 'fonts'),
    });
    expect(result.probe.width).toBe(1080);
    expect(result.probe.height).toBe(1920);
    expect(result.probe.videoCodec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs(result.probe.duration - 2)).toBeLessThan(0.2);

    await rm(resolve(root, 'gui', 'output', 'project-test'), { recursive: true, force: true });
  }, 120000);

  it('splits a video clip in the project config', async () => {
    const videoData = await readFile(videoPath);
    const videoAsset = await saveProjectAsset(root, projectId, 'blue.mp4', videoData);

    const config = await loadProjectConfig(root, projectId);
    config.clips = [{ assetId: videoAsset.assetId, in: 0, out: 3, fit: 'cover' }];
    await saveProjectConfig(root, projectId, config);

    const updated = await splitProjectClip(root, projectId, 0, 1);
    expect(updated.clips.length).toBe(2);
    expect(updated.clips[0].out).toBe(1);
    expect(updated.clips[1].in).toBe(1);
    expect(updated.clips[1].out).toBe(3);

    await removeProjectClip(root, projectId, 1);
    const after = await loadProjectConfig(root, projectId);
    expect(after.clips.length).toBe(1);
  });

  it('rejects invalid clip in/out ranges', async () => {
    const config = await loadProjectConfig(root, projectId);
    const assets = await listProjectAssets(root, projectId);
    const videoAsset = assets.find((a) => a.type === 'video');
    const imageAsset = assets.find((a) => a.type === 'image');
    if (!videoAsset) throw new Error('video asset not found');
    if (!imageAsset) throw new Error('image asset not found');

    config.clips = [{ assetId: videoAsset.assetId, in: 2, out: 2, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/終了位置は開始位置より後/);

    config.clips = [{ assetId: videoAsset.assetId, in: 2, out: 1, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/終了位置は開始位置より後/);

    config.clips = [{ assetId: videoAsset.assetId, in: -1, out: 1, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/開始位置は 0 以上/);

    config.clips = [{ assetId: videoAsset.assetId, in: 0, out: 100, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/終了位置が素材の長さを超え/);

    config.clips = [{ assetId: videoAsset.assetId, in: 5.1, out: 6, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/開始位置が素材の長さを超え/);

    config.clips = [{ assetId: imageAsset.assetId, in: 1, out: 1, fit: 'cover' }];
    await expect(buildProjectTimeline(root, projectId, config)).rejects.toThrow(/終了位置は開始位置より後/);
  });

  it('imports transcript subtitles mapped to the current clips', async () => {
    const imageData = await readFile(imagePath);
    const asset = await saveProjectAsset(root, `transcript-${projectId}`, 'image.png', imageData);
    const config = await loadProjectConfig(root, `transcript-${projectId}`);
    config.clips = [{ assetId: asset.assetId, in: 0, out: 5, fit: 'cover' }];

    const cues = await importTranscriptSubtitles(root, `transcript-${projectId}`, [
      { start: 0, end: 2, text: 'Hello' },
      { start: 2, end: 4, text: 'World' },
    ], config);
    expect(cues.length).toBe(2);
    expect(cues[0].start).toBe(0);
    expect(cues[0].text).toBe('Hello');

    await rm(resolve(root, 'gui', 'projects', `transcript-${projectId}`), { recursive: true, force: true });
  });

  it('rejects invalid project ID characters', async () => {
    await expect(saveProjectAsset(root, 'bad!id', 'image.png', await readFile(imagePath)))
      .rejects.toThrow('プロジェクトIDには半角英数字、ハイフン、アンダースコアのみ使用できます');
  });

  it('rejects a main audio track shorter than the video', async () => {
    const imageData = await readFile(imagePath);
    const audioData = await readFile(audioPath);
    const pid = `short-audio-${projectId}`;
    await rm(resolve(root, 'gui', 'projects', pid), { recursive: true, force: true });
    const imageAsset = await saveProjectAsset(root, pid, 'image.png', imageData);
    const audioAsset = await saveProjectAsset(root, pid, 'audio.mp3', audioData);
    const config = await loadProjectConfig(root, pid);
    config.clips = [{ assetId: imageAsset.assetId, in: 0, out: 3, fit: 'cover' }];
    config.mainAudio = { assetId: audioAsset.assetId, in: 0, out: 1 };
    await expect(buildProjectTimeline(root, pid, config)).rejects.toThrow('主音声');
    await rm(resolve(root, 'gui', 'projects', pid), { recursive: true, force: true });
  });
});
