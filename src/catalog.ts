import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, rmdir, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { sha256File } from './core.js';
import { generateThumbnail, isInside, ThumbnailInfo } from './thumbnails.js';

const O_RDONLY = constants.O_RDONLY;
const O_WRONLY = constants.O_WRONLY;
const O_CREAT = constants.O_CREAT;
const O_EXCL = constants.O_EXCL;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

const execFileAsync = promisify(execFile);

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'] as const;
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4a'] as const;
export const ALLOWED_EXTENSIONS: readonly string[] = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
];

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;

export interface CatalogOptions {
  catalogRoot?: string;
  concurrency?: number;
  hashFile?: (path: string) => Promise<string>;
  thumbnailDir?: string;
  projectRoot?: string;
  maxThumbnailDimension?: number;
}

function isAllowedExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return ALLOWED_EXTENSIONS.some((e) => e === lower);
}

function getExpectedType(ext: string): 'image' | 'video' | 'audio' | undefined {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.some((e) => e === lower)) return 'image';
  if (VIDEO_EXTENSIONS.some((e) => e === lower)) return 'video';
  if (AUDIO_EXTENSIONS.some((e) => e === lower)) return 'audio';
  return undefined;
}

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

export interface AudioStreamInfo {
  index?: number;
  codec: string;
  sampleRate?: number;
  channels?: number;
}

export interface ProbeResult {
  type: 'image' | 'video' | 'audio';
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  audioStreams: AudioStreamInfo[];
}

export interface CatalogErrorInfo {
  code: string;
  message: string;
}

export interface CatalogEntry {
  id?: string;
  relativePath: string;
  sizeBytes: number;
  mtime: number;
  probe?: ProbeResult;
  thumbnail?: ThumbnailInfo;
  error?: CatalogErrorInfo;
  duplicateOf?: string;
  duplicatePaths?: string[];
}

export interface Catalog {
  catalogRoot: string;
  count: number;
  assets: CatalogEntry[];
}

class CatalogError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_DATA: 'Media data could not be parsed',
  NOT_FOUND: 'Media file not found',
  PERMISSION_DENIED: 'Permission denied while reading media',
  UNSUPPORTED_FORMAT: 'Unsupported media format',
  PROBE_FAILED: 'Media probe failed',
  NO_STREAMS: 'No video or audio streams found',
  EXTENSION_MISMATCH: 'Extension does not match probed media type',
  PROCESS_FAILED: 'Failed to process media file',
  HASH_FAILED: 'Failed to compute content hash',
  OUTPUT_UNDER_INPUT: 'Output path conflicts with input directory',
};

function getErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Unknown error';
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

function parseFrameRate(str: string | undefined): number | undefined {
  if (!str) return undefined;
  if (str.includes('/')) {
    const [num, den] = str.split('/').map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
    return num / den;
  }
  return parseNonNegativeNumber(str);
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

const IMAGE_FORMAT_HINTS = ['png', 'jpeg', 'jpg', 'webp', 'gif', 'image2', 'bmp'];

function isImageFormat(format?: { format_name?: string }): boolean {
  const name = format?.format_name;
  if (!name) return false;
  return IMAGE_FORMAT_HINTS.some((hint) => name.includes(hint));
}

function determineProbeType(
  video: FfprobeStream | undefined,
  audioStreams: FfprobeStream[],
  format?: { duration?: string; format_name?: string },
): 'image' | 'video' | 'audio' | undefined {
  if (video) {
    const hasMultipleFrames = video.nb_frames !== undefined && Number(video.nb_frames) > 1;
    const hasDuration =
      parseDuration(format?.duration) !== undefined ||
      parseDuration(video.duration) !== undefined;
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

async function probeMedia(filePath: string, ext: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const code = classifyFfprobeError(stderr);
    throw new CatalogError(code, getErrorMessage(code));
  }

  const parsed: FfprobeResult = JSON.parse(stdout);
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audioStreams = parsed.streams.filter((s) => s.codec_type === 'audio');
  const type = determineProbeType(video, audioStreams, parsed.format);

  if (type === undefined) {
    throw new CatalogError('NO_STREAMS', getErrorMessage('NO_STREAMS'));
  }

  const expected = getExpectedType(ext);
  if (expected !== undefined && expected !== type) {
    throw new CatalogError('EXTENSION_MISMATCH', getErrorMessage('EXTENSION_MISMATCH'));
  }

  const durationStr = parsed.format?.duration ?? video?.duration ?? audioStreams[0]?.duration;
  const duration = parseDuration(durationStr);

  const mappedAudio: AudioStreamInfo[] = audioStreams
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      sampleRate: parseNonNegativeNumber(s.sample_rate),
      channels: s.channels,
    }));

  const result: ProbeResult = {
    type,
    hasAudio: mappedAudio.length > 0,
    audioStreams: mappedAudio,
  };

  if (video) {
    result.width = video.width;
    result.height = video.height;
    result.videoCodec = video.codec_name;
    const avgFps = parseFrameRate(video.avg_frame_rate);
    const rFps = parseFrameRate(video.r_frame_rate);
    if (avgFps !== undefined && avgFps > 0) {
      result.fps = avgFps;
    } else if (rFps !== undefined && rFps > 0) {
      result.fps = rFps;
    }
  }

  if (duration !== undefined) {
    result.duration = duration;
  }

  if (mappedAudio.length > 0) {
    result.audioCodec = mappedAudio[0].codec;
  }

  return result;
}

