import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { resolveOutputPath, writeJsonAtomic, type WriteJsonAtomicOptions } from './catalog.js';
import { verifyOutputNotSameAsInput } from './catalog-diff.js';
import { TimelineSchema, sha256File, resolveSafePath, type Timeline, type Clip } from './core.js';
import { isInside } from './thumbnails.js';
import {
  verifySelectedSegmentIntegrity,
  MediaSegmentManifestSchema,
  type MediaSegment,
  type MediaSegmentManifest,
  type SegmentIntegrityResult,
} from './media-segments.js';

const O_RDONLY = constants.O_RDONLY;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_JSON_BYTES = 10 * 1024 * 1024;

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const SegmentSelectionSchema = z
  .object({
    segmentIds: z
      .array(HexSha256Schema)
      .refine((ids) => ids.length >= 1, {
        message: 'At least one segment ID is required',
      })
      .refine((ids) => ids.length <= 5, {
        message: 'At most 5 segment IDs are allowed',
      }),
  })
  .strict();

export interface SegmentSelection {
  segmentIds: string[];
}

export interface ReadJsonFileOptions {
  maxBytes?: number;
  label?: string;
}

export interface ReadJsonFileResult {
  resolved: string;
  realpath: string;
  text: string;
  sha256: string;
  stat: Stats;
  parentStat: Stats;
  parentRealpath: string;
  data: unknown;
}

export interface GenerateAndWriteTimelineOptions {
  projectRoot: string;
  manifestRel: string;
  selectionRel: string;
  inputRoot: string;
  outputRel?: string;
  __testHooks?: {
    writeJsonAtomic?: WriteJsonAtomicOptions['__testHooks'];
  };
}

export interface GenerateAndWriteTimelineResult {
  timeline: Timeline;
  outputPath: string;
  timelineSha256: string;
  manifestSha256: string;
  selectionSha256: string;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return v;
  });
}

export function toDeterministicObject<T>(value: T): unknown {
  return JSON.parse(stableStringify(value));
}

function assertInsideProjectRoot(projectRoot: string, filePath: string, label: string): void {
  if (!isInside(projectRoot, filePath)) {
    throw new Error(`${label} escaped project root: ${filePath}`);
  }
}

