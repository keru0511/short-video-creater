import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog, CatalogEntry } from './catalog.js';
import { resolveSafePath } from './core.js';
import {
  computeSegmentId,
  getExclusionReason,
  MEDIA_SUBRANGE_SCHEMA_VERSION,
  verifySelectedSegmentIntegrity,
  type MediaSegment,
  type MediaSegmentExcludedEntry,
  type MediaSegmentManifest,
  type SegmentIntegrityResult,
} from './media-segments.js';
import {
  toDeterministicObject,
  stableStringify,
  readJsonFileSafe,
  type ReadJsonFileResult,
} from './segment-selection.js';
import { isInside } from './thumbnails.js';
import {
  assertNoDuplicateKeys,
  captureInputSnapshot,
  type PublishInput,
  publishAtomicNoReplace,
  type PublishAtomicNoReplaceOptions,
  type PublishAtomicTestHooks,
} from './transcript-manifest.js';
import { parseCatalog, DEFAULT_MAX_CATALOG_ASSETS } from './catalog-diff.js';

const DEFAULT_MAX_SUBRANGE_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CATALOG_BYTES = 100 * 1024 * 1024;
const MAX_RANGES = 100;

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const MediaSubrangeSchema = z
  .object({
    assetContentId: HexSha256Schema,
    relativePath: z.string().min(1),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((s) => s.start < s.end, {
    message: 'sub-range start must be less than end',
    path: ['start'],
  });

const MediaSubrangeRequestSchema = z
  .object({
    schemaVersion: z.literal('v1'),
    ranges: z.array(MediaSubrangeSchema).min(1).max(MAX_RANGES),
  })
  .strict();

export type MediaSubrange = z.infer<typeof MediaSubrangeSchema>;
export type MediaSubrangeRequest = z.infer<typeof MediaSubrangeRequestSchema>;

export interface ReadMediaSubrangeRequestResult extends ReadJsonFileResult {
  request: MediaSubrangeRequest;
}

export interface MediaSubrangeManifestBuildResult {
  manifest: MediaSegmentManifest;
  verifiedAssets: Map<string, SegmentIntegrityResult & { relativePath: string }>;
}

export interface MediaSubrangeTestHooks extends PublishAtomicTestHooks {
  beforeCatalogParse?: (ctx: {
    resolved: string;
    realpath: string;
    stat: Stats;
    sha256: string;
    text: string;
  }) => Promise<void>;
  beforePublish?: () => Promise<void>;
}

export interface GenerateAndWriteMediaSubrangeManifestOptions {
  projectRoot: string;
  inputRoot: string;
  catalogRel: string;
  rangeRequestRel: string;
  outputRel?: string;
  __testHooks?: MediaSubrangeTestHooks;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

function isCanonicalRelativePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (relPath.includes('\0')) return false;
  if (/^[A-Za-z]:[/\\]/.test(relPath)) return false;
  if (relPath.startsWith('\\\\')) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;

  const normalized = relPath.replace(/\\/g, '/');
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
  }
  return true;
}

function canonicalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.').join('/');
}

export function normalizeMediaSubrangeOutputRel(outputRel: string): string {
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
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`Invalid output path component in: ${outputRel}`);
    }
  }
  if (parts.length > 0 && parts[0] === 'output') {
    parts.shift();
  }
  if (parts.length === 0) {
    throw new Error(`Invalid output path: ${outputRel}`);
  }
  if (!parts[parts.length - 1].toLowerCase().endsWith('.json')) {
    throw new Error('Output path must end with .json');
  }
  return parts.join('/');
}

export async function readMediaSubrangeRequest(
  projectRoot: string,
  relPath: string,
  options?: { maxBytes?: number },
): Promise<ReadMediaSubrangeRequestResult> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Media subrange request',
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_SUBRANGE_REQUEST_BYTES,
  });
  assertNoDuplicateKeys(result.text);
  const request = MediaSubrangeRequestSchema.parse(result.data);
  return { ...result, request };
}

