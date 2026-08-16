import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTrustedDirectory } from '../audit.js';
import { ffprobe, type Bgm, type Clip, type Timeline } from '../core.js';
import { prepareFonts } from '../fixtures.js';
import { resolveSafePath, sha256File } from '../utils.js';
import { verifyFontGlyphs } from '../subtitles.js';
import {
  analyzeAsset,
  suggestTrendingClips,
  type MediaAnalysis,
  type ScoredClip,
  type TrendScorerOptions,
  type UsedRange,
} from '../trend-scorer.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.wma', '.oga']);

export interface ProjectAsset {
  assetId: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  duration?: number;
  width?: number;
  height?: number;
  previewUrl?: string;
}

export interface ProjectClipConfig {
  assetId: string;
  in?: number;
  out?: number;
  fit?: 'cover' | 'contain';
  x?: number;
  y?: number;
  scale?: number;
}

export interface ProjectAudioTrackConfig {
  assetId: string;
  in?: number;
  out?: number;
  start?: number;
  volume?: number;
}

export interface ProjectSubtitleCue {
  start: number;
  end: number;
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
  fontColor?: string;
  fontAlpha?: number;
  borderWidth?: number;
  borderColor?: string;
  box?: boolean;
  boxColor?: string;
  boxAlpha?: number;
  align?: 'left' | 'center' | 'right';
  font?: string;
  fontHash?: string;
}

export interface ProjectTimelineConfig {
  outputPreset?: 'preview' | 'final';
  background?: string;
  clips: ProjectClipConfig[];
  mainAudio?: ProjectAudioTrackConfig;
  bgm?: ProjectAudioTrackConfig;
  subtitles?: ProjectSubtitleCue[];
  crossfade?: { enabled?: boolean; duration?: number };
}

export interface ProjectPaths {
  projectRoot: string;
  inputDir: string;
  previewsDir: string;
}

export function getProjectPaths(projectRoot: string): ProjectPaths {
  return {
    projectRoot,
    inputDir: resolve(projectRoot, 'input'),
    previewsDir: resolve(projectRoot, 'previews'),
  };
}

export function resolveProjectRoot(rootDir: string, projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error('プロジェクトIDには半角英数字、ハイフン、アンダースコアのみ使用できます');
  }
  return resolve(rootDir, 'gui', 'projects', projectId);
}

function sanitizeAssetId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function classifyExtension(filename: string): ProjectAsset['type'] | undefined {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return undefined;
}

export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return base || 'file';
}

async function ensureDirs(paths: ProjectPaths, rootDir: string): Promise<void> {
  await ensureTrustedDirectory(paths.projectRoot, rootDir, true);
  await ensureTrustedDirectory(paths.inputDir, rootDir, true);
  await ensureTrustedDirectory(paths.previewsDir, rootDir, true);
}

async function probeForProject(filePath: string): Promise<{
  type: ProjectAsset['type'];
  duration?: number;
  width?: number;
  height?: number;
}> {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    try {
      const probe = await ffprobe(filePath);
      return { type: 'image', width: probe.width, height: probe.height };
    } catch {
      return { type: 'image' };
    }
  }

  const probe = await ffprobe(filePath);
  const duration = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : undefined;
  if (VIDEO_EXTS.has(ext) || (probe.hasVideo && !probe.hasAudio)) {
    return { type: 'video', duration, width: probe.width, height: probe.height };
  }
  if (AUDIO_EXTS.has(ext) || probe.hasAudio) {
    return { type: 'audio', duration };
  }
  if (probe.hasVideo) {
    return { type: 'video', duration, width: probe.width, height: probe.height };
  }
  throw new Error(`メディア形式を判定できません: ${basename(filePath)}`);
}

async function generatePreview(
  inputPath: string,
  type: 'image' | 'video' | 'audio',
  previewPath: string,
): Promise<boolean> {
  if (type === 'audio') return false;
  await mkdir(dirname(previewPath), { recursive: true });
  const seek = type === 'video' ? '0.5' : undefined;
  const args = ['-y'];
  if (seek) {
    args.push('-ss', seek);
  }
  args.push('-i', inputPath, '-vf', 'scale=480:-2:flags=lanczos', '-frames:v', '1', '-q:v', '2', previewPath);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`プレビュー生成に失敗しました: ${stderr}`));
    });
  });
}

