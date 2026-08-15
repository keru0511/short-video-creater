import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, ffprobe, type Timeline, type Clip, type Bgm } from '../core.js';
import { ensureTrustedDirectory, getErrorMessage, getOutputSnapshotPath, maskErrorMessage, prepareJobAssetDir, writeAuditManifest, type AuditAssetEntry, type AuditSource } from '../audit.js';
import { type SubtitleCue, verifyFontGlyphs, withSubtitleDefaults } from '../subtitles.js';
import { resolveSafePath, sha256File } from '../utils.js';
import { toUserMessage } from '../user-error.js';
import { prepareFonts } from '../fixtures.js';
import {
  autofillTimelineWithTrendingClips,
  buildProjectTimeline,
  getProjectAsset,
  getProjectPaths,
  getTrendingClipSuggestions,
  importTranscriptSubtitles,
  listProjectAssets,
  loadProjectConfig,
  recordProjectUsage,
  resolveAssetFilePath,
  resolveFontsForTimeline,
  resolveProjectRoot,
  saveProjectAsset,
  saveProjectConfig,
  type ProjectTimelineConfig,
} from './project.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const guiDir = resolve(root, 'gui');
const fixturesDir = resolve(guiDir, 'fixtures');
const outputDir = resolve(guiDir, 'output');
const fontsDir = resolve(root, 'fonts');
const indexHtmlPath = resolve(root, 'src', 'gui', 'index.html');

// Runtime allowlist set when the server starts. Host/Origin are fixed to the
// bound loopback address so DNS rebinding cannot be used to bypass CSRF checks.
let serverPort = 0;
const allowedOrigins = new Set<string>();
const allowedHosts = new Set<string>();

function refreshAllowedOrigins(port: number): void {
  serverPort = port;
  allowedOrigins.clear();
  allowedHosts.clear();
  allowedOrigins.add(`http://127.0.0.1:${port}`);
  allowedOrigins.add(`http://localhost:${port}`);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.wma', '.oga']);

function getMaxRequestBytes(): number {
  return Number(process.env.GUI_MAX_REQUEST_BYTES) || 100 * 1024 * 1024;
}
function getMaxFileBytes(): number {
  return Number(process.env.GUI_MAX_FILE_BYTES) || 50 * 1024 * 1024;
}
function getMaxTotalFiles(): number {
  return Number(process.env.GUI_MAX_TOTAL_FILES) || 10;
}

interface UploadedFile {
  name: string;
  originalName: string;
  savedName: string;
  savedPath: string;
  type: 'image' | 'video' | 'audio' | 'unknown';
}

interface GenerateConfig {
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

export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return base || 'file';
}

function getContentType(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function classifyFile(filename: string): UploadedFile['type'] {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unknown';
}

function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  afterEnd?: () => void,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body, afterEnd);
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  afterEnd?: () => void,
): void {
  if (res.headersSent) {
    if (afterEnd) afterEnd();
    return;
  }
  json(res, status, { ok: false, error: message }, afterEnd);
}

class RequestTooLargeError extends Error {}

function readLimitedBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      sendError(res, 413, 'リクエストサイズが大きすぎます', () => {
        req.socket?.destroy();
      });
      reject(new RequestTooLargeError('Content-Length exceeded'));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAbort);
    }

    function onData(chunk: Buffer) {
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        sendError(res, 413, 'リクエストサイズが大きすぎます', () => {
          req.socket?.destroy();
        });
        cleanup();
        reject(new RequestTooLargeError('request body too large'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onAbort() {
      cleanup();
      reject(new Error('リクエストが中断されました'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

function checkHost(req: IncomingMessage, res: ServerResponse): boolean {
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(host)) {
    sendError(res, 403, '許可されていない host です');
    return false;
  }
  return true;
}

function checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!checkHost(req, res)) return false;
  const origin = req.headers.origin;
  if (origin) {
    if (allowedOrigins.has(origin)) return true;
    sendError(res, 403, '許可されていない origin です');
    return false;
  }
  const referer = req.headers.referer;
  if (referer) {
    for (const o of allowedOrigins) {
      if (referer.startsWith(`${o}/`)) return true;
    }
  }
  sendError(res, 403, 'Origin または Referer が必要です');
  return false;
}

function getBoundary(contentType: string): string | undefined {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const b = (match?.[1] ?? match?.[2])?.trim();
  return b;
}

interface MultipartFileInfo {
  name: string;
  filename: string;
  data: Buffer;
}

function parseMultipartBody(body: Buffer, boundary: string): { fields: Record<string, string>; files: MultipartFileInfo[] } {
  const fields: Record<string, string> = {};
  const files: MultipartFileInfo[] = [];
  const token = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (true) {
    const i = body.indexOf(token, cursor);
    if (i === -1) {
      parts.push(body.subarray(cursor));
      break;
    }
    parts.push(body.subarray(cursor, i));
    cursor = i + token.length;
  }

  for (let idx = 1; idx < parts.length - 1; idx++) {
    const part = parts[idx];
    let dataStart = 0;
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) {
      dataStart = 2;
    }
    const sep = Buffer.from('\r\n\r\n');
    const headerEnd = part.indexOf(sep, dataStart);
    if (headerEnd === -1) continue;

    const headers = part.subarray(dataStart, headerEnd).toString('utf8');
    let data = part.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }

    const dispLine = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:')) || '';
    const params = dispLine.split(';').slice(1).map((s) => s.trim());
    let name: string | undefined;
    let filename: string | undefined;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      let value = param.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (key === 'name') name = value;
      if (key === 'filename') filename = value;
    }
    if (!name) continue;

    if (filename) {
      files.push({ name, filename, data });
    } else {
      fields[name] = data.toString('utf8');
    }
  }

  return { fields, files };
}

async function parseMultipart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ fields: Record<string, string>; files: MultipartFileInfo[] }> {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data 形式でリクエストを送信してください');
  }
  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw new Error('リクエストの boundary が見つかりません');
  }
  const body = await readLimitedBody(req, res, getMaxRequestBytes());
  return parseMultipartBody(body, boundary);
}

function uploadedFileRole(name: string, type: UploadedFile['type']): 'visual' | 'audio' | 'bgm' {
  if (name === 'bgm') return 'bgm';
  if (name === 'mainAudio') return 'audio';
  if (name.startsWith('clip-')) return 'visual';
  if (type === 'image' || type === 'video') return 'visual';
  if (type === 'audio') return 'audio';
  return 'visual';
}

function makeUploadedAssetName(role: 'visual' | 'audio' | 'bgm', ext: string, counters: Record<string, number>): string {
  const index = counters[role] ?? 0;
  counters[role] = index + 1;
  const e = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `asset-${role}-${index}${e}`;
}

async function writeUploadedFiles(
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

async function getMediaDuration(filePath: string): Promise<number> {
  const probe = await ffprobe(filePath);
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new Error(`ファイルの長さを取得できません: ${filePath}`);
  }
  return probe.duration;
}

async function listAvailableFonts(): Promise<string[]> {
  return (await readdir(fontsDir))
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower.endsWith('.ttf') || lower.endsWith('.otf');
    })
    .map((f) => resolve(fontsDir, f));
}