function validateRangeAgainstVerified(
  segment: MediaSegment,
  verified: SegmentIntegrityResult,
): void {
  if (Math.abs(verified.probeDuration - segment.duration) > 1e-6) {
    throw new Error(
      `Segment ${segment.segmentId} duration mismatch (Duration mismatch): expected ${segment.duration}, got ${verified.probeDuration}`,
    );
  }
  if (segment.start < 0) {
    throw new Error(`Segment ${segment.segmentId} start must be non-negative: ${segment.relativePath}`);
  }
  if (segment.end <= segment.start) {
    throw new Error(`Segment ${segment.segmentId} end must be greater than start: ${segment.relativePath}`);
  }
  if (segment.end > verified.probeDuration + 1e-6) {
    throw new Error(
      `Segment ${segment.segmentId} end (${segment.end}) exceeds source duration (${verified.probeDuration}) (duration mismatch): ${segment.relativePath}`,
    );
  }

  const expectedSegmentId = computeSegmentId({
    assetContentId: segment.assetContentId,
    relativePath: segment.relativePath,
    mediaType: segment.mediaType,
    start: segment.start,
    end: segment.end,
    duration: segment.duration,
    schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
  });
  if (expectedSegmentId !== segment.segmentId) {
    throw new Error(
      `Segment ${segment.segmentId} has invalid segmentId (Segment ID mismatch): expected ${expectedSegmentId}`,
    );
  }
}

async function verifyRange(
  projectRoot: string,
  inputRoot: string,
  segment: MediaSegment,
  verifiedByInputPath: Map<string, SegmentIntegrityResult>,
): Promise<SegmentIntegrityResult> {
  // Cache by the exact requested pathname so that two sub-ranges of the same file
  // share one ffprobe, but a different pathname (symlink/hard-link alias) is always
  // verified independently via lstat / O_NOFOLLOW / parent identity.
  const resolvedSource = resolveSafePath(inputRoot, segment.relativePath);

  const cached = verifiedByInputPath.get(resolvedSource);
  if (cached) {
    validateRangeAgainstVerified(segment, cached);
    return cached;
  }

  const verified = await verifySelectedSegmentIntegrity(
    projectRoot,
    inputRoot,
    segment,
    MEDIA_SUBRANGE_SCHEMA_VERSION,
  );
  validateRangeAgainstVerified(segment, verified);
  verifiedByInputPath.set(resolvedSource, verified);
  return verified;
}