export async function saveProjectAsset(
  rootDir: string,
  projectId: string,
  filename: string,
  data: Buffer,
): Promise<ProjectAsset> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const paths = getProjectPaths(projectRoot);
  await ensureDirs(paths, rootDir);

  const type = classifyExtension(filename);
  if (!type) {
    throw new Error(`未対応のファイル形式です: ${filename}`);
  }

  const assetId = sanitizeAssetId(randomUUID());
  const safeName = sanitizeFilename(filename);
  const assetDir = resolve(paths.inputDir, assetId);
  const filePath = resolve(assetDir, safeName);

  await ensureTrustedDirectory(dirname(assetDir), rootDir, true);
  await mkdir(assetDir, { recursive: true });
  await writeFile(filePath, data);

  const contentHash = await sha256File(filePath);
  const probe = await probeForProject(filePath);
  const previewName = `${assetId}.jpg`;
  const previewPath = resolve(paths.previewsDir, previewName);
  let previewUrl: string | undefined;
  try {
    const ok = await generatePreview(filePath, probe.type, previewPath);
    if (ok) {
      previewUrl = `/api/projects/${encodeURIComponent(projectId)}/previews/${previewName}`;
    }
  } catch {
    previewUrl = undefined;
  }

  const relativePath = relative(paths.inputDir, filePath).replace(/\\/g, '/');
  const stat = await lstat(filePath);
  const asset: ProjectAsset = {
    assetId,
    name: safeName,
    type: probe.type,
    relativePath,
    contentHash,
    sizeBytes: Number(stat.size),
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    previewUrl,
  };

  await writeFile(resolve(assetDir, 'asset.json'), JSON.stringify(asset, null, 2), 'utf8');
  return asset;
}

async function readAssetMeta(assetDir: string): Promise<ProjectAsset | undefined> {
  const metaPath = resolve(assetDir, 'asset.json');
  if (!existsSync(metaPath)) return undefined;
  try {
    const text = await readFile(metaPath, 'utf8');
    const data = JSON.parse(text) as ProjectAsset;
    return data;
  } catch {
    return undefined;
  }
}

export async function listProjectAssets(rootDir: string, projectId: string): Promise<ProjectAsset[]> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const paths = getProjectPaths(projectRoot);
  if (!existsSync(paths.inputDir)) return [];
  const entries = await readdir(paths.inputDir, { withFileTypes: true });
  const assets: ProjectAsset[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readAssetMeta(resolve(paths.inputDir, entry.name));
    if (meta) assets.push(meta);
  }
  return assets;
}

export async function getProjectAsset(
  rootDir: string,
  projectId: string,
  assetId: string,
): Promise<ProjectAsset | undefined> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const assetDir = resolve(projectRoot, 'input', sanitizeAssetId(assetId));
  return readAssetMeta(assetDir);
}

export async function resolveAssetFilePath(
  rootDir: string,
  projectId: string,
  assetId: string,
): Promise<string> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const assetDir = resolve(projectRoot, 'input', sanitizeAssetId(assetId));
  const meta = await readAssetMeta(assetDir);
  if (!meta) throw new Error(`素材が見つかりません: ${assetId}`);
  return resolveSafePath(projectRoot, join('input', sanitizeAssetId(assetId), meta.name));
}