async function resolveFontForText(
  text: string,
  preferredFont?: string,
): Promise<{ font: string; fontFile: string; fontHash: string }> {
  if (!existsSync(fontsDir)) {
    await mkdir(fontsDir, { recursive: true });
  }

  let files = await listAvailableFonts();

  if (files.length === 0) {
    try {
      await prepareFonts(root);
      files = await listAvailableFonts();
    } catch {
      throw new Error(
        '字幕を使うには fonts/ に .ttf/.otf フォントを配置するか、npm run setup:fonts を実行してください。',
      );
    }
  }

  if (files.length === 0) {
    throw new Error('字幕を使うには fonts/ に .ttf/.otf フォントを配置してください。');
  }

  if (preferredFont) {
    const preferredPath = files.find((f) => basename(f) === preferredFont);
    if (!preferredPath) {
      throw new Error(`指定されたフォントが見つかりません: ${preferredFont}`);
    }
    const hash = await sha256File(preferredPath);
    try {
      await verifyFontGlyphs(preferredPath, text);
    } catch (err) {
      throw new Error(`指定されたフォントで字幕テキストを表示できません: ${preferredFont}`);
    }
    return { font: basename(preferredPath), fontFile: preferredPath, fontHash: hash };
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

  files = files.sort((a, b) => {
    const aName = basename(a).toLowerCase();
    const bName = basename(b).toLowerCase();
    const aCjk = /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(aName) ? 1 : 0;
    const bCjk = /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(bName) ? 1 : 0;
    return bCjk - aCjk;
  });
  if (hasCjk) {
    const cjkFonts = files.filter((f) => /ipa|gothic|mincho|noto|cjk|jpn|japanese/.test(basename(f).toLowerCase()));
    if (cjkFonts.length > 0) files = cjkFonts;
  }

  for (const fontFile of files) {
    try {
      const hash = await sha256File(fontFile);
      await verifyFontGlyphs(fontFile, text);
      return { font: basename(fontFile), fontFile, fontHash: hash };
    } catch {
      continue;
    }
  }
  throw new Error('字幕テキストを表示できるフォントが見つかりません');
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

async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

async function serveOutputFile(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  try {
    const filePath = resolveSafePath(outputDir, name);
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendError(res, 404, 'リクエストされたコンテンツが見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getContentType(name),
      'Content-Length': info.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

function getOpenCommand(platform: string): string {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

async function handleOpenOutput(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkOrigin(req, res)) return;
  const command = getOpenCommand(process.platform);
  const child = spawn(command, [outputDir], { detached: true, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (c) => resolve(c));
    child.on('close', (c) => resolve(c));
  });
  child.unref();
  if (code !== null && code !== 0) {
    sendError(res, 500, `出力フォルダを開けませんでした（終了コード ${code}）`);
    return;
  }
  json(res, 200, { opened: true });
}

interface ProjectRoute {
  projectId: string;
  remainder: string;
}

const PROJECT_PATH_RE = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/;

function matchProjectRoute(pathname: string): ProjectRoute | undefined {
  const m = pathname.match(PROJECT_PATH_RE);
  if (!m) return undefined;
  return { projectId: m[1], remainder: m[2] ?? '' };
}

async function handleProjectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: ProjectRoute,
): Promise<void> {
  const { projectId, remainder } = route;
  const segments = remainder.split('/').filter(Boolean);

  if (req.method === 'POST' && segments.length === 1 && segments[0] === 'assets') {
    await handleProjectUploadAsset(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'assets') {
    await handleProjectListAssets(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'assets') {
    await handleProjectGetAsset(req, res, projectId, segments[1]);
    return;
  }

  if (req.method === 'GET' && segments.length === 3 && segments[0] === 'assets' && segments[2] === 'source') {
    await handleProjectSourceFile(req, res, projectId, segments[1]);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'previews') {
    await handleProjectPreview(req, res, projectId, segments[1]);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'config') {
    await handleProjectGetTimeline(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'save') {
    await handleProjectSaveTimeline(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'generate') {
    await handleProjectGenerate(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'subtitles') {
    await handleProjectTranscriptSubtitles(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'clips' && segments[1] === 'suggest') {
    await handleProjectSuggestClips(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'autofill') {
    await handleProjectAutofill(req, res, projectId);
    return;
  }

  res.writeHead(404);
  res.end('リクエストされたコンテンツが見つかりません');
}

async function handleProjectUploadAsset(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const { files } = await parseMultipart(req, res);
    const file = files.find((f) => f.name === 'file');
    if (!file) {
      sendError(res, 400, 'file フィールドが必要です');
      return;
    }
    if (file.data.length > getMaxFileBytes()) {
      sendError(res, 413, `ファイルサイズが大きすぎます`);
      return;
    }
    const asset = await saveProjectAsset(root, projectId, file.filename, file.data);
    json(res, 200, { ok: true, asset });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectListAssets(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const assets = await listProjectAssets(root, projectId);
    json(res, 200, { ok: true, assets });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectGetAsset(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  assetId: string,
): Promise<void> {
  try {
    const asset = await getProjectAsset(root, projectId, assetId);
    if (!asset) {
      sendError(res, 404, '素材が見つかりません');
      return;
    }
    json(res, 200, { ok: true, asset });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectSourceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  assetId: string,
): Promise<void> {
  try {
    const filePath = await resolveAssetFilePath(root, projectId, assetId);
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendError(res, 404, 'ファイルが見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Content-Length': String(info.size),
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    sendError(res, 404, toUserMessage(err));
  }
}

async function handleProjectGetTimeline(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const config = await loadProjectConfig(root, projectId);
    json(res, 200, { ok: true, config });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectSaveTimeline(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const config = JSON.parse(raw.toString('utf8')) as ProjectTimelineConfig;
    await saveProjectConfig(root, projectId, config);
    json(res, 200, { ok: true });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectPreview(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  filename: string,
): Promise<void> {
  try {
    const projectRoot = resolveProjectRoot(root, projectId);
    const previewPath = resolveSafePath(resolve(projectRoot, 'previews'), filename);
    const info = await stat(previewPath);
    if (!info.isFile()) {
      sendError(res, 404, 'リクエストされたコンテンツが見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getContentType(previewPath),
      'Content-Length': info.size,
    });
    createReadStream(previewPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

async function handleProjectGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  let timeline: Timeline | undefined;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const config = JSON.parse(raw.toString('utf8')) as ProjectTimelineConfig;
    await saveProjectConfig(root, projectId, config);
    timeline = await buildProjectTimeline(root, projectId, config);

    if (timeline.subtitles && timeline.subtitles.length > 0) {
      await resolveFontsForTimeline(root, projectId, timeline);
    }

    const projectRoot = resolveProjectRoot(root, projectId);
    const paths = getProjectPaths(projectRoot);
    const artifactDir = resolve(guiDir, 'output', 'artifacts', jobId);
    await prepareJobAssetDir(artifactDir, root);

    const result = await generate(timeline, {
      rootDir: projectRoot,
      fixturesDir: paths.inputDir,
      outputDir: artifactDir,
      fontsDir: resolve(projectRoot, 'fonts'),
    });

    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'GUI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir: paths.inputDir,
      fontsDir: resolve(projectRoot, 'fonts'),
      result,
    });

    const snapshotPath = getOutputSnapshotPath(outputDir, jobId, result.outputPath);
    const outputUrlPath = relative(outputDir, snapshotPath).replace(/\\/g, '/');

    await recordProjectUsage(root, projectId, config);

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
    if (!res.headersSent) {
      sendError(res, 400, toUserMessage(err));
    }
  }
}

async function handleProjectSuggestClips(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const suggestions = await getTrendingClipSuggestions(root, projectId);
    json(res, 200, { ok: true, suggestions });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectAutofill(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(_req, res)) return;
  try {
    const config = await autofillTimelineWithTrendingClips(root, projectId);
    json(res, 200, { ok: true, config });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectTranscriptSubtitles(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const payload = JSON.parse(raw.toString('utf8')) as { transcript: { start: number; end: number; text: string }[]; config: ProjectTimelineConfig };
    const cues = await importTranscriptSubtitles(root, projectId, payload.transcript, payload.config);
    json(res, 200, { ok: true, cues });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(indexHtmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkHost(req, res)) return;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveIndex(res);
      return;
    }

    const projectRoute = matchProjectRoute(pathname);
    if (projectRoute) {
      await handleProjectRoute(req, res, projectRoute);
      return;
    }

    if (pathname.startsWith('/api/projects/')) {
      const m = pathname.match(/^\/api\/projects\/([^/]+)/);
      if (m && !/^[a-zA-Z0-9_-]+$/.test(m[1])) {
        sendError(res, 400, 'プロジェクトIDには半角英数字、ハイフン、アンダースコアのみ使用できます');
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/api/generate') {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/fonts') {
      const fonts = (await listAvailableFonts()).map((f) => basename(f));
      json(res, 200, { ok: true, fonts });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/output/')) {
      const name = decodeURIComponent(pathname.slice('/api/output/'.length));
      await serveOutputFile(req, res, name);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/open-output') {
      await handleOpenOutput(req, res);
      return;
    }

    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  } catch (err) {
    console.error('リクエスト処理エラー:', err);
    if (!res.headersSent) {
      sendError(res, 500, toUserMessage(err));
    }
  }
}

export function startServer(port = 0): Promise<{ server: ReturnType<typeof createServer>; port: number; url: string; stop: () => Promise<void> }> {
  const server = createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const p = typeof address === 'object' && address ? address.port : port;
      refreshAllowedOrigins(p);
      resolve({
        server,
        port: p,
        url: `http://127.0.0.1:${p}`,
        stop: () => new Promise((res) => server.close((err) => res(err ? undefined : undefined))),
      });
    });
  });
}

async function main(): Promise<void> {
  const { url } = await startServer(Number(process.env.GUI_PORT ?? 0));
  console.log(`ローカルGUI: ${url}`);
}

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
