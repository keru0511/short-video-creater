import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, unlink, writeFile, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveSafePath, sha256File } from './core.js';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './catalog.js';

const execFileAsync = promisify(execFile);

export const PREVIEW_WIDTH = 360;
export const PREVIEW_HEIGHT = 640;
export const WAVE_WIDTH = 1280;
export const WAVE_HEIGHT = 720;
const PREVIEW_BACKGROUND = 'black';
const VIDEO_THUMBNAIL_MAX_TIME = 1.0;
const VIDEO_THUMBNAIL_DEFAULT_TIME = 0.0;

interface FfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
}

interface FfprobeResult {
  streams: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

const ProbeResultSchema = z.object({
  type: z.enum(['image', 'video', 'audio']),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  duration: z.number().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  hasAudio: z.boolean().default(false),
  audioStreams: z.array(z.any()).default([]),
});

const CatalogErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const CatalogEntrySchema = z.object({
  id: z.string().optional(),
  relativePath: z.string().min(1),
  sizeBytes: z.number(),
  mtime: z.number(),
  probe: ProbeResultSchema.optional(),
  error: CatalogErrorSchema.optional(),
  duplicateOf: z.string().optional(),
  duplicatePaths: z.array(z.string()).optional(),
});

const CatalogSchema = z.object({
  catalogRoot: z.string(),
  count: z.number(),
  assets: z.array(CatalogEntrySchema),
});

type ParsedCatalog = z.infer<typeof CatalogSchema>;
type ParsedEntry = ParsedCatalog['assets'][number];

export interface PreviewEntryError {
  code: string;
  message: string;
}

export interface CanonicalPreviewEntry {
  assetId?: string;
  type?: 'image' | 'video' | 'audio';
  relativePath: string;
  relativeOutput?: string;
  outputSha256?: string;
  error?: PreviewEntryError;
}

export interface CanonicalManifest {
  version: number;
  previewRoot: string;
  previews: CanonicalPreviewEntry[];
}

export interface RunPreviewEntry extends CanonicalPreviewEntry {
  diagnostic?: string;
}

export interface PreviewManifest {
  version: number;
  catalogPath: string;
  assetRoot: string;
  previewRoot: string;
  canonicalPath: string;
  canonicalSha256: string;
  runPath: string;
  ffmpegVersion: string;
  generatedAt: string;
  summary: { total: number; succeeded: number; failed: number };
  previews: RunPreviewEntry[];
}

export interface PreviewOptions {
  projectRoot?: string;
  concurrency?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  CATALOG_INVALID: 'Catalog JSON is invalid or does not match expected schema',
  CATALOG_NOT_FOUND: 'Catalog file not found',
  CATALOG_SYMLINK: 'Catalog path is a symbolic link',
  CATALOG_OUTPUT_OVERLAP: 'Catalog path overlaps with preview output directory',
  CATALOG_ERROR: 'Catalog entry contains an invalid error',
  INVALID_DATA: 'Invalid media data',
  MISSING_ID: 'Asset ID is missing',
  PATH_TRAVERSAL: 'Relative path escapes asset root',
  ABSOLUTE_PATH: 'Absolute paths are not allowed',
  NULL_BYTE_PATH: 'Null bytes are not allowed in path',
  CONTROL_CHARACTERS: 'Path contains control characters',
  SYMLINK_ESCAPE: 'Symbolic link escape detected',
  PROJECT_ROOT_INVALID: 'Project root is not a safe directory',
  PREVIEW_DIR_SYMLINK: 'Preview output directory contains a symbolic link',
  OUTPUT_INPUT_OVERLAP: 'Preview output directory overlaps with asset root',
  INVALID_PATH: 'Invalid path',
  NOT_FOUND: 'Media file not found',
  PERMISSION_DENIED: 'Permission denied while reading media',
  UNSUPPORTED_FORMAT: 'Unsupported media format',
  PROBE_FAILED: 'Media probe failed',
  NO_STREAMS: 'No video or audio streams found',
  TYPE_MISMATCH: 'Catalog type does not match actual media type',
  EXTENSION_MISMATCH: 'Extension does not match probed media type or is not allowed',
  PROCESS_FAILED: 'Failed to process media file',
  INVALID_PREVIEW: 'Generated preview does not match expected PNG dimensions or codec',
  PREVIEW_PROBE_FAILED: 'Failed to probe generated preview',
  HASH_FAILED: 'Failed to compute content hash',
  SOURCE_MODIFIED: 'Source file was modified during preview generation',
  OUTPUT_FAILED: 'Failed to write preview output',
};

function getErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Unknown error';
}