async function validateBaseDirectory(inputDir: string): Promise<string> {
  if (inputDir.includes('\0')) {
    throw new Error(`Invalid input directory: ${inputDir}`);
  }
  const resolved = resolve(inputDir);
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink()) {
    throw new Error(`Input directory is a symbolic link: ${inputDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Input path is not a directory: ${inputDir}`);
  }
  const realBase = await realpath(resolved);
  if (!isSubPath(realBase, resolved) || !isSubPath(resolved, realBase)) {
    throw new Error(`Resolved input directory is not under real path: ${inputDir}`);
  }
  return realBase;
}

interface FileInfo {
  path: string;
  stat: Awaited<ReturnType<typeof lstat>>;
}

async function collectFiles(base: string, dir: string): Promise<FileInfo[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: FileInfo[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const entryStat = await lstat(abs);
    if (entryStat.isSymbolicLink()) {
      continue;
    }
    if (entryStat.isDirectory()) {
      files.push(...(await collectFiles(base, abs)));
    } else if (entryStat.isFile()) {
      files.push({ path: abs, stat: entryStat });
    }
  }
  return files;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

function normalizeRelativePath(base: string, filePath: string): string {
  const raw = relative(base, filePath).replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..') || parts.length === 0) {
    throw new Error(`File path escapes base directory: ${filePath}`);
  }
  return parts.join('/');
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

interface ProcessFileOptions {
  base: string;
  hashFile: (path: string) => Promise<string>;
  thumbnailDir?: string;
  projectRoot?: string;
  maxThumbnailDimension?: number;
  thumbnailCache: Map<string, Promise<ThumbnailInfo | undefined>>;
}

async function processFile(
  info: FileInfo & { ext: string },
  options: ProcessFileOptions,
): Promise<CatalogEntry> {
  const { base, hashFile, thumbnailDir, projectRoot, maxThumbnailDimension, thumbnailCache } = options;
  const relativePath = normalizeRelativePath(base, info.path);
  const sizeBytes = Number(info.stat.size);
  const mtime = Math.floor(Number(info.stat.mtimeMs));

  let id: string;
  try {
    id = await hashFile(info.path);
  } catch {
    return {
      relativePath,
      sizeBytes,
      mtime,
      error: { code: 'HASH_FAILED', message: getErrorMessage('HASH_FAILED') },
    };
  }

  try {
    const probe = await probeMedia(info.path, info.ext);
    let thumbnail: ThumbnailInfo | undefined;
    if (thumbnailDir && projectRoot && (probe.type === 'image' || probe.type === 'video')) {
      let promise = thumbnailCache.get(id);
      if (!promise) {
        promise = generateThumbnail({
          inputRoot: base,
          sourceRelativePath: relativePath,
          sourceHash: id,
          sourceType: probe.type,
          sourceDuration: probe.duration,
          thumbnailDir,
          projectRoot,
          maxDimension: maxThumbnailDimension,
        });
        thumbnailCache.set(id, promise);
      }
      thumbnail = await promise;
    }
    return { id, relativePath, sizeBytes, mtime, probe, thumbnail };
  } catch (err) {
    const code = err instanceof CatalogError ? err.code : 'PROCESS_FAILED';
    return { id, relativePath, sizeBytes, mtime, error: { code, message: getErrorMessage(code) } };
  }
}

function assignDuplicateFields(entries: CatalogEntry[]): void {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    if (!entry.id) continue;
    const group = groups.get(entry.id);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.id, [entry]);
    }
  }

  for (const entry of entries) {
    if (!entry.id) continue;
    const group = groups.get(entry.id)!;
    if (entry === group[0]) {
      if (group.length > 1) {
        entry.duplicatePaths = group.slice(1).map((e) => e.relativePath);
      }
    } else {
      entry.duplicateOf = group[0].relativePath;
    }
  }
}