export async function buildProjectTimeline(
  rootDir: string,
  projectId: string,
  config: ProjectTimelineConfig,
): Promise<Timeline> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  if (!config.clips || config.clips.length === 0) {
    throw new Error('画像・動画クリップを1つ以上追加してください');
  }
  if (config.clips.length > 5) {
    throw new Error('画像・動画は最大5つまでです');
  }

  const clips: Clip[] = [];
  let currentStart = 0;
  const visualDurations: number[] = [];

  for (let i = 0; i < config.clips.length; i++) {
    const c = config.clips[i];
    const asset = await getProjectAsset(rootDir, projectId, c.assetId);
    if (!asset) throw new Error(`クリップ ${i + 1} の素材が見つかりません: ${c.assetId}`);
    if (asset.type !== 'image' && asset.type !== 'video') {
      throw new Error(`クリップ ${i + 1} は画像・動画ではありません: ${asset.name}`);
    }

    const fit: 'cover' | 'contain' = c.fit === 'contain' ? 'contain' : 'cover';
    const x = Number.isFinite(c.x) ? Number(c.x) : 0;
    const y = Number.isFinite(c.y) ? Number(c.y) : 0;
    const scale = Number.isFinite(c.scale) && Number(c.scale) > 0 ? Number(c.scale) : 1;

    const sourceIn = c.in == null ? 0 : Number(c.in);
    if (!Number.isFinite(sourceIn) || sourceIn < 0) {
      throw new Error(`クリップ ${i + 1} の開始位置は 0 以上の数値である必要があります: ${asset.name}`);
    }

    let sourceOut: number;
    if (asset.type === 'image') {
      if (c.out == null) {
        sourceOut = sourceIn + 5;
      } else {
        const outVal = Number(c.out);
        if (!Number.isFinite(outVal)) {
          throw new Error(`クリップ ${i + 1} の終了位置を数値で指定してください: ${asset.name}`);
        }
        if (outVal <= sourceIn) {
          throw new Error(`クリップ ${i + 1} の終了位置は開始位置より後である必要があります: ${asset.name}`);
        }
        sourceOut = outVal;
      }
    } else {
      if (!Number.isFinite(asset.duration) || asset.duration! <= 0) {
        throw new Error(`クリップ ${i + 1} の長さを取得できません: ${asset.name}`);
      }
      if (sourceIn > asset.duration! + 0.001) {
        throw new Error(`クリップ ${i + 1} の開始位置が素材の長さを超えています: ${asset.name}`);
      }
      if (c.out == null) {
        sourceOut = asset.duration!;
      } else {
        const outVal = Number(c.out);
        if (!Number.isFinite(outVal)) {
          throw new Error(`クリップ ${i + 1} の終了位置を数値で指定してください: ${asset.name}`);
        }
        if (outVal > asset.duration! + 0.001) {
          throw new Error(`クリップ ${i + 1} の終了位置が素材の長さを超えています: ${asset.name}`);
        }
        if (outVal <= sourceIn) {
          throw new Error(`クリップ ${i + 1} の終了位置は開始位置より後である必要があります: ${asset.name}`);
        }
        sourceOut = outVal;
      }
    }

    if (sourceIn >= sourceOut) {
      throw new Error(`クリップ ${i + 1} の開始・終了位置が不正です`);
    }

    const duration = sourceOut - sourceIn;
    clips.push({
      type: asset.type,
      source: asset.relativePath,
      start: currentStart,
      end: currentStart + duration,
      in: sourceIn,
      out: sourceOut,
      fit,
      x,
      y,
      scale,
    });
    visualDurations.push(duration);
    currentStart += duration;
  }

  const baseDuration = visualDurations.reduce((a, b) => a + b, 0);
  const transitionDurations: number[] = [];
  if (config.crossfade?.enabled && clips.length > 1) {
    const d = Number(config.crossfade.duration);
    if (!Number.isFinite(d) || d <= 0) {
      throw new Error('クロスフェード秒数が不正です');
    }
    for (let i = 0; i < clips.length - 1; i++) {
      const maxAllowed = Math.min(visualDurations[i], visualDurations[i + 1]);
      if (d > maxAllowed) {
        throw new Error(`クロスフェード秒数がクリップの長さを超えています（クリップ ${i + 1}・${i + 2}）`);
      }
      transitionDurations.push(d);
    }
  }
  const totalTransition = transitionDurations.reduce((a, b) => a + b, 0);
  const finalDuration = baseDuration - totalTransition;
  if (finalDuration <= 0) {
    throw new Error('最終的な動画時間が0秒以下になります');
  }

  if (config.mainAudio) {
    const asset = await getProjectAsset(rootDir, projectId, config.mainAudio.assetId);
    if (!asset || asset.type !== 'audio') {
      throw new Error('主音声には音声ファイルを選んでください');
    }
    if (!Number.isFinite(asset.duration) || asset.duration! <= 0) {
      throw new Error('主音声の長さを取得できません');
    }
    const inTime = Number.isFinite(config.mainAudio.in) && config.mainAudio.in! >= 0 ? Number(config.mainAudio.in) : 0;
    const outTime = Number.isFinite(config.mainAudio.out) && config.mainAudio.out! > inTime
      ? Number(config.mainAudio.out)
      : inTime + finalDuration;
    if (outTime - inTime < finalDuration - 0.001) {
      throw new Error(`主音声(${outTime - inTime}s)が動画の長さ(${finalDuration.toFixed(2)}s)より短いです`);
    }
    if (outTime > asset.duration! + 0.001) {
      throw new Error('主音声の終了位置が素材の長さを超えています');
    }
    clips.push({
      type: 'audio',
      source: asset.relativePath,
      start: 0,
      end: finalDuration,
      in: inTime,
      out: inTime + finalDuration,
      fit: 'cover',
      x: 0,
      y: 0,
    });
  }

  let bgm: Bgm | undefined;
  if (config.bgm) {
    const asset = await getProjectAsset(rootDir, projectId, config.bgm.assetId);
    if (!asset || asset.type !== 'audio') {
      throw new Error('BGMには音声ファイルを選んでください');
    }
    if (!Number.isFinite(asset.duration) || asset.duration! <= 0) {
      throw new Error('BGMの長さを取得できません');
    }
    const volume = Number.isFinite(config.bgm.volume) ? Math.min(1, Math.max(0, Number(config.bgm.volume))) : 0.5;
    const inTime = Number.isFinite(config.bgm.in) && config.bgm.in! >= 0 ? Number(config.bgm.in) : 0;
    const maxOut = Math.min(asset.duration!, inTime + finalDuration);
    const outTime = Number.isFinite(config.bgm.out) && config.bgm.out! > inTime
      ? Math.min(Number(config.bgm.out), maxOut)
      : maxOut;
    if (outTime <= inTime + 0.001) {
      throw new Error('BGMの範囲が不正です');
    }
    const bgmStart = Number.isFinite(config.bgm.start) && config.bgm.start! >= 0 ? Number(config.bgm.start) : 0;
    if (bgmStart + (outTime - inTime) > finalDuration + 0.001) {
      throw new Error('BGMの再生範囲が動画の長さを超えています');
    }
    bgm = {
      source: asset.relativePath,
      start: bgmStart,
      in: inTime,
      out: outTime,
      volume,
    };
  }

  const background = (config.background ?? '000000').replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(background)) {
    throw new Error('背景色は6桁の16進数で指定してください');
  }

  const timeline: Timeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'video.mp4',
    background: background.toLowerCase(),
    outputPreset: config.outputPreset === 'final' ? 'final' : 'preview',
    clips,
  };

  if (transitionDurations.length > 0) {
    timeline.transitions = transitionDurations.map((d) => ({ type: 'crossfade' as const, duration: d }));
  }

  if (bgm) {
    timeline.bgm = bgm;
  }

  if (config.subtitles && config.subtitles.length > 0) {
    const normalized = config.subtitles.map((s, idx) => {
      const start = Number(s.start);
      const end = Number(s.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error(`字幕 ${idx + 1} の開始・終了時間が不正です`);
      }
      if (end > finalDuration + 0.001) {
        throw new Error(`字幕 ${idx + 1} の終了時間が動画の長さを超えています`);
      }
      const text = String(s.text ?? '');
      if (!text) throw new Error(`字幕 ${idx + 1} のテキストが空です`);
      const hexColor = (value: unknown, fallback: string): string => {
        const str = String(value ?? fallback);
        return /^#?[0-9A-Fa-f]{6}$/.test(str) ? str : fallback;
      };
      return {
        start,
        end,
        text,
        x: Number.isFinite(s.x) ? Number(s.x) : 540,
        y: Number.isFinite(s.y) ? Number(s.y) : 1500,
        fontSize: Number.isFinite(s.fontSize) ? Number(s.fontSize) : 100,
        fontColor: hexColor(s.fontColor, '#FFFFFF'),
        fontAlpha: Number.isFinite(s.fontAlpha) ? Math.max(0, Math.min(1, Number(s.fontAlpha))) : 1,
        borderWidth: Number.isFinite(s.borderWidth) ? Number(s.borderWidth) : 0,
        borderColor: hexColor(s.borderColor, '#000000'),
        box: Boolean(s.box),
        boxColor: hexColor(s.boxColor, '#000000'),
        boxAlpha: Number.isFinite(s.boxAlpha) ? Math.max(0, Math.min(1, Number(s.boxAlpha))) : 0.5,
        align: ['left', 'center', 'right'].includes(s.align as string) ? (s.align as 'left' | 'center' | 'right') : 'left',
        font: s.font ? String(s.font) : undefined,
        fontHash: s.fontHash ? String(s.fontHash) : undefined,
      };
    });
    timeline.subtitles = normalized;
  }

  return timeline;
}