const CATALOG_ERROR_ALLOWLIST = new Set<string>([
  'INVALID_DATA',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'UNSUPPORTED_FORMAT',
  'PROBE_FAILED',
  'NO_STREAMS',
  'EXTENSION_MISMATCH',
  'PROCESS_FAILED',
  'HASH_FAILED',
  'OUTPUT_UNDER_INPUT',
]);

function normalizeCatalogError(
  error: { code: string; message: string },
  diagnostic?: string,
): { error: PreviewEntryError; diagnostic?: string } {
  if (CATALOG_ERROR_ALLOWLIST.has(error.code)) {
    return { error: { code: error.code, message: getErrorMessage(error.code) } };
  }
  return {
    error: { code: 'CATALOG_ERROR', message: getErrorMessage('CATALOG_ERROR') },
    diagnostic: diagnostic ?? `${error.code}: ${error.message}`,
  };
}

function validateConcurrency(value: unknown): number {
  const num = Number(value);
  if (
    !Number.isFinite(num) ||
    !Number.isInteger(num) ||
    num < 1 ||
    num > MAX_CONCURRENCY
  ) {
    throw new Error(
      `concurrency must be an integer between 1 and ${MAX_CONCURRENCY}, got ${String(value)}`,
    );
  }
  return num;
}

function isSubPath(base: string, target: string): boolean {
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  const targetWithSep = target.endsWith(sep) ? target : target + sep;
  return targetWithSep === baseWithSep || targetWithSep.startsWith(baseWithSep);
}

function parseNonNegativeNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    const [h, m, s] = parts;
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return undefined;
    return h * 3600 + m * 60 + s;
  }
  return parseNonNegativeNumber(value);
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'] as const;
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4a'] as const;
const ALLOWED_EXTENSIONS: readonly string[] = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
];

const IMAGE_FORMAT_HINTS = ['png', 'jpeg', 'jpg', 'webp', 'gif', 'image2', 'bmp'];

function isImageFormat(format?: { format_name?: string }): boolean {
  const name = format?.format_name;
  if (!name) return false;
  return IMAGE_FORMAT_HINTS.some((hint) => name.includes(hint));
}

function getExpectedType(ext: string): 'image' | 'video' | 'audio' | undefined {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.some((e) => e === lower)) return 'image';
  if (VIDEO_EXTENSIONS.some((e) => e === lower)) return 'video';
  if (AUDIO_EXTENSIONS.some((e) => e === lower)) return 'audio';
  return undefined;
}

function determineActualType(
  video: FfprobeStream | undefined,
  audioStreams: FfprobeStream[],
  format?: { duration?: string; format_name?: string },
): 'image' | 'video' | 'audio' | undefined {
  if (video) {
    const nbFrames = video.nb_frames !== undefined ? Number(video.nb_frames) : undefined;
    const hasMultipleFrames = nbFrames !== undefined && nbFrames > 1;
    const hasDuration =
      parseDuration(format?.duration) !== undefined || parseDuration(video.duration) !== undefined;
    if (
      audioStreams.length === 0 &&
      !hasDuration &&
      !hasMultipleFrames &&
      isImageFormat(format)
    ) {
      return 'image';
    }
    return 'video';
  }
  if (audioStreams.length > 0) {
    return 'audio';
  }
  return undefined;
}