export async function generateCatalog(
  inputDir: string,
  options: CatalogOptions = {},
): Promise<Catalog> {
  const base = await validateBaseDirectory(inputDir);
  const collected = await collectFiles(base, base);

  const allowed = collected
    .map((info) => ({ ...info, ext: extname(info.path) }))
    .filter(({ ext }) => isAllowedExtension(ext));

  const concurrency = validateConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  const hashFile = options.hashFile ?? sha256File;
  const thumbnailCache = new Map<string, Promise<ThumbnailInfo | undefined>>();
  const tasks = allowed.map((info) => () =>
    processFile(info, {
      base,
      hashFile,
      thumbnailDir: options.thumbnailDir,
      projectRoot: options.projectRoot,
      maxThumbnailDimension: options.maxThumbnailDimension,
      thumbnailCache,
    }),
  );
  const entries = await runWithConcurrency(tasks, concurrency);

  entries.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  assignDuplicateFields(entries);

  return {
    catalogRoot: options.catalogRoot ?? basename(base),
    count: entries.length,
    assets: entries,
  };
}

export function resolveOutputPath(projectRoot: string, outputRel: string): string {
  if (isAbsolute(outputRel)) {
    throw new Error(`Absolute paths are not allowed: ${outputRel}`);
  }
  if (outputRel.includes('\0')) {
    throw new Error(`Null bytes are not allowed in path: ${outputRel}`);
  }
  // Windows drive-relative and drive-absolute prefixes (C:catalog.json, C:\foo,
  // C:/foo, C:dir/catalog.json) are not valid output paths even on POSIX hosts.
  if (/^[A-Za-z]:/.test(outputRel)) {
    throw new Error(`Windows drive-relative or drive-absolute paths are not allowed: ${outputRel}`);
  }
  // Reject Windows UNC prefixes as well.
  if (outputRel.startsWith('\\\\')) {
    throw new Error(`UNC paths are not allowed: ${outputRel}`);
  }
  const normalized = outputRel.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    throw new Error(`Path traversal is not allowed: ${outputRel}`);
  }
  if (parts.length === 0) {
    throw new Error(`Invalid output path: ${outputRel}`);
  }
  const fileName = parts[parts.length - 1];
  if (!fileName.toLowerCase().endsWith('.json')) {
    throw new Error('Output path must end with .json');
  }
  return resolve(resolve(projectRoot), 'output', parts.join('/'));
}

export interface WriteJsonAtomicTestHooks {
  beforeTempCreate?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    tempName: string;
    finalName: string;
  }) => Promise<void>;
  beforeRename?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    tempName: string;
    finalName: string;
  }) => Promise<void>;
  afterRename?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
    outputPath: string;
  }) => Promise<void>;
}

export interface WriteJsonAtomicVerify {
  expectedSha256?: string;
  expectedBytes?: Uint8Array;
}

export interface WriteJsonAtomicOptions {
  __testHooks?: WriteJsonAtomicTestHooks;
  verify?: WriteJsonAtomicVerify;
}

function isEEXIST(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

export function fdRelativeBase(fh: FileHandle): string | null {
  const platform = process.platform;
  if (platform === 'linux') {
    return `/proc/self/fd/${fh.fd}`;
  }
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'netbsd' || platform === 'openbsd') {
    return `/dev/fd/${fh.fd}`;
  }
  return null;
}

export async function verifyDirLocation(fh: FileHandle, expected: string, projectRoot: string): Promise<void> {
  const fdStat = await fh.stat();
  if (!fdStat.isDirectory()) {
    throw new Error(`not a directory fd: ${expected}`);
  }
  const pathStat = await lstat(expected).catch(() => null);
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    pathStat.dev !== fdStat.dev ||
    pathStat.ino !== fdStat.ino
  ) {
    throw new Error(`directory location does not match: ${expected}`);
  }
  const real = await realpath(expected).catch(() => null);
  if (!real || !isInside(projectRoot, real)) {
    throw new Error(`directory outside project root: ${expected}`);
  }
}