export async function resolveFontForTimeline(
  rootDir: string,
  projectId: string,
  text: string,
  preferredFont?: string,
): Promise<{ font: string; fontFile: string; fontHash: string }> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const fontsDir = resolve(projectRoot, 'fonts');
  await mkdir(fontsDir, { recursive: true });

  const rootFonts = await prepareFonts(rootDir).catch(() => [] as string[]);
  const projectFonts = (await readdir(fontsDir).catch(() => []))
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => resolve(fontsDir, f));
  let candidates = [...projectFonts, ...rootFonts];
  if (candidates.length === 0) {
    throw new Error('字幕を使うには fonts/ に .ttf/.otf フォントを配置してください');
  }

  if (preferredFont) {
    const preferredPath = candidates.find((f) => basename(f) === preferredFont);
    if (!preferredPath) {
      throw new Error(`指定されたフォントが見つかりません: ${preferredFont}`);
    }
    try {
      await verifyFontGlyphs(preferredPath, text);
    } catch {
      throw new Error(`指定されたフォントで字幕テキストを表示できません: ${preferredFont}`);
    }
    const dest = resolve(fontsDir, basename(preferredPath));
    if (preferredPath !== dest) {
      await copyFile(preferredPath, dest);
    }
    const hash = await sha256File(dest);
    return { font: basename(dest), fontFile: dest, fontHash: hash };
  }

  const hasCjk = [...text].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    );
  });

  if (hasCjk) {
    const cjk = candidates
      .filter((f) => /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(basename(f).toLowerCase()))
      .sort((a, b) => basename(a).localeCompare(basename(b)));
    if (cjk.length > 0) candidates = cjk;
  }

  for (const fontFile of candidates) {
    try {
      await verifyFontGlyphs(fontFile, text);
    } catch {
      continue;
    }
    const dest = resolve(fontsDir, basename(fontFile));
    if (fontFile !== dest) {
      await copyFile(fontFile, dest);
    }
    const hash = await sha256File(dest);
    return { font: basename(dest), fontFile: dest, fontHash: hash };
  }

  throw new Error('字幕テキストを表示できるフォントが見つかりません');
}

