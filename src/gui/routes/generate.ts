import { randomUUID } from 'node:crypto';
import { cp, rm, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generate, ffprobe, type Timeline, type Clip, type Bgm } from '../../core.js';
import {
  ensureTrustedDirectory,
  getErrorMessage,
  getOutputSnapshotPath,
  maskErrorMessage,
  prepareJobAssetDir,
  writeAuditManifest,
  type AuditAssetEntry,
  type AuditSource,
} from '../../audit.js';
import { type SubtitleCue, withSubtitleDefaults } from '../../subtitles.js';
import { toUserMessage } from '../../user-error.js';
import { fontsDir, guiDir, outputDir, root } from '../paths.js';
import { checkOrigin, json, sendError } from '../utils/response.js';
import {
  getMaxFileBytes,
  getMaxRequestBytes,
  getMaxTotalFiles,
  parseMultipart,
  type MultipartFileInfo,
} from '../middleware/multipart.js';
import {
  classifyFile,
  makeUploadedAssetName,
  sanitizeFilename,
  uploadedFileRole,
} from '../utils/filename.js';
import { resolveFontForText } from '../utils/fonts.js';

export interface UploadedFile {
  name: string;
  originalName: string;
  savedName: string;
  savedPath: string;
  type: 'image' | 'video' | 'audio' | 'unknown';
}

export interface GenerateConfig {
  outputPreset?: 'preview' | 'final';
  background?: string;
  clips: Array<{ duration?: number; in?: number; out?: number; fit?: 'cover' | 'contain'; x?: number; y?: number; scale?: number }>;
  bgm?: { volume?: number; start?: number; in?: number; out?: number };
  subtitles?: Array<{
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
  }>;
  crossfade?: { enabled?: boolean; duration?: number };
}

export async function getMediaDuration(filePath: string): Promise<number> {
  const probe = await ffprobe(filePath);
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new Error(`ファイルの長さを取得できません: ${filePath}`);
  }
  return probe.duration;
}

function validateHexColor(color: string): string {
  if (!/^[0-9A-Fa-f]{6}$/.test(color)) {
    throw new Error('背景色は6桁の16進数で指定してください');
  }
  return color.toLowerCase();
}