async function mkdirAt(parentFh: FileHandle, component: string, fallbackPath: string): Promise<boolean> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    try {
      await mkdir(`${base}/${component}`);
      return true;
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      return false;
    }
  }
  // Fallback for platforms without fd-relative paths: create the directory if
  // it does not exist. We cannot reliably detect creation on these platforms,
  // so we report false to avoid deleting a pre-existing directory.
  try {
    await mkdir(resolve(fallbackPath, component), { recursive: true });
  } catch (err) {
    if (!isEEXIST(err)) throw err;
  }
  return false;
}

export async function openAt(
  parentFh: FileHandle,
  component: string,
  flags: number,
  fallbackPath: string,
  projectRoot: string,
  mode?: number,
): Promise<FileHandle> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    if (mode !== undefined) {
      return open(`${base}/${component}`, flags, mode);
    }
    return open(`${base}/${component}`, flags);
  }
  await verifyDirLocation(parentFh, fallbackPath, projectRoot);
  if (mode !== undefined) {
    return open(resolve(fallbackPath, component), flags, mode);
  }
  return open(resolve(fallbackPath, component), flags);
}

async function renameAt(
  parentFh: FileHandle,
  oldName: string,
  newName: string,
  fallbackPath: string,
): Promise<void> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    await rename(`${base}/${oldName}`, `${base}/${newName}`);
  } else {
    await rename(resolve(fallbackPath, oldName), resolve(fallbackPath, newName));
  }
}

async function unlinkAt(parentFh: FileHandle, name: string, fallbackPath: string): Promise<void> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    await unlink(`${base}/${name}`).catch(() => {});
  } else {
    await unlink(resolve(fallbackPath, name)).catch(() => {});
  }
}

async function rmdirAt(parentFh: FileHandle, name: string, fallbackPath: string): Promise<void> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    await rmdir(`${base}/${name}`).catch(() => {});
  } else {
    await rmdir(resolve(fallbackPath, name)).catch(() => {});
  }
}

