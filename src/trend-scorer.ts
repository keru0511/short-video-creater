import { spawn } from 'node:child_process';
import type { ProjectAsset } from './gui/project.js';

export interface PerSecondFeatures {
  energy: number;
  sceneChanges: number;
  silence: boolean;
}

export interface MediaAnalysis {
  duration: number;
  features: PerSecondFeatures[];
  sceneChanges: number[];
}

export interface UsedRange {
  start: number;
  end: number;
}

export interface ScoredClip {
  assetId: string;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  unusedFraction: number;
}

export interface TrendScorerOptions {
  windowSize?: number;
  step?: number;
  minDuration?: number;
  maxDuration?: number;
  energyWeight?: number;
  sceneWeight?: number;
  silenceWeight?: number;
  noveltyWeight?: number;
}

const DEFAULT_SAMPLE_RATE = 16000;
const SAMPLE_BYTES = 2;
const SILENCE_DB = -40;
const SCENE_THRESHOLD = 0.3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dbToEnergyScore(db: number): number {
  return clamp((db + 60) / 60, 0, 1);
}

export async function analyzeAsset(
  filePath: string,
  type: ProjectAsset['type'],
  duration?: number,
): Promise<MediaAnalysis> {
  if (type === 'image') {
    return { duration: duration ?? 0, features: [], sceneChanges: [] };
  }

  const [audioFeatures, sceneTimestamps] = await Promise.all([
    (async () => {
      if (type !== 'audio' && type !== 'video') return [];
      try {
        return await extractAudioFeatures(filePath);
      } catch {
        return [];
      }
    })(),
    type === 'video' ? extractSceneChanges(filePath) : Promise.resolve([]),
  ]);

  const inferredDuration = duration ?? Math.max(
    audioFeatures.length,
    sceneTimestamps.length > 0 ? Math.ceil(sceneTimestamps[sceneTimestamps.length - 1]) : 0,
  );

  const features: PerSecondFeatures[] = [];
  for (let i = 0; i < inferredDuration; i++) {
    const energy = audioFeatures[i]?.energy ?? 0;
    const silence = audioFeatures[i]?.silence ?? true;
    const sceneCount = sceneTimestamps.filter((t) => t >= i && t < i + 1).length;
    features.push({ energy, sceneChanges: sceneCount, silence });
  }

  return { duration: inferredDuration, features, sceneChanges: sceneTimestamps };
}

function extractAudioFeatures(filePath: string): Promise<{ energy: number; silence: boolean }[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', filePath,
      '-vn',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(DEFAULT_SAMPLE_RATE),
      '-ac', '1',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    const chunks: Buffer[] = [];
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.stdout.on('data', (chunk) => { chunks.push(chunk); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg audio extraction failed: ${stderr || code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const samplesPerSecond = DEFAULT_SAMPLE_RATE;
      const bytesPerSecond = samplesPerSecond * SAMPLE_BYTES;
      const features: { energy: number; silence: boolean }[] = [];

      let secondIndex = 0;
      while (secondIndex * bytesPerSecond < buffer.length) {
        const offset = secondIndex * bytesPerSecond;
        const slice = buffer.subarray(offset, offset + bytesPerSecond);
        let sumSquares = 0;
        let sampleCount = 0;
        for (let i = 0; i + 1 < slice.length; i += SAMPLE_BYTES) {
          const sample = slice.readInt16LE(i);
          sumSquares += sample * sample;
          sampleCount++;
        }
        const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
        const db = rms > 0 ? 20 * Math.log10(rms / 32768) : -100;
        const energy = dbToEnergyScore(db);
        const silence = db < SILENCE_DB;
        features.push({ energy, silence });
        secondIndex++;
      }
      resolve(features);
    });
  });
}

function extractSceneChanges(filePath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', filePath,
      '-vf', `select=gt(scene\\,${SCENE_THRESHOLD}),showinfo`,
      '-an',
      '-f', 'null',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // Some static files produce no selected frames and exit 0; tolerate non-zero if output exists.
      }
      const timestamps: number[] = [];
      const regex = /pts_time:([\d.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stderr)) !== null) {
        const t = parseFloat(match[1]);
        if (Number.isFinite(t) && t >= 0) timestamps.push(t);
      }
      resolve(timestamps);
    });
  });
}

