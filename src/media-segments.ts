import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import type { Catalog, CatalogEntry, WriteJsonAtomicOptions } from './catalog.js';
import { resolveOutputPath, writeJsonAtomic } from './catalog.js';
import { verifyOutputNotSameAsInput } from './catalog-diff.js';
import { resolveSafePath, type ProbeInfo } from './core.js';
import { isInside } from './thumbnails.js';

const O_RDONLY = constants.O_RDONLY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK_SIZE = 64 * 1024;

export const SEGMENT_SCHEMA_VERSION = 'v1';
export const MEDIA_SUBRANGE_SCHEMA_VERSION = 'v2';

export type MediaSegmentExclusionReason =
  | 'ERROR_ENTRY'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_DURATION'
  | 'MISSING_ID'
  | 'MISSING_PROBE';

export interface MediaSegment {
  segmentId: string;
  assetContentId: string;
  relativePath: string;
  mediaType: 'video' | 'audio';
  start: number;
  end: number;
  duration: number;
}

export interface MediaSegmentExcludedEntry {
  relativePath: string;
  reason: MediaSegmentExclusionReason;
}

export interface MediaSegmentManifest {
  schemaVersion: string;
  count: number;
  excludedCount: number;
  excluded: MediaSegmentExcludedEntry[];
  segments: MediaSegment[];
}

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ExclusionReasonSchema = z.enum([
  'ERROR_ENTRY',
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_DURATION',
  'MISSING_ID',
  'MISSING_PROBE',
]);

export const MediaSegmentV1Schema = z
  .object({
    segmentId: HexSha256Schema,
    assetContentId: HexSha256Schema,
    relativePath: z.string().min(1),
    mediaType: z.enum(['video', 'audio']),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    duration: z.number().finite().positive(),
  })
  .strict()
  .refine((s) => s.start < s.end, {
    message: 'segment start must be less than end',
    path: ['start'],
  })
  .refine((s) => s.start === 0, {
    message: 'segment start must be 0 (KER-313 v1 contract)',
    path: ['start'],
  })
  .refine((s) => s.end === s.duration, {
    message: 'segment end must equal duration (KER-313 v1 contract)',
    path: ['end'],
  });

export const MediaSegmentV2Schema = z
  .object({
    segmentId: HexSha256Schema,
    assetContentId: HexSha256Schema,
    relativePath: z.string().min(1),
    mediaType: z.enum(['video', 'audio']),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    duration: z.number().finite().positive(),
  })
  .strict()
  .refine((s) => s.start < s.end, {
    message: 'segment start must be less than end',
    path: ['start'],
  })
  .refine((s) => s.end <= s.duration, {
    message: 'segment end must not exceed source duration',
    path: ['end'],
  });

export const MediaSegmentSchema = z.union([MediaSegmentV1Schema, MediaSegmentV2Schema]);

export const MediaSegmentExcludedEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    reason: ExclusionReasonSchema,
  })
  .strict();

const MediaSegmentManifestV1Schema = z
  .object({
    schemaVersion: z.literal('v1'),
    count: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    excluded: z.array(MediaSegmentExcludedEntrySchema),
    segments: z.array(MediaSegmentV1Schema),
  })
  .strict()
  .refine((m) => m.count === m.segments.length, {
    message: 'manifest count does not match segments length',
    path: ['count'],
  })
  .refine((m) => m.excludedCount === m.excluded.length, {
    message: 'manifest excludedCount does not match excluded length',
    path: ['excludedCount'],
  })
  .refine(
    (m) => {
      const seen = new Set<string>();
      for (const s of m.segments) {
        if (seen.has(s.segmentId)) return false;
        seen.add(s.segmentId);
      }
      return true;
    },
    {
      message: 'Duplicate segment ID in manifest',
      path: ['segments'],
    },
  );

const MediaSegmentManifestV2Schema = z
  .object({
    schemaVersion: z.literal('v2'),
    count: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    excluded: z.array(MediaSegmentExcludedEntrySchema),
    segments: z.array(MediaSegmentV2Schema),
  })
  .strict()
  .refine((m) => m.count === m.segments.length, {
    message: 'manifest count does not match segments length',
    path: ['count'],
  })
  .refine((m) => m.excludedCount === m.excluded.length, {
    message: 'manifest excludedCount does not match excluded length',
    path: ['excludedCount'],
  })
  .refine(
    (m) => {
      const seen = new Set<string>();
      for (const s of m.segments) {
        if (seen.has(s.segmentId)) return false;
        seen.add(s.segmentId);
      }
      return true;
    },
    {
      message: 'Duplicate segment ID in manifest',
      path: ['segments'],
    },
  );

export const MediaSegmentManifestSchema = z.union([MediaSegmentManifestV1Schema, MediaSegmentManifestV2Schema]);