export async function readJsonFileSafe(
  projectRoot: string,
  relPath: string,
  options?: ReadJsonFileOptions,
): Promise<ReadJsonFileResult> {
  const label = options?.label ?? 'JSON file';
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_JSON_BYTES;

  const resolved = resolveSafePath(projectRoot, relPath);
  assertInsideProjectRoot(projectRoot, resolved, label);

  const beforeStat = await lstat(resolved);
  if (!beforeStat.isFile()) {
    throw new Error(`${label} is not a regular file: ${relPath}`);
  }
  if (beforeStat.size > maxBytes) {
    throw new Error(`${label} exceeds maximum size: ${beforeStat.size}`);
  }

  const parentPath = dirname(resolved);
  const parentStat = await lstat(parentPath);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`${label} parent is not a directory: ${relPath}`);
  }
  const parentReal = await realpath(parentPath).catch(() => null);
  if (!parentReal || !isInside(projectRoot, parentReal)) {
    throw new Error(`${label} parent escaped project root: ${relPath}`);
  }

  const fh = await open(resolved, O_RDONLY | O_NOFOLLOW);
  let buffer: Buffer;
  try {
    const statBeforeOpen = await fh.stat();
    if (
      statBeforeOpen.dev !== beforeStat.dev ||
      statBeforeOpen.ino !== beforeStat.ino ||
      statBeforeOpen.size !== beforeStat.size ||
      statBeforeOpen.mtimeMs !== beforeStat.mtimeMs
    ) {
      throw new Error(`${label} was replaced between lstat and open: ${relPath}`);
    }
    if (!statBeforeOpen.isFile()) {
      throw new Error(`${label} is not a regular file: ${relPath}`);
    }
    if (statBeforeOpen.size > maxBytes) {
      throw new Error(`${label} exceeds maximum size: ${statBeforeOpen.size}`);
    }

    const fileSize = statBeforeOpen.size;
    const readBuffer = Buffer.alloc(fileSize);
    let offset = 0;
    while (offset < fileSize) {
      const toRead = Math.min(CHUNK_SIZE, fileSize - offset);
      const { bytesRead } = await fh.read(readBuffer, offset, toRead, offset);
      if (bytesRead === 0) {
        throw new Error(`${label} shrank during read: ${offset} of ${fileSize} bytes`);
      }
      offset += bytesRead;
    }

    const eofBuf = Buffer.alloc(1);
    const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
    if (eofRead !== 0) {
      throw new Error(`${label} grew during read`);
    }

    const afterStat = await fh.stat();
    if (
      afterStat.dev !== statBeforeOpen.dev ||
      afterStat.ino !== statBeforeOpen.ino ||
      afterStat.size !== statBeforeOpen.size ||
      afterStat.mtimeMs !== statBeforeOpen.mtimeMs
    ) {
      throw new Error(`${label} changed during read`);
    }

    buffer = readBuffer;
  } finally {
    await fh.close().catch(() => {});
  }

  const real = await realpath(resolved).catch(() => null);
  if (!real || !isInside(projectRoot, real)) {
    throw new Error(`${label} escaped project root after read`);
  }
  if (dirname(real) !== parentReal) {
    throw new Error(`${label} realpath is not directly inside its parent: ${relPath}`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8: ${relPath}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON: ${relPath}`);
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return { resolved, realpath: real, text, sha256, stat: beforeStat, parentStat, parentRealpath: parentReal, data };
}

async function readManifest(
  projectRoot: string,
  relPath: string,
): Promise<{ resolved: string; realpath: string; sha256: string; stat: Stats; manifest: MediaSegmentManifest }> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Media segment manifest',
  });
  const manifest = MediaSegmentManifestSchema.parse(result.data);
  return { resolved: result.resolved, realpath: result.realpath, sha256: result.sha256, stat: result.stat, manifest };
}

async function readSelection(
  projectRoot: string,
  relPath: string,
): Promise<{ resolved: string; realpath: string; sha256: string; stat: Stats; selection: SegmentSelection }> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Segment selection',
  });
  const selection = SegmentSelectionSchema.parse(result.data);
  return { resolved: result.resolved, realpath: result.realpath, sha256: result.sha256, stat: result.stat, selection };
}

export function normalizeTimelineOutputRel(outputRel: string): string {
  if (typeof outputRel !== 'string') {
    throw new Error('Output path must be a string');
  }
  if (outputRel.includes('\0')) {
    throw new Error(`Null bytes are not allowed in output path: ${outputRel}`);
  }
  if (/^[A-Za-z]:/.test(outputRel)) {
    throw new Error(`Windows drive paths are not allowed: ${outputRel}`);
  }
  if (outputRel.startsWith('\\\\')) {
    throw new Error(`UNC paths are not allowed: ${outputRel}`);
  }
  const normalized = outputRel.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new Error(`Absolute paths are not allowed: ${outputRel}`);
  }
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new Error(`Path traversal is not allowed: ${outputRel}`);
  }
  if (parts.length > 0 && parts[0] === 'output') {
    parts.shift();
  }
  if (
    parts.length !== 2 ||
    parts[0] !== 'timelines' ||
    !parts[1].toLowerCase().endsWith('.json')
  ) {
    throw new Error(`Output path must be timelines/<file>.json: ${outputRel}`);
  }
  return parts.join('/');
}

export function deriveTimelineOutputPath(outputRel: string): string {
  const normalized = normalizeTimelineOutputRel(outputRel);
  // normalizeTimelineOutputRel already enforces a .json suffix under timelines/.
  return `${normalized.slice(0, -5)}.mp4`;
}

export function buildTimelineFromManifestAndSelection(
  manifest: MediaSegmentManifest,
  selection: SegmentSelection,
  timelineOutputPath: string,
): Timeline {
  if (selection.segmentIds.length === 0) {
    throw new Error('At least one segment ID is required');
  }
  if (selection.segmentIds.length > 5) {
    throw new Error('At most 5 segment IDs are allowed');
  }

  const segmentMap = new Map<string, MediaSegment>();
  for (const segment of manifest.segments) {
    if (segmentMap.has(segment.segmentId)) {
      throw new Error(`Duplicate segment ID in manifest: ${segment.segmentId}`);
    }
    segmentMap.set(segment.segmentId, segment);
  }

  const seen = new Set<string>();
  const clips: Clip[] = [];
  let currentStart = 0;

  for (const segmentId of selection.segmentIds) {
    if (seen.has(segmentId)) {
      throw new Error(`Duplicate segment ID: ${segmentId}`);
    }
    seen.add(segmentId);

    const segment = segmentMap.get(segmentId);
    if (!segment) {
      throw new Error(`Unknown segment ID: ${segmentId}`);
    }
    if (segment.mediaType !== 'video') {
      throw new Error(`Segment ${segmentId} is not a video segment`);
    }

    const duration = segment.end - segment.start;
    if (!(duration > 0) || !Number.isFinite(duration)) {
      throw new Error(`Segment ${segmentId} has invalid duration`);
    }

    clips.push({
      type: 'video',
      source: segment.relativePath,
      start: currentStart,
      end: currentStart + duration,
      in: segment.start,
      out: segment.end,
      fit: 'cover',
      x: 0,
      y: 0,
    });

    currentStart += duration;
  }

  const timeline: Timeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: timelineOutputPath,
    background: '000000',
    outputPreset: 'preview',
    clips,
  };

  return TimelineSchema.parse(timeline);
}

async function verifyInputUnchanged(
  resolved: string,
  beforeSha256: string,
  beforeStat: Stats,
  beforeRealpath: string,
  trustedRoot: string,
  label: string,
): Promise<void> {
  const real = await realpath(resolved).catch(() => null);
  if (!real || !isInside(trustedRoot, real)) {
    throw new Error(`${label} escaped trusted root before publish: ${resolved}`);
  }
  if (real !== beforeRealpath) {
    throw new Error(`${label} canonical path changed before publish: ${resolved}`);
  }

  const afterStat = await lstat(resolved);
  if (afterStat.isSymbolicLink()) {
    throw new Error(`${label} became a symbolic link: ${resolved}`);
  }
  if (
    afterStat.dev !== beforeStat.dev ||
    afterStat.ino !== beforeStat.ino ||
    afterStat.size !== beforeStat.size ||
    afterStat.mtimeMs !== beforeStat.mtimeMs
  ) {
    throw new Error(`${label} stat changed before publish: ${resolved}`);
  }
  const afterSha256 = await sha256File(resolved);
  if (afterSha256 !== beforeSha256) {
    throw new Error(`${label} content changed before publish: ${resolved}`);
  }
}

export async function generateAndWriteTimeline(
  options: GenerateAndWriteTimelineOptions,
): Promise<GenerateAndWriteTimelineResult> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);
  if (!isInside(projectRoot, inputRoot)) {
    throw new Error(`Input root escaped project root: ${options.inputRoot}`);
  }
  const outputRel = normalizeTimelineOutputRel(options.outputRel ?? 'timelines/selection.json');

  const {
    resolved: manifestResolved,
    realpath: manifestRealpath,
    sha256: manifestSha256,
    stat: manifestStat,
    manifest,
  } = await readManifest(projectRoot, options.manifestRel);
  const {
    resolved: selectionResolved,
    realpath: selectionRealpath,
    sha256: selectionSha256,
    stat: selectionStat,
    selection,
  } = await readSelection(projectRoot, options.selectionRel);

  const timelineOutputPath = deriveTimelineOutputPath(outputRel);
  const timeline = buildTimelineFromManifestAndSelection(manifest, selection, timelineOutputPath);
  const timelineData = toDeterministicObject(timeline);
  const expectedOutputBytes = Buffer.from(JSON.stringify(timelineData, null, 2) + '\n', 'utf8');
  const expectedOutputSha = createHash('sha256').update(expectedOutputBytes).digest('hex');

  const safeOutput = resolveOutputPath(projectRoot, outputRel);
  await verifyOutputNotSameAsInput(projectRoot, safeOutput, manifestResolved);
  await verifyOutputNotSameAsInput(projectRoot, safeOutput, selectionResolved);

  const sourceSnapshots: (SegmentIntegrityResult & { relativePath: string })[] = [];
  const seenSourceInodes = new Map<string, string>();
  for (const segmentId of selection.segmentIds) {
    const segment = manifest.segments.find((s) => s.segmentId === segmentId);
    if (!segment) continue;
    const snapshot = await verifySelectedSegmentIntegrity(
      projectRoot,
      inputRoot,
      segment,
      manifest.schemaVersion,
    );
    if (snapshot.stat.nlink > 1) {
      throw new Error(`Selected source is a hard link or has multiple links: ${segment.relativePath}`);
    }
    const inodeKey = `${snapshot.stat.dev}:${snapshot.stat.ino}`;
    const existingPath = seenSourceInodes.get(inodeKey);
    if (existingPath !== undefined) {
      if (existingPath !== segment.relativePath) {
        throw new Error(
          `Selected source shares an inode with ${existingPath} but has a different path: ${segment.relativePath}`,
        );
      }
      continue;
    }
    seenSourceInodes.set(inodeKey, segment.relativePath);
    sourceSnapshots.push({ ...snapshot, relativePath: segment.relativePath });
  }

  async function verifyInputs(): Promise<void> {
    await verifyInputUnchanged(
      manifestResolved,
      manifestSha256,
      manifestStat,
      manifestRealpath,
      projectRoot,
      'Media segment manifest',
    );
    await verifyInputUnchanged(
      selectionResolved,
      selectionSha256,
      selectionStat,
      selectionRealpath,
      projectRoot,
      'Segment selection',
    );
    for (const snap of sourceSnapshots) {
      await verifyInputUnchanged(
        snap.resolved,
        snap.sha256,
        snap.stat,
        snap.realpath,
        inputRoot,
        'Selected source',
      );
    }
  }

  const injectedBeforeRename = options.__testHooks?.writeJsonAtomic?.beforeRename;
  const outputPath = await writeJsonAtomic(
    timelineData,
    projectRoot,
    outputRel,
    inputRoot,
    {
      __testHooks: {
        ...(options.__testHooks?.writeJsonAtomic ?? {}),
        beforeRename: async (ctx) => {
          await injectedBeforeRename?.(ctx);
          // Final commit barrier: all inputs must be unchanged and at the same
          // canonical, trusted-root location right before the atomic rename.
          await verifyInputs();
        },
      },
      verify: { expectedSha256: expectedOutputSha },
    },
  );

  return {
    timeline,
    outputPath,
    timelineSha256: expectedOutputSha,
    manifestSha256,
    selectionSha256,
  };
}