async function buildTimeline(
  config: GenerateConfig,
  files: Map<string, UploadedFile>,
): Promise<Timeline> {
  if (!Array.isArray(config.clips) || config.clips.length === 0) {
    throw new Error('画像・動画クリップを1つ以上追加してください');
  }
  if (config.clips.length > 5) {
    throw new Error('画像・動画は最大5つまでです');
  }

  const visualSources: Array<{
    source: string;
    type: 'image' | 'video';
    duration: number;
    sourceIn: number;
    sourceOut: number;
    fit: 'cover' | 'contain';
    x: number;
    y: number;
    scale: number;
  }> = [];
  for (let i = 0; i < config.clips.length; i++) {
    const up = files.get(`clip-${i}`);
    if (!up) {
      throw new Error(`クリップ ${i + 1} のファイルが見つかりません`);
    }
    if (up.type !== 'image' && up.type !== 'video') {
      throw new Error(`${up.originalName} は画像・動画ファイルではありません`);
    }
    const clipCfg = config.clips[i];
    const sourceIn = Number.isFinite(clipCfg.in) ? Math.max(0, Number(clipCfg.in)) : 0;
    let sourceOut: number;
    if (Number.isFinite(clipCfg.out)) {
      sourceOut = Number(clipCfg.out);
    } else if (Number.isFinite(clipCfg.duration)) {
      sourceOut = sourceIn + Number(clipCfg.duration);
    } else {
      throw new Error(`クリップ ${i + 1} の out または duration を指定してください`);
    }
    if (!Number.isFinite(sourceOut) || sourceOut <= sourceIn + 0.001) {
      throw new Error(`クリップ ${i + 1} の終了位置が不正です`);
    }
    const duration = sourceOut - sourceIn;
    const x = Number.isFinite(clipCfg.x) ? Number(clipCfg.x) : 0;
    const y = Number.isFinite(clipCfg.y) ? Number(clipCfg.y) : 0;
    const scale = Number.isFinite(clipCfg.scale) && Number(clipCfg.scale) > 0 ? Number(clipCfg.scale) : 1;
    const fit = clipCfg.fit === 'contain' ? 'contain' : 'cover';
    visualSources.push({ source: up.savedName, type: up.type, duration, sourceIn, sourceOut, fit, x, y, scale });
  }

  const baseDuration = visualSources.reduce((sum, v) => sum + v.duration, 0);
  const transitionDurations: number[] = [];
  if (config.crossfade?.enabled && visualSources.length > 1) {
    const duration = Number(config.crossfade.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('クロスフェード秒数が不正です');
    }
    for (let i = 0; i < visualSources.length - 1; i++) {
      transitionDurations.push(duration);
    }
  }
  const totalTransition = transitionDurations.reduce((sum, d) => sum + d, 0);
  const finalDuration = baseDuration - totalTransition;
  if (finalDuration <= 0) {
    throw new Error('最終的な動画時間が0秒以下になります。クリップ秒数を長くしてください');
  }

  const clips: Clip[] = [];
  let start = 0;
  for (const vs of visualSources) {
    clips.push({
      type: vs.type,
      source: vs.source,
      start,
      end: start + vs.duration,
      in: vs.sourceIn,
      out: vs.sourceOut,
      fit: vs.fit,
      x: vs.x,
      y: vs.y,
      scale: vs.scale,
    } as Clip);
    start += vs.duration;
  }

  const mainAudio = files.get('mainAudio');
  if (mainAudio) {
    if (mainAudio.type !== 'audio') {
      throw new Error('主音声には音声ファイルを選んでください');
    }
    const audioDuration = await getMediaDuration(mainAudio.savedPath);
    if (audioDuration < finalDuration - 0.001) {
      throw new Error(
        `主音声(${audioDuration.toFixed(2)}秒)が動画の長さ(${finalDuration.toFixed(2)}秒)より短いです`,
      );
    }
    clips.push({
      type: 'audio',
      source: mainAudio.savedName,
      start: 0,
      end: finalDuration,
      in: 0,
      out: finalDuration,
      fit: 'cover',
      x: 0,
      y: 0,
    } as Clip);
  }

  const bgmFile = files.get('bgm');
  let bgm: Bgm | undefined;
  if (bgmFile) {
    if (bgmFile.type !== 'audio') {
      throw new Error('BGMには音声ファイルを選んでください');
    }
    const bgmDuration = await getMediaDuration(bgmFile.savedPath);
    const volume = Number.isFinite(config.bgm?.volume) ? Math.min(1, Math.max(0, Number(config.bgm!.volume))) : 0.5;
    const bgmIn = Number.isFinite(config.bgm?.in) ? Number(config.bgm!.in) : 0;
    const bgmOutRaw = Number.isFinite(config.bgm?.out) ? Number(config.bgm!.out) : Math.min(bgmDuration, finalDuration);
    const bgmOut = Math.min(Math.max(bgmOutRaw, bgmIn + 0.001), bgmDuration);
    const bgmStart = Number.isFinite(config.bgm?.start) ? Number(config.bgm!.start) : 0;
    if (bgmStart + (bgmOut - bgmIn) > finalDuration + 0.001) {
      throw new Error('BGMの再生範囲が動画の長さを超えています');
    }
    bgm = {
      source: bgmFile.savedName,
      start: bgmStart,
      in: bgmIn,
      out: bgmOut,
      volume,
    };
  }

  const background = validateHexColor(config.background ?? '000000');
  const timeline: Timeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'video.mp4',
    background,
    outputPreset: config.outputPreset === 'final' ? 'final' : 'preview',
    clips,
  };

  if (bgm) {
    timeline.bgm = bgm;
  }

  if (config.subtitles && config.subtitles.length > 0) {
    const hexColor = (value: unknown, fallback: string): string => {
      const str = String(value ?? fallback);
      return /^#?[0-9A-Fa-f]{6}$/.test(str) ? str : fallback;
    };
    const normalized: SubtitleCue[] = [];
    for (let idx = 0; idx < config.subtitles.length; idx++) {
      const s = config.subtitles[idx];
      const start = Number(s.start);
      const end = Number(s.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error(`字幕 ${idx + 1} の開始・終了時間が不正です`);
      }
      const text = String(s.text ?? '');
      if (!text) {
        throw new Error(`字幕 ${idx + 1} のテキストが空です`);
      }
      const cue = withSubtitleDefaults({
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
        box: s.box === true,
        boxColor: hexColor(s.boxColor, '#000000'),
        boxAlpha: Number.isFinite(s.boxAlpha) ? Math.max(0, Math.min(1, Number(s.boxAlpha))) : 0.5,
        align: ['left', 'center', 'right'].includes(s.align as string) ? (s.align as 'left' | 'center' | 'right') : 'left',
        font: s.font,
      });
      const resolved = await resolveFontForText(text, s.font);
      cue.font = resolved.font;
      cue.fontHash = resolved.fontHash;
      normalized.push(cue);
    }
    timeline.subtitles = normalized;
  }

  if (transitionDurations.length > 0) {
    timeline.transitions = transitionDurations.map((d) => ({ type: 'crossfade' as const, duration: d }));
  }

  return timeline;
}