export interface WriteMediaSegmentManifestOptions extends WriteJsonAtomicOptions {
  previousCatalogPath?: string;
}

export interface GenerateMediaSegmentManifestOptions {
  projectRoot: string;
  outputRel?: string;
  inputRoot: string;
  previousCatalogPath?: string;
  __testHooks?: WriteJsonAtomicOptions['__testHooks'];
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

function isValidDuration(duration: unknown): duration is number {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

export function getExclusionReason(entry: CatalogEntry): MediaSegmentExclusionReason | null {
  if (entry.error) return 'ERROR_ENTRY';
  if (entry.id === undefined) return 'MISSING_ID';
  if (!entry.probe) return 'MISSING_PROBE';
  const mediaType = entry.probe.type;
  if (mediaType !== 'video' && mediaType !== 'audio') return 'UNSUPPORTED_MEDIA_TYPE';
  if (!isValidDuration(entry.probe.duration)) return 'INVALID_DURATION';
  return null;
}

interface StableSegmentInput {
  assetContentId: string;
  relativePath: string;
  mediaType: 'video' | 'audio';
  start: number;
  end: number;
  duration: number;
  schemaVersion?: string;
}

function stableSegmentPayload(input: StableSegmentInput): string {
  const payload = {
    assetContentId: input.assetContentId,
    duration: input.duration,
    end: input.end,
    mediaType: input.mediaType,
    relativePath: input.relativePath,
    schemaVersion: input.schemaVersion ?? SEGMENT_SCHEMA_VERSION,
    start: input.start,
  };
  return JSON.stringify(payload);
}

export function computeSegmentId(input: StableSegmentInput): string {
  return createHash('sha256').update(stableSegmentPayload(input)).digest('hex');
}

export interface SegmentIntegrityResult {
  resolved: string;
  realpath: string;
  stat: Stats;
  parentStat: Stats;
  parentRealpath: string;
  sha256: string;
  probeDuration: number;
  mediaType: 'video' | 'audio';
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
}

interface FfprobeResult {
  streams: FfprobeStream[];
  format?: { duration?: string };
}

function parseDurationString(value: string | undefined): number {
  if (value === undefined) return NaN;
  return Number(value);
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value.includes('/')) {
    const [num, den] = value.split('/').map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
    const rate = num / den;
    return Number.isFinite(rate) ? rate : undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseFfprobeOutput(stdout: string): ProbeInfo {
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

async function sha256FromFd(fh: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const readBuffer = Buffer.alloc(CHUNK_SIZE);
  let offset = 0;
  while (offset < size) {
    const toRead = Math.min(CHUNK_SIZE, size - offset);
    const { bytesRead } = await fh.read(readBuffer, 0, toRead, offset);
    if (bytesRead === 0) {
      throw new Error(`File shrank during hash read: ${offset} of ${size} bytes`);
    }
    hash.update(readBuffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const eofBuf = Buffer.alloc(1);
  const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, size);
  if (eofRead !== 0) {
    throw new Error('File grew during hash read');
  }
  return hash.digest('hex');
}

const FFPROBE_TIMEOUT_MS = 30_000;
const FFPROBE_KILL_TIMEOUT_MS = 5_000;
const FFPROBE_MAX_STDOUT_BYTES = 1 * 1024 * 1024;
const FFPROBE_MAX_STDERR_BYTES = 64 * 1024;

function validateBoundedOption(name: string, value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${name} must be a finite positive safe integer`);
  }
  return value;
}

export interface FfprobeFromFdOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  command?: string;
}

export function ffprobeFromFd(fd: number, options?: FfprobeFromFdOptions): Promise<ProbeInfo> {
  const command = options?.command ?? 'ffprobe';
  const timeoutMs = validateBoundedOption('timeoutMs', options?.timeoutMs, FFPROBE_TIMEOUT_MS);
  const maxStdoutBytes = validateBoundedOption(
    'maxStdoutBytes',
    options?.maxStdoutBytes,
    FFPROBE_MAX_STDOUT_BYTES,
  );
  const maxStderrBytes = validateBoundedOption(
    'maxStderrBytes',
    options?.maxStderrBytes,
    FFPROBE_MAX_STDERR_BYTES,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '/dev/fd/3'],
      { stdio: ['ignore', 'pipe', 'pipe', fd] },
    );
    if (!child.stdout || !child.stderr) {
      child.kill();
      reject(new Error('ffprobe stdio unavailable'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    let killed = false;
    let abortReason: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    function finish(error: Error | null, value?: ProbeInfo): void {
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
      }, FFPROBE_KILL_TIMEOUT_MS);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) terminate(new Error(`ffprobe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
      if (stdoutLen > maxStdoutBytes) {
        terminate(new Error(`ffprobe stdout exceeded ${maxStdoutBytes} bytes`));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      const take = Math.min(chunk.length, Math.max(0, maxStderrBytes - stderrLen));
      if (take > 0) stderrChunks.push(chunk.subarray(0, take));
      stderrLen += chunk.length;
      if (stderrLen > maxStderrBytes) {
        terminate(new Error(`ffprobe stderr exceeded ${maxStderrBytes} bytes`));
      }
    });

    child.on('error', (err) => finish(err));

    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (killed) {
        finish(abortReason ?? new Error(`ffprobe killed (signal ${signal ?? 'unknown'}): ${stderr.slice(-2000)}`));
      } else if (code !== 0 || signal) {
        finish(new Error(`ffprobe failed with ${code} (signal ${signal ?? 'none'}): ${stderr.slice(-2000)}`));
      } else {
        try {
          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          finish(null, parseFfprobeOutput(stdout));
        } catch (err) {
          finish(err as Error);
        }
      }
    });
  });
}