function classifyFfprobeError(stderr: string): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('invalid data found when processing input')) return 'INVALID_DATA';
  if (lower.includes('no such file or directory')) return 'NOT_FOUND';
  if (lower.includes('permission denied')) return 'PERMISSION_DENIED';
  if (lower.includes('unknown format') || lower.includes('unsupported format')) {
    return 'UNSUPPORTED_FORMAT';
  }
  return 'PROBE_FAILED';
}

function classifyFfmpegError(stderr: string): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('no such file or directory')) return 'NOT_FOUND';
  if (lower.includes('invalid data found when processing input')) return 'INVALID_DATA';
  if (lower.includes('permission denied')) return 'PERMISSION_DENIED';
  if (lower.includes('unknown format') || lower.includes('unsupported format')) {
    return 'UNSUPPORTED_FORMAT';
  }
  if (lower.includes('matches no streams')) return 'NO_STREAMS';
  return 'PROCESS_FAILED';
}

function classifyResolveError(message: string): string {
  if (message.includes('Null bytes')) return 'NULL_BYTE_PATH';
  if (message.includes('Absolute')) return 'ABSOLUTE_PATH';
  if (message.includes('traversal') || message.includes('escapes')) return 'PATH_TRAVERSAL';
  if (message.includes('Symbolic') || message.includes('symbolic')) return 'SYMLINK_ESCAPE';
  if (message.includes('not found') || message.includes('File not found')) return 'NOT_FOUND';
  return 'INVALID_PATH';
}

