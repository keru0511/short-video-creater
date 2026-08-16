import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, link, mkdir, open, readlink, realpath, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path, { relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';
import { resolveSafePath } from './core.js';

const O_RDONLY = constants.O_RDONLY;
const O_WRONLY = constants.O_WRONLY;
const O_CREAT = constants.O_CREAT;
const O_EXCL = constants.O_EXCL;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

export const DEFAULT_THUMBNAIL_MAX_DIMENSION = 480;
export const MAX_THUMBNAIL_DIMENSION = 8192;
export const THUMBNAIL_SCHEMA_VERSION = 'v1';

// Hard upper bound on source bytes. Larger inputs are rejected before consumption.
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// Sources at or below this size are read into a bounded Buffer before FFmpeg.
// Sources above this limit are streamed so memory usage stays bounded.
export const SOURCE_BUFFER_LIMIT = 16 * 1024 * 1024; // 16 MiB

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_THUMBNAIL_VERIFY_BYTES = DEFAULT_MAX_OUTPUT_BYTES;
const SOURCE_STREAM_CHUNK = 64 * 1024; // 64 KiB

export interface ThumbnailInfo {
  identifier: string;
  sha256: string;
  width: number;
  height: number;
}

interface TestHooks {
  afterThumbnailDirValidation?: (ctx: { thumbnailDir: string }) => Promise<void>;
  beforeChildDirCreation?: (ctx: { parentDir: string; component: string }) => Promise<void>;
  beforeSourceRead?: (ctx: { sourcePath: string; sourceSize: number; sourceFd: number }) => Promise<void>;
  afterSourceReadChunk?: (ctx: { sourcePath: string; bytesRead: number; total: number }) => Promise<void>;
  beforeFfmpeg?: (ctx: { sourcePath: string; finalPath: string }) => Promise<void>;
  beforeFinalWrite?: (ctx: { finalPath: string; expectedSha: string }) => Promise<void>;
  afterTempCreate?: (ctx: { tempPath: string; tempFd: number }) => Promise<void>;
  beforePublishLink?: (ctx: { thumbnailDir: string; finalName: string; finalPath: string }) => Promise<void>;
  afterFinalOpen?: (ctx: { finalPath: string; finalFd: number; expectedSha: string }) => Promise<void>;
  afterFinalHash?: (ctx: { finalPath: string; finalFd: number; expectedSha: string; hash: string }) => Promise<void>;
  maxSourceBytes?: number;
  sourceBufferLimit?: number;
  maxOutputBytes?: number;
  maxStderrBytes?: number;
}

interface VerifyThumbnailTestHooks {
  beforeRead?: (ctx: { finalPath: string; finalFd: number; expectedSha: string }) => Promise<void>;
  afterRead?: (ctx: { finalPath: string; finalFd: number; expectedSha: string; hash: string }) => Promise<void>;
}

export interface ThumbnailOptions {
  inputRoot: string;
  sourceRelativePath: string;
  sourceHash: string;
  sourceType: 'image' | 'video';
  sourceDuration?: number;
  thumbnailDir: string;
  projectRoot: string;
  maxDimension?: number;
  __testHooks?: TestHooks;
}

interface FfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeResult {
  streams: FfprobeStream[];
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isInside(base: string, target: string, pathImpl: typeof path = path): boolean {
  const baseResolved = pathImpl.resolve(base);
  const targetResolved = pathImpl.resolve(target);
  if (baseResolved === targetResolved) {
    return true;
  }
  const sep = pathImpl.sep;
  const rel = pathImpl.relative(baseResolved, targetResolved);
  if (
    pathImpl.isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    rel.split(sep).includes('..')
  ) {
    return false;
  }
  return true;
}

function isValidSha256(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

function isValidMaxDimension(max: unknown): max is number {
  return (
    typeof max === 'number' && Number.isInteger(max) && max > 0 && max <= MAX_THUMBNAIL_DIMENSION
  );
}

function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('../')
  );
}

function buildThumbnailFileName(sourceHash: string, maxDimension: number): string {
  const name = `${THUMBNAIL_SCHEMA_VERSION}-${maxDimension}-${sourceHash}.jpg`;
  if (!isSafeFileName(name)) {
    throw new Error(`unsafe thumbnail file name: ${name}`);
  }
  return name;
}

function buildIdentifier(projectRoot: string, finalPath: string): string {
  return relative(resolve(projectRoot), resolve(finalPath))
    .split(sep)
    .join('/');
}

function computeSeekTime(sourceDuration: number | undefined): number {
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    return 0;
  }
  return sourceDuration / 2;
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFileFromFd(
  fh: FileHandle,
  expectedSize: number,
  maxBytes: number,
): Promise<{ hash: string; size: number } | undefined> {
  if (expectedSize < 0 || expectedSize > maxBytes) {
    return undefined;
  }
  const hash = createHash('sha256');
  let totalRead = 0;
  let pos = 0;
  const chunk = Buffer.alloc(SOURCE_STREAM_CHUNK);
  while (pos < expectedSize) {
    const toRead = Math.min(SOURCE_STREAM_CHUNK, expectedSize - pos);
    const { bytesRead } = await fh.read(chunk, 0, toRead, pos);
    if (bytesRead === 0) {
      break;
    }
    hash.update(chunk.subarray(0, bytesRead));
    totalRead += bytesRead;
    pos += bytesRead;
  }
  if (totalRead !== expectedSize) {
    return undefined;
  }
  // Ensure the file has not grown beyond the size we authenticated.
  const eofBuf = Buffer.alloc(1);
  const { bytesRead } = await fh.read(eofBuf, 0, 1, expectedSize);
  if (bytesRead !== 0) {
    return undefined;
  }
  return { hash: hash.digest('hex'), size: expectedSize };
}

async function verifySourceUnchanged(sourceFh: FileHandle, sourceSize: number, beforeStat: Stats): Promise<void> {
  const eofBuf = Buffer.alloc(1);
  const { bytesRead } = await sourceFh.read(eofBuf, 0, 1, sourceSize);
  if (bytesRead !== 0) {
    throw new Error('source grew after fstat');
  }
  const afterStat = await sourceFh.stat();
  if (
    Number(afterStat.size) !== sourceSize ||
    afterStat.dev !== beforeStat.dev ||
    afterStat.ino !== beforeStat.ino ||
    Number(afterStat.mtimeMs) !== Number(beforeStat.mtimeMs)
  ) {
    throw new Error('source changed after fstat');
  }
}

function fdRelativeBase(fh: FileHandle): string | null {
  const platform = process.platform;
  if (platform === 'linux') {
    return `/proc/self/fd/${fh.fd}`;
  }
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'netbsd' || platform === 'openbsd') {
    return `/dev/fd/${fh.fd}`;
  }
  return null;
}