function overlapFraction(ranges: UsedRange[], start: number, end: number): number {
  const span = end - start;
  if (span <= 0) return 0;
  let overlap = 0;
  for (const r of ranges) {
    const s = Math.max(start, r.start);
    const e = Math.min(end, r.end);
    if (e > s) overlap += e - s;
  }
  return overlap / span;
}

function scoreWindow(
  assetId: string,
  features: PerSecondFeatures[],
  start: number,
  end: number,
  usedRanges: UsedRange[],
  options: Required<TrendScorerOptions>,
): ScoredClip | undefined {
  const duration = end - start;
  if (duration <= 0) return undefined;

  let energySum = 0;
  let sceneSum = 0;
  let nonSilenceCount = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    const f = features[i];
    if (!f) continue;
    energySum += f.energy;
    sceneSum += f.sceneChanges;
    if (!f.silence) nonSilenceCount++;
    count++;
  }
  if (count === 0) return undefined;

  const energyScore = energySum / count;
  const sceneDensity = sceneSum / duration;
  const sceneScore = clamp(sceneDensity, 0, 1);
  const nonSilenceScore = nonSilenceCount / count;
  const unusedFraction = 1 - overlapFraction(usedRanges, start, end);

  const score =
    energyScore * options.energyWeight +
    sceneScore * options.sceneWeight +
    nonSilenceScore * options.silenceWeight +
    unusedFraction * options.noveltyWeight;

  const reasons: string[] = [];
  if (energyScore > 0.5) reasons.push('音声が盛り上がっている');
  if (sceneScore > 0.1) reasons.push('シーン切り替えが多い');
  if (nonSilenceScore > 0.7) reasons.push('無音区間が少ない');
  if (unusedFraction >= 0.8) reasons.push('まだ未使用');
  else if (unusedFraction >= 0.5) reasons.push('半分以上未使用');
  if (start <= 1) reasons.push('冒頭がフック');

  return {
    assetId,
    start,
    end,
    score,
    reasons,
    unusedFraction,
  };
}

export function scoreAssetWindows(
  assetId: string,
  analysis: MediaAnalysis,
  usedRanges: UsedRange[],
  options: TrendScorerOptions = {},
): ScoredClip[] {
  const opts: Required<TrendScorerOptions> = {
    windowSize: 10,
    step: 1,
    minDuration: 5,
    maxDuration: 60,
    energyWeight: 0.25,
    sceneWeight: 0.25,
    silenceWeight: 0.15,
    noveltyWeight: 0.35,
    ...options,
  };

  const duration = Math.floor(analysis.duration);
  if (duration < opts.minDuration) return [];

  const results: ScoredClip[] = [];
  for (let start = 0; start + opts.minDuration <= duration; start += opts.step) {
    let end = Math.min(start + opts.windowSize, duration);
    if (end - start > opts.maxDuration) end = start + opts.maxDuration;
    if (end - start < opts.minDuration) continue;
    const scored = scoreWindow(assetId, analysis.features, start, end, usedRanges, opts);
    if (scored) results.push(scored);
  }
  return results;
}

export function suggestTrendingClips(
  analyses: Record<string, MediaAnalysis>,
  usages: Record<string, UsedRange[]>,
  options?: TrendScorerOptions,
  maxSuggestions = 5,
): ScoredClip[] {
  const all: ScoredClip[] = [];
  for (const assetId of Object.keys(analyses)) {
    const used = usages[assetId] ?? [];
    all.push(...scoreAssetWindows(assetId, analyses[assetId], used, options));
  }

  all.sort((a, b) => b.score - a.score);

  const selected: ScoredClip[] = [];
  const selectedByAsset: Record<string, ScoredClip[]> = {};
  for (const clip of all) {
    if (selected.length >= maxSuggestions) break;
    const siblings = selectedByAsset[clip.assetId] ?? [];
    const overlaps = siblings.some((s) => clip.start < s.end && s.start < clip.end);
    if (overlaps) continue;
    selected.push(clip);
    siblings.push(clip);
    selectedByAsset[clip.assetId] = siblings;
  }

  return selected;
}