export async function resolveFontsForTimeline(
  rootDir: string,
  projectId: string,
  timeline: Timeline,
): Promise<void> {
  if (!timeline.subtitles || timeline.subtitles.length === 0) return;
  for (const cue of timeline.subtitles) {
    const resolved = await resolveFontForTimeline(rootDir, projectId, cue.text, cue.font);
    cue.font = resolved.font;
    cue.fontHash = resolved.fontHash;
  }
  timeline.font = timeline.subtitles[0].font;
  timeline.fontHash = timeline.subtitles[0].fontHash;
}

export async function ensureProjectRoot(
  rootDir: string,
  projectId: string,
): Promise<ProjectPaths> {
  const projectRoot = resolveProjectRoot(rootDir, projectId);
  const paths = getProjectPaths(projectRoot);
  await ensureDirs(paths, rootDir);
  return paths;
}

export function getProjectConfigPath(rootDir: string, projectId: string): string {
  return resolve(resolveProjectRoot(rootDir, projectId), 'timeline.json');
}

export const DEFAULT_PROJECT_CONFIG: ProjectTimelineConfig = {
  outputPreset: 'preview',
  background: '000000',
  clips: [],
  crossfade: { enabled: false, duration: 0 },
};

export async function loadProjectConfig(
  rootDir: string,
  projectId: string,
): Promise<ProjectTimelineConfig> {
  await ensureProjectRoot(rootDir, projectId);
  const path = getProjectConfigPath(rootDir, projectId);
  if (!existsSync(path)) return DEFAULT_PROJECT_CONFIG;
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<ProjectTimelineConfig>;
    return {
      ...DEFAULT_PROJECT_CONFIG,
      ...parsed,
      clips: Array.isArray(parsed.clips) ? parsed.clips : [],
      subtitles: Array.isArray(parsed.subtitles) ? parsed.subtitles : undefined,
      crossfade: parsed.crossfade ?? DEFAULT_PROJECT_CONFIG.crossfade,
    };
  } catch {
    return DEFAULT_PROJECT_CONFIG;
  }
}