export async function writeUploadedFiles(
  files: MultipartFileInfo[],
  targetDir: string,
  rootDir: string,
): Promise<Map<string, UploadedFile>> {
  if (files.length > getMaxTotalFiles()) {
    throw new Error(`ファイルは最大 ${getMaxTotalFiles()} 個までです`);
  }
  let totalBytes = 0;
  const maxRequestBytes = getMaxRequestBytes();
  for (const f of files) {
    if (f.data.length > getMaxFileBytes()) {
      throw new Error(`ファイル ${f.filename} が大きすぎます`);
    }
    totalBytes += f.data.length;
    if (totalBytes > maxRequestBytes) {
      throw new Error('合計ファイルサイズが大きすぎます');
    }
  }

  await prepareJobAssetDir(targetDir, rootDir);

  const map = new Map<string, UploadedFile>();
  const written: string[] = [];
  const counters: Record<string, number> = { visual: 0, audio: 0, bgm: 0 };
  try {
    for (const f of files) {
      const type = classifyFile(f.filename);
      const role = uploadedFileRole(f.name, type);
      const safe = sanitizeFilename(f.filename);
      const savedName = makeUploadedAssetName(role, extname(safe), counters);
      const savedPath = resolve(targetDir, savedName);
      await writeFile(savedPath, f.data);
      written.push(savedPath);
      map.set(f.name, {
        name: f.name,
        originalName: f.filename,
        savedName,
        savedPath,
        type,
      });
    }
  } catch (err) {
    for (const p of written) {
      await rm(p, { force: true }).catch(() => {});
    }
    throw err;
  }
  return map;
}