async function readFdTarget(fh: FileHandle): Promise<string | null> {
  const base = fdRelativeBase(fh);
  if (!base) return null;
  try {
    let target = await readlink(base);
    if (typeof target !== 'string') return null;
    // /proc/self/fd/<fd> appends " (deleted)" when the inode lost all directory
    // entries, even if a new entry was later created at the same path. Strip the
    // suffix and let lstat/dev+ino checks confirm the path is still valid.
    if (target.endsWith(' (deleted)')) {
      target = target.slice(0, -' (deleted)'.length);
    }
    return target;
  } catch {
    return null;
  }
}

async function atPath(dirFh: FileHandle, component: string, fallbackDir: string, projectRoot: string): Promise<string> {
  const base = fdRelativeBase(dirFh);
  if (base) {
    return `${base}/${component}`;
  }
  // Fallback for platforms without fd-relative directory capabilities. We
  // re-verify the directory path is still the same inode and inside the project
  // root before every use. This cannot eliminate the path-name race window on
  // such platforms; the threat model therefore requires a separate OS identity
  // or immutable storage for adversarial same-user deployments.
  await verifyDirLocation(dirFh, fallbackDir, projectRoot);
  return resolve(fallbackDir, component);
}

async function readFileAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fh.read(buf, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buf.subarray(0, offset);
}

async function verifyFileLocation(fh: FileHandle, expected: string, boundaryRoot: string): Promise<void> {
  const fdStat = await fh.stat();
  const fdTarget = await readFdTarget(fh);
  const pathToCheck = fdTarget ?? expected;
  const pathStat = await lstat(pathToCheck).catch(() => null);
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.dev !== fdStat.dev ||
    pathStat.ino !== fdStat.ino
  ) {
    throw new Error(`file location mismatch: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(boundaryRoot, real)) {
    throw new Error(`file outside boundary: ${expected}`);
  }
}

async function verifyDirLocation(fh: FileHandle, expected: string, projectRoot: string): Promise<void> {
  const fdStat = await fh.stat();
  if (!fdStat.isDirectory()) {
    throw new Error(`not a directory fd: ${expected}`);
  }
  const fdTarget = await readFdTarget(fh);
  const pathToCheck = fdTarget ?? expected;
  const pathStat = await lstat(pathToCheck).catch(() => null);
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    pathStat.dev !== fdStat.dev ||
    pathStat.ino !== fdStat.ino
  ) {
    throw new Error(`directory location mismatch: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(projectRoot, real)) {
    throw new Error(`directory outside project root: ${expected}`);
  }
}