export async function saveProjectConfig(
  rootDir: string,
  projectId: string,
  config: ProjectTimelineConfig,
): Promise<void> {
  await ensureProjectRoot(rootDir, projectId);
  const path = getProjectConfigPath(rootDir, projectId);
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
}

export async function addProjectClip(
  rootDir: string,
  projectId: string,
  clip: ProjectClipConfig,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  if (config.clips.length >= 5) {
    throw new Error('画像・動画は最大5つまでです');
  }
  config.clips.push(clip);
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}

export async function setProjectClip(
  rootDir: string,
  projectId: string,
  index: number,
  patch: Partial<ProjectClipConfig>,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  if (index < 0 || index >= config.clips.length) {
    throw new Error('クリップが見つかりません');
  }
  config.clips[index] = { ...config.clips[index], ...patch };
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}

export async function splitProjectClip(
  rootDir: string,
  projectId: string,
  index: number,
  splitAt: number,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  if (index < 0 || index >= config.clips.length) {
    throw new Error('クリップが見つかりません');
  }
  const clip = config.clips[index];
  const asset = await getProjectAsset(rootDir, projectId, clip.assetId);
  const sourceIn = Number.isFinite(clip.in) && clip.in! >= 0 ? Number(clip.in) : 0;
  let sourceOut: number;
  if (asset && asset.type === 'image') {
    sourceOut = Number.isFinite(clip.out) && clip.out! > sourceIn ? Number(clip.out) : sourceIn + 5;
  } else {
    sourceOut = Number.isFinite(clip.out) && clip.out! > sourceIn ? Number(clip.out) : (asset?.duration ?? sourceIn + 5);
  }
  if (!Number.isFinite(splitAt) || splitAt <= sourceIn || splitAt >= sourceOut) {
    throw new Error('分割位置がクリップの範囲外です');
  }
  if (config.clips.length >= 5) {
    throw new Error('クリップを分割すると最大5つを超えます');
  }
  const left = { ...clip, out: splitAt };
  const right = { ...clip, in: splitAt };
  config.clips.splice(index, 1, left, right);
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}

export async function moveProjectClip(
  rootDir: string,
  projectId: string,
  index: number,
  newIndex: number,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  if (index < 0 || index >= config.clips.length || newIndex < 0 || newIndex >= config.clips.length) {
    throw new Error('クリップが見つかりません');
  }
  const [removed] = config.clips.splice(index, 1);
  config.clips.splice(newIndex, 0, removed);
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}

export async function removeProjectClip(
  rootDir: string,
  projectId: string,
  index: number,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  if (index < 0 || index >= config.clips.length) {
    throw new Error('クリップが見つかりません');
  }
  config.clips.splice(index, 1);
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}