export async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkOrigin(req, res)) return;

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const assetsDir = resolve(guiDir, 'output', 'assets', jobId);
  const artifactDir = resolve(guiDir, 'output', 'artifacts', jobId);
  let uploaded: Map<string, UploadedFile> | undefined;
  let config: GenerateConfig | undefined;
  let timeline: Timeline | undefined;
  let assetMap: AuditAssetEntry[] = [];

  async function writeFailureManifest(err: unknown): Promise<string | null> {
    const finishedAt = new Date().toISOString();
    try {
      return await writeAuditManifest({
        jobId,
        source: 'GUI' as AuditSource,
        startedAt,
        finishedAt,
        rootDir: root,
        outputDir,
        fixturesDir: assetsDir,
        fontsDir: assetsDir,
        timeline: (timeline ?? config) as (Timeline | Record<string, unknown>) | undefined,
        assetMap,
        error: err,
      });
    } catch (auditErr) {
      console.error('監査ログの書き込みに失敗しました:', auditErr);
      return null;
    }
  }

  function sendFailureResponse(res: ServerResponse, err: unknown, manifestPath: string | null): void {
    if (manifestPath === null) {
      json(res, 500, { ok: false, error: '監査ログの書き込みに失敗しました', auditJobId: jobId, auditManifestPath: null });
    } else {
      json(res, 400, { ok: false, error: maskErrorMessage(toUserMessage(err), root), auditJobId: jobId, auditManifestPath: manifestPath });
    }
  }

  try {
    const { fields, files } = await parseMultipart(req, res);
    const configRaw = fields['config'];
    if (!configRaw) {
      const err = new Error('設定（config）が送られていません');
      const manifestPath = await writeFailureManifest(err);
      if (!res.headersSent) {
        sendFailureResponse(res, err, manifestPath);
      }
      return;
    }

    try {
      config = JSON.parse(configRaw) as GenerateConfig;
    } catch (parseErr) {
      const err = parseErr instanceof Error ? parseErr : new Error('設定のJSONが不正です');
      const manifestPath = await writeFailureManifest(err);
      if (!res.headersSent) {
        sendFailureResponse(res, err, manifestPath);
      }
      return;
    }

    try {
      await prepareJobAssetDir(artifactDir, root);
      uploaded = await writeUploadedFiles(files, assetsDir, root);
    } catch (uploadErr) {
      const message = getErrorMessage(uploadErr);
      const isValidation = message.includes('ファイル') || message.includes('合計') || message.includes('大きすぎ');
      const manifestPath = await writeFailureManifest(uploadErr);
      if (!res.headersSent) {
        if (isValidation) {
          sendFailureResponse(res, uploadErr, manifestPath);
        } else {
          json(res, 500, { ok: false, error: 'Internal server error', auditJobId: jobId, auditManifestPath: manifestPath });
        }
      }
      return;
    }
    for (const up of uploaded.values()) {
      const role = uploadedFileRole(up.name, up.type);
      assetMap.push({
        role,
        originalSource: up.originalName,
        assetName: up.savedName,
        absPath: up.savedPath,
      });
    }

    timeline = await buildTimeline(config, uploaded);
    timeline.outputPath = 'video.mp4';

    if (timeline.font && timeline.fontHash) {
      const originalFontPath = resolve(fontsDir, timeline.font);
      const fontExt = extname(timeline.font) || '.ttf';
      const assetFontName = `asset-font-global${fontExt}`;
      const assetFontPath = resolve(assetsDir, assetFontName);
      await cp(originalFontPath, assetFontPath, { preserveTimestamps: true });
      timeline.font = assetFontName;
      assetMap.push({
        role: 'font',
        originalSource: basename(originalFontPath),
        assetName: assetFontName,
        absPath: assetFontPath,
        hash: timeline.fontHash,
      });
    }

    if (timeline.subtitles && timeline.subtitles.length > 0) {
      for (let i = 0; i < timeline.subtitles.length; i++) {
        const cue = timeline.subtitles[i];
        if (!cue.font || !cue.fontHash) continue;
        const originalFontPath = resolve(fontsDir, cue.font);
        const fontExt = extname(cue.font) || '.ttf';
        const assetFontName = `asset-font-${i}${fontExt}`;
        const assetFontPath = resolve(assetsDir, assetFontName);
        await cp(originalFontPath, assetFontPath, { preserveTimestamps: true });
        cue.font = assetFontName;
      }
    }

    await ensureTrustedDirectory(outputDir, root, true);
    const result = await generate(timeline, { rootDir: root, fixturesDir: assetsDir, outputDir: artifactDir, fontsDir: assetsDir });

    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'GUI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir: assetsDir,
      fontsDir: assetsDir,
      result,
      assetMap,
    });

    const snapshotPath = getOutputSnapshotPath(outputDir, jobId, result.outputPath);
    const outputUrlPath = relative(outputDir, snapshotPath).replace(/\\/g, '/');

    json(res, 200, {
      ok: true,
      outputUrl: `/api/output/${encodeURIComponent(outputUrlPath)}`,
      outputPath: outputUrlPath,
      auditJobId: jobId,
      auditManifestPath: manifestPath,
      timelineHash: result.timelineHash,
      sourceHashes: result.sourceHashes,
      probe: result.probe,
      outputPreset: result.outputPreset,
      effectiveEncoding: result.effectiveEncoding,
      ffmpegVersion: result.ffmpegVersion,
    });
  } catch (err) {
    const manifestPath = await writeFailureManifest(err);
    if (!res.headersSent) {
      sendFailureResponse(res, err, manifestPath);
    }
  }
}