export async function buildMediaSubrangeManifest(
  options: {
    projectRoot: string;
    inputRoot: string;
    catalog: Catalog;
    request: MediaSubrangeRequest;
  },
): Promise<MediaSubrangeManifestBuildResult> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);
  if (!isInside(projectRoot, inputRoot)) {
    throw new Error(`Input root escaped project root: ${options.inputRoot}`);
  }

  const catalogByPath = new Map<string, CatalogEntry>();
  for (const entry of options.catalog.assets) {
    if (catalogByPath.has(entry.relativePath)) {
      throw new Error(`Duplicate relativePath in catalog: ${entry.relativePath}`);
    }
    catalogByPath.set(entry.relativePath, entry);
  }

  const requestedRangeKeys = new Set<string>();
  const verifiedByInputPath = new Map<string, SegmentIntegrityResult>();
  const seenInodes = new Map<string, string>();
  const verifiedAssets = new Map<string, SegmentIntegrityResult & { relativePath: string }>();
  const segments: MediaSegment[] = [];

  for (const range of options.request.ranges) {
    MediaSubrangeSchema.parse(range);
    if (!isCanonicalRelativePath(range.relativePath)) {
      throw new Error(`Invalid relativePath in range request: ${range.relativePath}`);
    }
    const canonicalRel = canonicalizeRelativePath(range.relativePath);
    const rangeKey = `${canonicalRel}:${range.start}:${range.end}`;
    if (requestedRangeKeys.has(rangeKey)) {
      throw new Error(
        `Duplicate range in request: ${range.relativePath} [${range.start}, ${range.end}]`,
      );
    }
    requestedRangeKeys.add(rangeKey);

    const entry = catalogByPath.get(canonicalRel);
    if (!entry) {
      throw new Error(`Unknown asset in range request: ${range.relativePath}`);
    }
    const reason = getExclusionReason(entry);
    if (reason) {
      throw new Error(
        `Cannot create sub-range for excluded catalog entry ${range.relativePath}: ${reason}`,
      );
    }
    if (entry.id !== range.assetContentId) {
      throw new Error(
        `assetContentId mismatch for ${range.relativePath}: catalog ${entry.id}, request ${range.assetContentId}`,
      );
    }

    const mediaType = entry.probe!.type as 'video' | 'audio';
    const duration = entry.probe!.duration as number;
    const segmentId = computeSegmentId({
      assetContentId: entry.id!,
      relativePath: canonicalRel,
      mediaType,
      start: range.start,
      end: range.end,
      duration,
      schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    });
    const segment: MediaSegment = {
      segmentId,
      assetContentId: entry.id!,
      relativePath: canonicalRel,
      mediaType,
      start: range.start,
      end: range.end,
      duration,
    };

    const verified = await verifyRange(projectRoot, inputRoot, segment, verifiedByInputPath);
    if (verified.stat.nlink > 1) {
      throw new Error(`Range source is a hard link or has multiple links: ${canonicalRel}`);
    }
    const inodeKey = `${verified.stat.dev}:${verified.stat.ino}`;
    const existingInodePath = seenInodes.get(inodeKey);
    if (existingInodePath !== undefined && existingInodePath !== verified.realpath) {
      throw new Error(
        `Range source shares an inode with ${existingInodePath} but has a different canonical path: ${canonicalRel}`,
      );
    }
    if (existingInodePath === undefined) {
      seenInodes.set(inodeKey, verified.realpath);
    }
    // Deduplicate publish snapshots by canonical asset identity (realpath),
    // not by segment pathname. Semantic verification above is per segment.
    if (!verifiedAssets.has(verified.realpath)) {
      verifiedAssets.set(verified.realpath, { ...verified, relativePath: canonicalRel });
    }

    segments.push(segment);
  }

  segments.sort((a, b) => compareUtf8(a.segmentId, b.segmentId));

  const excluded: MediaSegmentExcludedEntry[] = [];
  for (const entry of options.catalog.assets) {
    const reason = getExclusionReason(entry);
    if (reason) {
      excluded.push({ relativePath: entry.relativePath, reason });
    }
  }
  excluded.sort((a, b) => {
    const cmp = compareUtf8(a.relativePath, b.relativePath);
    return cmp !== 0 ? cmp : compareUtf8(a.reason, b.reason);
  });

  const manifest: MediaSegmentManifest = {
    schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
    count: segments.length,
    excludedCount: excluded.length,
    excluded,
    segments,
  };

  return { manifest, verifiedAssets };
}

export interface WriteMediaSubrangeManifestOptions {
  projectRoot: string;
  inputRoot: string;
  manifest: MediaSegmentManifest;
  rangeRequestResult: ReadMediaSubrangeRequestResult;
  catalogResult: ReadJsonFileResult;
  verifiedAssets: Map<string, SegmentIntegrityResult & { relativePath: string }>;
  outputRel: string;
  __testHooks?: PublishAtomicNoReplaceOptions['__testHooks'];
}