export async function importTranscriptSubtitles(
  rootDir: string,
  projectId: string,
  transcript: { start: number; end: number; text: string }[],
  config: ProjectTimelineConfig,
): Promise<ProjectSubtitleCue[]> {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    throw new Error('トランスクリプトが空です');
  }

  interface Segment {
    assetId: string;
    sourceIn: number;
    sourceOut: number;
    timelineStart: number;
    timelineEnd: number;
  }

  const segments: Segment[] = [];
  let timelineStart = 0;
  for (let i = 0; i < config.clips.length; i++) {
    const clip = config.clips[i];
    const asset = await getProjectAsset(rootDir, projectId, clip.assetId);
    if (!asset) throw new Error(`クリップ ${i + 1} の素材が見つかりません: ${clip.assetId}`);
    const sourceIn = Number.isFinite(clip.in) && clip.in! >= 0 ? Number(clip.in) : 0;
    let sourceOut: number;
    if (asset.type === 'image') {
      sourceOut = Number.isFinite(clip.out) && clip.out! > sourceIn ? Number(clip.out) : sourceIn + 5;
    } else {
      sourceOut = Number.isFinite(clip.out) && clip.out! > sourceIn ? Number(clip.out) : (asset.duration ?? sourceIn + 5);
    }
    const duration = sourceOut - sourceIn;
    segments.push({
      assetId: clip.assetId,
      sourceIn,
      sourceOut,
      timelineStart,
      timelineEnd: timelineStart + duration,
    });
    timelineStart += duration;
  }

  const cues: ProjectSubtitleCue[] = [];
  for (const entry of transcript) {
    const sourceStart = Number(entry.start);
    const sourceEnd = Number(entry.end);
    const text = String(entry.text ?? '').trim();
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart || !text) continue;

    for (const seg of segments) {
      const overlapStart = Math.max(sourceStart, seg.sourceIn);
      const overlapEnd = Math.min(sourceEnd, seg.sourceOut);
      if (overlapStart < overlapEnd) {
        cues.push({
          start: seg.timelineStart + (overlapStart - seg.sourceIn),
          end: seg.timelineStart + (overlapEnd - seg.sourceIn),
          text,
        });
      }
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

export interface ProjectUsage {
  version: 'v1';
  ranges: Record<string, UsedRange[]>;
}

export interface TrendSuggestion extends ProjectClipConfig {
  score: number;
  reasons: string[];
  unusedFraction: number;
  type?: ProjectAsset['type'];
}

function getUsagePath(rootDir: string, projectId: string): string {
  return resolve(resolveProjectRoot(rootDir, projectId), 'usage.json');
}

function getTrendAnalysisCachePath(rootDir: string, projectId: string): string {
  return resolve(resolveProjectRoot(rootDir, projectId), 'trend-analysis.json');
}

export async function loadProjectUsage(
  rootDir: string,
  projectId: string,
): Promise<ProjectUsage> {
  await ensureProjectRoot(rootDir, projectId);
  const path = getUsagePath(rootDir, projectId);
  if (!existsSync(path)) return { version: 'v1', ranges: {} };
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as ProjectUsage;
    if (parsed?.version !== 'v1') return { version: 'v1', ranges: {} };
    return { version: 'v1', ranges: parsed.ranges ?? {} };
  } catch {
    return { version: 'v1', ranges: {} };
  }
}

export async function recordProjectUsage(
  rootDir: string,
  projectId: string,
  config: ProjectTimelineConfig,
): Promise<void> {
  const usage = await loadProjectUsage(rootDir, projectId);
  for (const clip of config.clips) {
    const asset = await getProjectAsset(rootDir, projectId, clip.assetId);
    if (!asset) continue;
    const start = Number.isFinite(clip.in) && clip.in! >= 0 ? Number(clip.in) : 0;
    let end: number;
    if (asset.type === 'image') {
      end = Number.isFinite(clip.out) && clip.out! > start ? Number(clip.out) : start + 5;
    } else {
      end = Number.isFinite(clip.out) && clip.out! > start ? Number(clip.out) : (asset.duration ?? start + 5);
    }
    if (end <= start) continue;
    if (!usage.ranges[asset.assetId]) usage.ranges[asset.assetId] = [];
    usage.ranges[asset.assetId].push({ start, end });
  }
  await ensureProjectRoot(rootDir, projectId);
  await writeFile(getUsagePath(rootDir, projectId), JSON.stringify(usage, null, 2), 'utf8');
}

interface TrendAnalysisCache {
  version: 'v1';
  analyses: Record<string, { contentHash: string; analysis: MediaAnalysis }>;
}

async function loadTrendAnalysisCache(
  rootDir: string,
  projectId: string,
): Promise<TrendAnalysisCache> {
  const path = getTrendAnalysisCachePath(rootDir, projectId);
  if (!existsSync(path)) return { version: 'v1', analyses: {} };
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as TrendAnalysisCache;
    if (parsed?.version !== 'v1') return { version: 'v1', analyses: {} };
    return { version: 'v1', analyses: parsed.analyses ?? {} };
  } catch {
    return { version: 'v1', analyses: {} };
  }
}