async function getFfmpegVersion(ffmpegPath = 'ffmpeg'): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-version']);
    const first = stdout.split('\n')[0] ?? '';
    const match = first.match(/^ffmpeg version\s+(.+?)(?:\s+Copyright|\s|$)/i);
    return match?.[1]?.trim() || first.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new PreviewError('PREVIEW_DIR_SYMLINK', `Preview output path is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new PreviewError(
      'PROJECT_ROOT_INVALID',
      `Preview output path is not a directory: ${path}`,
    );
  }
}

async function createPreviewDir(previewDir: string): Promise<void> {
  const outputDir = dirname(previewDir);
  await assertDirectoryNotSymlink(outputDir);
  await mkdir(outputDir, { recursive: true });
  await assertDirectoryNotSymlink(previewDir);
  await mkdir(previewDir, { recursive: true });
}

async function resolveProjectRoot(input: string): Promise<string> {
  if (input.includes('\0')) {
    throw new PreviewError('PROJECT_ROOT_INVALID', 'Null bytes are not allowed in project root');
  }
  const resolved = resolve(input);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(resolved);
  } catch {
    throw new PreviewError('PROJECT_ROOT_INVALID', `Project root does not exist: ${input}`);
  }
  if (stats.isSymbolicLink()) {
    throw new PreviewError('PROJECT_ROOT_INVALID', `Project root is a symbolic link: ${input}`);
  }
  if (!stats.isDirectory()) {
    throw new PreviewError('PROJECT_ROOT_INVALID', `Project root is not a directory: ${input}`);
  }
  const realRoot = await realpath(resolved);
  if (!isSubPath(realRoot, resolved) || !isSubPath(resolved, realRoot)) {
    throw new PreviewError('PROJECT_ROOT_INVALID', `Project root contains a symbolic link: ${input}`);
  }
  return realRoot;
}

async function validateAssetRoot(input: string, previewDir: string): Promise<string> {
  if (input.includes('\0')) {
    throw new PreviewError('NULL_BYTE_PATH', getErrorMessage('NULL_BYTE_PATH'));
  }
  const resolved = resolve(input);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(resolved);
  } catch {
    throw new PreviewError('NOT_FOUND', `Asset root does not exist: ${input}`);
  }
  if (stats.isSymbolicLink()) {
    throw new PreviewError('SYMLINK_ESCAPE', `Asset root is a symbolic link: ${input}`);
  }
  if (!stats.isDirectory()) {
    throw new PreviewError('NOT_FOUND', `Asset root is not a directory: ${input}`);
  }
  const realBase = await realpath(resolved);
  if (!isSubPath(realBase, resolved) || !isSubPath(resolved, realBase)) {
    throw new PreviewError('SYMLINK_ESCAPE', `Asset root contains a symbolic link: ${input}`);
  }
  if (isSubPath(realBase, previewDir) || isSubPath(previewDir, realBase)) {
    throw new PreviewError(
      'OUTPUT_INPUT_OVERLAP',
      `Asset root overlaps with preview output directory: ${input}`,
    );
  }
  return realBase;
}

function resolveAssetPath(realBase: string, relPath: string): string {
  if (relPath.includes('\0')) {
    throw new PreviewError('NULL_BYTE_PATH', getErrorMessage('NULL_BYTE_PATH'));
  }
  if (/[\x00-\x1F\x7F]/.test(relPath)) {
    throw new PreviewError('CONTROL_CHARACTERS', getErrorMessage('CONTROL_CHARACTERS'));
  }
  if (isAbsolute(relPath)) {
    throw new PreviewError('ABSOLUTE_PATH', getErrorMessage('ABSOLUTE_PATH'));
  }
  try {
    return resolveSafePath(realBase, relPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = classifyResolveError(message);
    throw new PreviewError(code, getErrorMessage(code), message);
  }
}

async function rejectSymlinkAncestors(resolvedPath: string): Promise<void> {
  let current = '/';
  const parts = resolvedPath.split(sep).filter((p) => p.length > 0);
  for (const part of parts) {
    current = resolve(current, part);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new PreviewError(
        'CATALOG_SYMLINK',
        `Catalog path contains a symbolic link ancestor: ${current}`,
      );
    }
  }
}

async function validateCatalogPath(input: string, previewDir: string): Promise<string> {
  if (input.includes('\0')) {
    throw new PreviewError('CATALOG_INVALID', 'Null bytes are not allowed in catalog path');
  }
  const resolved = resolve(input);

  await rejectSymlinkAncestors(resolved);

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(resolved);
  } catch {
    throw new PreviewError('CATALOG_NOT_FOUND', `Catalog file not found: ${input}`);
  }
  if (stats.isSymbolicLink()) {
    throw new PreviewError('CATALOG_SYMLINK', `Catalog path is a symbolic link: ${input}`);
  }
  if (!stats.isFile()) {
    throw new PreviewError('CATALOG_NOT_FOUND', `Catalog path is not a file: ${input}`);
  }

  let realDir: string;
  try {
    realDir = await realpath(dirname(resolved));
  } catch {
    realDir = dirname(resolved);
  }
  const realCatalogPath = resolve(realDir, basename(resolved));

  if (isSubPath(previewDir, realCatalogPath) || isSubPath(realCatalogPath, previewDir)) {
    throw new PreviewError(
      'CATALOG_OUTPUT_OVERLAP',
      `Catalog path overlaps with preview output directory: ${input}`,
    );
  }
  return resolved;
}

async function probeActualType(
  filePath: string,
  ffprobePath: string,
): Promise<'image' | 'video' | 'audio'> {
  let stdout: string;
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      filePath,
    ]));
  } catch (err) {
    const errStderr = (err as { stderr?: string }).stderr ?? stderr;
    const code = classifyFfprobeError(errStderr);
    throw new PreviewError(code, getErrorMessage(code), errStderr.trim() || undefined);
  }

  const parsed: FfprobeResult = JSON.parse(stdout);
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audioStreams = parsed.streams.filter((s) => s.codec_type === 'audio');
  const type = determineActualType(video, audioStreams, parsed.format);

  if (type === undefined) {
    throw new PreviewError('NO_STREAMS', getErrorMessage('NO_STREAMS'));
  }
  return type;
}

async function validatePreviewOutput(
  outputPath: string,
  type: 'image' | 'video' | 'audio',
  ffprobePath: string,
): Promise<void> {
  let stdout: string;
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height',
      '-of',
      'json',
      outputPath,
    ]));
  } catch (err) {
    const errStderr = (err as { stderr?: string }).stderr ?? stderr;
    throw new PreviewError(
      'PREVIEW_PROBE_FAILED',
      getErrorMessage('PREVIEW_PROBE_FAILED'),
      errStderr.trim() || undefined,
    );
  }

  const parsed = JSON.parse(stdout) as {
    streams: Array<{ codec_name?: string; width?: number; height?: number }>;
  };
  const stream = parsed.streams[0];
  if (!stream || stream.codec_name !== 'png') {
    throw new PreviewError(
      'INVALID_PREVIEW',
      getErrorMessage('INVALID_PREVIEW'),
      `expected codec png, got ${stream?.codec_name ?? 'none'}`,
    );
  }

  const expectedWidth = type === 'audio' ? WAVE_WIDTH : PREVIEW_WIDTH;
  const expectedHeight = type === 'audio' ? WAVE_HEIGHT : PREVIEW_HEIGHT;
  if (stream.width !== expectedWidth || stream.height !== expectedHeight) {
    throw new PreviewError(
      'INVALID_PREVIEW',
      getErrorMessage('INVALID_PREVIEW'),
      `expected ${expectedWidth}x${expectedHeight}, got ${stream.width}x${stream.height}`,
    );
  }
}

class PreviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnostic?: string,
  ) {
    super(message);
  }
}

function buildImagePreviewArgs(
  input: string,
  output: string,
  ffmpegPath = 'ffmpeg',
): string[] {
  const filter = `scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:${PREVIEW_BACKGROUND},format=rgba`;
  return [ffmpegPath, '-y', '-i', input, '-vf', filter, '-frames:v', '1', '-c:v', 'png', output];
}

function buildVideoPreviewArgs(
  input: string,
  duration: number | undefined,
  output: string,
  ffmpegPath = 'ffmpeg',
): string[] {
  let time: number;
  if (duration !== undefined && duration > 0) {
    time = Math.min(VIDEO_THUMBNAIL_MAX_TIME, duration / 2);
    if (time >= duration) {
      time = Math.max(0, duration / 2);
    }
  } else {
    time = VIDEO_THUMBNAIL_DEFAULT_TIME;
  }
  const filter = `scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:${PREVIEW_BACKGROUND},format=rgba`;
  return [
    ffmpegPath,
    '-y',
    '-ss',
    String(time),
    '-i',
    input,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    output,
  ];
}

function buildAudioPreviewArgs(
  input: string,
  output: string,
  ffmpegPath = 'ffmpeg',
): string[] {
  const filter = `aformat=channel_layouts=mono,showwavespic=s=${WAVE_WIDTH}x${WAVE_HEIGHT}:colors=#00ff00`;
  return [
    ffmpegPath,
    '-y',
    '-i',
    input,
    '-filter_complex',
    filter,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    output,
  ];
}

