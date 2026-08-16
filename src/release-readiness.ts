import { spawn, type StdioOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { lstat, link, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { TextEncoder, TextDecoder } from 'node:util';

import { AuditManifestSchema, type AuditManifest } from './audit.js';
import {
  ApprovalDecisionRecordSchema,
  assertNoDuplicateKeys,
  canonicalSha256,
  parseIsoTimestamp,
  resolveArtifact,
  validateArtifactIdentifier,
  type ApprovalDecisionRecord,
} from './approval.js';
import { resolveOutputPath } from './catalog.js';
import { verifyOutputNotSameAsInput } from './catalog-diff.js';
import { type ProbeInfo } from './core.js';
import { resolveSafePath } from './utils.js';
import { isInside } from './thumbnails.js';

export const READINESS_SCHEMA_VERSION = '1.0.0';

const MAX_READINESS_JSON_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_MP4_BYTES = 500 * 1024 * 1024; // 500 MiB
const CHUNK_SIZE = 64 * 1024;
const O_RDONLY = constants.O_RDONLY;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_CREAT = constants.O_CREAT ?? 0;
const O_EXCL = constants.O_EXCL ?? 0;
const O_RDWR = constants.O_RDWR ?? 0;
const O_TMPFILE = 0o20200000;

function runProcess(
  command: string,
  args: string[],
  stdinBuffer?: Buffer,
  maxOutputBytes = 10 * 1024 * 1024,
  maxStderrBytes: number = maxOutputBytes,
  timeoutMs = 0,
  stdio: StdioOptions = ['pipe', 'pipe', 'pipe'],
  throwOnNonZero = true,
): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    let killed = false;
    let abortReason: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    function finish(error: Error | null, value?: { stdout: Buffer; stderr: string; exitCode: number | null }): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value!);
    }

    function terminate(reason: Error): void {
      if (killed || settled) return;
      killed = true;
      abortReason = reason;
      child.kill();
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) terminate(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
        if (stdoutLen > maxOutputBytes) {
          terminate(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes`));
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        const take = Math.min(chunk.length, Math.max(0, maxStderrBytes - stderrLen));
        if (take > 0) stderrChunks.push(chunk.subarray(0, take));
        stderrLen += chunk.length;
        if (stderrLen > maxStderrBytes) {
          terminate(new Error(`${command} stderr exceeded ${maxStderrBytes} bytes`));
        }
      });
    }

    child.on('error', (err) => finish(err));

    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (killed) {
        finish(abortReason ?? new Error(`${command} killed (signal ${signal ?? 'unknown'}): ${stderr.slice(-2000)}`));
      } else if (code !== 0 && throwOnNonZero) {
        finish(new Error(`${command} failed with ${code}: ${stderr.slice(-2000)}`));
      } else {
        finish(null, { stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code });
      }
    });

    if (child.stdin) {
      child.stdin.on('error', (err) => {
        if (settled) return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EPIPE' && code !== 'EOF') finish(err);
      });
      if (stdinBuffer) {
        child.stdin.end(stdinBuffer);
      } else {
        child.stdin.end();
      }
    }
  });
}

function runProcessText(
  command: string,
  args: string[],
  stdinBuffer?: Buffer,
  maxOutputBytes = 10 * 1024 * 1024,
  maxStderrBytes: number = maxOutputBytes,
  timeoutMs = 0,
  stdio: StdioOptions = ['pipe', 'pipe', 'pipe'],
): Promise<string> {
  return runProcess(command, args, stdinBuffer, maxOutputBytes, maxStderrBytes, timeoutMs, stdio).then(
    (result) => result.stdout.toString('utf8'),
  );
}

interface WriteReadinessReportTestHooks {
  /** Runs after the temp directory is bound but before any bytes are written.
   *  Tests can swap directories or place foreign finals here; the final
   *  verification and atomic link must reject or avoid publishing outside the
   *  intended directory. */
  beforeBarrier?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
  }) => Promise<void> | void;
  /** Runs after the report bytes are written but before fsync. */
  beforeSync?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
  }) => Promise<void> | void;
  /** Runs after the report temp is written and synced, but before the final
   *  integrity check and atomic link publishes the report. */
  beforeRename?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
  }) => Promise<void> | void;
  /** Runs after the final input re-verification completes but before the
   *  synchronous final stat and no-replace publish. Adversarial tests can
   *  modify inputs here and the final stat must reject the change. */
  beforePublish?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
  }) => Promise<void> | void;
  /** Runs after the synchronous final stat and directory-location checks but
   *  before the no-replace publish. Adversarial tests can modify inputs;
   *  the Python helper's final content/stat re-verification will reject the
   *  change before the syscall. */
  beforeRenameat2?: (ctx: {
    dirFh: FileHandle;
    dirPath: string;
    finalName: string;
  }) => Promise<void> | void;
  /** For tests: signal file paths keyed by input label. The Python publish
   *  helper will pause before copying that input until the signal file is
   *  removed, and will create `{path}.ack` while it is paused. */
  pythonStallBeforeInputCopy?: Record<string, string>;
  /** For tests: signal file paths keyed by input label. The Python publish
   *  helper will pause after copying that input until the signal file is
   *  removed, and will create `{path}.ack` while it is paused. */
  pythonStallAfterInputCopy?: Record<string, string>;
  /** Overrides the Python helper command for adversarial failure tests. */
  publishHelperCommand?: string;
  /** Overrides the Python helper script source. */
  publishHelperScript?: string;
  /** Overrides the helper subprocess timeout. */
  publishHelperTimeoutMs?: number;
  /** For tests: if true, the Python publish helper attempts to write to the
   *  sealed report temp fd and expects EPERM/EACCES, proving the immutable
   *  seal is effective for a same-owner process. */
  reportSealCheck?: boolean;
  /** For tests: if true, the Python publish helper raises an artificial
   *  failure after the final link. The TypeScript caller must recover by
   *  verifying the linked final and return success when it matches the
   *  expected report. */
  postLinkFail?: boolean;
  /** For tests: if true, the Python publish helper prints non-JSON stdout
   *  after a successful os.link. The TypeScript caller must recover by
   *  verifying the linked final and return success when it matches. */
  postLinkMalformed?: boolean;
  /** For tests: if true, the Python publish helper replaces the linked
   *  final with different bytes and exits with an error. The TypeScript
   *  caller must fail without deleting the foreign replacement. */
  postLinkForeignReplace?: boolean;
  /** For tests: if true, the Python publish helper unlinks the linked final
   *  and creates a new file with the same expected bytes but a different inode.
   *  The TypeScript caller must reject the final because it is not the linked
   *  report temp inode. */
  postLinkReplaceSameBytes?: boolean;
  /** For tests: if true, the Python publish helper reopens the linked final
   *  and appends extra bytes, then exits malformed. The TypeScript caller must
   *  reject the grown final. */
  postLinkGrow?: boolean;
  /** For tests: signal file path. The Python publish helper will pause after
   *  all inputs have been copied into sealed memfds and the report temp has been
   *  sealed, but before the atomic os.link that publishes the report. */
  pythonStallBeforeFinalLink?: string;
}


export interface ReadinessOptions {
  now?: Date | string | number;
  /** Legacy alias that applies to both JSON and artifact size limits. */
  maxBytes?: number;
  maxJsonBytes?: number;
  maxArtifactBytes?: number;
  readinessOutputRel?: string;
  __testHooks?: WriteReadinessReportTestHooks & {
    /** Legacy media open hook; prefer beforeInputOpen. */
    beforeArtifactOpen?: (identifier: string, resolvedPath: string) => Promise<void> | void;
    /** Runs after a canonical input is resolved but before its parent directory is opened. */
    beforeInputOpen?: (label: string, resolvedPath: string) => Promise<void> | void;
    /** Runs after the parent directory and file are opened but before the file bytes are read.
     *  Adversarial tests can rewrite the file here to be detected by the initial read. */
    beforeInputRead?: (label: string, resolvedPath: string) => Promise<void> | void;
    /** Runs after the file is read into a private buffer but before ffprobe or JSON parsing.
     *  Any rewrite of the original after this point cannot affect the captured snapshot. */
    beforeInputProbe?: (label: string, resolvedPath: string, buffer: Buffer) => Promise<void> | void;
    /** Runs after ffprobe, before SHA-256 of the captured buffer. */
    beforeInputHash?: (label: string, resolvedPath: string, buffer: Buffer) => Promise<void> | void;
    /** Runs after JSON is read into a private buffer but before parsing. */
    beforeInputParse?: (label: string, resolvedPath: string, buffer: Buffer) => Promise<void> | void;
  };
}

export interface ReadinessReport {
  action: string;
  audit: {
    identifier: string;
    jobId: string;
    output: {
      identifier: string;
      sha256: string;
      probe: Record<string, unknown>;
    };
    schemaVersion: string;
    sha256: string;
    status: string;
  };
  decision: ApprovalDecisionRecord & {
    identifier: string;
    sha256: string;
  };
  mp4: {
    identifier: string;
    sha256: string;
    probe: Record<string, unknown>;
  };
  ready: boolean;
  reasonCode: string;
  schemaVersion: string;
  verifiedAt: string;
}

export interface ReadinessResult {
  report: ReadinessReport;
  reportPath: string;
  reportSha256: string;
  mp4Sha256: string;
}

interface ReadinessJsonFileResult {
  resolved: string;
  realpath: string;
  text: string;
  sha256: string;
  stat: BigIntStats;
  parentRealpath: string;
  parentStat: BigIntStats;
  data: unknown;
}

interface InputSnapshot {
  identifier: string;
  resolved: string;
  realpath: string;
  stat: BigIntStats;
  sha256: string;
  parentRealpath: string;
  parentStat: BigIntStats;
  text?: string;
  data?: unknown;
}

interface ArtifactSnapshot extends InputSnapshot {
  probe: ProbeInfo;
}

interface HashAndProbeResult {
  sha256: string;
  probe: ProbeInfo;
  stat: BigIntStats;
  resolved: string;
  realpath: string;
  parentRealpath: string;
  parentStat: BigIntStats;
}

export class ReadinessError extends Error {
  declare cause?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function parseVerifiedAt(now: Date | string | number | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }

  if (typeof now === 'string') {
    try {
      const parsed = parseIsoTimestamp(now);
      return parsed.toISOString();
    } catch (err) {
      throw new ReadinessError(
        err instanceof Error ? err.message : 'Invalid now timestamp',
        'INVALID_TIMESTAMP',
      );
    }
  }

  const d = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(d.getTime())) {
    throw new ReadinessError('Invalid now timestamp', 'INVALID_TIMESTAMP');
  }
  const iso = d.toISOString();
  const parsed = parseIsoTimestamp(iso);
  if (parsed.getTime() !== d.getTime()) {
    throw new ReadinessError('Timestamp round-trip mismatch', 'INVALID_TIMESTAMP');
  }
  return iso;
}

function canonicalRelativePath(root: string, absPath: string): string {
  return relative(resolve(root), absPath).replace(/\\/g, '/');
}

function validateByteLimit(name: string, value: unknown): number {
  if (value === undefined) {
    throw new ReadinessError(`${name} is missing`, 'INVALID_OPTIONS');
  }
  if (typeof value !== 'number') {
    throw new ReadinessError(`${name} must be a number`, 'INVALID_OPTIONS');
  }
  if (!Number.isFinite(value) || Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
    throw new ReadinessError(
      `${name} must be a positive finite safe integer, got ${value}`,
      'INVALID_OPTIONS',
    );
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new ReadinessError(`${name} exceeds safe integer limit`, 'INVALID_OPTIONS');
  }
  return value;
}

function resolveByteLimit(specific: unknown, legacy: unknown, defaultValue: number): number {
  if (specific !== undefined) {
    return validateByteLimit('maxJsonBytes/maxArtifactBytes', specific);
  }
  if (legacy !== undefined) {
    return validateByteLimit('maxBytes', legacy);
  }
  return defaultValue;
}

async function readReadinessJsonFile(
  root: string,
  relPath: string,
  label: string,
  maxBytes: number,
  hooks?: {
    beforeInputOpen?: (label: string, resolvedPath: string) => Promise<void> | void;
    beforeInputRead?: (label: string, resolvedPath: string) => Promise<void> | void;
    beforeInputParse?: (label: string, resolvedPath: string, buffer: Buffer) => Promise<void> | void;
  },
): Promise<ReadinessJsonFileResult> {
  let resolved: string;
  try {
    resolved = resolveSafePath(root, relPath);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : `${label} path is invalid`,
      'INVALID_INPUT',
      err,
    );
  }

  const parentPath = dirname(resolved);
  const fileName = basename(resolved);

  const parentBeforeLstat = (await lstat(parentPath, { bigint: true }).catch((err) => {
    throw new ReadinessError(
      `${label} parent directory stat failed: ${(err as Error).message}`,
      'INVALID_INPUT',
      err,
    );
  })) as BigIntStats;
  if (parentBeforeLstat.isSymbolicLink() || !parentBeforeLstat.isDirectory()) {
    throw new ReadinessError(`${label} parent is not a directory: ${relPath}`, 'INVALID_INPUT');
  }

  if (hooks?.beforeInputOpen) {
    await hooks.beforeInputOpen(label, resolved);
  }

  const parentFh = await open(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch((err) => {
    throw new ReadinessError(
      `${label} parent directory open failed: ${(err as Error).message}`,
      'INVALID_INPUT',
      err,
    );
  });

  let result: ReadinessJsonFileResult;
  try {
    const parentFstat = (await parentFh.stat({ bigint: true })) as BigIntStats;
    if (
      parentFstat.isSymbolicLink() ||
      !parentFstat.isDirectory() ||
      String(parentFstat.dev) !== String(parentBeforeLstat.dev) ||
      String(parentFstat.ino) !== String(parentBeforeLstat.ino)
    ) {
      throw new ReadinessError(
        `${label} parent directory changed between stat and open`,
        'INVALID_INPUT',
      );
    }

    const parentReal = await realpath(`/proc/self/fd/${parentFh.fd}`).catch(() =>
      realpath(parentPath).catch(() => null),
    );
    if (!parentReal || !isInside(root, parentReal)) {
      throw new ReadinessError(`${label} parent directory escaped project root`, 'INVALID_INPUT');
    }

    const fileViaParent = `/proc/self/fd/${parentFh.fd}/${fileName}`;
    const beforeLstat = (await lstat(fileViaParent, { bigint: true }).catch((err) => {
      throw new ReadinessError(
        `${label} stat failed: ${(err as Error).message}`,
        'INVALID_INPUT',
        err,
      );
    })) as BigIntStats;
    if (beforeLstat.isSymbolicLink() || !beforeLstat.isFile()) {
      throw new ReadinessError(`${label} is not a regular file: ${relPath}`, 'INVALID_INPUT');
    }
    if (beforeLstat.size > BigInt(maxBytes)) {
      throw new ReadinessError(
        `${label} exceeds maximum size: ${beforeLstat.size}`,
        'INVALID_INPUT',
      );
    }

    const fh = await open(fileViaParent, O_RDONLY | O_NOFOLLOW).catch((err) => {
      throw new ReadinessError(
        `${label} open failed: ${(err as Error).message}`,
        'INVALID_INPUT',
        err,
      );
    });

    try {
      const statBeforeOpen = (await fh.stat({ bigint: true })) as BigIntStats;
      if (!statsEqual(statBeforeOpen, beforeLstat)) {
        throw new ReadinessError(`${label} was replaced between stat and open`, 'INVALID_INPUT');
      }
      if (statBeforeOpen.size > BigInt(maxBytes)) {
        throw new ReadinessError(
          `${label} exceeds maximum size: ${statBeforeOpen.size}`,
          'INVALID_INPUT',
        );
      }

      const fileSize = Number(statBeforeOpen.size);

      if (hooks?.beforeInputRead) {
        await hooks.beforeInputRead(label, resolved);
      }

      const readBuffer = Buffer.alloc(fileSize);
      let offset = 0;
      while (offset < fileSize) {
        const toRead = Math.min(CHUNK_SIZE, fileSize - offset);
        const { bytesRead } = await fh.read(readBuffer, offset, toRead, offset);
        if (bytesRead === 0) {
          throw new ReadinessError(`${label} shrank during read`, 'INVALID_INPUT');
        }
        offset += bytesRead;
      }

      const eofBuf = Buffer.alloc(1);
      const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
      if (eofRead !== 0) {
        throw new ReadinessError(`${label} grew during read`, 'INVALID_INPUT');
      }

      const afterStat = (await fh.stat({ bigint: true })) as BigIntStats;
      if (!statsEqual(afterStat, statBeforeOpen)) {
        throw new ReadinessError(`${label} changed during read`, 'INVALID_INPUT');
      }

      const real = await realpath(`/proc/self/fd/${fh.fd}`).catch(() =>
        realpath(fileViaParent).catch(() => null),
      );
      if (!real || !isInside(root, real)) {
        throw new ReadinessError(`${label} escaped project root after read`, 'INVALID_INPUT');
      }

      const resolvedReal = await realpath(resolved).catch(() => null);
      if (resolvedReal !== real) {
        throw new ReadinessError(`${label} file location changed between open and read`, 'INVALID_INPUT');
      }

      if (hooks?.beforeInputParse) {
        await hooks.beforeInputParse(label, resolved, readBuffer);
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(readBuffer);
      } catch {
        throw new ReadinessError(`${label} is not valid UTF-8: ${relPath}`, 'INVALID_INPUT');
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new ReadinessError(`${label} is not valid JSON: ${relPath}`, 'INVALID_INPUT');
      }

      const sha256 = createHash('sha256').update(readBuffer).digest('hex');

      result = {
        resolved,
        realpath: real,
        text,
        sha256,
        stat: statBeforeOpen,
        parentRealpath: parentReal,
        parentStat: parentFstat,
        data,
      };
    } finally {
      try {
        await fh.close();
      } catch {
        // fd close errors are not recoverable
      }
    }
  } finally {
    try {
      await parentFh.close();
    } catch {
      // fd close errors are not recoverable
    }
  }

  return result;
}

async function readJsonInput(
  root: string,
  relPath: string,
  label: string,
  maxBytes: number,
  hooks?: NonNullable<ReadinessOptions['__testHooks']>,
): Promise<ReadinessJsonFileResult> {
  try {
    validateArtifactIdentifier(relPath);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : `${label} path is not canonical`,
      'INVALID_INPUT_PATH',
      err,
    );
  }

  const result = await readReadinessJsonFile(root, relPath, label, maxBytes, {
    beforeInputOpen: (l, resolved) => hooks?.beforeInputOpen?.(l, resolved),
    beforeInputRead: (l, resolved) => hooks?.beforeInputRead?.(l, resolved),
    beforeInputParse: (l, resolved, buffer) => hooks?.beforeInputParse?.(l, resolved, buffer),
  });

  try {
    assertNoDuplicateKeys(result.text);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : `${label} contains duplicate keys`,
      'DUPLICATE_KEY',
      err,
    );
  }

  return result;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
}

interface FfprobeResult {
  streams: FfprobeStream[];
  format?: { duration?: string };
}

function parseDurationString(value: string | undefined): number {
  if (value === undefined) return NaN;
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return Number(value);
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.includes('/')) {
    const [num, den] = value.split('/').map(Number);
    if (!Number.isFinite(den) || den === 0) return undefined;
    const rate = num / den;
    return Number.isFinite(rate) ? rate : undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export interface FfprobeBufferOptions {
  command?: string;
  args?: string[];
  maxOutputBytes?: number;
  maxStderrBytes?: number;
  timeoutMs?: number;
}

export async function ffprobeFromBuffer(buffer: Buffer, options: FfprobeBufferOptions = {}): Promise<ProbeInfo> {
  const command = options.command ?? 'ffprobe';
  const args = options.args ?? ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '-i', '-'];
  const maxOutputBytes = options.maxOutputBytes ?? 1 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const stdout = await runProcessText(command, args, buffer, maxOutputBytes, maxStderrBytes, timeoutMs).catch((err) => {
    throw new Error(`ffprobe failed: ${(err as Error).message}`);
  });

  const parsed: FfprobeResult = JSON.parse(stdout);
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  const audio = parsed.streams.find((s) => s.codec_type === 'audio');
  const durationStr = parsed.format?.duration ?? video?.duration ?? audio?.duration;
  return {
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    duration: parseDurationString(durationStr),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
}

interface HashAndProbeOptions {
  maxArtifactBytes?: number;
  /** @deprecated Use maxArtifactBytes. */
  maxBytes?: number;
  label?: string;
  beforeOpen?: (path: string) => Promise<void> | void;
  beforeRead?: (path: string) => Promise<void> | void;
  beforeProbe?: (path: string, buffer: Buffer) => Promise<void> | void;
  beforeHash?: (path: string, buffer: Buffer) => Promise<void> | void;
}

function statsEqual(a: Stats | BigIntStats, b: Stats | BigIntStats): boolean {
  return (
    String(a.dev) === String(b.dev) &&
    String(a.ino) === String(b.ino) &&
    String(a.size) === String(b.size) &&
    String((a as BigIntStats).mtimeNs ?? a.mtimeMs) === String((b as BigIntStats).mtimeNs ?? b.mtimeMs)
  );
}

function dirStatsEqual(a: BigIntStats, b: BigIntStats): boolean {
  return (
    String(a.dev) === String(b.dev) &&
    String(a.ino) === String(b.ino) &&
    a.isDirectory() &&
    b.isDirectory()
  );
}

async function readFileIntoBuffer(
  fh: FileHandle,
  fileSize: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.alloc(fileSize);
  let offset = 0;
  while (offset < fileSize) {
    const toRead = Math.min(CHUNK_SIZE, fileSize - offset);
    const { bytesRead } = await fh.read(buffer, offset, toRead, offset);
    if (bytesRead === 0) {
      throw new Error(`${label} shrank during read`);
    }
    offset += bytesRead;
  }

  const eofBuf = Buffer.alloc(1);
  const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
  if (eofRead !== 0) {
    throw new Error(`${label} grew during read`);
  }

  return buffer;
}

async function hashAndProbeFile(
  filePath: string,
  options: HashAndProbeOptions = {},
): Promise<HashAndProbeResult> {
  const label = options.label ?? 'MP4 file';
  const maxBytes = options.maxArtifactBytes ?? options.maxBytes ?? MAX_MP4_BYTES;

  const parentPath = dirname(filePath);
  const fileName = basename(filePath);

  const parentBeforeLstat = (await lstat(parentPath, { bigint: true }).catch((err) => {
    throw new Error(`${label} parent directory stat failed: ${(err as Error).message}`);
  })) as BigIntStats;
  if (parentBeforeLstat.isSymbolicLink() || !parentBeforeLstat.isDirectory()) {
    throw new Error(`${label} parent directory is not a directory`);
  }

  if (options.beforeOpen) {
    await options.beforeOpen(filePath);
  }

  const parentFh = await open(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch((err) => {
    throw new Error(`${label} parent directory open failed: ${(err as Error).message}`);
  });

  try {
    const parentBeforeFstat = (await parentFh.stat({ bigint: true })) as BigIntStats;
    if (
      parentBeforeFstat.isSymbolicLink() ||
      !parentBeforeFstat.isDirectory() ||
      String(parentBeforeFstat.dev) !== String(parentBeforeLstat.dev) ||
      String(parentBeforeFstat.ino) !== String(parentBeforeLstat.ino)
    ) {
      throw new Error(`${label} parent directory changed between stat and open`);
    }

    const parentReal = await realpath(`/proc/self/fd/${parentFh.fd}`).catch(() =>
      realpath(parentPath).catch(() => parentPath),
    );

    const fileViaParent = `/proc/self/fd/${parentFh.fd}/${fileName}`;
    const origFh = await open(fileViaParent, O_RDONLY | O_NOFOLLOW).catch((err) => {
      throw new Error(`${label} open failed: ${(err as Error).message}`);
    });

    try {
      const beforeFstat = (await origFh.stat({ bigint: true })) as BigIntStats;
      if (!beforeFstat.isFile()) {
        throw new Error(`${label} is not a regular file`);
      }
      if (beforeFstat.size > BigInt(maxBytes)) {
        throw new Error(`${label} exceeds maximum size: ${beforeFstat.size}`);
      }

      const canonicalReal = await realpath(`/proc/self/fd/${origFh.fd}`).catch(() =>
        realpath(fileViaParent).catch(() => filePath),
      );

      const fileSize = Number(beforeFstat.size);

      if (options.beforeRead) {
        await options.beforeRead(filePath);
      }

      const buffer = await readFileIntoBuffer(origFh, fileSize, label);

      const afterFstat = (await origFh.stat({ bigint: true })) as BigIntStats;
      if (!statsEqual(afterFstat, beforeFstat)) {
        throw new Error(`${label} changed during read`);
      }

      if (options.beforeProbe) {
        await options.beforeProbe(filePath, buffer);
      }

      const probe = await ffprobeFromBuffer(buffer).catch((err) => {
        throw new Error(`${label} ffprobe failed: ${(err as Error).message}`);
      });

      if (options.beforeHash) {
        await options.beforeHash(filePath, buffer);
      }

      const sha256 = createHash('sha256').update(buffer).digest('hex');

      const resolvedReal = await realpath(filePath).catch(() => null);
      const fdReal = await realpath(`/proc/self/fd/${origFh.fd}`).catch(() => null);
      if (resolvedReal !== canonicalReal || fdReal !== canonicalReal) {
        throw new Error(`${label} file location changed between open and hash`);
      }

      return {
        sha256,
        probe,
        stat: afterFstat,
        resolved: filePath,
        realpath: canonicalReal,
        parentRealpath: parentReal,
        parentStat: parentBeforeFstat,
      };
    } finally {
      try {
        await origFh.close();
      } catch {
        // fd close errors are not recoverable
      }
    }
  } finally {
    try {
      await parentFh.close();
    } catch {
      // fd close errors are not recoverable
    }
  }
}

function toInputSnapshot(
  root: string,
  result: ReadinessJsonFileResult | HashAndProbeResult,
): InputSnapshot {
  return {
    identifier: canonicalRelativePath(root, result.resolved),
    resolved: result.resolved,
    realpath: result.realpath,
    stat: result.stat,
    sha256: result.sha256,
    parentRealpath: result.parentRealpath,
    parentStat: result.parentStat,
    text: 'text' in result ? result.text : undefined,
    data: 'data' in result ? result.data : undefined,
  };
}

function toArtifactSnapshot(root: string, result: HashAndProbeResult): ArtifactSnapshot {
  return {
    ...toInputSnapshot(root, result),
    probe: result.probe,
  };
}

function validateDecision(decision: ApprovalDecisionRecord): void {
  if (decision.action !== 'publish') {
    throw new ReadinessError('Decision action is not publish', 'DECISION_ACTION_MISMATCH');
  }
  if (decision.decision !== 'approved') {
    throw new ReadinessError('Decision is not approved', 'DECISION_NOT_APPROVED');
  }
  if (decision.reasonCode !== 'APPROVED') {
    throw new ReadinessError('Decision reasonCode is not APPROVED', 'DECISION_REASON_CODE');
  }
  if (decision.approver === null || decision.approver === undefined || decision.approver === '') {
    throw new ReadinessError('Approved decision missing approver', 'DECISION_MISSING_APPROVER');
  }
  try {
    validateArtifactIdentifier(decision.artifact);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Decision artifact is not canonical',
      'DECISION_ARTIFACT_INVALID',
      err,
    );
  }
}

function validateAudit(audit: AuditManifest): void {
  if (audit.schemaVersion !== READINESS_SCHEMA_VERSION) {
    throw new ReadinessError('Unsupported audit schema version', 'AUDIT_SCHEMA_VERSION');
  }
  if (audit.status !== 'success') {
    throw new ReadinessError('Audit status is not success', 'AUDIT_NOT_SUCCESS');
  }
  if (!audit.output) {
    throw new ReadinessError('Audit output missing', 'AUDIT_OUTPUT_MISSING');
  }
  try {
    validateArtifactIdentifier(audit.output.identifier);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Audit output identifier is not canonical',
      'AUDIT_OUTPUT_IDENTIFIER_INVALID',
      err,
    );
  }
}

function validateAuditArtifactNamespace(audit: AuditManifest, mp4Rel: string): void {
  if (!audit.output) {
    throw new ReadinessError('Audit output missing', 'AUDIT_OUTPUT_MISSING');
  }
  const identifier = audit.output.identifier;
  const parts = identifier.split('/');
  if (parts.length !== 4 || parts[0] !== 'output' || parts[1] !== 'artifacts') {
    throw new ReadinessError(
      'Audit output identifier is not in the artifact namespace',
      'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  }
  if (!parts[3].startsWith('snapshot-')) {
    throw new ReadinessError(
      'Audit output identifier does not name a snapshot artifact',
      'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  }
  if (parts[2] !== audit.jobId) {
    throw new ReadinessError(
      'Audit output identifier jobId does not match audit jobId',
      'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  }
  const mp4Basename = mp4Rel.split('/').pop();
  if (parts[3] !== `snapshot-${mp4Basename}`) {
    throw new ReadinessError(
      'Audit output identifier snapshot name does not match the final MP4',
      'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  }
}

function validateProbe(probe: ProbeInfo): void {
  if (!probe.hasVideo || probe.videoCodec !== 'h264') {
    throw new ReadinessError('MP4 does not have an H.264 video stream', 'MP4_VIDEO_MISMATCH');
  }
  if (!probe.hasAudio || probe.audioCodec !== 'aac') {
    throw new ReadinessError('MP4 does not have an AAC audio stream', 'MP4_AUDIO_MISMATCH');
  }
  if (!probe.width || !probe.height || probe.width * 16 !== probe.height * 9) {
    throw new ReadinessError('MP4 is not 9:16 aspect ratio', 'MP4_ASPECT_MISMATCH');
  }
  if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
    throw new ReadinessError('MP4 duration is invalid', 'MP4_DURATION_INVALID');
  }
}

function validateProbeMatch(probe: ProbeInfo, auditProbe: ProbeInfo): void {
  assertProbesEqual(probe, auditProbe, 'MP4 probe does not match audit output probe');
}

function validateArtifactMatch(
  mp4Rel: string,
  mp4Sha256: string,
  decision: ApprovalDecisionRecord,
  audit: AuditManifest,
): void {
  if (mp4Rel !== decision.artifact) {
    throw new ReadinessError('MP4 identifier does not match decision artifact', 'MP4_DECISION_IDENTIFIER_MISMATCH');
  }
  if (mp4Sha256 !== decision.artifactSha256) {
    throw new ReadinessError('MP4 SHA-256 does not match decision', 'MP4_DECISION_SHA_MISMATCH');
  }
  if (mp4Sha256 !== audit.output!.sha256) {
    throw new ReadinessError('MP4 SHA-256 does not match audit output', 'MP4_AUDIT_SHA_MISMATCH');
  }
}

function validateInputsDistinct(...inputs: { name: string; snapshot: InputSnapshot }[]): void {
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const a = inputs[i].snapshot;
      const b = inputs[j].snapshot;
      if (a.resolved === b.resolved || a.realpath === b.realpath) {
        throw new ReadinessError(
          `${inputs[i].name} and ${inputs[j].name} resolve to the same path`,
          'INPUT_COLLISION',
        );
      }
      if (a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino) {
        throw new ReadinessError(
          `${inputs[i].name} and ${inputs[j].name} share the same inode`,
          'INPUT_COLLISION',
        );
      }
    }
  }
}

function assertSnapshotsEqual(
  expected: InputSnapshot,
  actual: { resolved: string; realpath: string; parentRealpath: string; stat: BigIntStats; parentStat: BigIntStats; sha256: string; text?: string },
  label: string,
): void {
  if (expected.sha256 !== actual.sha256) {
    throw new ReadinessError(`${label} SHA-256 changed between read and publish boundary`, 'INPUT_CHANGED');
  }
  if (expected.text !== undefined && actual.text !== undefined && expected.text !== actual.text) {
    throw new ReadinessError(`${label} content changed between read and publish boundary`, 'INPUT_CHANGED');
  }
  if (expected.realpath !== actual.realpath || expected.parentRealpath !== actual.parentRealpath) {
    throw new ReadinessError(`${label} location changed between read and publish boundary`, 'INPUT_CHANGED');
  }
  if (
    String(expected.stat.dev) !== String(actual.stat.dev) ||
    String(expected.stat.ino) !== String(actual.stat.ino) ||
    String(expected.stat.size) !== String(actual.stat.size) ||
    String(expected.stat.mtimeNs) !== String(actual.stat.mtimeNs) ||
    String(expected.stat.ctimeNs) !== String(actual.stat.ctimeNs)
  ) {
    throw new ReadinessError(`${label} metadata changed between read and publish boundary`, 'INPUT_CHANGED');
  }
  if (
    String(expected.parentStat.dev) !== String(actual.parentStat.dev) ||
    String(expected.parentStat.ino) !== String(actual.parentStat.ino) ||
    !actual.parentStat.isDirectory()
  ) {
    throw new ReadinessError(`${label} parent directory changed between read and publish boundary`, 'INPUT_CHANGED');
  }
}

async function assertInputStatsUnchanged(
  snapshot: InputSnapshot,
  label: string,
): Promise<void> {
  const currentStat = (await lstat(snapshot.resolved, { bigint: true }).catch((err) => {
    throw new ReadinessError(`${label} final stat failed: ${(err as Error).message}`, 'INPUT_CHANGED', err);
  })) as BigIntStats;
  if (
    !currentStat.isFile() ||
    String(currentStat.dev) !== String(snapshot.stat.dev) ||
    String(currentStat.ino) !== String(snapshot.stat.ino) ||
    String(currentStat.size) !== String(snapshot.stat.size) ||
    String(currentStat.mtimeNs) !== String(snapshot.stat.mtimeNs) ||
    String(currentStat.ctimeNs) !== String(snapshot.stat.ctimeNs)
  ) {
    throw new ReadinessError(`${label} metadata changed at final boundary`, 'INPUT_CHANGED');
  }

  const currentRealpath = await realpath(snapshot.resolved).catch(() => null);
  if (!currentRealpath || currentRealpath !== snapshot.realpath) {
    throw new ReadinessError(`${label} realpath changed at final boundary`, 'INPUT_CHANGED');
  }

  const parentPath = dirname(snapshot.resolved);
  const currentParentRealpath = await realpath(parentPath).catch(() => null);
  if (!currentParentRealpath || currentParentRealpath !== snapshot.parentRealpath) {
    throw new ReadinessError(`${label} parent realpath changed at final boundary`, 'INPUT_CHANGED');
  }

  const currentParentStat = (await lstat(parentPath, { bigint: true }).catch((err) => {
    throw new ReadinessError(
      `${label} parent directory final stat failed: ${(err as Error).message}`,
      'INPUT_CHANGED',
      err,
    );
  })) as BigIntStats;
  if (
    String(currentParentStat.dev) !== String(snapshot.parentStat.dev) ||
    String(currentParentStat.ino) !== String(snapshot.parentStat.ino) ||
    !currentParentStat.isDirectory()
  ) {
    throw new ReadinessError(`${label} parent directory changed at final boundary`, 'INPUT_CHANGED');
  }
}

async function assertAllInputsStatsUnchanged(
  mp4Snapshot: ArtifactSnapshot,
  auditArtifactSnapshot: ArtifactSnapshot,
  auditSnapshot: InputSnapshot,
  decisionSnapshot: InputSnapshot,
): Promise<void> {
  // A final stat pass over all four inputs makes the sequential re-verification
  // atomic with respect to cross-input races: if one input is modified after its
  // own re-read but while another input is being verified, this pass detects it
  // before the readiness report is published.
  await Promise.all([
    assertInputStatsUnchanged(mp4Snapshot, 'MP4'),
    assertInputStatsUnchanged(auditArtifactSnapshot, 'Audit output artifact'),
    assertInputStatsUnchanged(auditSnapshot, 'Generation audit manifest'),
    assertInputStatsUnchanged(decisionSnapshot, 'Approval decision'),
  ]);
}

function assertInputStatsUnchangedSync(snapshot: InputSnapshot, label: string): void {
  let currentStat: BigIntStats;
  try {
    currentStat = lstatSync(snapshot.resolved, { bigint: true }) as BigIntStats;
  } catch (err) {
    throw new ReadinessError(`${label} final sync stat failed: ${(err as Error).message}`, 'INPUT_CHANGED', err);
  }
  if (
    !currentStat.isFile() ||
    String(currentStat.dev) !== String(snapshot.stat.dev) ||
    String(currentStat.ino) !== String(snapshot.stat.ino) ||
    String(currentStat.size) !== String(snapshot.stat.size) ||
    String(currentStat.mtimeNs) !== String(snapshot.stat.mtimeNs) ||
    String(currentStat.ctimeNs) !== String(snapshot.stat.ctimeNs)
  ) {
    throw new ReadinessError(`${label} metadata changed at final sync boundary`, 'INPUT_CHANGED');
  }

  let currentRealpath: string;
  try {
    currentRealpath = realpathSync(snapshot.resolved);
  } catch (err) {
    throw new ReadinessError(`${label} final sync realpath failed: ${(err as Error).message}`, 'INPUT_CHANGED', err);
  }
  if (currentRealpath !== snapshot.realpath) {
    throw new ReadinessError(`${label} realpath changed at final sync boundary`, 'INPUT_CHANGED');
  }

  const parentPath = dirname(snapshot.resolved);
  let currentParentRealpath: string;
  try {
    currentParentRealpath = realpathSync(parentPath);
  } catch (err) {
    throw new ReadinessError(
      `${label} parent final sync realpath failed: ${(err as Error).message}`,
      'INPUT_CHANGED',
      err,
    );
  }
  if (currentParentRealpath !== snapshot.parentRealpath) {
    throw new ReadinessError(`${label} parent realpath changed at final sync boundary`, 'INPUT_CHANGED');
  }

  let currentParentStat: BigIntStats;
  try {
    currentParentStat = lstatSync(parentPath, { bigint: true }) as BigIntStats;
  } catch (err) {
    throw new ReadinessError(
      `${label} parent directory final sync stat failed: ${(err as Error).message}`,
      'INPUT_CHANGED',
      err,
    );
  }
  if (
    String(currentParentStat.dev) !== String(snapshot.parentStat.dev) ||
    String(currentParentStat.ino) !== String(snapshot.parentStat.ino) ||
    !currentParentStat.isDirectory()
  ) {
    throw new ReadinessError(`${label} parent directory changed at final sync boundary`, 'INPUT_CHANGED');
  }
}

function assertAllInputsStatsUnchangedSync(
  mp4Snapshot: ArtifactSnapshot,
  auditArtifactSnapshot: ArtifactSnapshot,
  auditSnapshot: InputSnapshot,
  decisionSnapshot: InputSnapshot,
): void {
  // Synchronous final cross-check immediately before the no-replace publish.
  // This keeps the window between final verification and renameat2 as small as
  // a single event-loop tick.
  assertInputStatsUnchangedSync(mp4Snapshot, 'MP4');
  assertInputStatsUnchangedSync(auditArtifactSnapshot, 'Audit output artifact');
  assertInputStatsUnchangedSync(auditSnapshot, 'Generation audit manifest');
  assertInputStatsUnchangedSync(decisionSnapshot, 'Approval decision');
}

async function verifyInputsAtPublishBoundary(
  root: string,
  mp4Snapshot: ArtifactSnapshot,
  auditArtifactSnapshot: ArtifactSnapshot,
  auditSnapshot: InputSnapshot,
  decisionSnapshot: InputSnapshot,
  maxJsonBytes: number,
  maxArtifactBytes: number,
  hooks?: NonNullable<ReadinessOptions['__testHooks']>,
): Promise<void> {
  const finalHooks = {
    beforeInputOpen: hooks?.beforeInputOpen,
    beforeInputRead: hooks?.beforeInputRead,
    beforeInputHash: hooks?.beforeInputHash,
    beforeInputParse: hooks?.beforeInputParse,
  };

  const mp4Verify = await hashAndProbeFile(mp4Snapshot.resolved, {
    maxArtifactBytes,
    label: 'MP4',
    beforeOpen: finalHooks.beforeInputOpen ? () => finalHooks.beforeInputOpen!('MP4', mp4Snapshot.resolved) : undefined,
    beforeRead: finalHooks.beforeInputRead ? () => finalHooks.beforeInputRead!('MP4', mp4Snapshot.resolved) : undefined,
    beforeHash: finalHooks.beforeInputHash ? (path, buffer) => finalHooks.beforeInputHash!('MP4', path, buffer) : undefined,
  }).catch((err) => {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'MP4 changed between read and publish boundary',
      'INPUT_CHANGED',
      err,
    );
  });
  assertSnapshotsEqual(mp4Snapshot, mp4Verify, 'MP4');
  assertProbesEqual(mp4Snapshot.probe, mp4Verify.probe, 'MP4 probe changed between read and publish boundary');

  const auditArtifactVerify = await hashAndProbeFile(auditArtifactSnapshot.resolved, {
    maxArtifactBytes,
    label: 'Audit output artifact',
    beforeOpen: finalHooks.beforeInputOpen
      ? () => finalHooks.beforeInputOpen!('Audit output artifact', auditArtifactSnapshot.resolved)
      : undefined,
    beforeRead: finalHooks.beforeInputRead
      ? () => finalHooks.beforeInputRead!('Audit output artifact', auditArtifactSnapshot.resolved)
      : undefined,
    beforeHash: finalHooks.beforeInputHash
      ? (path, buffer) => finalHooks.beforeInputHash!('Audit output artifact', path, buffer)
      : undefined,
  }).catch((err) => {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Audit output artifact changed between read and publish boundary',
      'INPUT_CHANGED',
      err,
    );
  });
  assertSnapshotsEqual(auditArtifactSnapshot, auditArtifactVerify, 'Audit output artifact');
  assertProbesEqual(auditArtifactSnapshot.probe, auditArtifactVerify.probe, 'Audit output artifact probe changed between read and publish boundary');

  const auditVerify = await readJsonInput(root, auditSnapshot.identifier, 'Generation audit manifest', maxJsonBytes, finalHooks).catch(
    (err) => {
      throw new ReadinessError(
        err instanceof Error ? err.message : 'Audit manifest changed between read and publish boundary',
        'INPUT_CHANGED',
        err,
      );
    },
  );
  assertSnapshotsEqual(auditSnapshot, auditVerify, 'Generation audit manifest');

  const decisionVerify = await readJsonInput(root, decisionSnapshot.identifier, 'Approval decision', maxJsonBytes, finalHooks).catch(
    (err) => {
      throw new ReadinessError(
        err instanceof Error ? err.message : 'Approval decision changed between read and publish boundary',
        'INPUT_CHANGED',
        err,
      );
    },
  );
  assertSnapshotsEqual(decisionSnapshot, decisionVerify, 'Approval decision');

  await assertAllInputsStatsUnchanged(mp4Snapshot, auditArtifactSnapshot, auditSnapshot, decisionSnapshot);
}

async function verifyOutputNoCollision(
  root: string,
  outputPath: string,
  inputs: InputSnapshot[],
): Promise<void> {
  const outputStat = await lstat(outputPath).catch(() => null);
  if (outputStat) {
    throw new ReadinessError('Readiness output path already exists', 'OUTPUT_COLLISION');
  }
  for (const input of inputs) {
    await verifyOutputNotSameAsInput(root, outputPath, input.resolved).catch((err) => {
      throw new ReadinessError(
        err instanceof Error ? err.message : 'Readiness output collides with an input',
        'OUTPUT_COLLISION',
        err,
      );
    });
  }
}

function buildProbeReport(probe: ProbeInfo): Record<string, unknown> {
  return {
    audioCodec: probe.audioCodec ?? null,
    duration: probe.duration,
    fps: probe.fps ?? null,
    hasAudio: probe.hasAudio,
    height: probe.height ?? null,
    hasVideo: probe.hasVideo,
    sampleRate: probe.sampleRate ?? null,
    videoCodec: probe.videoCodec ?? null,
    width: probe.width ?? null,
  };
}

function buildReadinessReport(
  root: string,
  mp4Rel: string,
  mp4Sha256: string,
  mp4Probe: ProbeInfo,
  audit: AuditManifest,
  auditRead: ReadinessJsonFileResult,
  decision: ApprovalDecisionRecord,
  decisionRead: ReadinessJsonFileResult,
  verifiedAt: string,
): ReadinessReport {
  return {
    action: decision.action,
    audit: {
      identifier: canonicalRelativePath(root, auditRead.resolved),
      jobId: audit.jobId,
      output: {
        identifier: audit.output!.identifier,
        probe: buildProbeReport(audit.output!.probe),
        sha256: audit.output!.sha256,
      },
      schemaVersion: audit.schemaVersion,
      sha256: auditRead.sha256,
      status: audit.status,
    },
    decision: {
      action: decision.action,
      approver: decision.approver,
      artifact: decision.artifact,
      artifactSha256: decision.artifactSha256,
      decision: decision.decision,
      identifier: canonicalRelativePath(root, decisionRead.resolved),
      reasonCode: decision.reasonCode,
      requestSha256: decision.requestSha256,
      schemaVersion: decision.schemaVersion,
      sha256: decisionRead.sha256,
      verifiedAt: decision.verifiedAt,
    },
    mp4: {
      identifier: mp4Rel,
      probe: buildProbeReport(mp4Probe),
      sha256: mp4Sha256,
    },
    ready: true,
    reasonCode: 'READY',
    schemaVersion: READINESS_SCHEMA_VERSION,
    verifiedAt,
  };
}

function deriveReadinessOutputRel(
  mp4Rel: string,
  auditRel: string,
  decisionRel: string,
  verifiedAt: string,
): string {
  const id = canonicalSha256({
    action: 'publish',
    mp4: mp4Rel,
    audit: auditRel,
    decision: decisionRel,
    verifiedAt,
  });
  return `readiness/release-readiness-${id.slice(0, 16)}-${randomUUID()}.json`;
}

function assertProbesEqual(a: ProbeInfo, b: ProbeInfo, message: string): void {
  const fields: Array<keyof ProbeInfo> = [
    'width',
    'height',
    'fps',
    'videoCodec',
    'audioCodec',
    'sampleRate',
    'duration',
    'hasVideo',
    'hasAudio',
  ];
  for (const field of fields) {
    if (a[field] !== b[field]) {
      throw new ReadinessError(message, 'INPUT_CHANGED');
    }
  }
}

export async function verifyReleaseReadiness(
  projectRoot: string,
  mp4Rel: string,
  auditRel: string,
  decisionRel: string,
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const root = resolve(projectRoot);
  const hooks = options.__testHooks;

  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new ReadinessError('Project root is not a directory', 'INVALID_PROJECT_ROOT');
  }

  const maxJsonBytes = resolveByteLimit(options.maxJsonBytes, options.maxBytes, MAX_READINESS_JSON_BYTES);
  const maxArtifactBytes = resolveByteLimit(
    options.maxArtifactBytes,
    options.maxBytes,
    MAX_MP4_BYTES,
  );
  const verifiedAt = parseVerifiedAt(options.now);

  const decisionRead = await readJsonInput(root, decisionRel, 'Approval decision', maxJsonBytes, hooks);

  let decision: ApprovalDecisionRecord;
  try {
    decision = ApprovalDecisionRecordSchema.parse(decisionRead.data) as ApprovalDecisionRecord;
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Invalid approval decision',
      'INVALID_DECISION',
      err,
    );
  }
  validateDecision(decision);

  const auditRead = await readJsonInput(root, auditRel, 'Generation audit manifest', maxJsonBytes, hooks);

  let audit: AuditManifest;
  try {
    audit = AuditManifestSchema.parse(auditRead.data) as AuditManifest;
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Invalid audit manifest',
      'INVALID_AUDIT',
      err,
    );
  }
  validateAudit(audit);
  validateAuditArtifactNamespace(audit, mp4Rel);

  const mp4Info = await resolveArtifact(root, mp4Rel, { bigint: true }).catch((err) => {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'MP4 could not be resolved',
      'INVALID_MP4',
      err,
    );
  });

  if (hooks?.beforeArtifactOpen) {
    await hooks.beforeArtifactOpen(mp4Rel, mp4Info.resolved);
  }

  const auditArtifactInfo = await resolveArtifact(root, audit.output!.identifier, { bigint: true }).catch(
    (err) => {
      throw new ReadinessError(
        err instanceof Error ? err.message : 'Audit output artifact could not be resolved',
        'INVALID_AUDIT_ARTIFACT',
        err,
      );
    },
  );

  if (hooks?.beforeArtifactOpen) {
    await hooks.beforeArtifactOpen(audit.output!.identifier, auditArtifactInfo.resolved);
  }

  const mp4Result = await hashAndProbeFile(mp4Info.resolved, {
    maxArtifactBytes,
    label: 'MP4',
    beforeOpen: hooks?.beforeInputOpen ? () => hooks.beforeInputOpen!('MP4', mp4Info.resolved) : undefined,
    beforeRead: hooks?.beforeInputRead ? () => hooks.beforeInputRead!('MP4', mp4Info.resolved) : undefined,
    beforeProbe: (path, buffer) => hooks?.beforeInputProbe?.('MP4', path, buffer) ?? Promise.resolve(),
    beforeHash: (path, buffer) => hooks?.beforeInputHash?.('MP4', path, buffer) ?? Promise.resolve(),
  }).catch((err) => {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'MP4 could not be verified',
      'INVALID_MP4',
      err,
    );
  });

  const auditArtifactResult = await hashAndProbeFile(auditArtifactInfo.resolved, {
    maxArtifactBytes,
    label: 'Audit output artifact',
    beforeOpen: hooks?.beforeInputOpen ? () => hooks.beforeInputOpen!('Audit output artifact', auditArtifactInfo.resolved) : undefined,
    beforeRead: hooks?.beforeInputRead ? () => hooks.beforeInputRead!('Audit output artifact', auditArtifactInfo.resolved) : undefined,
    beforeProbe: (path, buffer) => hooks?.beforeInputProbe?.('Audit output artifact', path, buffer) ?? Promise.resolve(),
    beforeHash: (path, buffer) => hooks?.beforeInputHash?.('Audit output artifact', path, buffer) ?? Promise.resolve(),
  }).catch((err) => {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Audit output artifact could not be verified',
      'INVALID_AUDIT_ARTIFACT',
      err,
    );
  });

  validateProbe(mp4Result.probe);

  if (auditArtifactResult.sha256 !== audit.output!.sha256) {
    throw new ReadinessError(
      'Audit output artifact SHA-256 does not match audit manifest',
      'AUDIT_OUTPUT_SHA_MISMATCH',
    );
  }
  try {
    validateProbeMatch(auditArtifactResult.probe, audit.output!.probe);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Audit output artifact probe mismatch',
      'AUDIT_OUTPUT_PROBE_MISMATCH',
      err,
    );
  }

  if (mp4Result.sha256 !== auditArtifactResult.sha256) {
    throw new ReadinessError(
      'MP4 SHA-256 does not match audit output artifact',
      'MP4_AUDIT_SHA_MISMATCH',
    );
  }
  try {
    validateProbeMatch(mp4Result.probe, auditArtifactResult.probe);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'MP4 probe does not match audit output artifact',
      'MP4_PROBE_MISMATCH',
      err,
    );
  }

  validateArtifactMatch(mp4Rel, mp4Result.sha256, decision, audit);
  validateProbeMatch(mp4Result.probe, audit.output!.probe);

  const mp4Snapshot = toArtifactSnapshot(root, mp4Result);
  const auditArtifactSnapshot = toArtifactSnapshot(root, auditArtifactResult);
  const auditSnapshot = toInputSnapshot(root, auditRead);
  const decisionSnapshot = toInputSnapshot(root, decisionRead);

  validateInputsDistinct(
    { name: 'MP4', snapshot: mp4Snapshot },
    { name: 'audit output artifact', snapshot: auditArtifactSnapshot },
    { name: 'audit manifest', snapshot: auditSnapshot },
    { name: 'approval decision', snapshot: decisionSnapshot },
  );

  const report = buildReadinessReport(
    root,
    mp4Rel,
    mp4Result.sha256,
    mp4Result.probe,
    audit,
    auditRead,
    decision,
    decisionRead,
    verifiedAt,
  );
  const reportBody = JSON.stringify(report, null, 2) + '\n';
  const reportBytes = new TextEncoder().encode(reportBody);
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');

  const readinessOutputRel =
    options.readinessOutputRel ?? deriveReadinessOutputRel(mp4Rel, auditRel, decisionRel, verifiedAt);
  let safeOutputRel: string;
  try {
    safeOutputRel = readinessOutputRel.replace(/^output\//, '');
    const components = safeOutputRel.split('/');
    if (
      isAbsolute(safeOutputRel) ||
      safeOutputRel.includes('\0') ||
      safeOutputRel.startsWith('/') ||
      components.length < 2 ||
      components[0] !== 'readiness' ||
      components.some((c) => c === '' || c === '.' || c === '..')
    ) {
      throw new Error('Readiness output must be a relative path under output/readiness/');
    }
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Invalid readiness output path',
      'INVALID_OUTPUT_PATH',
      err,
    );
  }

  let safeOutput: string;
  try {
    safeOutput = resolveOutputPath(root, safeOutputRel);
  } catch (err) {
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Invalid readiness output path',
      'INVALID_OUTPUT_PATH',
      err,
    );
  }

  // Ensure the resolved output path is still strictly inside output/readiness/.
  const readinessDir = resolve(root, 'output', 'readiness');
  if (!isInside(readinessDir, safeOutput)) {
    throw new ReadinessError(
      'Readiness output resolved outside output/readiness/',
      'INVALID_OUTPUT_PATH',
    );
  }

  await verifyOutputNoCollision(root, safeOutput, [
    mp4Snapshot,
    auditArtifactSnapshot,
    auditSnapshot,
    decisionSnapshot,
  ]);

  const reportPath = await writeReadinessReportAtomic(
    reportBytes,
    reportSha256,
    root,
    safeOutputRel,
    {
      mp4Snapshot,
      auditArtifactSnapshot,
      auditSnapshot,
      decisionSnapshot,
      maxJsonBytes,
      maxArtifactBytes,
    },
    {
      __testHooks: hooks,
    },
  ).catch((err) => {
    if (err instanceof ReadinessError) {
      throw err;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR' || code === 'OUTPUT_COLLISION') {
      throw new ReadinessError(
        'Readiness output path already exists or destination directory changed',
        'OUTPUT_COLLISION',
        err,
      );
    }
    throw new ReadinessError(
      err instanceof Error ? err.message : 'Failed to write readiness report',
      'WRITE_FAILED',
      err,
    );
  });

  return {
    report,
    reportPath,
    reportSha256,
    mp4Sha256: mp4Result.sha256,
  };
}

const O_WRONLY_REPORT = constants.O_WRONLY;

function isEEXIST(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function isEISDIR(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EISDIR';
}

function isENOTEMPTY(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOTEMPTY';
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function fdRelativeBaseReport(fh: FileHandle): string | null {
  const platform = process.platform;
  if (platform === 'linux') {
    return `/proc/self/fd/${fh.fd}`;
  }
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'netbsd' || platform === 'openbsd') {
    return `/dev/fd/${fh.fd}`;
  }
  return null;
}

function outputCollisionErrorReport(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'OUTPUT_COLLISION';
  return err;
}

async function verifyDirLocationReport(fh: FileHandle, expected: string, projectRoot: string): Promise<void> {
  const fdStat = (await fh.stat({ bigint: true })) as BigIntStats;
  if (!fdStat.isDirectory()) {
    throw outputCollisionErrorReport(`not a directory fd: ${expected}`);
  }
  const pathStat = (await lstat(expected, { bigint: true }).catch(() => null)) as BigIntStats | null;
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    String(pathStat.dev) !== String(fdStat.dev) ||
    String(pathStat.ino) !== String(fdStat.ino)
  ) {
    throw outputCollisionErrorReport(`directory location does not match: ${expected}`);
  }
  const real = await realpath(expected).catch(() => null);
  if (!real || !isInside(projectRoot, real)) {
    throw outputCollisionErrorReport(`directory outside project root: ${expected}`);
  }
}

function verifyDirLocationReportSync(fh: FileHandle, expected: string, projectRoot: string): void {
  let fdStat: BigIntStats;
  try {
    fdStat = fstatSync(fh.fd, { bigint: true }) as BigIntStats;
  } catch (err) {
    throw outputCollisionErrorReport(`directory fd stat failed: ${expected}`);
  }
  if (!fdStat.isDirectory()) {
    throw outputCollisionErrorReport(`not a directory fd: ${expected}`);
  }
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(expected, { bigint: true }) as BigIntStats;
  } catch {
    throw outputCollisionErrorReport(`directory location does not match: ${expected}`);
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    String(pathStat.dev) !== String(fdStat.dev) ||
    String(pathStat.ino) !== String(fdStat.ino)
  ) {
    throw outputCollisionErrorReport(`directory location does not match: ${expected}`);
  }
  let real: string;
  try {
    real = realpathSync(expected);
  } catch {
    throw outputCollisionErrorReport(`directory realpath failed: ${expected}`);
  }
  if (!isInside(projectRoot, real)) {
    throw outputCollisionErrorReport(`directory outside project root: ${expected}`);
  }
}

async function mkdirAtReport(parentFh: FileHandle, component: string, fallbackPath: string): Promise<boolean> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    try {
      await mkdir(`${base}/${component}`);
      return true;
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      return false;
    }
  }
  try {
    await mkdir(resolve(fallbackPath, component), { recursive: true });
  } catch (err) {
    if (!isEEXIST(err)) throw err;
  }
  return false;
}

async function openAtReport(
  parentFh: FileHandle,
  component: string,
  flags: number,
  fallbackPath: string,
  projectRoot: string,
  mode?: number,
): Promise<FileHandle> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    if (mode !== undefined) {
      return open(`${base}/${component}`, flags, mode);
    }
    return open(`${base}/${component}`, flags);
  }
  await verifyDirLocationReport(parentFh, fallbackPath, projectRoot);
  if (mode !== undefined) {
    return open(resolve(fallbackPath, component), flags, mode);
  }
  return open(resolve(fallbackPath, component), flags);
}

async function unlinkAtReport(parentFh: FileHandle, name: string, fallbackPath: string): Promise<void> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    await unlink(`${base}/${name}`);
  } else {
    await unlink(resolve(fallbackPath, name));
  }
}

async function lstatAtReport(parentFh: FileHandle, name: string, fallbackPath: string): Promise<BigIntStats> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    return (await lstat(`${base}/${name}`, { bigint: true })) as BigIntStats;
  }
  return (await lstat(resolve(fallbackPath, name), { bigint: true })) as BigIntStats;
}

async function rmdirAtReport(parentFh: FileHandle, name: string, fallbackPath: string): Promise<void> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    await rmdir(`${base}/${name}`);
  } else {
    await rmdir(resolve(fallbackPath, name));
  }
}

async function linkAtReport(
  parentFh: FileHandle,
  oldName: string,
  newName: string,
  fallbackPath: string,
): Promise<void> {
  const base = fdRelativeBaseReport(parentFh);
  if (base) {
    await link(`${base}/${oldName}`, `${base}/${newName}`);
  } else {
    await link(resolve(fallbackPath, oldName), resolve(fallbackPath, newName));
  }
}

function isCleanupErrorReport(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

interface WriteReadinessReportInputs {
  mp4Snapshot: ArtifactSnapshot;
  auditArtifactSnapshot: ArtifactSnapshot;
  auditSnapshot: InputSnapshot;
  decisionSnapshot: InputSnapshot;
  maxJsonBytes: number;
  maxArtifactBytes: number;
}

async function verifyReportIntegrity(fh: FileHandle, expectedSha256: string, label: string): Promise<void> {
  const stat = (await fh.stat({ bigint: true })) as BigIntStats;
  if (!stat.isFile()) {
    throw new ReadinessError(`${label} is not a regular file`, 'WRITE_FAILED');
  }
  const size = Number(stat.size);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const toRead = Math.min(CHUNK_SIZE, size - offset);
    const { bytesRead } = await fh.read(buffer, offset, toRead, offset);
    if (bytesRead === 0) {
      throw new ReadinessError(`${label} shrank before publish`, 'WRITE_FAILED');
    }
    offset += bytesRead;
  }
  const eofBuf = Buffer.alloc(1);
  const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, size);
  if (eofRead !== 0) {
    throw new ReadinessError(`${label} grew before publish`, 'WRITE_FAILED');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== expectedSha256) {
    throw new ReadinessError(`${label} integrity check failed before publish`, 'WRITE_FAILED');
  }
}

interface PublishContractInput {
  label: string;
  dirFd: number;
  name: string;
  type: 'media' | 'json';
  expectedSha256: string;
  expectedStat: {
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    mode: number;
  };
  expectedParentStat: { dev: string; ino: string; mode: number };
  expectedRealpath: string;
  expectedParentRealpath: string;
  isMedia: boolean;
}

interface PublishContract {
  outputDirFd: number;
  reportTempFd: number;
  finalName: string;
  reportSha256: string;
  projectRoot: string;
  outputDirRealpath: string;
  outputDirStat: { dev: string; ino: string; mode: number };
  inputs: PublishContractInput[];
  __testHooks?: {
    stallBeforeInputCopy?: Record<string, string>;
    stallAfterInputCopy?: Record<string, string>;
    reportSealCheck?: boolean;
    postLinkFail?: boolean;
    postLinkMalformed?: boolean;
    postLinkForeignReplace?: boolean;
    postLinkReplaceSameBytes?: boolean;
    postLinkGrow?: boolean;
    stallBeforeFinalLink?: string;
  };
}


const PUBLISH_SCRIPT = `import errno
import fcntl
import hashlib
import json
import os
import stat
import sys
import time

F_ADD_SEALS = fcntl.F_ADD_SEALS
F_SEAL_ALL = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
MFD_FLAGS = os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING


def fail(code, error, errno_code=0):
    print(json.dumps({"ok": False, "code": code, "error": error, "errno": errno_code}))
    sys.exit(0)


def readlink_fd(fd):
    try:
        return os.readlink(f"/proc/self/fd/{fd}")
    except OSError:
        return None


def realpath_fd(fd):
    target = readlink_fd(fd)
    if target is None:
        return None
    if target.endswith(" (deleted)"):
        target = target[: -len(" (deleted)")]
    try:
        return os.path.realpath(target)
    except (OSError, ValueError):
        return target


def is_inside(root, target):
    try:
        root_real = os.path.realpath(root)
        target_real = os.path.realpath(target)
    except (OSError, ValueError):
        return False
    if root_real == target_real:
        return True
    try:
        common = os.path.commonpath([root_real, target_real])
    except ValueError:
        return False
    return common == root_real


def verify_dir(fd, expected, expected_real, root, label, code="INPUT_CHANGED"):
    try:
        st = os.fstat(fd)
    except OSError as e:
        fail(code, f"{label} fstat: {e.strerror}", e.errno)
    if not stat.S_ISDIR(st.st_mode):
        fail(code, f"{label} is not a directory")
    if (st.st_mode & 0o777) != expected["mode"] or str(st.st_dev) != expected["dev"] or str(st.st_ino) != expected["ino"]:
        fail(code, f"{label} directory stat mismatch")
    real = realpath_fd(fd)
    if real != expected_real or not is_inside(root, real):
        fail(code, f"{label} directory realpath mismatch")


def copy_fd_to_memfd(src_fd, size, label):
    try:
        mfd = os.memfd_create(f"snap-{label}", flags=MFD_FLAGS)
    except OSError as e:
        fail("WRITE_FAILED", f"{label} memfd_create: {e.strerror}", e.errno)
    try:
        os.lseek(src_fd, 0, os.SEEK_SET)
    except OSError:
        pass
    h = hashlib.sha256()
    buf_size = 1 << 20
    remaining = size
    try:
        while remaining > 0:
            chunk = os.read(src_fd, min(buf_size, remaining))
            if not chunk:
                fail("INPUT_CHANGED", f"{label} shrank during copy")
            os.write(mfd, chunk)
            h.update(chunk)
            remaining -= len(chunk)
        extra = os.read(src_fd, 1)
        if extra:
            fail("INPUT_CHANGED", f"{label} grew during copy")
        try:
            fcntl.fcntl(mfd, F_ADD_SEALS, F_SEAL_ALL)
        except OSError as e:
            fail("WRITE_FAILED", f"{label} seal failed: {e.strerror}", e.errno)
        os.lseek(mfd, 0, os.SEEK_SET)
        return mfd, h.hexdigest()
    except Exception:
        try:
            os.close(mfd)
        except OSError:
            pass
        raise


def hash_fd(fd, size, label):
    """Compute SHA-256 of fd from current offset through exactly size bytes.

    Returns the hex digest and verifies the file did not grow or shrink.
    """
    try:
        os.lseek(fd, 0, os.SEEK_SET)
    except OSError:
        pass
    h = hashlib.sha256()
    buf_size = 1 << 20
    remaining = size
    while remaining > 0:
        chunk = os.read(fd, min(buf_size, remaining))
        if not chunk:
            fail("INPUT_CHANGED", f"{label} shrank during final hash")
        h.update(chunk)
        remaining -= len(chunk)
    extra = os.read(fd, 1)
    if extra:
        fail("INPUT_CHANGED", f"{label} grew during final hash")
    return h.hexdigest()


def wait_for_signal(path, label):
    ack = path + ".ack"
    try:
        fd = os.open(ack, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
        os.close(fd)
    except OSError as e:
        fail("WRITE_FAILED", f"{label} stall ack: {e.strerror}", e.errno)
    try:
        deadline = time.monotonic() + 30.0
        while os.path.exists(path):
            if time.monotonic() > deadline:
                fail("WRITE_FAILED", f"{label} stall timeout")
            time.sleep(0.01)
    finally:
        try:
            os.unlink(ack)
        except OSError:
            pass


def main():
    if sys.platform != "linux":
        fail("UNSUPPORTED_PLATFORM", "Linux required")
    if not hasattr(os, "memfd_create") or not hasattr(os, "link"):
        fail("UNSUPPORTED_PLATFORM", "missing OS primitives")
    if len(sys.argv) < 2:
        fail("WRITE_FAILED", "missing contract")

    contract = json.loads(sys.argv[1])
    output_dir_fd = contract["outputDirFd"]
    report_temp_fd = contract["reportTempFd"]
    final_name = contract["finalName"]
    report_sha256 = contract["reportSha256"]
    project_root = contract["projectRoot"]
    output_dir_real_expected = contract["outputDirRealpath"]
    output_dir_stat_expected = contract["outputDirStat"]
    inputs = contract["inputs"]
    test_hooks = contract.get("__testHooks", {})

    verify_dir(output_dir_fd, output_dir_stat_expected, output_dir_real_expected, project_root, "output dir", "WRITE_FAILED")

    opened = []
    locked_fds = []
    linked = False
    out_stat = None
    report_mfd = -1
    out_fd_local = -1
    report_fd = report_temp_fd
    stall_before = test_hooks.get("stallBeforeInputCopy", {}) if isinstance(test_hooks, dict) else {}
    stall_after = test_hooks.get("stallAfterInputCopy", {}) if isinstance(test_hooks, dict) else {}

    try:
        for inp in inputs:
            parent_fd = inp["dirFd"]
            name = inp["name"]
            label = inp["label"]
            fd = -1
            mfd = -1

            before = stall_before.get(label) if isinstance(stall_before, dict) else None
            if before:
                wait_for_signal(before, label)

            verify_dir(parent_fd, inp["expectedParentStat"], inp["expectedParentRealpath"], project_root, f"{label} parent", "INPUT_CHANGED")
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            except OSError as e:
                fail("INPUT_CHANGED", f"{label} open: {e.strerror}", e.errno)
            try:
                st = os.fstat(fd)
                exp = inp["expectedStat"]
                if (
                    (st.st_mode & 0o777) != exp["mode"]
                    or str(st.st_dev) != exp["dev"]
                    or str(st.st_ino) != exp["ino"]
                    or str(st.st_size) != exp["size"]
                    or str(st.st_mtime_ns) != exp["mtimeNs"]
                    or str(st.st_ctime_ns) != exp["ctimeNs"]
                ):
                    fail("INPUT_CHANGED", f"{label} stat mismatch")
                if not stat.S_ISREG(st.st_mode):
                    fail("INPUT_CHANGED", f"{label} not regular file")
                real = realpath_fd(fd)
                if real != inp["expectedRealpath"] or not is_inside(project_root, real):
                    fail("INPUT_CHANGED", f"{label} realpath mismatch")
                mfd, actual_sha = copy_fd_to_memfd(fd, st.st_size, label)
                if actual_sha != inp["expectedSha256"]:
                    fail("INPUT_CHANGED", f"{label} sha256 mismatch")

                after = stall_after.get(label) if isinstance(stall_after, dict) else None
                if after:
                    wait_for_signal(after, label)

                opened.append((fd, st, parent_fd, name, label, mfd, actual_sha))
                fd = -1
                mfd = -1
            finally:
                if fd != -1:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                if mfd != -1:
                    try:
                        os.close(mfd)
                    except OSError:
                        pass

        # The four inputs have been copied into sealed memfds. The memfds hold the
        # exact bytes that will be published, but the Linear acceptance contract
        # also requires the original canonical paths to be unchanged up to the
        # os.link commit.  A final pre-link verification pass checks each input
        # again (parent directory identity, file identity, and SHA-256) so that
        # any rewrite, replacement, truncation, growth, or parent-directory swap
        # after the sealed copy fails closed with INPUT_CHANGED.

        # Seal the report into a memfd snapshot as well.
        try:
            report_st = os.fstat(report_fd)
        except OSError as e:
            fail("WRITE_FAILED", f"report temp fstat: {e.strerror}", e.errno)
        if not stat.S_ISREG(report_st.st_mode):
            fail("WRITE_FAILED", "report temp not regular file")

        report_mfd, actual_report_sha = copy_fd_to_memfd(report_fd, report_st.st_size, "report")
        if actual_report_sha != report_sha256:
            fail("WRITE_FAILED", "report sha mismatch")

        if isinstance(test_hooks, dict) and test_hooks.get("reportSealCheck"):
            try:
                os.write(report_mfd, b"x")
                fail("WRITE_FAILED", "report temp is mutable after seal")
            except OSError as e:
                if e.errno not in (errno.EPERM, errno.EACCES):
                    fail("WRITE_FAILED", f"report temp write after seal returned unexpected errno {e.errno}")

        # Test hook: pause before the final commit verification. Adversarial tests
        # can rewrite/replace/truncate/grow/swap an original input here; the
        # following final verification loop must catch the change.
        stall_before_final = test_hooks.get("stallBeforeFinalLink") if isinstance(test_hooks, dict) else None
        if stall_before_final:
            wait_for_signal(stall_before_final, "beforeFinalLink")

        # Final pre-commit verification of the original canonical inputs.
        # This loop runs immediately before os.link so that the time window
        # between identity check and link is as small as the kernel allows.
        # Each input fd is opened once and locked with a shared advisory flock
        # so a cooperating producer cannot modify the file during the commit.
        for inp in inputs:
            parent_fd = inp["dirFd"]
            name = inp["name"]
            label = inp["label"]
            verify_dir(parent_fd, inp["expectedParentStat"], inp["expectedParentRealpath"], project_root, f"{label} parent at commit", "INPUT_CHANGED")
            fd = -1
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            except OSError as e:
                fail("INPUT_CHANGED", f"{label} open at commit: {e.strerror}", e.errno)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except OSError as e:
                    if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        fail("INPUT_CHANGED", f"{label} is locked by another process at commit")
                    fail("INPUT_CHANGED", f"{label} lock at commit: {e.strerror}", e.errno)
                st = os.fstat(fd)
                exp = inp["expectedStat"]
                if (
                    (st.st_mode & 0o777) != exp["mode"]
                    or str(st.st_dev) != exp["dev"]
                    or str(st.st_ino) != exp["ino"]
                    or str(st.st_size) != exp["size"]
                    or str(st.st_mtime_ns) != exp["mtimeNs"]
                    or str(st.st_ctime_ns) != exp["ctimeNs"]
                ):
                    fail("INPUT_CHANGED", f"{label} stat mismatch at commit")
                if not stat.S_ISREG(st.st_mode):
                    fail("INPUT_CHANGED", f"{label} not regular file at commit")
                real = realpath_fd(fd)
                if real != inp["expectedRealpath"] or not is_inside(project_root, real):
                    fail("INPUT_CHANGED", f"{label} realpath mismatch at commit")
                actual_sha = hash_fd(fd, st.st_size, label)
                if actual_sha != inp["expectedSha256"]:
                    fail("INPUT_CHANGED", f"{label} sha256 mismatch at commit")
                locked_fds.append(fd)
                fd = -1
            finally:
                if fd != -1:
                    try:
                        os.close(fd)
                    except OSError:
                        pass

        # Create an anonymous output inode in the bound output directory and
        # copy the sealed report snapshot into it, then fsync/fchmod and link.
        try:
            out_fd = os.open('.', os.O_TMPFILE | os.O_RDWR, 0o600, dir_fd=output_dir_fd)
        except OSError as e:
            fail("WRITE_FAILED", f"create output temp: {e.strerror}", e.errno)
        out_fd_local = out_fd
        try:
            remaining = report_st.st_size
            while remaining > 0:
                chunk = os.read(report_mfd, min(1 << 20, remaining))
                if not chunk:
                    fail("WRITE_FAILED", "report read short")
                written = 0
                while written < len(chunk):
                    n = os.write(out_fd_local, chunk[written:])
                    if n == 0:
                        fail("WRITE_FAILED", "report write short")
                    written += n
                remaining -= len(chunk)
            try:
                os.fsync(out_fd_local)
            except OSError as e:
                fail("WRITE_FAILED", f"fsync output temp: {e.strerror}", e.errno)
            try:
                os.fchmod(out_fd_local, 0o400)
            except OSError as e:
                fail("WRITE_FAILED", f"fchmod output temp: {e.strerror}", e.errno)

            selflink = f"/proc/self/fd/{out_fd_local}"
            try:
                os.link(selflink, final_name, dst_dir_fd=output_dir_fd, follow_symlinks=True)
            except FileExistsError:
                fail("OUTPUT_COLLISION", "readiness output already exists")
            except OSError as e:
                fail("WRITE_FAILED", f"link final: {e.strerror}", e.errno)
            linked = True
            # Capture the linked inode's post-link metadata.
            out_stat = os.fstat(out_fd_local)

            # The anonymous inode now has a single name. Close our writable fd so
            # there is no writable alias left in the publishing process.
            try:
                if out_fd_local != -1:
                    os.close(out_fd_local)
                    out_fd_local = -1
            except OSError:
                pass

            # Emit the linked inode identity so the TypeScript caller can prove
            # provenance even if the helper crashes or prints malformed output
            # immediately after this point.
            print(json.dumps({
                "linked": True,
                "outDev": str(out_stat.st_dev),
                "outIno": str(out_stat.st_ino),
                "outSize": str(out_stat.st_size),
                "outMtimeNs": str(out_stat.st_mtime_ns),
                "outCtimeNs": str(out_stat.st_ctime_ns),
            }))
            sys.stdout.flush()
        finally:
            if out_fd_local != -1:
                try:
                    os.close(out_fd_local)
                except OSError:
                    pass
                out_fd_local = -1

        if isinstance(test_hooks, dict) and test_hooks.get("postLinkFail"):
            raise RuntimeError("injected post-link failure")
        if isinstance(test_hooks, dict) and test_hooks.get("postLinkMalformed"):
            print("not-json")
            return
        if isinstance(test_hooks, dict) and test_hooks.get("postLinkForeignReplace"):
            try:
                os.unlink(final_name, dir_fd=output_dir_fd)
                fd_foreign = os.open(final_name, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o644, dir_fd=output_dir_fd)
                os.write(fd_foreign, b"foreign replacement")
                os.close(fd_foreign)
            except OSError:
                pass
            return
        if isinstance(test_hooks, dict) and test_hooks.get("postLinkReplaceSameBytes"):
            # Replace the linked final with the same bytes under a new inode.
            # This tests that verifyFinalCommit rejects same-content foreign
            # files by checking the report temp inode provenance.
            try:
                fd_check = os.open(final_name, os.O_RDONLY, dir_fd=output_dir_fd)
                os.lseek(fd_check, 0, os.SEEK_SET)
                same_bytes = b""
                while True:
                    chunk = os.read(fd_check, 1 << 20)
                    if not chunk:
                        break
                    same_bytes += chunk
                os.close(fd_check)
                # Rename the original final to a temporary name before creating
                # the replacement. Keeping the original inode allocated while the
                # new file is created prevents the filesystem from reusing the
                # same inode number (and possibly the same coarse timestamps),
                # so the TypeScript verifier can reliably detect the foreign
                # replacement by inode.
                tmp_name = final_name + ".postlink-old"
                os.rename(final_name, tmp_name, src_dir_fd=output_dir_fd, dst_dir_fd=output_dir_fd)
                try:
                    fd_new = os.open(final_name, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o400, dir_fd=output_dir_fd)
                    written = 0
                    while written < len(same_bytes):
                        n = os.write(fd_new, same_bytes[written:])
                        if n == 0:
                            break
                        written += n
                    os.close(fd_new)
                finally:
                    try:
                        os.unlink(tmp_name, dir_fd=output_dir_fd)
                    except OSError:
                        pass
            except OSError as e:
                raise RuntimeError(f"postLinkReplaceSameBytes: {e.strerror}") from e
            return
        if isinstance(test_hooks, dict) and test_hooks.get("postLinkGrow"):
            # Append extra bytes to the linked final to test post-read size/EOF checks.
            try:
                os.chmod(final_name, 0o600, dir_fd=output_dir_fd)
                fd_grow = os.open(final_name, os.O_WRONLY | os.O_APPEND, dir_fd=output_dir_fd)
                os.write(fd_grow, b"extra")
                os.close(fd_grow)
                os.chmod(final_name, 0o400, dir_fd=output_dir_fd)
            except OSError as e:
                raise RuntimeError(f"postLinkGrow: {e.strerror}") from e
            return

        return

    except BaseException as e:
        if isinstance(e, SystemExit):
            raise
        # os.link is the final commit. If it succeeded, the report is published.
        # Any failure after that point must not attempt to unlink the final,
        # because a stat/unlink sequence could remove a foreign replacement.
        # The TypeScript caller will verify the linked inode and content, so
        # re-raise the exception (causing a non-zero exit) and let it inspect the
        # final. Pre-link errors still use fail() to emit a parseable code.
        if linked:
            raise
        fail("WRITE_FAILED", f"publish failed: {e}")

    finally:
        for fd, st, parent_fd, name, label, mfd, actual_sha in opened:
            try:
                os.close(mfd)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        for lock_fd in locked_fds:
            try:
                os.close(lock_fd)
            except OSError:
                pass
        if report_mfd != -1 and report_mfd != report_fd:
            try:
                os.close(report_mfd)
            except OSError:
                pass
        if out_fd_local != -1:
            try:
                os.close(out_fd_local)
            except OSError:
                pass


if __name__ == "__main__":
    main()
`;


async function verifyFinalCommit(
  dirFh: FileHandle,
  finalName: string,
  expectedSha256: string,
  expectedSize: number,
  expectedStat?: { dev: bigint; ino: bigint; size: bigint; mtimeNs?: bigint; ctimeNs?: bigint },
): Promise<boolean> {
  // Open the final path through the bound output directory so it is not
  // affected by parent-directory swap races. O_NOFOLLOW ensures we do not
  // follow a symlink that may have been swapped in after the helper linked.
  const finalPath = `/proc/self/fd/${dirFh.fd}/${finalName}`;
  let fh: FileHandle;
  try {
    fh = await open(finalPath, O_RDONLY | O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const preSt = (await fh.stat({ bigint: true })) as BigIntStats;
    if (!preSt.isFile() || preSt.size !== BigInt(expectedSize)) return false;
    if (expectedStat) {
      if (preSt.dev !== expectedStat.dev || preSt.ino !== expectedStat.ino || preSt.size !== expectedStat.size) return false;
      if (expectedStat.mtimeNs !== undefined && preSt.mtimeNs !== expectedStat.mtimeNs) return false;
      if (expectedStat.ctimeNs !== undefined && preSt.ctimeNs !== expectedStat.ctimeNs) return false;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total < expectedSize) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, expectedSize - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total !== expectedSize) return false;

    // EOF check: ensure the file did not grow during the read.
    const extraBuf = Buffer.alloc(1);
    const { bytesRead: extraRead } = await fh.read(extraBuf, 0, 1, null);
    if (extraRead !== 0) return false;

    const hash = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    if (hash !== expectedSha256) return false;

    // Post-read identity check: the opened fd must still point to the same
    // inode, and the path must still resolve to that inode. This catches a
    // foreign replacement that happens during or immediately after the read.
    const postSt = (await fh.stat({ bigint: true })) as BigIntStats;
    if (!postSt.isFile() || postSt.size !== BigInt(expectedSize)) return false;
    if (expectedStat) {
      if (postSt.dev !== expectedStat.dev || postSt.ino !== expectedStat.ino || postSt.size !== expectedStat.size) return false;
      if (expectedStat.mtimeNs !== undefined && postSt.mtimeNs !== expectedStat.mtimeNs) return false;
      if (expectedStat.ctimeNs !== undefined && postSt.ctimeNs !== expectedStat.ctimeNs) return false;
    }

    let pathStat: BigIntStats;
    try {
      pathStat = (await lstat(finalPath, { bigint: true })) as BigIntStats;
    } catch {
      return false;
    }
    if (!pathStat.isFile() || pathStat.size !== BigInt(expectedSize)) return false;
    if (pathStat.dev !== postSt.dev || pathStat.ino !== postSt.ino) return false;
    if (expectedStat) {
      if (pathStat.dev !== expectedStat.dev || pathStat.ino !== expectedStat.ino || pathStat.size !== expectedStat.size) return false;
      if (expectedStat.mtimeNs !== undefined && pathStat.mtimeNs !== expectedStat.mtimeNs) return false;
      if (expectedStat.ctimeNs !== undefined && pathStat.ctimeNs !== expectedStat.ctimeNs) return false;
    }

    return true;
  } catch {
    return false;
  } finally {
    try {
      await fh.close();
    } catch {
      // best-effort close
    }
  }
}


async function publishAtomicNoReplace(
  dirFh: FileHandle,
  reportFh: FileHandle,
  finalName: string,
  reportSha256: string,
  inputs: WriteReadinessReportInputs,
  projectRoot: string,
  currentPath: string,
  testHooks?: WriteReadinessReportTestHooks,
): Promise<void> {
  const root = resolve(projectRoot);
  const outputDirFd = dirFh.fd;
  const reportTempFd = reportFh.fd;
  const reportSize = Number((await reportFh.stat({ bigint: true })).size);

  const outputDirRealpath = await realpath(currentPath).catch(() => null);
  if (!outputDirRealpath || !isInside(root, outputDirRealpath)) {
    throw new ReadinessError('Output directory location changed before publish', 'WRITE_FAILED');
  }
  const outputDirStat = (await dirFh.stat({ bigint: true })) as BigIntStats;

  const inputList: PublishContractInput[] = [];
  const parentFds: number[] = [];
  const stdio: Array<'pipe' | number> = ['pipe', 'pipe', 'pipe', outputDirFd, reportTempFd];

  const inputOrder = [inputs.mp4Snapshot, inputs.auditArtifactSnapshot, inputs.auditSnapshot, inputs.decisionSnapshot];
  const inputLabels = ['MP4', 'Audit output artifact', 'Generation audit manifest', 'Approval decision'];

  try {
    for (let i = 0; i < inputOrder.length; i++) {
      const snapshot = inputOrder[i];
      const label = inputLabels[i];
      const parentPath = dirname(snapshot.resolved);
      const name = basename(snapshot.resolved);
      let parentFd: number;
      try {
        parentFd = openSync(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (err) {
        throw new ReadinessError(`${label} parent directory open failed: ${(err as Error).message}`, 'WRITE_FAILED', err);
      }
      parentFds.push(parentFd);
      let parentRealpath: string;
      try {
        parentRealpath = realpathSync(parentPath);
      } catch {
        closeSync(parentFd);
        throw new ReadinessError(`${label} parent directory realpath failed`, 'WRITE_FAILED');
      }
      if (!isInside(root, parentRealpath)) {
        closeSync(parentFd);
        throw new ReadinessError(`${label} parent directory outside project root`, 'WRITE_FAILED');
      }
      const parentStat = fstatSync(parentFd, { bigint: true }) as BigIntStats;
      const stat = snapshot.stat;
      const dirFd = stdio.length;
      stdio.push(parentFd);
      inputList.push({
        label,
        dirFd,
        name,
        type: label === 'MP4' || label === 'Audit output artifact' ? 'media' : 'json',
        expectedSha256: snapshot.sha256,
        expectedStat: {
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String((stat as BigIntStats).mtimeNs ?? stat.mtimeMs),
          ctimeNs: String((stat as BigIntStats).ctimeNs ?? stat.ctimeMs),
          mode: Number(stat.mode) & 0o777,
        },
        expectedParentStat: {
          dev: String(parentStat.dev),
          ino: String(parentStat.ino),
          mode: Number(parentStat.mode) & 0o777,
        },
        expectedRealpath: snapshot.realpath,
        expectedParentRealpath: parentRealpath,
        isMedia: label === 'MP4' || label === 'Audit output artifact',
      });
    }
  } catch (err) {
    for (const fd of parentFds) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
    throw err;
  }

  const contract: PublishContract = {
    outputDirFd: 3,
    reportTempFd: 4,
    finalName,
    reportSha256,
    projectRoot: root,
    outputDirRealpath,
    outputDirStat: {
      dev: String(outputDirStat.dev),
      ino: String(outputDirStat.ino),
      mode: Number(outputDirStat.mode) & 0o777,
    },
    inputs: inputList,
    __testHooks:
      testHooks?.pythonStallBeforeInputCopy ||
      testHooks?.pythonStallAfterInputCopy ||
      testHooks?.reportSealCheck ||
      testHooks?.postLinkFail ||
      testHooks?.postLinkMalformed ||
      testHooks?.postLinkForeignReplace ||
      testHooks?.postLinkReplaceSameBytes ||
      testHooks?.postLinkGrow ||
      testHooks?.pythonStallBeforeFinalLink
        ? {
            stallBeforeInputCopy: testHooks.pythonStallBeforeInputCopy,
            stallAfterInputCopy: testHooks.pythonStallAfterInputCopy,
            reportSealCheck: testHooks.reportSealCheck,
            postLinkFail: testHooks.postLinkFail,
            postLinkMalformed: testHooks.postLinkMalformed,
            postLinkForeignReplace: testHooks.postLinkForeignReplace,
            postLinkReplaceSameBytes: testHooks.postLinkReplaceSameBytes,
            postLinkGrow: testHooks.postLinkGrow,
            stallBeforeFinalLink: testHooks.pythonStallBeforeFinalLink,
          }
        : undefined,
  };

  const contractJson = JSON.stringify(contract);
  const command = testHooks?.publishHelperCommand ?? 'python3';
  const script = testHooks?.publishHelperScript ?? PUBLISH_SCRIPT;
  const timeoutMs = testHooks?.publishHelperTimeoutMs ?? 120_000;

  type PublishResult = {
    ok?: boolean;
    code?: string;
    error?: string;
    errno?: number;
    linked?: boolean;
    outDev?: string;
    outIno?: string;
    outSize?: string;
    outMtimeNs?: string;
    outCtimeNs?: string;
  };

  try {
    // The helper is run with throwOnNonZero=false so we can inspect stdout even
    // when it exits non-zero after a successful os.link.
    const { stdout } = await runProcess(
      command,
      ['-', contractJson],
      Buffer.from(script),
      4096,
      64 * 1024,
      timeoutMs,
      stdio,
      false,
    );

    // The helper may emit multiple JSON lines (status, ok/fail). We parse the
    // last well-formed JSON line; if the last line is malformed, we fall back to
    // the linked-inode status line or to verifyFinalCommit without provenance.
    let lastResult: PublishResult | null = null;
    let linkedStat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } | undefined;
    for (const line of stdout.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as PublishResult;
        if (parsed && typeof parsed === 'object') {
          lastResult = parsed;
          if (parsed.linked && parsed.outDev !== undefined && parsed.outIno !== undefined && parsed.outSize !== undefined) {
            linkedStat = {
              dev: BigInt(parsed.outDev),
              ino: BigInt(parsed.outIno),
              size: BigInt(parsed.outSize),
              mtimeNs: BigInt(parsed.outMtimeNs ?? 0),
              ctimeNs: BigInt(parsed.outCtimeNs ?? 0),
            };
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    }

    if (linkedStat) {
      // The helper linked the report. The final file on disk must be the same
      // inode and contain the expected report bytes. This is the normal success
      // path and the post-link adversarial tests; it is never bypassed.
      const committed = await verifyFinalCommit(dirFh, finalName, reportSha256, reportSize, linkedStat);
      if (committed) {
        return;
      }
    }

    if (lastResult?.code) {
      if (lastResult.code === 'UNSUPPORTED_PLATFORM') {
        throw new ReadinessError(lastResult.error ?? 'publish not supported on this platform', 'UNSUPPORTED_PLATFORM');
      }
      if (lastResult.code === 'OUTPUT_COLLISION') {
        throw new ReadinessError(lastResult.error ?? 'readiness output already exists', 'OUTPUT_COLLISION');
      }
      if (lastResult.code === 'INPUT_CHANGED') {
        throw new ReadinessError(lastResult.error ?? 'input changed at publish boundary', 'INPUT_CHANGED');
      }
      throw new ReadinessError(lastResult.error ?? 'publish failed', lastResult.code);
    }
    throw new ReadinessError('publish helper failed: no parseable result', 'WRITE_FAILED');
  } finally {
    for (const fd of parentFds) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}


async function writeReadinessReportAtomic(
  bytes: Uint8Array,
  reportSha256: string,
  projectRoot: string,
  outputRel: string,
  inputs: WriteReadinessReportInputs,
  options: { __testHooks?: WriteReadinessReportTestHooks } = {},
): Promise<string> {
  if (process.platform !== 'linux') {
    throw new ReadinessError('Atomic publish is only supported on Linux', 'UNSUPPORTED_PLATFORM');
  }

  const root = resolve(projectRoot);
  const outputPath = resolveOutputPath(projectRoot, outputRel);
  const relFromRoot = canonicalRelativePath(root, outputPath);
  const parts = relFromRoot.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) {
    throw new Error('Invalid output path');
  }
  const fileName = parts.pop()!;
  if (!fileName.toLowerCase().endsWith('.json')) {
    throw new Error('Output path must end with .json');
  }

  const rootFh = await open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  const handles: FileHandle[] = [rootFh];
  let dirFh = rootFh;
  let currentPath = root;
  const createdDirs: { parentFh: FileHandle; component: string; parentPath: string }[] = [];

  let originalDirMode: number | undefined;

  try {
    await verifyDirLocationReport(rootFh, root, root);

    for (let i = 0; i < parts.length; i++) {
      const comp = parts[i];
      const nextPath = resolve(currentPath, comp);
      await verifyDirLocationReport(dirFh, currentPath, root);
      const created = await mkdirAtReport(dirFh, comp, currentPath);
      let childFh: FileHandle;
      try {
        childFh = await openAtReport(dirFh, comp, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, currentPath, root);
        handles.push(childFh);
        await verifyDirLocationReport(childFh, nextPath, root);
      } catch (err) {
        if (created) {
          try {
            await rmdirAtReport(dirFh, comp, currentPath);
          } catch {
            // best-effort cleanup of directory we just created
          }
        }
        throw err;
      }
      if (created && i > 0) {
        // The top-level output/ directory is treated as shared; do not remove it.
        createdDirs.push({ parentFh: dirFh, component: comp, parentPath: currentPath });
      }
      dirFh = childFh;
      currentPath = nextPath;
    }

    await verifyDirLocationReport(dirFh, currentPath, root);

    // Capture the original directory mode before the test hook / temp creation,
    // so any failure from this point on can restore the original mode. Failures
    // before this point leave originalDirMode undefined and therefore cannot
    // accidentally chmod the directory to 0.
    const dirStat = (await dirFh.stat({ bigint: true })) as BigIntStats;
    originalDirMode = Number(dirStat.mode) & 0o777;

    await options.__testHooks?.beforeBarrier?.({
      dirFh,
      dirPath: currentPath,
      finalName: fileName,
    });

    // Create an anonymous temporary inode inside the bound output directory.
    // It has no name until it is atomically linked to finalName, so no named
    // writable temp alias can be left behind.
    let tempFh: FileHandle;
    try {
      tempFh = await open(`/proc/self/fd/${dirFh.fd}`, O_TMPFILE | O_RDWR, 0o600);
    } catch (err) {
      throw new ReadinessError('Failed to create anonymous report temp', 'WRITE_FAILED', err);
    }
    handles.push(tempFh);

    try {
      await tempFh.writeFile(bytes);

      await options.__testHooks?.beforeSync?.({
        dirFh,
        dirPath: currentPath,
        finalName: fileName,
      });

      await tempFh.sync();

      await options.__testHooks?.beforeRename?.({
        dirFh,
        dirPath: currentPath,
        finalName: fileName,
      });

      // Verify the anonymous inode content has not been mutated.
      await verifyReportIntegrity(tempFh, reportSha256, 'Readiness report temp');

      // Confirm the target directory is still at the expected path before the
      // final input re-verification.
      await verifyDirLocationReport(dirFh, currentPath, root);

      // Re-verify all four inputs. Any change after the initial read is caught
      // before the report is published.
      await verifyInputsAtPublishBoundary(
        root,
        inputs.mp4Snapshot,
        inputs.auditArtifactSnapshot,
        inputs.auditSnapshot,
        inputs.decisionSnapshot,
        inputs.maxJsonBytes,
        inputs.maxArtifactBytes,
        options.__testHooks,
      );

      // Final commit-protocol hook. Tests may modify inputs here; the
      // synchronous final cross-check immediately below must reject the change.
      await options.__testHooks?.beforePublish?.({
        dirFh,
        dirPath: currentPath,
        finalName: fileName,
      });

      // Synchronous final cross-check immediately before the no-replace publish.
      assertAllInputsStatsUnchangedSync(
        inputs.mp4Snapshot,
        inputs.auditArtifactSnapshot,
        inputs.auditSnapshot,
        inputs.decisionSnapshot,
      );

      // Synchronous directory location check right before the single-step link.
      verifyDirLocationReportSync(dirFh, currentPath, root);

      // Post-stat/helper-start window hook. Tests may modify inputs here; the
      // Python helper's final content/stat re-verification will reject the
      // change before the syscall.
      await options.__testHooks?.beforeRenameat2?.({
        dirFh,
        dirPath: currentPath,
        finalName: fileName,
      });

      await publishAtomicNoReplace(
        dirFh,
        tempFh,
        fileName,
        reportSha256,
        inputs,
        root,
        currentPath,
        options.__testHooks,
      );

      return outputPath;
    } catch (err) {
      // The anonymous inode has no name and is released when all descriptors are closed.
      try {
        await tempFh.close();
      } catch {
        // best-effort
      }
      throw err;
    }
  } catch (err) {
    const cleanupErrors: unknown[] = [];

    for (let i = createdDirs.length - 1; i >= 0; i--) {
      const { parentFh, component, parentPath } = createdDirs[i];
      try {
        await rmdirAtReport(parentFh, component, parentPath);
      } catch (cleanupErr) {
        if (!isCleanupErrorReport(cleanupErr) || cleanupErr.code !== 'ENOTEMPTY') {
          cleanupErrors.push(cleanupErr);
        }
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [err, ...cleanupErrors],
        `write failed: ${(err as Error).message}; cleanup also failed: ${cleanupErrors
          .map((e) => (e as Error).message)
          .join(', ')}`,
      );
    }

    throw err;
  } finally {
    try {
      if (originalDirMode !== undefined) {
        const currentMode = (await dirFh.stat({ bigint: true })) as BigIntStats;
        if ((Number(currentMode.mode) & 0o777) !== originalDirMode) {
          await dirFh.chmod(originalDirMode);
        }
      }
    } catch {
      // best-effort mode restoration
    }
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // closing an fd we no longer need
      }
    }
  }
}