async function saveTrendAnalysisCache(
  rootDir: string,
  projectId: string,
  cache: TrendAnalysisCache,
): Promise<void> {
  await writeFile(getTrendAnalysisCachePath(rootDir, projectId), JSON.stringify(cache, null, 2), 'utf8');
}

export async function getTrendingClipSuggestions(
  rootDir: string,
  projectId: string,
  options?: TrendScorerOptions,
  maxSuggestions = 5,
): Promise<TrendSuggestion[]> {
  await ensureProjectRoot(rootDir, projectId);
  const assets = await listProjectAssets(rootDir, projectId);
  const usage = await loadProjectUsage(rootDir, projectId);
  const cache = await loadTrendAnalysisCache(rootDir, projectId);
  const newCache: TrendAnalysisCache = { version: 'v1', analyses: {} };
  const analyses: Record<string, MediaAnalysis> = {};

  await Promise.all(
    assets.map(async (asset) => {
      if (asset.type === 'image') return;
      const cached = cache.analyses[asset.assetId];
      let analysis: MediaAnalysis;
      if (cached && cached.contentHash === asset.contentHash) {
        analysis = cached.analysis;
      } else {
        const filePath = await resolveAssetFilePath(rootDir, projectId, asset.assetId);
        analysis = await analyzeAsset(filePath, asset.type, asset.duration);
      }
      newCache.analyses[asset.assetId] = { contentHash: asset.contentHash, analysis };
      if (analysis.duration > 0) {
        analyses[asset.assetId] = analysis;
      }
    }),
  );

  await saveTrendAnalysisCache(rootDir, projectId, newCache);

  const suggestions = suggestTrendingClips(analyses, usage.ranges, options, maxSuggestions);
  const assetById = new Map(assets.map((a) => [a.assetId, a]));
  return suggestions.map((s) => ({
    assetId: s.assetId,
    in: s.start,
    out: s.end,
    fit: 'cover' as const,
    score: s.score,
    reasons: s.reasons,
    unusedFraction: s.unusedFraction,
    type: assetById.get(s.assetId)?.type,
  }));
}

function rangesOverlap(ranges: UsedRange[], start: number, end: number): boolean {
  for (const r of ranges) {
    if (start < r.end && r.start < end) return true;
  }
  return false;
}

export async function autofillTimelineWithTrendingClips(
  rootDir: string,
  projectId: string,
  count = 3,
): Promise<ProjectTimelineConfig> {
  const config = await loadProjectConfig(rootDir, projectId);
  const usage = await loadProjectUsage(rootDir, projectId);

  const usedRanges: Record<string, UsedRange[]> = {};
  function getUsed(assetId: string): UsedRange[] {
    if (!usedRanges[assetId]) usedRanges[assetId] = [...(usage.ranges[assetId] ?? [])];
    return usedRanges[assetId];
  }
  for (const clip of config.clips) {
    const asset = await getProjectAsset(rootDir, projectId, clip.assetId);
    const start = Number.isFinite(clip.in) && clip.in! >= 0 ? Number(clip.in) : 0;
    let end: number;
    if (asset?.type === 'image') {
      end = Number.isFinite(clip.out) && clip.out! > start ? Number(clip.out) : start + 5;
    } else {
      end = Number.isFinite(clip.out) && clip.out! > start ? Number(clip.out) : (asset?.duration ?? start + 5);
    }
    if (end > start) getUsed(clip.assetId).push({ start, end });
  }

  const suggestions = await getTrendingClipSuggestions(rootDir, projectId, undefined, 20);
  let added = 0;
  for (const s of suggestions) {
    if (config.clips.length >= 5) break;
    if (s.type === 'audio') continue;
    const sIn = Number(s.in);
    const sOut = Number(s.out);
    if (rangesOverlap(getUsed(s.assetId), sIn, sOut)) continue;
    config.clips.push({ assetId: s.assetId, in: sIn, out: sOut, fit: 'cover' });
    getUsed(s.assetId).push({ start: sIn, end: sOut });
    added++;
    if (added >= count) break;
  }
  await saveProjectConfig(rootDir, projectId, config);
  return config;
}