function statsEqual(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

export async function verifySelectedSegmentIntegrity(
  projectRoot: string,
  inputRoot: string,
  segment: MediaSegment,
  schemaVersion: string = SEGMENT_SCHEMA_VERSION,
): Promise<SegmentIntegrityResult> {
  const resolvedSource = resolveSafePath(inputRoot, segment.relativePath);
  const realSource = await realpath(resolvedSource).catch(() => null);
  if (!realSource || !isInside(inputRoot, realSource) || !isInside(projectRoot, realSource)) {
    throw new Error(
      `Segment ${segment.segmentId} source escaped input root (Path escapes base directory): ${segment.relativePath}`,
    );
  }

  const beforeLstat = await lstat(resolvedSource);
  if (beforeLstat.isSymbolicLink() || !beforeLstat.isFile()) {
    throw new Error(
      `Segment ${segment.segmentId} source is not a regular file: ${segment.relativePath}`,
    );
  }

  const parentPath = dirname(resolvedSource);
  const parentStat = await lstat(parentPath);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(
      `Segment ${segment.segmentId} parent is not a directory: ${segment.relativePath}`,
    );
  }
  const parentReal = await realpath(parentPath).catch(() => null);
  if (!parentReal || !isInside(inputRoot, parentReal) || !isInside(projectRoot, parentReal)) {
    throw new Error(
      `Segment ${segment.segmentId} parent escaped input root: ${segment.relativePath}`,
    );
  }

  const assetFh = await open(resolvedSource, O_RDONLY | O_NOFOLLOW);
  try {
    const statBeforeOpen = await assetFh.stat();
    if (
      statBeforeOpen.dev !== beforeLstat.dev ||
      statBeforeOpen.ino !== beforeLstat.ino ||
      statBeforeOpen.size !== beforeLstat.size ||
      statBeforeOpen.mtimeMs !== beforeLstat.mtimeMs
    ) {
      throw new Error(
        `Segment ${segment.segmentId} source was replaced between lstat and open: ${segment.relativePath}`,
      );
    }
    if (statBeforeOpen.isSymbolicLink() || !statBeforeOpen.isFile()) {
      throw new Error(
        `Segment ${segment.segmentId} source is not a regular file: ${segment.relativePath}`,
      );
    }

    const actualContentId = await sha256FromFd(assetFh, statBeforeOpen.size);
    if (actualContentId !== segment.assetContentId) {
      throw new Error(
        `Segment ${segment.segmentId} assetContentId mismatch (SHA-256 mismatch): expected ${segment.assetContentId}, got ${actualContentId}`,
      );
    }

    const statAfterHash = await assetFh.stat();
    if (!statsEqual(statBeforeOpen, statAfterHash)) {
      throw new Error(
        `Segment ${segment.segmentId} source changed during hash read: ${segment.relativePath}`,
      );
    }

    const probe = await ffprobeFromFd(assetFh.fd);
    const statAfterProbe = await assetFh.stat();
    if (!statsEqual(statBeforeOpen, statAfterProbe)) {
      throw new Error(
        `Segment ${segment.segmentId} source changed during ffprobe: ${segment.relativePath}`,
      );
    }

    const derivedMediaType = probe.hasVideo ? 'video' : probe.hasAudio ? 'audio' : undefined;
    if (derivedMediaType !== segment.mediaType) {
      throw new Error(
        `Segment ${segment.segmentId} media type mismatch (Media type mismatch): expected ${segment.mediaType}, got ${derivedMediaType ?? 'unknown'}`,
      );
    }
    if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
      throw new Error(
        `Segment ${segment.segmentId} source has no positive duration (Duration mismatch): ${segment.relativePath}`,
      );
    }
    if (Math.abs(probe.duration - segment.duration) > 1e-6) {
      throw new Error(
        `Segment ${segment.segmentId} duration mismatch (Duration mismatch): expected ${segment.duration}, got ${probe.duration}`,
      );
    }
    if (segment.start < 0) {
      throw new Error(
        `Segment ${segment.segmentId} start must be non-negative: ${segment.relativePath}`,
      );
    }
    if (segment.end <= segment.start) {
      throw new Error(
        `Segment ${segment.segmentId} end must be greater than start: ${segment.relativePath}`,
      );
    }
    if (segment.end > probe.duration + 1e-6) {
      throw new Error(
        `Segment ${segment.segmentId} end (${segment.end}) exceeds source duration (${probe.duration}) (duration mismatch): ${segment.relativePath}`,
      );
    }
    if (schemaVersion === SEGMENT_SCHEMA_VERSION) {
      if (segment.start !== 0) {
        throw new Error(`Segment ${segment.segmentId} start must be 0 (invalid segmentId): ${segment.relativePath}`);
      }
      if (segment.end !== segment.duration) {
        throw new Error(`Segment ${segment.segmentId} end must equal duration (invalid segmentId): ${segment.relativePath}`);
      }
    }

    const expectedSegmentId = computeSegmentId({
      assetContentId: segment.assetContentId,
      relativePath: segment.relativePath,
      mediaType: segment.mediaType,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      schemaVersion,
    });
    if (expectedSegmentId !== segment.segmentId) {
      throw new Error(
        `Segment ${segment.segmentId} has invalid segmentId (Segment ID mismatch): expected ${expectedSegmentId}`,
      );
    }

    if (!realSource || dirname(realSource) !== parentReal) {
      throw new Error(
        `Segment ${segment.segmentId} realpath is not directly inside its parent: ${segment.relativePath}`,
      );
    }

    return {
      resolved: resolvedSource,
      realpath: realSource,
      stat: statBeforeOpen,
      parentStat,
      parentRealpath: parentReal,
      sha256: actualContentId,
      probeDuration: probe.duration,
      mediaType: derivedMediaType as 'video' | 'audio',
    };
  } finally {
    await assetFh.close().catch(() => {});
  }
}

