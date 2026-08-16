import { describe, it, expect, beforeAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixtures } from '../src/fixtures.js';
import { ffprobe } from '../src/core.js';
import {
  analyzeAsset,
  scoreAssetWindows,
  suggestTrendingClips,
  type MediaAnalysis,
  type UsedRange,
} from '../src/trend-scorer.js';
import {
  autofillTimelineWithTrendingClips,
  getTrendingClipSuggestions,
  loadProjectUsage,
  recordProjectUsage,
  saveProjectAsset,
  saveProjectConfig,
  type ProjectTimelineConfig,
} from '../src/gui/project.js';
import { readFile } from 'node:fs/promises';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = resolve(root, 'fixtures');
const projectId = `test-trend-${Date.now()}`;

let videoPath: string;
let audioPath: string;
let videoDuration: number;
let audioDuration: number;

beforeAll(async () => {
  await rm(resolve(root, 'gui', 'projects', projectId), { recursive: true, force: true });
  await generateFixtures(root);
  videoPath = resolve(fixturesDir, 'blue.mp4');
  audioPath = resolve(fixturesDir, 'audio.mp3');
  videoDuration = (await ffprobe(videoPath)).duration ?? 0;
  audioDuration = (await ffprobe(audioPath)).duration ?? 0;
}, 120000);

describe('trend-scorer', () => {
  it('analyzes a video asset for audio energy and scene changes', async () => {
    const analysis = await analyzeAsset(videoPath, 'video', videoDuration);
    expect(analysis.duration).toBeGreaterThan(0);
    expect(analysis.features.length).toBeGreaterThan(0);
    expect(Number.isFinite(analysis.features[0].energy)).toBe(true);
    expect(typeof analysis.features[0].silence).toBe('boolean');
    expect(Array.isArray(analysis.sceneChanges)).toBe(true);
  }, 60000);

  it('analyzes an audio asset', async () => {
    const analysis = await analyzeAsset(audioPath, 'audio', audioDuration);
    expect(analysis.duration).toBeGreaterThan(0);
    expect(analysis.features.length).toBeGreaterThan(0);
    expect(Number.isFinite(analysis.features[0].energy)).toBe(true);
    expect(Array.isArray(analysis.sceneChanges)).toBe(true);
  }, 60000);

  it('scores windows and identifies unused ranges', () => {
    const features = Array.from({ length: 10 }, (_, i) => ({
      energy: i < 3 ? 0.2 : 0.9,
      sceneChanges: i === 4 ? 1 : 0,
      silence: i < 3,
    }));
    const analysis: MediaAnalysis = { duration: 10, features, sceneChanges: [4] };
    const used: UsedRange[] = [{ start: 0, end: 3 }];
    const scored = scoreAssetWindows('a', analysis, used);
    expect(scored.length).toBeGreaterThan(0);
    const best = scored.reduce((p, c) => (p.score > c.score ? p : c));
    expect(best.start).toBeGreaterThanOrEqual(3);
    expect(best.unusedFraction).toBeGreaterThan(0);
  });

  it('suggests non-overlapping clips across assets', () => {
    const analyses: Record<string, MediaAnalysis> = {
      a: { duration: 15, features: Array.from({ length: 15 }, (_, i) => ({ energy: 0.5, sceneChanges: i % 5 === 0 ? 1 : 0, silence: false })), sceneChanges: [5, 10] },
      b: { duration: 12, features: Array.from({ length: 12 }, (_, i) => ({ energy: 0.8, sceneChanges: 0, silence: false })), sceneChanges: [] },
    };
    const usage: Record<string, UsedRange[]> = { a: [{ start: 0, end: 3 }] };
    const suggestions = suggestTrendingClips(analyses, usage, undefined, 3);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const s of suggestions) {
      expect(s.score).toBeGreaterThan(0);
      expect(s.end - s.start).toBeGreaterThanOrEqual(5);
      expect(s.end - s.start).toBeLessThanOrEqual(15);
    }
    const aSuggestions = suggestions.filter((s) => s.assetId === 'a');
    expect(aSuggestions.length).toBeLessThanOrEqual(1);
  });

  it('records project usage and reuses it for novelty scoring', async () => {
    const videoData = await readFile(videoPath);
    const asset = await saveProjectAsset(root, projectId, 'blue.mp4', videoData);
    const config: ProjectTimelineConfig = {
      clips: [{ assetId: asset.assetId, in: 0, out: 1, fit: 'cover' }],
      mainAudio: undefined,
      bgm: undefined,
      subtitles: [],
      crossfade: { enabled: false, duration: 0.5 },
      outputPreset: 'preview',
    };
    await saveProjectConfig(root, projectId, config);
    await recordProjectUsage(root, projectId, config);

    const usage = await loadProjectUsage(root, projectId);
    expect(usage.ranges[asset.assetId]).toBeDefined();
    expect(usage.ranges[asset.assetId].length).toBe(1);
    expect(usage.ranges[asset.assetId][0].start).toBe(0);
    expect(usage.ranges[asset.assetId][0].end).toBeCloseTo(1, 5);
  });

  it('suggests trending clips for project assets', async () => {
    const suggestions = await getTrendingClipSuggestions(root, projectId);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].score).toBeGreaterThan(0);
    expect(suggestions[0]).toHaveProperty('assetId');
    expect(suggestions[0]).toHaveProperty('in');
    expect(suggestions[0]).toHaveProperty('out');
    expect(suggestions[0]).toHaveProperty('reasons');
    expect(suggestions[0]).toHaveProperty('unusedFraction');
    expect(suggestions[0]).toHaveProperty('type');
  }, 120000);

  it('autofills timeline with trending clips', async () => {
    const config = await autofillTimelineWithTrendingClips(root, projectId);
    expect(config.clips.length).toBeGreaterThan(0);
    expect(config.clips.every((c) => c.assetId && Number.isFinite(c.in) && Number.isFinite(c.out))).toBe(true);
  }, 120000);

  it('suggests audio assets but does not autofill them as visual clips', async () => {
    const audioData = await readFile(audioPath);
    const audioAsset = await saveProjectAsset(root, projectId, 'audio.mp3', audioData);

    const suggestions = await getTrendingClipSuggestions(root, projectId, undefined, 20);
    expect(suggestions.some((s) => s.assetId === audioAsset.assetId && s.type === 'audio')).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);

    const config = await autofillTimelineWithTrendingClips(root, projectId);
    expect(config.clips.some((c) => c.assetId === audioAsset.assetId)).toBe(false);
  }, 120000);
});