async function openTrustedDir(
  projectRoot: string,
  dir: string,
  hooks: TestHooks | undefined,
): Promise<{ fh: FileHandle; expected: string }> {
  const root = resolve(projectRoot);
  const target = resolve(root, dir);
  if (!isInside(root, target)) {
    throw new Error('thumbnail directory outside project root');
  }
  const rel = relative(root, target);
  const components = rel.split(sep).filter(Boolean);
  let fh = await open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  let current = root;
  try {
    await verifyDirLocation(fh, current, root);
    for (const component of components) {
      const parentFh = fh;
      const parentCurrent = current;
      current = resolve(current, component);
      if (!isInside(root, current)) {
        throw new Error('thumbnail directory component outside project root');
      }
      await hooks?.beforeChildDirCreation?.({ parentDir: parentCurrent, component });
      await verifyDirLocation(parentFh, parentCurrent, root);

      let childFh: FileHandle | undefined;
      let lastErr: unknown;
      let childPathAttempted: string | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const childPath = await atPath(parentFh, component, parentCurrent, root);
          childPathAttempted = childPath;
          childFh = await open(childPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          break;
        } catch (err) {
          lastErr = err;
          if (isErrnoException(err) && err.code === 'ENOENT') {
            try {
              const childPath = await atPath(parentFh, component, parentCurrent, root);
              childPathAttempted = childPath;
              await mkdir(childPath, { recursive: false, mode: 0o700 });
            } catch (mkErr) {
              if (isErrnoException(mkErr) && (mkErr.code === 'EEXIST' || mkErr.code === 'ENOTDIR')) {
                continue;
              }
              throw mkErr;
            }
            continue;
          }
          if (isErrnoException(err) && (err.code === 'ENOTDIR' || err.code === 'ELOOP')) {
            continue;
          }
          throw err;
        }
      }
      if (!childFh) {
        throw lastErr;
      }
      // On platforms without fd-relative paths a path race can cause mkdir/open
      // to target a directory outside the project root. Fail closed and remove
      // any directory we may have just created if verification fails.
      try {
        await verifyDirLocation(childFh, current, root);
      } catch (verifyErr) {
        if (childPathAttempted && !fdRelativeBase(parentFh)) {
          await rmdir(childPathAttempted).catch(() => {});
        }
        throw verifyErr;
      }
      await parentFh.close();
      fh = childFh;
    }
    return { fh, expected: current };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

function runProcess(
  command: string,
  args: string[],
  stdinBuffer?: Buffer,
  maxOutputBytes = 10 * 1024 * 1024,
): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killed = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
      if (!killed && stdoutLen > maxOutputBytes) {
        killed = true;
        child.kill();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
      if (!killed && stderrLen > maxOutputBytes) {
        killed = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${command} failed with ${code}: ${stderr.slice(-2000)}`));
      } else {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code });
      }
    });
    if (stdinBuffer) {
      child.stdin?.end(stdinBuffer);
    } else {
      child.stdin?.end();
    }
  });
}

async function runProcessText(
  command: string,
  args: string[],
  stdinBuffer?: Buffer,
  maxOutputBytes = 10 * 1024 * 1024,
): Promise<string> {
  const { stdout } = await runProcess(command, args, stdinBuffer, maxOutputBytes);
  return stdout.toString('utf8');
}

function buildFfmpegArgs(
  sourceType: 'image' | 'video',
  seekTime: number | undefined,
  maxDimension: number,
): string[] {
  const scaleFilter = `scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease`;
  const args: string[] = ['-y'];
  args.push('-i', '-');
  if (sourceType === 'video' && seekTime !== undefined && seekTime > 0) {
    // Output seeking works on non-seekable pipe input (non-faststart MP4, etc.).
    args.push('-ss', String(seekTime));
  }
  args.push('-vf', scaleFilter, '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-');
  return args;
}

async function generateThumbnailFromBuffer(
  sourceBuffer: Buffer,
  sourceType: 'image' | 'video',
  sourceDuration: number | undefined,
  maxDimension: number,
  maxOutputBytes: number,
): Promise<Buffer> {
  const seekTime = sourceType === 'video' ? computeSeekTime(sourceDuration) : undefined;
  const args = buildFfmpegArgs(sourceType, seekTime, maxDimension);
  const { stdout } = await runProcess('ffmpeg', args, sourceBuffer, maxOutputBytes);
  if (stdout.length === 0) {
    throw new Error('ffmpeg produced empty thumbnail output');
  }
  return stdout;
}

function runFfmpegStreamed(
  args: string[],
  sourceFh: FileHandle,
  sourcePath: string,
  sourceSize: number,
  sourceStat: Stats,
  expectedSourceHash: string,
  maxSourceBytes: number,
  maxOutputBytes: number,
  maxStderrBytes: number,
  hooks: TestHooks | undefined,
): Promise<{ thumbnailBuffer: Buffer; sourceSha: string }> {
  if (sourceSize > maxSourceBytes) {
    return Promise.reject(new Error('source exceeds maximum allowed bytes'));
  }
  if (sourceSize === 0) {
    return Promise.reject(new Error('source is empty'));
  }
  return new Promise<{ thumbnailBuffer: Buffer; sourceSha: string }>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderr = '';
    let stderrLen = 0;
    let killed = false;
    let childExited = false;
    let childExitCode: number | null = null;
    let verifiedSourceSha: string | undefined;
    let finalized = false;

    function tryFinalize() {
      if (finalized) return;
      if (!verifiedSourceSha || !childExited) return;
      finalized = true;
      if (childExitCode === 0) {
        resolve({ thumbnailBuffer: Buffer.concat(stdoutChunks), sourceSha: verifiedSourceSha });
      } else {
        reject(new Error(`ffmpeg failed with ${childExitCode}: ${stderr.slice(-2000)}`));
      }
    }

    function abort(err: Error) {
      if (finalized) return;
      finalized = true;
      killed = true;
      child.kill();
      reject(err);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
      if (!killed && stdoutLen > maxOutputBytes) {
        abort(new Error(`ffmpeg stdout exceeded ${maxOutputBytes} bytes`));
      }
    });
    child.stdin?.on('error', () => {
      // If the child is killed (e.g. due to stdout/stderr bounds) the stdin write
      // may emit EPIPE after the per-write promise has already settled. Swallow
      // those late errors; writeToStdin handles synchronous/callback errors.
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < maxStderrBytes) {
        const take = Math.min(chunk.length, maxStderrBytes - stderrLen);
        stderr += chunk.subarray(0, take).toString('utf8');
      }
      stderrLen += chunk.length;
      if (!killed && stderrLen > maxStderrBytes) {
        abort(new Error(`ffmpeg stderr exceeded ${maxStderrBytes} bytes`));
      }
    });
    child.on('error', (err) => {
      if (!killed) abort(err);
    });
    child.on('close', (code) => {
      childExited = true;
      childExitCode = code;
      if (code !== 0) {
        // Stop the pump immediately. Without this, the loop would keep reading and
        // hashing a large, broken source even though ffmpeg has already failed.
        if (!finalized) {
          abort(new Error(`ffmpeg failed with ${code}: ${stderr.slice(-2000)}`));
        }
      } else {
        tryFinalize();
      }
    });

    const hash = createHash('sha256');
    let total = 0;
    let pos = 0;
    const buf = Buffer.alloc(SOURCE_STREAM_CHUNK);
    let reading = false;

    function writeToStdin(chunk: Buffer): Promise<void> {
      if (killed || childExited || child.stdin?.destroyed || child.stdin?.writableEnded) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveWrite, rejectWrite) => {
        let settled = false;
        function cleanup() {
          settled = true;
          child.stdin?.off('error', onError);
          child.stdin?.off('close', onClose);
        }
        function onError(err: Error) {
          if (!settled) {
            cleanup();
            if (childExited) {
              resolveWrite();
            } else {
              rejectWrite(err);
            }
          }
        }
        function onClose() {
          if (!settled) { cleanup(); resolveWrite(); }
        }
        child.stdin?.once('error', onError);
        child.stdin?.once('close', onClose);

        try {
          child.stdin!.write(chunk, (err) => {
            if (!settled) {
              cleanup();
              if (err) {
                if (childExited) {
                  resolveWrite();
                } else {
                  rejectWrite(err);
                }
              } else {
                resolveWrite();
              }
            }
          });
        } catch (err) {
          cleanup();
          if (childExited) {
            resolveWrite();
          } else {
            rejectWrite(err as Error);
          }
        }
      });
    }

    async function pump() {
      try {
        if (reading || killed) return;
        reading = true;
        while (pos < sourceSize && !killed) {
          const toRead = Math.min(SOURCE_STREAM_CHUNK, sourceSize - pos);
          const { bytesRead } = await sourceFh.read(buf, 0, toRead, pos);
          if (bytesRead === 0) {
            abort(new Error('source EOF before expected size'));
            return;
          }
          const chunk = buf.subarray(0, bytesRead);
          total += bytesRead;
          pos += bytesRead;
          await hooks?.afterSourceReadChunk?.({ sourcePath, bytesRead, total });
          if (total > maxSourceBytes) {
            abort(new Error('source exceeded maximum allowed bytes during streaming'));
            return;
          }
          hash.update(chunk);
          if (!child.stdin?.destroyed && !childExited) {
            try {
              await writeToStdin(chunk);
            } catch (err) {
              if (!childExited) {
                abort(err as Error);
                return;
              }
            }
          }
          if (!reading) return; // stopped by outside event? Keep reading.
        }

        if (killed) return;

        // Confirm EOF at the original fstat size and re-stat the open fd to
        // detect any append or inode replacement before finalizing the hash.
        try {
          await verifySourceUnchanged(sourceFh, sourceSize, sourceStat);
        } catch (err) {
          abort(err as Error);
          return;
        }

        const sourceSha = hash.digest('hex');
        if (sourceSha !== expectedSourceHash) {
          abort(new Error('source hash mismatch'));
          return;
        }
        verifiedSourceSha = sourceSha;
        if (!child.stdin?.destroyed && !child.stdin?.writableEnded) {
          child.stdin?.end();
        }
        tryFinalize();
      } catch (err) {
        if (!killed) abort(err as Error);
      }
    }

    pump();
  });
}

async function generateThumbnailFromStream(
  sourceFh: FileHandle,
  sourcePath: string,
  sourceType: 'image' | 'video',
  sourceDuration: number | undefined,
  maxDimension: number,
  sourceSize: number,
  sourceStat: Stats,
  expectedSourceHash: string,
  maxSourceBytes: number,
  maxOutputBytes: number,
  maxStderrBytes: number,
  hooks: TestHooks | undefined,
): Promise<{ thumbnailBuffer: Buffer; sourceSha: string }> {
  const seekTime = sourceType === 'video' ? computeSeekTime(sourceDuration) : undefined;
  const args = buildFfmpegArgs(sourceType, seekTime, maxDimension);
  return runFfmpegStreamed(args, sourceFh, sourcePath, sourceSize, sourceStat, expectedSourceHash, maxSourceBytes, maxOutputBytes, maxStderrBytes, hooks);
}

async function probeThumbnailBuffer(buffer: Buffer, maxDimension: number): Promise<{ width: number; height: number }> {
  const stdout = await runProcessText(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-of', 'json', '-i', '-'],
    buffer,
    10 * 1024 * 1024,
  );
  const parsed: FfprobeResult = JSON.parse(stdout);
  const stream = parsed.streams.find((s) => s.codec_type === 'video');
  if (
    !stream ||
    stream.codec_name !== 'mjpeg' ||
    typeof stream.width !== 'number' ||
    typeof stream.height !== 'number' ||
    stream.width <= 0 ||
    stream.height <= 0 ||
    stream.width > maxDimension ||
    stream.height > maxDimension
  ) {
    throw new Error('thumbnail does not satisfy mjpeg dimension contract');
  }
  return { width: stream.width, height: stream.height };
}

async function verifyFinalFile(
  finalPath: string,
  expectedBuffer: Buffer,
  expectedSha: string,
  width: number,
  height: number,
  projectRoot: string,
  hooks: TestHooks | undefined,
): Promise<ThumbnailInfo | undefined> {
  let finalFh: FileHandle | undefined;
  try {
    finalFh = await open(finalPath, O_RDONLY | O_NOFOLLOW);
    const fdStatAfterOpen = await finalFh.stat();
    if (Number(fdStatAfterOpen.size) !== expectedBuffer.length) {
      return undefined;
    }

    // Ensure the caller-supplied path still resolves to the inode we opened.
    const namedStatAfterOpen = await lstat(finalPath).catch(() => null);
    if (
      !namedStatAfterOpen ||
      namedStatAfterOpen.dev !== fdStatAfterOpen.dev ||
      namedStatAfterOpen.ino !== fdStatAfterOpen.ino
    ) {
      return undefined;
    }

    const fdPathAfterOpen = await readFdTarget(finalFh);
    const pathToCheckAfterOpen = fdPathAfterOpen ?? finalPath;
    const pathStatAfterOpen = await lstat(pathToCheckAfterOpen).catch(() => null);
    if (
      !pathStatAfterOpen ||
      pathStatAfterOpen.isSymbolicLink() ||
      !pathStatAfterOpen.isFile() ||
      pathStatAfterOpen.dev !== fdStatAfterOpen.dev ||
      pathStatAfterOpen.ino !== fdStatAfterOpen.ino
    ) {
      return undefined;
    }
    if (fdPathAfterOpen) {
      if (!isInside(projectRoot, fdPathAfterOpen)) {
        return undefined;
      }
    } else {
      const realAfterOpen = await realpath(finalPath).catch(() => null);
      if (!realAfterOpen || !isInside(projectRoot, realAfterOpen)) {
        return undefined;
      }
    }

    if (hooks?.afterFinalOpen) {
      await hooks.afterFinalOpen({ finalPath, finalFd: finalFh.fd, expectedSha });
    }

    const content = await readFileAt(finalFh, 0, expectedBuffer.length);
    if (content.length !== expectedBuffer.length || !content.equals(expectedBuffer)) {
      return undefined;
    }
    const hash = sha256Buffer(content);
    if (hash !== expectedSha) {
      return undefined;
    }

    if (hooks?.afterFinalHash) {
      await hooks.afterFinalHash({ finalPath, finalFd: finalFh.fd, expectedSha, hash });
    }

    // Re-verify the file after the hash hook to catch same-inode modifications.
    const fdStatAfterHash = await finalFh.stat();
    if (Number(fdStatAfterHash.size) !== expectedBuffer.length) {
      return undefined;
    }

    // The caller-supplied path must still name the same inode after the hook.
    const namedStatAfterHash = await lstat(finalPath).catch(() => null);
    if (
      !namedStatAfterHash ||
      namedStatAfterHash.dev !== fdStatAfterHash.dev ||
      namedStatAfterHash.ino !== fdStatAfterHash.ino
    ) {
      return undefined;
    }

    const fdPathAfterHash = await readFdTarget(finalFh);
    const pathToCheckAfterHash = fdPathAfterHash ?? finalPath;
    const pathStatAfterHash = await lstat(pathToCheckAfterHash).catch(() => null);
    if (
      !pathStatAfterHash ||
      pathStatAfterHash.isSymbolicLink() ||
      !pathStatAfterHash.isFile() ||
      pathStatAfterHash.dev !== fdStatAfterHash.dev ||
      pathStatAfterHash.ino !== fdStatAfterHash.ino
    ) {
      return undefined;
    }
    if (fdPathAfterHash) {
      if (!isInside(projectRoot, fdPathAfterHash)) {
        return undefined;
      }
    } else {
      const realAfterHash = await realpath(finalPath).catch(() => null);
      if (!realAfterHash || !isInside(projectRoot, realAfterHash)) {
        return undefined;
      }
    }

    const afterContent = await readFileAt(finalFh, 0, expectedBuffer.length);
    if (afterContent.length !== expectedBuffer.length || !afterContent.equals(expectedBuffer)) {
      return undefined;
    }
    const afterHash = sha256Buffer(afterContent);
    if (afterHash !== expectedSha) {
      return undefined;
    }

    return {
      identifier: buildIdentifier(projectRoot, fdPathAfterHash ?? finalPath),
      sha256: afterHash,
      width,
      height,
    };
  } catch {
    return undefined;
  } finally {
    await finalFh?.close().catch(() => {});
  }
}

async function publishFinal(
  thumbnailDirFh: FileHandle,
  thumbnailDirExpected: string,
  finalName: string,
  thumbnailBuffer: Buffer,
  outputSha: string,
  width: number,
  height: number,
  projectRoot: string,
  hooks: TestHooks | undefined,
): Promise<ThumbnailInfo | undefined> {
  await verifyDirLocation(thumbnailDirFh, thumbnailDirExpected, projectRoot);

  const tempName = `.tmp-${randomUUID()}.jpg`;
  const tempPath = await atPath(thumbnailDirFh, tempName, thumbnailDirExpected, projectRoot);
  const finalProcPath = await atPath(thumbnailDirFh, finalName, thumbnailDirExpected, projectRoot);
  const finalPathForHooks = resolve(thumbnailDirExpected, finalName);

  let tempFh: FileHandle | undefined;
  try {
    await hooks?.beforeFinalWrite?.({ finalPath: finalPathForHooks, expectedSha: outputSha });
    await verifyDirLocation(thumbnailDirFh, thumbnailDirExpected, projectRoot);

    // Create the temporary file read-only from the start. The creator's write fd
    // can still write and fsync; once closed, no new write opens can succeed.
    // The final hard link inherits the same 0o400 mode.
    tempFh = await open(tempPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o400);
    await verifyFileLocation(tempFh, tempPath, projectRoot);
    await hooks?.afterTempCreate?.({ tempPath, tempFd: tempFh.fd });
    await tempFh.writeFile(thumbnailBuffer);
    await tempFh.sync();

    await hooks?.beforePublishLink?.({ thumbnailDir: thumbnailDirExpected, finalName, finalPath: finalPathForHooks });
    await verifyDirLocation(thumbnailDirFh, thumbnailDirExpected, projectRoot);

    try {
      await link(tempPath, finalProcPath);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EEXIST') {
        const existing = await verifyFinalFile(finalProcPath, thumbnailBuffer, outputSha, width, height, projectRoot, hooks);
        await unlink(tempPath).catch(() => {});
        return existing;
      }
      throw err;
    }

    const result = await verifyFinalFile(finalProcPath, thumbnailBuffer, outputSha, width, height, projectRoot, hooks);
    if (!result) {
      // Do not unlink finalProcPath on failure. A content-addressed path may be a
      // shared final placed by a concurrent process; removing it by pathname is a
      // TOCTOU race. The caller must re-verify the returned ThumbnailInfo.
      await unlink(tempPath).catch(() => {});
      return undefined;
    }
    await unlink(tempPath).catch(() => {});
    return result;
  } catch {
    // Cleanup only our temporary file. The content-addressed final path must
    // not be unlinked here because a same-inode check followed by unlink is not
    // a compare-and-delete primitive on any supported OS.
    await tempFh?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    return undefined;
  } finally {
    await tempFh?.close().catch(() => {});
  }
}

export async function generateThumbnail(options: ThumbnailOptions): Promise<ThumbnailInfo | undefined> {
  let sourceFh: FileHandle | undefined;
  let thumbnailDirFh: FileHandle | undefined;

  try {
    if (options.sourceType !== 'image' && options.sourceType !== 'video') {
      return undefined;
    }
    const maxDimension = options.maxDimension ?? DEFAULT_THUMBNAIL_MAX_DIMENSION;
    if (!isValidMaxDimension(maxDimension)) {
      return undefined;
    }
    if (!isValidSha256(options.sourceHash)) {
      return undefined;
    }

    let sourcePath: string;
    try {
      sourcePath = resolveSafePath(options.inputRoot, options.sourceRelativePath);
    } catch {
      return undefined;
    }
    const sourceStat = await lstat(sourcePath).catch(() => null);
    if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      return undefined;
    }
    const sourceReal = await realpath(sourcePath).catch(() => null);
    if (!sourceReal || !isInside(options.inputRoot, sourceReal)) {
      return undefined;
    }

    sourceFh = await open(sourcePath, O_RDONLY | O_NOFOLLOW);
    await verifyFileLocation(sourceFh, sourcePath, options.inputRoot);
    const sourceFdStat = await sourceFh.stat();
    if (!sourceFdStat.isFile()) {
      return undefined;
    }

    const sourceSizeBig = typeof sourceFdStat.size === 'bigint' ? sourceFdStat.size : BigInt(sourceFdStat.size);
    const maxSourceBytes = BigInt(options.__testHooks?.maxSourceBytes ?? MAX_SOURCE_BYTES);
    const sourceBufferLimit = BigInt(options.__testHooks?.sourceBufferLimit ?? SOURCE_BUFFER_LIMIT);
    const maxOutputBytes = options.__testHooks?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderrBytes = options.__testHooks?.maxStderrBytes ?? 1 * 1024 * 1024;

    if (sourceSizeBig > maxSourceBytes) {
      return undefined;
    }
    if (sourceSizeBig === 0n) {
      return undefined;
    }

    const thumbnailDirTarget = resolve(options.projectRoot, options.thumbnailDir);
    if (!isInside(options.projectRoot, thumbnailDirTarget)) {
      return undefined;
    }
    const trusted = await openTrustedDir(options.projectRoot, options.thumbnailDir, options.__testHooks);
    thumbnailDirFh = trusted.fh;
    const thumbnailDirExpected = trusted.expected;

    await options.__testHooks?.afterThumbnailDirValidation?.({ thumbnailDir: thumbnailDirExpected });
    await verifyDirLocation(thumbnailDirFh, thumbnailDirExpected, options.projectRoot);

    const finalName = buildThumbnailFileName(options.sourceHash, maxDimension);
    const finalPath = resolve(thumbnailDirExpected, finalName);

    const sourceSize = Number(sourceSizeBig);
    let thumbnailBuffer: Buffer;
    let sourceSha: string;
    if (sourceSizeBig <= sourceBufferLimit) {
      await options.__testHooks?.beforeSourceRead?.({ sourcePath, sourceSize, sourceFd: sourceFh.fd });
      const sourceBuffer = await readFileAt(sourceFh, 0, sourceSize);
      if (sourceBuffer.length !== sourceSize) {
        return undefined;
      }
      // Confirm EOF at the original fstat size and re-stat the open fd (size,
      // mtime, dev, ino) to detect append/growth or inode replacement.
      try {
        await verifySourceUnchanged(sourceFh, sourceSize, sourceFdStat);
      } catch {
        return undefined;
      }
      sourceSha = sha256Buffer(sourceBuffer);
      if (sourceSha !== options.sourceHash) {
        return undefined;
      }
      await options.__testHooks?.beforeFfmpeg?.({ sourcePath, finalPath });
      thumbnailBuffer = await generateThumbnailFromBuffer(
        sourceBuffer,
        options.sourceType,
        options.sourceDuration,
        maxDimension,
        maxOutputBytes,
      );
    } else {
      await options.__testHooks?.beforeFfmpeg?.({ sourcePath, finalPath });
      const result = await generateThumbnailFromStream(
        sourceFh,
        sourcePath,
        options.sourceType,
        options.sourceDuration,
        maxDimension,
        sourceSize,
        sourceFdStat,
        options.sourceHash,
        Number(maxSourceBytes),
        maxOutputBytes,
        maxStderrBytes,
        options.__testHooks,
      );
      sourceSha = result.sourceSha;
      thumbnailBuffer = result.thumbnailBuffer;
    }

    const { width, height } = await probeThumbnailBuffer(thumbnailBuffer, maxDimension);
    const outputSha = sha256Buffer(thumbnailBuffer);

    return await publishFinal(
      thumbnailDirFh,
      thumbnailDirExpected,
      finalName,
      thumbnailBuffer,
      outputSha,
      width,
      height,
      options.projectRoot,
      options.__testHooks,
    );
  } catch {
    return undefined;
  } finally {
    await sourceFh?.close().catch(() => {});
    await thumbnailDirFh?.close().catch(() => {});
  }
}

export async function verifyThumbnail(
  projectRoot: string,
  info: ThumbnailInfo,
  __testHooks?: VerifyThumbnailTestHooks,
): Promise<boolean> {
  let finalFh: FileHandle | undefined;
  try {
    const finalPath = resolve(projectRoot, info.identifier);
    if (!isInside(resolve(projectRoot), finalPath)) {
      return false;
    }
    finalFh = await open(finalPath, O_RDONLY | O_NOFOLLOW);
    await verifyFileLocation(finalFh, finalPath, projectRoot);
    const initialFdStat = await finalFh.stat();
    const fileSize = Number(initialFdStat.size);
    if (fileSize < 0 || fileSize > MAX_THUMBNAIL_VERIFY_BYTES) {
      return false;
    }

    await __testHooks?.beforeRead?.({ finalPath, finalFd: finalFh.fd, expectedSha: info.sha256 });

    const hashResult = await hashFileFromFd(finalFh, fileSize, MAX_THUMBNAIL_VERIFY_BYTES);
    if (!hashResult) {
      return false;
    }

    await __testHooks?.afterRead?.({ finalPath, finalFd: finalFh.fd, expectedSha: info.sha256, hash: hashResult.hash });

    // The fd must still point to the same inode/size we authenticated.
    const afterFdStat = await finalFh.stat();
    if (
      afterFdStat.dev !== initialFdStat.dev ||
      afterFdStat.ino !== initialFdStat.ino ||
      Number(afterFdStat.size) !== fileSize
    ) {
      return false;
    }

    // The caller-supplied path must still name the same inode/size after the read.
    const afterPathStat = await lstat(finalPath).catch(() => null);
    if (
      !afterPathStat ||
      afterPathStat.dev !== afterFdStat.dev ||
      afterPathStat.ino !== afterFdStat.ino ||
      Number(afterPathStat.size) !== fileSize
    ) {
      return false;
    }

    return hashResult.hash === info.sha256;
  } catch {
    return false;
  } finally {
    await finalFh?.close().catch(() => {});
  }
}