function manifestToBytes(manifest: MediaSegmentManifest): { bytes: Buffer; sha256: string } {
  const deterministic = toDeterministicObject(manifest);
  const bytes = Buffer.from(JSON.stringify(deterministic, null, 2) + '\n', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

async function buildPublishInputs(
  projectRoot: string,
  rangeRequestResult: ReadMediaSubrangeRequestResult,
  catalogResult: ReadJsonFileResult,
  verifiedAssets: Map<string, SegmentIntegrityResult & { relativePath: string }>,
): Promise<PublishInput[]> {
  const inputs: PublishInput[] = [];

  inputs.push(
    await captureInputSnapshot(
      projectRoot,
      rangeRequestResult.resolved,
      rangeRequestResult.realpath,
      rangeRequestResult.stat,
      rangeRequestResult.sha256,
      'Media subrange request',
      rangeRequestResult.parentStat,
      rangeRequestResult.parentRealpath,
    ),
  );

  inputs.push(
    await captureInputSnapshot(
      projectRoot,
      catalogResult.resolved,
      catalogResult.realpath,
      catalogResult.stat,
      catalogResult.sha256,
      'Catalog',
      catalogResult.parentStat,
      catalogResult.parentRealpath,
    ),
  );

  for (const [, verified] of verifiedAssets) {
    inputs.push(
      await captureInputSnapshot(
        projectRoot,
        verified.resolved,
        verified.realpath,
        verified.stat,
        verified.sha256,
        `Asset ${verified.relativePath}`,
        verified.parentStat,
        verified.parentRealpath,
      ),
    );
  }

  return inputs;
}

export async function writeMediaSubrangeManifest(
  options: WriteMediaSubrangeManifestOptions,
): Promise<string> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);
  const outputRel = normalizeMediaSubrangeOutputRel(options.outputRel);

  const { bytes, sha256: expectedSha256 } = manifestToBytes(options.manifest);

  const inputs = await buildPublishInputs(
    projectRoot,
    options.rangeRequestResult,
    options.catalogResult,
    options.verifiedAssets,
  );

  const previousSourcePaths = [options.rangeRequestResult.resolved, options.catalogResult.resolved];

  return publishAtomicNoReplace(
    bytes,
    projectRoot,
    outputRel,
    inputRoot,
    inputs,
    {
      expectedSha256,
      previousSourcePaths,
      __testHooks: options.__testHooks,
    },
  );
}

export async function generateAndWriteMediaSubrangeManifest(
  options: GenerateAndWriteMediaSubrangeManifestOptions,
): Promise<{ manifest: MediaSegmentManifest; outputPath: string }> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);
  if (!isInside(projectRoot, inputRoot)) {
    throw new Error(`Input root escaped project root: ${options.inputRoot}`);
  }

  const catalogResult = await readJsonFileSafe(projectRoot, options.catalogRel, {
    label: 'Catalog',
    maxBytes: DEFAULT_MAX_CATALOG_BYTES,
  });
  assertNoDuplicateKeys(catalogResult.text);

  await options.__testHooks?.beforeCatalogParse?.({
    resolved: catalogResult.resolved,
    realpath: catalogResult.realpath,
    stat: catalogResult.stat,
    sha256: catalogResult.sha256,
    text: catalogResult.text,
  });

  const catalog = parseCatalog(catalogResult.text, DEFAULT_MAX_CATALOG_ASSETS);

  const rangeRequestResult = await readMediaSubrangeRequest(projectRoot, options.rangeRequestRel, {
    maxBytes: DEFAULT_MAX_SUBRANGE_REQUEST_BYTES,
  });

  const outputRel = normalizeMediaSubrangeOutputRel(options.outputRel ?? 'media-subranges/manifest.json');

  const { manifest, verifiedAssets } = await buildMediaSubrangeManifest({
    projectRoot,
    inputRoot,
    catalog,
    request: rangeRequestResult.request,
  });

  await options.__testHooks?.beforePublish?.();

  const outputPath = await writeMediaSubrangeManifest({
    projectRoot,
    inputRoot,
    manifest,
    rangeRequestResult,
    catalogResult,
    verifiedAssets,
    outputRel,
    __testHooks: options.__testHooks,
  });

  return { manifest, outputPath };
}