async function runFfmpeg(args: string[]): Promise<void> {
  const [command, ...commandArgs] = args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(
        new PreviewError('PROCESS_FAILED', getErrorMessage('PROCESS_FAILED'), String(err)),
      );
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        const errorCode = classifyFfmpegError(stderr);
        reject(
          new PreviewError(
            errorCode,
            getErrorMessage(errorCode),
            stderr.trim() || undefined,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function previewFileName(id: string, type: 'image' | 'video' | 'audio'): string {
  return `${id}-${type}.png`;
}

interface InternalPreviewEntry {
  assetId?: string;
  type?: 'image' | 'video' | 'audio';
  relativePath: string;
  relativeOutput?: string;
  outputSha256?: string;
  error?: PreviewEntryError;
  diagnostic?: string;
}

interface PreviewResult {
  relativeOutput: string;
  outputSha256: string;
}

interface SharedOutputQueueItem {
  produce: () => Promise<PreviewResult>;
  resolve: (value: PreviewResult) => void;
  reject: (reason: unknown) => void;
}

interface SharedOutputState {
  success?: Promise<PreviewResult>;
  queue: SharedOutputQueueItem[];
  running: boolean;
}

function toCanonical(entry: InternalPreviewEntry): CanonicalPreviewEntry {
  const result: CanonicalPreviewEntry = { relativePath: entry.relativePath };
  if (entry.assetId !== undefined) result.assetId = entry.assetId;
  if (entry.type !== undefined) result.type = entry.type;
  if (entry.relativeOutput !== undefined) result.relativeOutput = entry.relativeOutput;
  if (entry.outputSha256 !== undefined) result.outputSha256 = entry.outputSha256;
  if (entry.error !== undefined) result.error = entry.error;
  return result;
}

function toRun(entry: InternalPreviewEntry): RunPreviewEntry {
  const result: RunPreviewEntry = { relativePath: entry.relativePath };
  if (entry.assetId !== undefined) result.assetId = entry.assetId;
  if (entry.type !== undefined) result.type = entry.type;
  if (entry.relativeOutput !== undefined) result.relativeOutput = entry.relativeOutput;
  if (entry.outputSha256 !== undefined) result.outputSha256 = entry.outputSha256;
  if (entry.error !== undefined) result.error = entry.error;
  if (entry.diagnostic !== undefined) result.diagnostic = entry.diagnostic;
  return result;
}

const MAX_DIAGNOSTIC_LENGTH = 1024;

function sanitizeDiagnostic(raw: string, masks: Array<[string, string]>): string {
  let sanitized = raw.replace(/[\x00\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const sorted = [...masks].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, label] of sorted) {
    sanitized = sanitized.split(prefix).join(label);
  }
  if (sanitized.length > MAX_DIAGNOSTIC_LENGTH) {
    sanitized = sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH) + '... [truncated]';
  }
  return sanitized;
}

async function getVideoDuration(filePath: string, ffprobePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-show_format',
      '-of',
      'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    return parseDuration(parsed.format?.duration);
  } catch {
    return undefined;
  }
}

async function producePreview(
  outputName: string,
  filePath: string,
  actualType: 'image' | 'video' | 'audio',
  beforeHash: string,
  previewDir: string,
  options: Required<Pick<PreviewOptions, 'ffmpegPath' | 'ffprobePath'>>,
): Promise<PreviewResult> {
  const outputPath = resolve(previewDir, outputName);
  const tempPath = `${outputPath}.${randomUUID()}.png`;

  try {
    let duration: number | undefined;
    if (actualType === 'video') {
      duration = await getVideoDuration(filePath, options.ffprobePath);
    }
    const args =
      actualType === 'image'
        ? buildImagePreviewArgs(filePath, tempPath, options.ffmpegPath)
        : actualType === 'video'
          ? buildVideoPreviewArgs(filePath, duration, tempPath, options.ffmpegPath)
          : buildAudioPreviewArgs(filePath, tempPath, options.ffmpegPath);
    await runFfmpeg(args);
    await validatePreviewOutput(tempPath, actualType, options.ffprobePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    const code = err instanceof PreviewError ? err.code : 'PROCESS_FAILED';
    const message = err instanceof PreviewError ? err.message : getErrorMessage('PROCESS_FAILED');
    const diagnostic = err instanceof PreviewError ? err.diagnostic : String(err);
    throw new PreviewError(code, message, diagnostic);
  }

  let afterHash: string;
  try {
    afterHash = await sha256File(filePath);
  } catch {
    await unlink(tempPath).catch(() => {});
    throw new PreviewError('HASH_FAILED', getErrorMessage('HASH_FAILED'));
  }
  if (afterHash !== beforeHash) {
    await unlink(tempPath).catch(() => {});
    throw new PreviewError('SOURCE_MODIFIED', getErrorMessage('SOURCE_MODIFIED'), 'source file was modified during preview generation');
  }

  let outputSha256: string;
  try {
    outputSha256 = await sha256File(tempPath);
  } catch {
    await unlink(tempPath).catch(() => {});
    throw new PreviewError('OUTPUT_FAILED', getErrorMessage('OUTPUT_FAILED'));
  }

  try {
    await rename(tempPath, outputPath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw new PreviewError(
      'OUTPUT_FAILED',
      getErrorMessage('OUTPUT_FAILED'),
      err instanceof Error ? err.message : String(err),
    );
  }

  return { relativeOutput: outputName, outputSha256 };
}

async function processAsset(
  entry: ParsedEntry,
  realBase: string,
  previewDir: string,
  options: Required<Pick<PreviewOptions, 'ffmpegPath' | 'ffprobePath'>>,
  getSharedOutput: (outputName: string, produce: () => Promise<PreviewResult>) => Promise<PreviewResult>,
): Promise<InternalPreviewEntry> {
  const base: InternalPreviewEntry = {
    assetId: entry.id,
    type: entry.probe?.type,
    relativePath: entry.relativePath,
  };

  let filePath: string;
  try {
    filePath = resolveAssetPath(realBase, entry.relativePath);
  } catch (err) {
    const code = err instanceof PreviewError ? err.code : 'INVALID_PATH';
    const message = err instanceof PreviewError ? err.message : getErrorMessage('INVALID_PATH');
    return { ...base, relativePath: '<invalid path>', error: { code, message } };
  }

  if (entry.error) {
    const normalized = normalizeCatalogError(entry.error);
    return { ...base, error: normalized.error, diagnostic: normalized.diagnostic };
  }

  if (!entry.id) {
    return { ...base, error: { code: 'MISSING_ID', message: getErrorMessage('MISSING_ID') } };
  }

  let actualType: 'image' | 'video' | 'audio';
  try {
    actualType = await probeActualType(filePath, options.ffprobePath);
  } catch (err) {
    const code = err instanceof PreviewError ? err.code : 'PROBE_FAILED';
    const message = err instanceof PreviewError ? err.message : getErrorMessage('PROBE_FAILED');
    const diagnostic = err instanceof PreviewError ? err.diagnostic : String(err);
    return { ...base, error: { code, message }, diagnostic };
  }

  const expectedType = getExpectedType(extname(entry.relativePath));
  if (expectedType === undefined || expectedType !== actualType) {
    return {
      ...base,
      type: actualType,
      error: { code: 'EXTENSION_MISMATCH', message: getErrorMessage('EXTENSION_MISMATCH') },
      diagnostic:
        expectedType === undefined
          ? `extension ${extname(entry.relativePath)} is not allowed`
          : `expected ${expectedType}, got ${actualType}`,
    };
  }

  if (entry.probe?.type && entry.probe.type !== actualType) {
    return {
      ...base,
      type: actualType,
      error: { code: 'TYPE_MISMATCH', message: getErrorMessage('TYPE_MISMATCH') },
      diagnostic: `catalog type ${entry.probe.type}, actual type ${actualType}`,
    };
  }

  let beforeHash: string;
  try {
    beforeHash = await sha256File(filePath);
  } catch {
    return { ...base, type: actualType, error: { code: 'HASH_FAILED', message: getErrorMessage('HASH_FAILED') } };
  }
  if (beforeHash !== entry.id) {
    return {
      ...base,
      type: actualType,
      error: { code: 'HASH_FAILED', message: getErrorMessage('HASH_FAILED') },
      diagnostic: 'source hash does not match catalog ID',
    };
  }

  const outputName = previewFileName(entry.id, actualType);
  let result: PreviewResult;
  try {
    result = await getSharedOutput(outputName, () =>
      producePreview(outputName, filePath, actualType, beforeHash, previewDir, options),
    );
  } catch (err) {
    const code = err instanceof PreviewError ? err.code : 'PROCESS_FAILED';
    const message = err instanceof PreviewError ? err.message : getErrorMessage('PROCESS_FAILED');
    const diagnostic = err instanceof PreviewError ? err.diagnostic : String(err);
    return { ...base, type: actualType, error: { code, message }, diagnostic };
  }

  return {
    ...base,
    type: actualType,
    relativeOutput: result.relativeOutput,
    outputSha256: result.outputSha256,
  };
}

async function writeAtomicFile(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, filePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function generateMediaPreviews(
  catalogPath: string,
  assetRoot: string,
  options: PreviewOptions = {},
): Promise<PreviewManifest> {
  if (catalogPath.includes('\0') || assetRoot.includes('\0')) {
    throw new PreviewError('NULL_BYTE_PATH', getErrorMessage('NULL_BYTE_PATH'));
  }

  const projectRoot = await resolveProjectRoot(options.projectRoot ?? process.cwd());
  const previewDir = resolve(projectRoot, 'output', 'previews');

  const realBase = await validateAssetRoot(assetRoot, previewDir);
  const resolvedCatalogPath = await validateCatalogPath(catalogPath, previewDir);

  await createPreviewDir(previewDir);

  const catalogRaw = JSON.parse(await readFile(resolvedCatalogPath, 'utf8'));
  const catalog = CatalogSchema.parse(catalogRaw);

  const concurrency = validateConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';

  const ffmpegVersion = await getFfmpegVersion(ffmpegPath);

  const sharedOutputs = new Map<string, SharedOutputState>();
  function getSharedOutput(
    outputName: string,
    produce: () => Promise<PreviewResult>,
  ): Promise<PreviewResult> {
    let state = sharedOutputs.get(outputName);
    if (!state) {
      state = { queue: [], running: false };
      sharedOutputs.set(outputName, state);
    }
    if (state.success) {
      return state.success;
    }
    return new Promise((resolve, reject) => {
      state!.queue.push({ produce, resolve, reject });
      runSharedQueue(state!);
    });
  }

  async function runSharedQueue(state: SharedOutputState): Promise<void> {
    if (state.running) return;
    state.running = true;
    while (state.queue.length > 0) {
      if (state.success) {
        const next = state.queue.shift()!;
        next.resolve(await state.success);
        continue;
      }
      const current = state.queue.shift()!;
      try {
        const result = await current.produce();
        state.success = Promise.resolve(result);
        current.resolve(result);
      } catch (err) {
        current.reject(err);
        // allow the next queued duplicate source to try
      }
    }
    state.running = false;
  }

  const tasks = catalog.assets.map(
    (entry) => () => processAsset(entry, realBase, previewDir, { ffmpegPath, ffprobePath }, getSharedOutput),
  );
  const entries = await runWithConcurrency(tasks, concurrency);

  const canonicalPreviews = entries.map(toCanonical).sort((a, b) => {
    const aId = a.assetId ?? '';
    const bId = b.assetId ?? '';
    if (aId !== bId) return aId.localeCompare(bId);
    return a.relativePath.localeCompare(b.relativePath);
  });

  const canonicalManifest: CanonicalManifest = {
    version: 1,
    previewRoot: posixRelative(projectRoot, previewDir),
    previews: canonicalPreviews,
  };

  const canonicalPath = resolve(previewDir, 'manifest.json');
  const runPath = resolve(previewDir, 'run.json');

  await writeAtomicFile(canonicalPath, JSON.stringify(canonicalManifest, null, 2) + '\n');
  const canonicalSha256 = await sha256File(canonicalPath);

  const diagnosticMasks: Array<[string, string]> = [
    [projectRoot, '<projectRoot>'],
    [realBase, '<assetRoot>'],
    [resolvedCatalogPath, '<catalogPath>'],
    [dirname(resolvedCatalogPath), '<catalogDir>'],
  ];

  const runManifest: PreviewManifest = {
    version: 1,
    catalogPath: resolvedCatalogPath,
    assetRoot: realBase,
    previewRoot: posixRelative(projectRoot, previewDir),
    canonicalPath: posixRelative(projectRoot, canonicalPath),
    canonicalSha256,
    runPath: posixRelative(projectRoot, runPath),
    ffmpegVersion,
    generatedAt: new Date().toISOString(),
    summary: {
      total: entries.length,
      succeeded: entries.filter((e) => !e.error).length,
      failed: entries.filter((e) => e.error).length,
    },
    previews: entries.map((e) => {
      const runEntry = toRun(e);
      if (runEntry.diagnostic !== undefined) {
        runEntry.diagnostic = sanitizeDiagnostic(runEntry.diagnostic, diagnosticMasks);
      }
      return runEntry;
    }),
  };

  await writeAtomicFile(runPath, JSON.stringify(runManifest, null, 2) + '\n');

  return runManifest;
}