async function hashFileFromFh(fh: FileHandle): Promise<{ sha256: string; size: number }> {
  const CHUNK = 64 * 1024;
  const hash = createHash('sha256');
  const stat = await fh.stat();
  if (!stat.isFile()) {
    throw new Error('Committed output is not a regular file');
  }
  const fileSize = stat.size;
  const readBuffer = Buffer.alloc(CHUNK);
  let offset = 0;
  while (offset < fileSize) {
    const toRead = Math.min(CHUNK, fileSize - offset);
    const { bytesRead } = await fh.read(readBuffer, 0, toRead, offset);
    if (bytesRead === 0) {
      throw new Error(`Committed output shrank during read: ${offset} of ${fileSize} bytes`);
    }
    hash.update(readBuffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const eofBuf = Buffer.alloc(1);
  const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
  if (eofRead !== 0) {
    throw new Error('Committed output grew during read');
  }
  return { sha256: hash.digest('hex'), size: fileSize };
}

async function verifyFinalContent(
  dirFh: FileHandle,
  fileName: string,
  dirPath: string,
  verify: WriteJsonAtomicVerify,
  projectRoot: string,
): Promise<void> {
  const fh = await openAt(dirFh, fileName, O_RDONLY | O_NOFOLLOW, dirPath, projectRoot);
  try {
    const { sha256, size } = await hashFileFromFh(fh);
    if (verify.expectedSha256 !== undefined && sha256 !== verify.expectedSha256) {
      throw new Error('Committed output SHA-256 does not match expected');
    }
    if (verify.expectedBytes !== undefined) {
      if (size !== verify.expectedBytes.length) {
        throw new Error('Committed output size does not match expected');
      }
      const expectedSha = createHash('sha256').update(verify.expectedBytes).digest('hex');
      if (sha256 !== expectedSha) {
        throw new Error('Committed output bytes do not match expected');
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

export async function writeJsonAtomic(
  data: unknown,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  options?: WriteJsonAtomicOptions,
): Promise<string> {
  const root = resolve(projectRoot);
  // Validate the output path string first. This catches traversal, absolute
  // paths, and non-.json names before any filesystem mutation. The actual
  // write uses a verified directory fd, so this string result is only used for
  // validation and to derive the canonical relative path from projectRoot.
  const safeOutput = resolveOutputPath(projectRoot, outputRel);

  const inputResolved = resolve(inputRoot);
  if (isSubPath(inputResolved, safeOutput)) {
    throw new Error('Output path cannot be inside input directory');
  }

  const relFromRoot = relative(root, safeOutput).replace(/\\/g, '/');
  const parts = relFromRoot.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) {
    throw new Error('Invalid output path');
  }
  const fileName = parts.pop()!;

  const rootFh = await open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  const handles: FileHandle[] = [rootFh];
  let dirFh = rootFh;
  let currentPath = root;
  let tempName = '';
  // Directories newly created by this execution that should be removed on
  // failure. The top-level output/ directory is excluded because it is treated
  // as a shared resource; its name may refer to a replaced or moved inode.
  const createdDirs: { parentFh: FileHandle; component: string; parentPath: string }[] = [];
  try {
    await verifyDirLocation(rootFh, root, root);

    for (let i = 0; i < parts.length; i++) {
      const comp = parts[i];
      const nextPath = resolve(currentPath, comp);
      await verifyDirLocation(dirFh, currentPath, root);
      const created = await mkdirAt(dirFh, comp, currentPath);
      let childFh: FileHandle;
      try {
        childFh = await openAt(dirFh, comp, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, currentPath, root);
        handles.push(childFh);
        await verifyDirLocation(childFh, nextPath, root);
      } catch (err) {
        // Only remove the directory if this execution just created it. Never
        // remove a pre-existing directory (even an empty one) by name.
        if (created) {
          await rmdirAt(dirFh, comp, currentPath);
        }
        throw err;
      }
      if (created && i > 0) {
        createdDirs.push({ parentFh: dirFh, component: comp, parentPath: currentPath });
      }
      dirFh = childFh;
      currentPath = nextPath;
    }

    tempName = `.${fileName}.${randomUUID()}.tmp`;
    await options?.__testHooks?.beforeTempCreate?.({
      dirFh,
      dirPath: currentPath,
      tempName,
      finalName: fileName,
    });
    // Barrier: verify the leaf directory immediately before creating the temp
    // file. If an ancestor was swapped to an external directory/symlink, this
    // rejects before any write.
    await verifyDirLocation(dirFh, currentPath, root);

    const tempFh = await openAt(
      dirFh,
      tempName,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      currentPath,
      root,
      0o600,
    );
    let writeErr: unknown;
    try {
      await tempFh.writeFile(JSON.stringify(data, null, 2) + '\n');
      await tempFh.sync();
    } catch (err) {
      writeErr = err;
    } finally {
      await tempFh.close().catch(() => {});
    }
    if (writeErr) {
      throw writeErr;
    }

    // Barrier: re-verify the directory before the atomic publish. The
    // beforeRename hook runs after this so tests can move the directory inode
    // between the barrier and the actual rename.
    await verifyDirLocation(dirFh, currentPath, root);
    await options?.__testHooks?.beforeRename?.({
      dirFh,
      dirPath: currentPath,
      tempName,
      finalName: fileName,
    });
    // Final barrier right before rename.
    await verifyDirLocation(dirFh, currentPath, root);
    await renameAt(dirFh, tempName, fileName, currentPath);
    const outputPath = resolve(currentPath, fileName);
    await options?.__testHooks?.afterRename?.({
      dirFh,
      dirPath: currentPath,
      finalName: fileName,
      outputPath,
    });

    // Final integrity barrier: verify the directory handle still points to the
    // intended directory, then verify the committed file through that handle
    // (no symlink following) matches the expected deterministic content.
    await verifyDirLocation(dirFh, currentPath, root);
    if (options?.verify) {
      await verifyFinalContent(dirFh, fileName, currentPath, options.verify, root);
    }

    return outputPath;
  } catch (err) {
    if (tempName) {
      await unlinkAt(dirFh, tempName, currentPath).catch(() => {});
    }
    // Roll back only nested directories that this execution newly created.
    // Shared finals, existing directories, and directories moved outside the
    // project root are never removed by mutable name.
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      const { parentFh, component, parentPath } = createdDirs[i];
      await rmdirAt(parentFh, component, parentPath).catch(() => {});
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR') {
      throw new Error(`Output directory is a symbolic link or not a directory`);
    }
    throw err;
  } finally {
    for (const h of handles) {
      await h.close().catch(() => {});
    }
  }
}

export async function writeCatalog(
  catalog: Catalog,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  options?: WriteJsonAtomicOptions,
): Promise<string> {
  return writeJsonAtomic(catalog, projectRoot, outputRel, inputRoot, options);
}