export function buildMediaSegmentManifest(catalog: Catalog): MediaSegmentManifest {
  const segments: MediaSegment[] = [];
  const excluded: MediaSegmentExcludedEntry[] = [];

  for (const entry of catalog.assets) {
    const reason = getExclusionReason(entry);
    if (reason) {
      excluded.push({ relativePath: entry.relativePath, reason });
      continue;
    }

    const mediaType = entry.probe!.type as 'video' | 'audio';
    const duration = entry.probe!.duration as number;
    const start = 0;
    const end = duration;
    const segmentId = computeSegmentId({
      assetContentId: entry.id!,
      relativePath: entry.relativePath,
      mediaType,
      start,
      end,
      duration,
      schemaVersion: SEGMENT_SCHEMA_VERSION,
    });

    segments.push({
      segmentId,
      assetContentId: entry.id!,
      relativePath: entry.relativePath,
      mediaType,
      start,
      end,
      duration,
    });
  }

  segments.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  excluded.sort((a, b) => {
    const cmp = compareUtf8(a.relativePath, b.relativePath);
    if (cmp !== 0) return cmp;
    return compareUtf8(a.reason, b.reason);
  });

  return {
    schemaVersion: SEGMENT_SCHEMA_VERSION,
    count: segments.length,
    excludedCount: excluded.length,
    excluded,
    segments,
  };
}

export async function writeMediaSegmentManifest(
  manifest: MediaSegmentManifest,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  options?: WriteMediaSegmentManifestOptions,
): Promise<string> {
  if (options?.previousCatalogPath) {
    const safeOutput = resolveOutputPath(projectRoot, outputRel);
    await verifyOutputNotSameAsInput(projectRoot, safeOutput, options.previousCatalogPath);
  }
  return writeJsonAtomic(manifest, projectRoot, outputRel, inputRoot, options);
}

export async function generateAndWriteMediaSegmentManifest(
  catalog: Catalog,
  options: GenerateMediaSegmentManifestOptions,
): Promise<{ manifest: MediaSegmentManifest; outputPath: string }> {
  const manifest = buildMediaSegmentManifest(catalog);
  const outputRel = options.outputRel ?? 'media-segments/manifest.json';
  const outputPath = await writeMediaSegmentManifest(
    manifest,
    options.projectRoot,
    outputRel,
    options.inputRoot,
    {
      previousCatalogPath: options.previousCatalogPath,
      __testHooks: options.__testHooks,
    },
  );
  return { manifest, outputPath };
}
