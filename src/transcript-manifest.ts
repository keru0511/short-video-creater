import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { resolveOutputPath, type WriteJsonAtomicTestHooks } from './catalog.js';
import { verifyOutputNotSameAsInput } from './catalog-diff.js';
import {
  MediaSegmentManifestSchema,
  SEGMENT_SCHEMA_VERSION,
  verifySelectedSegmentIntegrity,
  type MediaSegment,
  type MediaSegmentManifest,
} from './media-segments.js';
import { readJsonFileSafe } from './segment-selection.js';
import { isInside } from './thumbnails.js';
import { sha256File } from './core.js';

const O_RDONLY = constants.O_RDONLY;
const O_WRONLY = constants.O_WRONLY;
const O_CREAT = constants.O_CREAT;
const O_EXCL = constants.O_EXCL;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_RDWR = constants.O_RDWR;
const O_TMPFILE = 0o20200000;
const CHUNK_SIZE = 64 * 1024;

function consumeString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= text.length) {
        throw new Error('Unterminated string escape');
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      return i + 1;
    }
    i++;
  }
  throw new Error('Unterminated string');
}

function parseStringValue(text: string, start: number, end: number): string {
  try {
    return JSON.parse(text.slice(start, end)) as string;
  } catch {
    throw new Error('Invalid string value');
  }
}

function consumeLiteral(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\r' ||
      c === '\n' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === ',' ||
      c === ':' ||
      c === '"'
    ) {
      break;
    }
    i++;
  }
  return i;
}

export function assertNoDuplicateKeys(text: string): void {
  type Container = { type: 'object'; keys: Set<string> } | { type: 'array' };
  type State = 'value' | 'objectKey' | 'afterKey' | 'afterValue';

  const stack: Container[] = [];
  let state: State = 'value';
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    switch (state) {
      case 'value': {
        if (c === '{') {
          stack.push({ type: 'object', keys: new Set<string>() });
          state = 'objectKey';
          i++;
        } else if (c === '[') {
          stack.push({ type: 'array' });
          state = 'value';
          i++;
        } else if (c === '"') {
          const end = consumeString(text, i);
          i = end;
          state = 'afterValue';
        } else if (c === ']' && stack.length > 0 && stack[stack.length - 1].type === 'array') {
          stack.pop();
          i++;
          state = 'afterValue';
        } else if (c === '}' || c === ']') {
          throw new Error('Unexpected closing bracket');
        } else {
          i = consumeLiteral(text, i);
          state = 'afterValue';
        }
        break;
      }
      case 'objectKey': {
        if (c === '}') {
          stack.pop();
          state = 'afterValue';
          i++;
        } else if (c === '"') {
          const end = consumeString(text, i);
          const key = parseStringValue(text, i, end);
          const top = stack[stack.length - 1];
          if (top?.type === 'object') {
            if (top.keys.has(key)) {
              throw new Error(`Duplicate key: ${key}`);
            }
            top.keys.add(key);
          }
          i = end;
          state = 'afterKey';
        } else {
          throw new Error('Expected object key');
        }
        break;
      }
      case 'afterKey': {
        if (c === ':') {
          state = 'value';
          i++;
        } else {
          throw new Error('Expected colon');
        }
        break;
      }
      case 'afterValue': {
        if (stack.length === 0) {
          throw new Error('Trailing data after JSON root');
        }
        const top = stack[stack.length - 1];
        if (c === ',') {
          i++;
          state = top.type === 'object' ? 'objectKey' : 'value';
        } else if (c === '}' && top.type === 'object') {
          stack.pop();
          i++;
          state = 'afterValue';
        } else if (c === ']' && top.type === 'array') {
          stack.pop();
          i++;
          state = 'afterValue';
        } else {
          throw new Error('Expected comma or closing bracket');
        }
        break;
      }
    }
  }

  if (state !== 'afterValue' || stack.length !== 0) {
    throw new Error('Unexpected end of JSON');
  }
}

export const TRANSCRIPT_SCHEMA_VERSION = 'v1';
export const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_TEXT_LENGTH = 100_000;
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_SPEAKER_LENGTH = 128;
export const MAX_ENTRIES = 100_000;

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++; // consume low surrogate of valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidTranscriptText(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return false;
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return false;
  if (/[\x00-\x1f\x7f]/.test(text)) return false;
  if (hasLoneSurrogate(text)) return false;
  return true;
}

function isValidSpeaker(speaker: string): boolean {
  if (typeof speaker !== 'string') return false;
  if (speaker.length === 0 || speaker.length > MAX_SPEAKER_LENGTH) return false;
  if (/[\x00-\x1f\x7f]/.test(speaker)) return false;
  if (hasLoneSurrogate(speaker)) return false;
  return true;
}

const TranscriptSourceEntrySchema = z
  .object({
    segmentId: HexSha256Schema,
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    text: z
      .string()
      .min(1)
      .refine(isValidTranscriptText, {
        message: 'text must not be empty, contain control characters, NUL, lone surrogates, or be oversized',
      }),
    speaker: z
      .string()
      .min(1)
      .refine(isValidSpeaker, {
        message: 'speaker must not be empty or contain control characters / lone surrogates',
      })
      .optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine((e) => e.start < e.end, {
    message: 'start must be less than end',
    path: ['end'],
  });

export type TranscriptSourceEntry = z.infer<typeof TranscriptSourceEntrySchema>;

const TranscriptSourceSchema = z
  .object({
    schemaVersion: z.literal('v1'),
    entries: z.array(TranscriptSourceEntrySchema).max(MAX_ENTRIES),
  })
  .strict();

export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

export interface TranscriptManifestSourceInfo {
  identifier: string;
  sha256: string;
}

const TranscriptUtteranceSchema = z
  .object({
    utteranceId: HexSha256Schema,
    segmentId: HexSha256Schema,
    assetContentId: HexSha256Schema,
    relativePath: z.string().min(1),
    segmentStart: z.number().finite().nonnegative(),
    segmentEnd: z.number().finite().positive(),
    segmentDuration: z.number().finite().positive(),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    text: z
      .string()
      .min(1)
      .refine(isValidTranscriptText, {
        message: 'text must not be empty, contain control characters, NUL, lone surrogates, or be oversized',
      }),
    speaker: z
      .string()
      .min(1)
      .refine(isValidSpeaker, {
        message: 'speaker must not be empty or contain control characters / lone surrogates',
      })
      .optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine((u) => u.start < u.end, {
    message: 'start must be less than end',
    path: ['end'],
  })
  .refine(
    (u) =>
      u.segmentStart < u.segmentEnd &&
      u.segmentEnd <= u.segmentDuration,
    {
      message: 'segmentStart must be less than segmentEnd and segmentEnd must not exceed segmentDuration',
      path: ['segmentEnd'],
    },
  )
  .refine(
    (u) =>
      u.segmentStart <= u.start && u.start < u.end && u.end <= u.segmentEnd,
    {
      message: 'utterance timestamps must satisfy segmentStart <= start < end <= segmentEnd',
      path: ['start'],
    },
  )
  .refine(
    (u) =>
      u.utteranceId ===
      computeUtteranceId({
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        segmentId: u.segmentId,
        start: u.start,
        end: u.end,
        text: u.text,
        speaker: u.speaker ?? null,
        confidence: u.confidence ?? null,
      }),
    {
      message: 'utteranceId does not match computed id',
      path: ['utteranceId'],
    },
  );

export const TranscriptManifestSchema = z
  .object({
    schemaVersion: z.literal('v1'),
    sourceManifest: z
      .object({
        identifier: z.string().min(1),
        sha256: HexSha256Schema,
      })
      .strict(),
    mediaSegmentManifest: z
      .object({
        identifier: z.string().min(1),
        sha256: HexSha256Schema,
      })
      .strict(),
    count: z.number().int().nonnegative(),
    utterances: z.array(TranscriptUtteranceSchema),
  })
  .strict()
  .refine((m) => m.count === m.utterances.length, {
    message: 'count does not match utterances length',
    path: ['count'],
  });

export type TranscriptUtterance = z.infer<typeof TranscriptUtteranceSchema>;
export type TranscriptManifest = z.infer<typeof TranscriptManifestSchema>;

export interface ReadMediaSegmentManifestResult {
  resolved: string;
  realpath: string;
  sha256: string;
  stat: Stats;
  parentStat: Stats;
  parentRealpath: string;
  manifest: MediaSegmentManifest;
  identifier: string;
}

export interface ReadTranscriptSourceResult {
  resolved: string;
  realpath: string;
  sha256: string;
  stat: Stats;
  parentStat: Stats;
  parentRealpath: string;
  source: TranscriptSource;
  identifier: string;
}

function canonicalizeProjectRelative(projectRoot: string, absoluteRealpath: string): string {
  const root = resolve(projectRoot);
  const real = resolve(absoluteRealpath);
  const rel = relative(root, real).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || rel === '..') {
    throw new Error(`Path escaped project root: ${absoluteRealpath}`);
  }
  return rel;
}

function validateMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) {
    return DEFAULT_MAX_SOURCE_BYTES;
  }
  if (
    !Number.isFinite(maxBytes) ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('maxBytes must be a finite positive safe integer');
  }
  return maxBytes;
}

export async function readMediaSegmentManifest(
  projectRoot: string,
  relPath: string,
  options?: { maxBytes?: number },
): Promise<ReadMediaSegmentManifestResult> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Media segment manifest',
    maxBytes: validateMaxBytes(options?.maxBytes),
  });
  assertNoDuplicateKeys(result.text);
  const manifest = MediaSegmentManifestSchema.parse(result.data) as MediaSegmentManifest;
  const identifier = canonicalizeProjectRelative(projectRoot, result.realpath);
  return {
    resolved: result.resolved,
    realpath: result.realpath,
    sha256: result.sha256,
    stat: result.stat,
    parentStat: result.parentStat,
    parentRealpath: result.parentRealpath,
    manifest,
    identifier,
  };
}

export async function readTranscriptSource(
  projectRoot: string,
  relPath: string,
  options?: { maxBytes?: number },
): Promise<ReadTranscriptSourceResult> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Transcript source',
    maxBytes: validateMaxBytes(options?.maxBytes),
  });
  assertNoDuplicateKeys(result.text);
  const source = TranscriptSourceSchema.parse(result.data);
  const identifier = canonicalizeProjectRelative(projectRoot, result.realpath);
  return {
    resolved: result.resolved,
    realpath: result.realpath,
    sha256: result.sha256,
    stat: result.stat,
    parentStat: result.parentStat,
    parentRealpath: result.parentRealpath,
    source,
    identifier,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      return Object.fromEntries(entries);
    }
    return v;
  });
}

export function computeUtteranceId(payload: {
  schemaVersion: string;
  segmentId: string;
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  confidence: number | null;
}): string {
  const stablePayload = {
    schemaVersion: payload.schemaVersion,
    segmentId: payload.segmentId,
    start: payload.start,
    end: payload.end,
    text: payload.text,
    speaker: payload.speaker,
    confidence: payload.confidence,
  };
  return createHash('sha256').update(stableStringify(stablePayload)).digest('hex');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullableString(a: string | undefined, b: string | undefined): number {
  return compareStrings(a ?? '', b ?? '');
}

function compareNullableNumber(a: number | undefined, b: number | undefined): number {
  const aa = a ?? -1;
  const bb = b ?? -1;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function compareUtterances(a: TranscriptUtterance, b: TranscriptUtterance): number {
  const segmentCmp = compareStrings(a.segmentId, b.segmentId);
  if (segmentCmp !== 0) return segmentCmp;
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return 0;
}

function sortUtterances(utterances: TranscriptUtterance[]): TranscriptUtterance[] {
  return [...utterances]
    .map((u, index) => ({ u, index }))
    .sort((a, b) => {
      const cmp = compareUtterances(a.u, b.u);
      if (cmp !== 0) return cmp;
      return a.index - b.index;
    })
    .map(({ u }) => u);
}

function canonicalizeTranscriptManifest(manifest: TranscriptManifest): TranscriptManifest {
  const canonicalUtterances = sortUtterances(manifest.utterances).map((u) => {
    const utterance: Record<string, unknown> = {
      utteranceId: u.utteranceId,
      segmentId: u.segmentId,
      assetContentId: u.assetContentId,
      relativePath: u.relativePath,
      segmentStart: u.segmentStart,
      segmentEnd: u.segmentEnd,
      segmentDuration: u.segmentDuration,
      start: u.start,
      end: u.end,
      text: u.text,
    };
    if (u.speaker !== undefined) {
      utterance.speaker = u.speaker;
    }
    if (u.confidence !== undefined) {
      utterance.confidence = u.confidence;
    }
    return utterance as TranscriptUtterance;
  });

  return {
    schemaVersion: manifest.schemaVersion,
    sourceManifest: {
      identifier: manifest.sourceManifest.identifier,
      sha256: manifest.sourceManifest.sha256,
    },
    mediaSegmentManifest: {
      identifier: manifest.mediaSegmentManifest.identifier,
      sha256: manifest.mediaSegmentManifest.sha256,
    },
    count: manifest.count,
    utterances: canonicalUtterances,
  };
}

function canonicalTranscriptManifestToString(manifest: TranscriptManifest): string {
  return JSON.stringify(canonicalizeTranscriptManifest(manifest), null, 2);
}

export interface BuildTranscriptManifestInputs {
  mediaSegmentManifest: MediaSegmentManifest;
  mediaSegmentManifestIdentifier: string;
  mediaSegmentManifestSha256: string;
  transcriptSource: TranscriptSource;
  transcriptSourceIdentifier: string;
  transcriptSourceSha256: string;
}

export function buildTranscriptManifest(inputs: BuildTranscriptManifestInputs): TranscriptManifest {
  const { mediaSegmentManifest, transcriptSource } = inputs;

  const segmentMap = new Map<string, MediaSegment>();
  for (const segment of mediaSegmentManifest.segments) {
    if (segmentMap.has(segment.segmentId)) {
      throw new Error(`Duplicate segment ID in manifest: ${segment.segmentId}`);
    }
    segmentMap.set(segment.segmentId, segment);
  }

  const utterances: TranscriptUtterance[] = [];
  const duplicateKeys = new Set<string>();

  for (let index = 0; index < transcriptSource.entries.length; index++) {
    const entry = transcriptSource.entries[index];

    if (!Number.isFinite(entry.start) || entry.start < 0) {
      throw new Error(`Transcript start must be a finite non-negative number: ${String(entry.start)}`);
    }
    if (!Number.isFinite(entry.end) || entry.end < 0) {
      throw new Error(`Transcript end must be a finite non-negative number: ${String(entry.end)}`);
    }
    if (entry.start >= entry.end) {
      throw new Error(`Transcript start must be less than end: ${entry.start} >= ${entry.end}`);
    }
    if (!isValidTranscriptText(entry.text)) {
      throw new Error(
        'Transcript text must not be empty, contain control characters, NUL, lone surrogates, or be oversized',
      );
    }
    if (entry.speaker !== undefined && !isValidSpeaker(entry.speaker)) {
      throw new Error(
        'Transcript speaker must not be empty or contain control characters / lone surrogates',
      );
    }
    if (
      entry.confidence !== undefined &&
      (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)
    ) {
      throw new Error('Transcript confidence must be a finite number in [0, 1]');
    }

    const segment = segmentMap.get(entry.segmentId);
    if (!segment) {
      throw new Error(`Unknown segment ID: ${entry.segmentId}`);
    }
    if (segment.mediaType !== 'video' && segment.mediaType !== 'audio') {
      throw new Error(`Referenced segment ${entry.segmentId} is not a video or audio segment`);
    }
    if (entry.start < segment.start) {
      throw new Error(
        `Transcript start ${entry.start} is before segment start ${segment.start} for segment ${entry.segmentId}`,
      );
    }
    if (entry.end > segment.end) {
      throw new Error(
        `Transcript end ${entry.end} exceeds segment end ${segment.end} for segment ${entry.segmentId}`,
      );
    }
    if (entry.end > segment.duration) {
      throw new Error(
        `Transcript end ${entry.end} exceeds segment duration ${segment.duration} for segment ${entry.segmentId}`,
      );
    }

    const speaker = entry.speaker ?? null;
    const confidence = entry.confidence ?? null;

    const duplicatePayload = {
      segmentId: entry.segmentId,
      start: entry.start,
      end: entry.end,
      text: entry.text,
      speaker,
      confidence,
    };
    const duplicateKey = stableStringify(duplicatePayload);
    if (duplicateKeys.has(duplicateKey)) {
      throw new Error(
        `Duplicate transcript entry for segment ${entry.segmentId} at ${entry.start}-${entry.end}`,
      );
    }
    duplicateKeys.add(duplicateKey);

    const utteranceId = computeUtteranceId({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      segmentId: entry.segmentId,
      start: entry.start,
      end: entry.end,
      text: entry.text,
      speaker,
      confidence,
    });

    const utterance: TranscriptUtterance = {
      utteranceId,
      segmentId: entry.segmentId,
      assetContentId: segment.assetContentId,
      relativePath: segment.relativePath,
      segmentStart: segment.start,
      segmentEnd: segment.end,
      segmentDuration: segment.duration,
      start: entry.start,
      end: entry.end,
      text: entry.text,
    };
    if (entry.speaker !== undefined) {
      (utterance as TranscriptUtterance).speaker = entry.speaker;
    }
    if (entry.confidence !== undefined) {
      (utterance as TranscriptUtterance).confidence = entry.confidence;
    }
    utterances.push(utterance);
  }

  const sortedUtterances = sortUtterances(utterances);

  const manifest: TranscriptManifest = {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    sourceManifest: {
      identifier: inputs.transcriptSourceIdentifier,
      sha256: inputs.transcriptSourceSha256,
    },
    mediaSegmentManifest: {
      identifier: inputs.mediaSegmentManifestIdentifier,
      sha256: inputs.mediaSegmentManifestSha256,
    },
    count: sortedUtterances.length,
    utterances: sortedUtterances,
  };

  return canonicalizeTranscriptManifest(TranscriptManifestSchema.parse(manifest));
}

export interface VerifiedMediaSegment extends MediaSegment {
  assetResolved: string;
  assetRealpath: string;
  assetStat: Stats;
  assetParentStat: Stats;
  assetParentRealpath: string;
  assetSha256: string;
  probeDuration: number;
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

export async function verifySegmentIntegrity(
  segment: MediaSegment,
  inputRoot: string,
  projectRoot?: string,
  schemaVersion: string = SEGMENT_SCHEMA_VERSION,
): Promise<VerifiedMediaSegment> {
  const result = await verifySelectedSegmentIntegrity(
    projectRoot ? resolve(projectRoot) : resolve(inputRoot),
    resolve(inputRoot),
    segment,
    schemaVersion,
  );
  return {
    ...segment,
    assetResolved: result.resolved,
    assetRealpath: result.realpath,
    assetStat: result.stat,
    assetParentStat: result.parentStat,
    assetParentRealpath: result.parentRealpath,
    assetSha256: result.sha256,
    probeDuration: result.probeDuration,
  };
}

export async function verifyMediaSegmentManifest(
  manifest: MediaSegmentManifest,
  inputRoot: string,
  projectRoot?: string,
): Promise<Map<string, VerifiedMediaSegment>> {
  const map = new Map<string, VerifiedMediaSegment>();
  for (const segment of manifest.segments) {
    const verified = await verifySegmentIntegrity(segment, inputRoot, projectRoot, manifest.schemaVersion);
    map.set(segment.segmentId, verified);
  }
  return map;
}

export interface PublishInput {
  label: string;
  resolved: string;
  realpath: string;
  sha256: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
  parentResolved: string;
  parentRealpath: string;
  parentDev: string;
  parentIno: string;
  parentMode: number;
}

interface AssetPublishInput extends PublishInput {
  segment: MediaSegment;
}

function bigintIdentity(st: BigIntStats): { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: number } {
  return {
    dev: String(st.dev),
    ino: String(st.ino),
    size: String(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    mode: Number(st.mode) & 0o777,
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

export async function captureInputSnapshot(
  projectRoot: string,
  resolved: string,
  realpathValue: string,
  expectedStat: Stats,
  sha256: string,
  label: string,
  expectedParentStat?: Stats,
  expectedParentRealpath?: string,
): Promise<PublishInput> {
  const parentPath = dirname(resolved);
  const parentFh = await open(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const parentStatBig = (await parentFh.stat({ bigint: true })) as BigIntStats;
    if (parentStatBig.isSymbolicLink() || !parentStatBig.isDirectory()) {
      throw new Error(`Input parent is not a directory: ${parentPath}`);
    }
    const parentRealpath = await realpath(parentPath).catch(() => null);
    if (!parentRealpath || !isInside(resolve(projectRoot), parentRealpath)) {
      throw new Error(`Input parent escaped project root: ${parentPath}`);
    }
    if (expectedParentStat) {
      if (
        parentStatBig.dev !== BigInt(expectedParentStat.dev) ||
        parentStatBig.ino !== BigInt(expectedParentStat.ino) ||
        (Number(parentStatBig.mode) & 0o777) !== (expectedParentStat.mode & 0o777)
      ) {
        throw new Error(`${label} parent identity changed before snapshot`);
      }
    }
    if (expectedParentRealpath && parentRealpath !== expectedParentRealpath) {
      throw new Error(`${label} parent realpath changed before snapshot`);
    }

    const fh = await open(resolved, O_RDONLY | O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        throw new Error(`Input is not a regular file: ${resolved}`);
      }
      if (
        st.dev !== expectedStat.dev ||
        st.ino !== expectedStat.ino ||
        st.size !== expectedStat.size ||
        st.mtimeMs !== expectedStat.mtimeMs ||
        st.ctimeMs !== expectedStat.ctimeMs
      ) {
        throw new Error(`${label} identity changed before snapshot`);
      }

      const stBig = (await fh.stat({ bigint: true })) as BigIntStats;
      const actualSha256 = await sha256FromFd(fh, st.size);
      if (actualSha256 !== sha256) {
        throw new Error(`${label} content changed before snapshot`);
      }

      const stAfter = (await fh.stat({ bigint: true })) as BigIntStats;
      if (
        stAfter.dev !== stBig.dev ||
        stAfter.ino !== stBig.ino ||
        stAfter.size !== stBig.size ||
        stAfter.mtimeNs !== stBig.mtimeNs ||
        stAfter.ctimeNs !== stBig.ctimeNs
      ) {
        throw new Error(`${label} changed during snapshot capture`);
      }

      const real = await realpath(resolved).catch(() => null);
      if (!real || real !== realpathValue || !isInside(resolve(projectRoot), real)) {
        throw new Error(`${label} realpath changed before snapshot`);
      }
      if (dirname(real) !== parentRealpath) {
        throw new Error(`${label} is not directly inside its parent: ${resolved}`);
      }

      const id = bigintIdentity(stBig);
      const parentId = bigintIdentity(parentStatBig);
      return {
        label,
        resolved,
        realpath: realpathValue,
        sha256,
        ...id,
        parentResolved: parentPath,
        parentRealpath,
        parentDev: parentId.dev,
        parentIno: parentId.ino,
        parentMode: parentId.mode,
      };
    } finally {
      await fh.close().catch(() => {});
    }
  } finally {
    await parentFh.close().catch(() => {});
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

function isEEXIST(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

async function verifyDirLocation(fh: FileHandle, expected: string, projectRoot: string): Promise<void> {
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
  if (!real || !isInside(resolve(projectRoot), real)) {
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
  try {
    await mkdir(resolve(fallbackPath, component), { recursive: true });
  } catch (err) {
    if (!isEEXIST(err)) throw err;
  }
  return false;
}

async function openAt(
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

async function rmdirAt(parentFh: FileHandle, name: string, fallbackPath: string): Promise<void> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    await rmdir(`${base}/${name}`).catch(() => {});
  } else {
    await rmdir(resolve(fallbackPath, name)).catch(() => {});
  }
}

const PUBLISH_SCRIPT = `import errno
import fcntl
import hashlib
import json
import os
import stat
import sys
import time

O_RDONLY = os.O_RDONLY
O_NOFOLLOW = os.O_NOFOLLOW


def fail(code, error, errno_code=0):
    print(json.dumps({"ok": False, "code": code, "error": error, "errno": errno_code}))
    sys.exit(0)


def ok(linked=True, out_dev=None, out_ino=None, out_size=None, out_mtime_ns=None, out_ctime_ns=None):
    print(json.dumps({
        "ok": True,
        "linked": linked,
        "outDev": out_dev,
        "outIno": out_ino,
        "outSize": out_size,
        "outMtimeNs": out_mtime_ns,
        "outCtimeNs": out_ctime_ns,
    }))
    sys.stdout.flush()


def realpath_fd(fd):
    try:
        target = os.readlink(f"/proc/self/fd/{fd}")
    except OSError:
        return None
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
    if (
        (st.st_mode & 0o777) != expected["mode"]
        or str(st.st_dev) != expected["dev"]
        or str(st.st_ino) != expected["ino"]
    ):
        fail(code, f"{label} directory changed (stat mismatch)")
    real = realpath_fd(fd)
    if real != expected_real or not is_inside(root, real):
        fail(code, f"{label} directory realpath mismatch")


def hash_fd(fd, size, label):
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
            fail("INPUT_CHANGED", f"{label} shrank during hash")
        h.update(chunk)
        remaining -= len(chunk)
    extra = os.read(fd, 1)
    if extra:
        fail("INPUT_CHANGED", f"{label} grew during hash")
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
    if not hasattr(os, "link") or not hasattr(fcntl, "flock"):
        fail("UNSUPPORTED_PLATFORM", "missing OS primitives")
    if len(sys.argv) < 2:
        fail("WRITE_FAILED", "missing contract")
    contract = json.loads(sys.argv[1])
    output_dir_fd = contract["outputDirFd"]
    output_temp_fd = contract["outputTempFd"]
    final_name = contract["finalName"]
    output_sha256 = contract["outputSha256"]
    project_root = contract["projectRoot"]
    output_dir_real_expected = contract["outputDirRealpath"]
    output_dir_stat_expected = contract["outputDirStat"]
    inputs = contract["inputs"]
    test_hooks = contract.get("__testHooks", {})

    verify_dir(output_dir_fd, output_dir_stat_expected, output_dir_real_expected, project_root, "output dir", "WRITE_FAILED")

    opened = []
    locked = []
    input_fds = []
    input_files = []

    try:
        for inp in inputs:
            parent_fd = inp["dirFd"]
            name = inp["name"]
            label = inp["label"]

            before = test_hooks.get("stallBeforeInputHash") if isinstance(test_hooks, dict) else None
            if before and label in before:
                wait_for_signal(before[label], label)

            verify_dir(parent_fd, inp["expectedParentStat"], inp["expectedParentRealpath"], project_root, f"{label} parent", "INPUT_CHANGED")

            fd = -1
            try:
                fd = os.open(name, O_RDONLY | O_NOFOLLOW, dir_fd=parent_fd)
            except OSError as e:
                fail("INPUT_CHANGED", f"{label} open: {e.strerror}", e.errno)

            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except OSError as e:
                    if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        fail("INPUT_CHANGED", f"{label} is locked by another process")
                    fail("INPUT_CHANGED", f"{label} flock: {e.strerror}", e.errno)
                locked.append(fd)

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
                    fail("INPUT_CHANGED", f"{label} changed (stat mismatch)")
                if not stat.S_ISREG(st.st_mode):
                    fail("INPUT_CHANGED", f"{label} changed (not regular file)")
                real = realpath_fd(fd)
                if real != inp["expectedRealpath"] or not is_inside(project_root, real):
                    fail("INPUT_CHANGED", f"{label} realpath mismatch")

                actual_sha = hash_fd(fd, st.st_size, label)
                if actual_sha != inp["expectedSha256"]:
                    fail("INPUT_CHANGED", f"{label} changed (sha256 mismatch)")

                input_fds.append(fd)
                input_files.append({"fd": fd, "inp": inp, "st": st})
                opened.append((parent_fd, fd, name, label))
                fd = -1
            finally:
                if fd != -1:
                    try:
                        os.close(fd)
                    except OSError:
                        pass

        try:
            out_st = os.fstat(output_temp_fd)
        except OSError as e:
            fail("WRITE_FAILED", f"output temp fstat: {e.strerror}", e.errno)
        if not stat.S_ISREG(out_st.st_mode):
            fail("WRITE_FAILED", "output temp not regular file")

        actual_out_sha = hash_fd(output_temp_fd, out_st.st_size, "output")
        if actual_out_sha != output_sha256:
            fail("WRITE_FAILED", "output sha256 mismatch")

        try:
            os.fchmod(output_temp_fd, 0o400)
        except OSError as e:
            fail("WRITE_FAILED", f"output fchmod: {e.strerror}", e.errno)

        before_final = test_hooks.get("stallBeforeFinalLink") if isinstance(test_hooks, dict) else None
        if before_final:
            wait_for_signal(before_final, "beforeFinalLink")

        verify_dir(output_dir_fd, output_dir_stat_expected, output_dir_real_expected, project_root, "output dir at commit", "WRITE_FAILED")

        for entry in input_files:
            fd = entry["fd"]
            inp = entry["inp"]
            label = inp["label"]
            parent_fd = inp["dirFd"]
            name = inp["name"]

            verify_dir(parent_fd, inp["expectedParentStat"], inp["expectedParentRealpath"], project_root, f"{label} parent at commit", "INPUT_CHANGED")

            try:
                st_now = os.fstat(fd)
            except OSError as e:
                fail("INPUT_CHANGED", f"{label} fstat at commit: {e.strerror}", e.errno)
            exp = inp["expectedStat"]
            if (
                (st_now.st_mode & 0o777) != exp["mode"]
                or str(st_now.st_dev) != exp["dev"]
                or str(st_now.st_ino) != exp["ino"]
                or str(st_now.st_size) != exp["size"]
                or str(st_now.st_mtime_ns) != exp["mtimeNs"]
                or str(st_now.st_ctime_ns) != exp["ctimeNs"]
            ):
                fail("INPUT_CHANGED", f"{label} changed at commit (stat mismatch)")

            try:
                path_st = os.lstat(name, dir_fd=parent_fd)
            except OSError as e:
                fail("INPUT_CHANGED", f"{label} path lstat at commit: {e.strerror}", e.errno)
            if (
                not stat.S_ISREG(path_st.st_mode)
                or path_st.st_dev != st_now.st_dev
                or path_st.st_ino != st_now.st_ino
            ):
                fail("INPUT_CHANGED", f"{label} path identity changed at commit")

            real = realpath_fd(fd)
            if real != inp["expectedRealpath"] or not is_inside(project_root, real):
                fail("INPUT_CHANGED", f"{label} realpath mismatch at commit")

        try:
            os.link(f"/proc/self/fd/{output_temp_fd}", final_name, dst_dir_fd=output_dir_fd, follow_symlinks=True)
        except FileExistsError:
            fail("OUTPUT_COLLISION", "output already exists")
        except OSError as e:
            fail("WRITE_FAILED", f"link final: {e.strerror}", e.errno)

        out_stat = os.fstat(output_temp_fd)
        ok(True, str(out_stat.st_dev), str(out_stat.st_ino), str(out_stat.st_size), str(out_stat.st_mtime_ns), str(out_stat.st_ctime_ns))
    finally:
        for fd in locked:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        for fd in input_fds:
            try:
                os.close(fd)
            except OSError:
                pass

    if isinstance(test_hooks, dict) and test_hooks.get("postLinkFail"):
        raise RuntimeError("injected post-link failure")
    if isinstance(test_hooks, dict) and test_hooks.get("postLinkMalformed"):
        print("not-json")
        sys.exit(0)
    if isinstance(test_hooks, dict) and test_hooks.get("postLinkForeignReplace"):
        try:
            os.unlink(final_name, dir_fd=output_dir_fd)
            fd_foreign = os.open(final_name, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o644, dir_fd=output_dir_fd)
            os.write(fd_foreign, b"foreign replacement")
            os.close(fd_foreign)
        except OSError:
            pass
        sys.exit(0)
    if isinstance(test_hooks, dict) and test_hooks.get("postLinkReplaceSameBytes"):
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
            os.unlink(final_name, dir_fd=output_dir_fd)
            fd_new = os.open(final_name, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o400, dir_fd=output_dir_fd)
            written = 0
            while written < len(same_bytes):
                n = os.write(fd_new, same_bytes[written:])
                if n == 0:
                    break
                written += n
            os.close(fd_new)
        except OSError as e:
            raise RuntimeError(f"postLinkReplaceSameBytes: {e.strerror}") from e
        sys.exit(0)
    if isinstance(test_hooks, dict) and test_hooks.get("postLinkGrow"):
        try:
            os.chmod(final_name, 0o600, dir_fd=output_dir_fd)
            fd_grow = os.open(final_name, os.O_WRONLY | os.O_APPEND, dir_fd=output_dir_fd)
            os.write(fd_grow, b"extra")
            os.close(fd_grow)
            os.chmod(final_name, 0o400, dir_fd=output_dir_fd)
        except OSError as e:
            raise RuntimeError(f"postLinkGrow: {e.strerror}") from e
        sys.exit(0)
    if isinstance(test_hooks, dict) and test_hooks.get("postLinkStall"):
        wait_for_signal(test_hooks["postLinkStall"], "postLinkStall")

main()
`;

interface PublishResult {
  ok?: boolean;
  linked?: boolean;
  outDev?: string;
  outIno?: string;
  outSize?: string;
  outMtimeNs?: string;
  outCtimeNs?: string;
  code?: string;
  error?: string;
  errno?: number;
}

function mapPythonError(result: PublishResult): Error {
  const code = result.code ?? 'WRITE_FAILED';
  const message = result.error ?? 'publish helper failed';
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function parseLastPublishResult(stdout: Buffer): PublishResult | null {
  for (const line of stdout.toString('utf8').split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PublishResult;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore non-JSON trailing lines
    }
  }
  return null;
}

interface VerifyFinalCommitResult {
  ok: boolean;
  isOwn: boolean;
}

async function verifyFinalCommit(
  dirFh: FileHandle,
  finalName: string,
  tempFh: FileHandle,
  expectedSha256: string,
  allowExistingFinal = false,
): Promise<VerifyFinalCommitResult> {
  const expectedSize = Number((await tempFh.stat({ bigint: true })).size);
  const finalPath = `/proc/self/fd/${dirFh.fd}/${finalName}`;
  let fh: FileHandle;
  try {
    fh = await open(finalPath, O_RDONLY | O_NOFOLLOW);
  } catch {
    return { ok: false, isOwn: false };
  }
  try {
    const tempStat = (await tempFh.stat({ bigint: true })) as BigIntStats;
    const preSt = (await fh.stat({ bigint: true })) as BigIntStats;
    const isOwn = preSt.dev === tempStat.dev && preSt.ino === tempStat.ino;
    if (!preSt.isFile() || preSt.size !== BigInt(expectedSize)) {
      return { ok: false, isOwn };
    }
    if (allowExistingFinal && preSt.nlink !== 1n) {
      return { ok: false, isOwn };
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
    if (total !== expectedSize) return { ok: false, isOwn };

    const extraBuf = Buffer.alloc(1);
    const { bytesRead: extraRead } = await fh.read(extraBuf, 0, 1, null);
    if (extraRead !== 0) return { ok: false, isOwn };

    const hash = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    if (hash !== expectedSha256) return { ok: false, isOwn };

    const postSt = (await fh.stat({ bigint: true })) as BigIntStats;
    if (!postSt.isFile() || postSt.size !== BigInt(expectedSize)) return { ok: false, isOwn: false };
    if (allowExistingFinal) {
      if (postSt.nlink !== 1n || postSt.dev !== preSt.dev || postSt.ino !== preSt.ino) {
        return { ok: false, isOwn: false };
      }
    } else if (postSt.dev !== tempStat.dev || postSt.ino !== tempStat.ino) {
      return { ok: false, isOwn: false };
    }

    let pathStat: BigIntStats;
    try {
      pathStat = (await lstat(finalPath, { bigint: true })) as BigIntStats;
    } catch {
      return { ok: false, isOwn };
    }
    if (!pathStat.isFile() || pathStat.size !== BigInt(expectedSize)) return { ok: false, isOwn };
    if (allowExistingFinal && pathStat.nlink !== 1n) {
      return { ok: false, isOwn };
    }
    if (pathStat.dev !== postSt.dev || pathStat.ino !== postSt.ino) {
      return { ok: false, isOwn: false };
    }

    return { ok: true, isOwn };
  } catch {
    return { ok: false, isOwn: false };
  } finally {
    try {
      await fh.close();
    } catch {
      // best-effort close
    }
  }
}

interface RunPythonContractResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: Error;
}

function runPythonContract(
  contract: Record<string, unknown>,
  stdio: Array<'pipe' | number>,
  timeoutMs = 60_000,
): Promise<RunPythonContractResult> {
  const contractJson = JSON.stringify(contract);
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-', contractJson], { stdio });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      reject(new Error('publish helper stdio unavailable'));
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

    function finish(error: Error | null, value?: RunPythonContractResult): void {
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
        if (!settled) terminate(new Error(`publish helper timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdin.write(PUBLISH_SCRIPT);
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
      if (stdoutLen > 4096) {
        terminate(new Error('publish helper stdout exceeded 4096 bytes'));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      const take = Math.min(chunk.length, Math.max(0, 64 * 1024 - stderrLen));
      if (take > 0) stderrChunks.push(chunk.subarray(0, take));
      stderrLen += chunk.length;
      if (stderrLen > 64 * 1024) {
        terminate(new Error('publish helper stderr exceeded 65536 bytes'));
      }
    });

    child.on('error', (err) => finish(err));

    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const stdout = Buffer.concat(stdoutChunks);
      if (killed) {
        finish(null, {
          stdout,
          stderr,
          exitCode: code,
          signal,
          error: abortReason ?? undefined,
        });
      } else {
        finish(null, { stdout, stderr, exitCode: code, signal });
      }
    });
  });
}

export interface PublishAtomicTestHooks extends WriteJsonAtomicTestHooks {
  stallBeforeFinalLink?: string;
  postLinkFail?: boolean;
  postLinkMalformed?: boolean;
  postLinkForeignReplace?: boolean;
  postLinkReplaceSameBytes?: boolean;
  postLinkGrow?: boolean;
  postLinkStall?: string;
  publishHelperTimeoutMs?: number;
  beforeInputSnapshot?: (label: string) => Promise<void>;
  beforeFontGlyphInspection?: () => Promise<void>;
  afterVerify?: (finalPath: string, verified: { ok: boolean; isOwn: boolean }) => Promise<void> | void;
}

export interface PublishAtomicNoReplaceOptions {
  __testHooks?: PublishAtomicTestHooks;
  expectedSha256?: string;
  previousSourcePaths?: string[];
  /**
   * If true, an existing final at the output path that is a regular file with
   * nlink=1, an unchanging fd/path identity, and the exact expected SHA-256 is
   * accepted as a successful idempotent publish. Default false preserves the
   * strict no-replace contract for other callers.
   */
  allowExistingFinal?: boolean;
}

export async function publishAtomicNoReplace(
  bytes: Buffer,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  inputs: PublishInput[] = [],
  options?: PublishAtomicNoReplaceOptions,
): Promise<string> {
  const root = resolve(projectRoot);
  const safeOutput = resolveOutputPath(projectRoot, outputRel);

  const inputResolved = resolve(inputRoot);
  if (isInside(inputResolved, safeOutput)) {
    throw new Error('Output path cannot be inside input directory');
  }

  for (const previousPath of options?.previousSourcePaths ?? []) {
    await verifyOutputNotSameAsInput(projectRoot, safeOutput, previousPath);
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

    if (options?.expectedSha256) {
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      if (actualSha !== options.expectedSha256) {
        throw new Error('Output bytes SHA-256 mismatch before publish');
      }
    }

    const base = fdRelativeBase(dirFh);
    if (!base) {
      throw new Error('Linux /proc/self/fd is required for atomic publish');
    }
    const tempFh = await open(base, O_TMPFILE | O_RDWR, 0o600);
    handles.push(tempFh);
    await tempFh.writeFile(bytes);
    await tempFh.sync();

    await options?.__testHooks?.beforeRename?.({
      dirFh,
      dirPath: currentPath,
      tempName: '',
      finalName: fileName,
    });

    const outputDirStat = (await dirFh.stat({ bigint: true })) as BigIntStats;
    const outputDirRealpath = await realpath(currentPath).catch(() => null);
    if (!outputDirRealpath || !isInside(root, outputDirRealpath)) {
      throw new Error('Output directory location changed before publish');
    }

    const outputSha256 = createHash('sha256').update(bytes).digest('hex');

    const parentFhs: FileHandle[] = [];
    const parentFhIndex = new Map<FileHandle, number>();
    const dedupParents = new Map<string, FileHandle>();
    const contractInputs: Record<string, unknown>[] = [];

    for (const input of inputs) {
      let parentFh = dedupParents.get(input.parentResolved);
      if (!parentFh) {
        parentFh = await open(input.parentResolved, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        dedupParents.set(input.parentResolved, parentFh);
        parentFhs.push(parentFh);
        handles.push(parentFh);
      }
      let idx = parentFhIndex.get(parentFh);
      if (idx === undefined) {
        idx = parentFhs.length - 1;
        parentFhIndex.set(parentFh, idx);
      }
      const dirFd = 5 + idx;
      const name = basename(input.resolved);
      contractInputs.push({
        dirFd,
        name,
        label: input.label,
        expectedSha256: input.sha256,
        expectedStat: {
          dev: input.dev,
          ino: input.ino,
          size: input.size,
          mtimeNs: input.mtimeNs,
          ctimeNs: input.ctimeNs,
          mode: input.mode,
        },
        expectedRealpath: input.realpath,
        expectedParentRealpath: input.parentRealpath,
        expectedParentStat: {
          dev: input.parentDev,
          ino: input.parentIno,
          mode: input.parentMode,
        },
      });
    }

    const stdio: Array<'pipe' | number> = ['pipe', 'pipe', 'pipe', dirFh.fd, tempFh.fd];
    for (const fh of parentFhs) {
      stdio.push(fh.fd);
    }

    const serializableHooks: Record<string, unknown> = {};
    const testHooks = options?.__testHooks;
    if (testHooks?.stallBeforeFinalLink) serializableHooks.stallBeforeFinalLink = testHooks.stallBeforeFinalLink;
    if (testHooks?.postLinkFail) serializableHooks.postLinkFail = true;
    if (testHooks?.postLinkMalformed) serializableHooks.postLinkMalformed = true;
    if (testHooks?.postLinkForeignReplace) serializableHooks.postLinkForeignReplace = true;
    if (testHooks?.postLinkReplaceSameBytes) serializableHooks.postLinkReplaceSameBytes = true;
    if (testHooks?.postLinkGrow) serializableHooks.postLinkGrow = true;
    if (testHooks?.postLinkStall) serializableHooks.postLinkStall = testHooks.postLinkStall;

    const contract: Record<string, unknown> = {
      outputDirFd: 3,
      outputTempFd: 4,
      finalName: fileName,
      outputSha256,
      projectRoot: root,
      outputDirRealpath,
      outputDirStat: {
        dev: String(outputDirStat.dev),
        ino: String(outputDirStat.ino),
        mode: Number(outputDirStat.mode) & 0o777,
      },
      inputs: contractInputs,
      __testHooks: serializableHooks,
    };

    const timeoutMs = testHooks?.publishHelperTimeoutMs ?? 60_000;
    const { stdout, stderr, exitCode, signal, error: helperError } = await runPythonContract(
      contract,
      stdio,
      timeoutMs,
    );
    const lastResult = parseLastPublishResult(stdout);
    const allowExistingFinal = options?.allowExistingFinal ?? false;

    const verified = await verifyFinalCommit(dirFh, fileName, tempFh, outputSha256, allowExistingFinal);
    const finalPath = resolve(currentPath, fileName);
    await testHooks?.afterVerify?.(finalPath, verified);

    // Re-verify after the test-only hook to close the window between verification and return.
    const finalVerified = verified.ok && testHooks?.afterVerify
      ? await verifyFinalCommit(dirFh, fileName, tempFh, outputSha256, allowExistingFinal)
      : verified;

    if (finalVerified.ok) {
      return finalPath;
    }

    // The final path is not our committed content. Do not mutate it; fail closed.
    if (helperError) {
      throw helperError;
    }
    if (lastResult?.code) {
      throw mapPythonError(lastResult);
    }
    throw new Error(
      `publish helper failed with ${exitCode ?? 'unknown'} (signal ${signal ?? 'none'}): ${stderr.slice(-2000)}`,
    );
  } catch (err) {
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      const { parentFh, component, parentPath } = createdDirs[i];
      await rmdirAt(parentFh, component, parentPath).catch(() => {});
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR' || code === 'OUTPUT_COLLISION') {
      throw err;
    }
    throw err;
  } finally {
    for (const h of handles) {
      await h.close().catch(() => {});
    }
  }
}

export interface WriteTranscriptManifestOptions {
  __testHooks?: PublishAtomicTestHooks;
  previousSourcePaths?: string[];
}

export async function writeTranscriptManifest(
  manifest: TranscriptManifest,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  options?: WriteTranscriptManifestOptions,
): Promise<string> {
  const canonical = canonicalizeTranscriptManifest(TranscriptManifestSchema.parse(manifest));

  const normalized = normalizeTranscriptOutputRel(outputRel);
  const safeOutput = resolveOutputPath(projectRoot, normalized);

  if (isInside(resolve(inputRoot), safeOutput)) {
    throw new Error('Output path cannot be inside input directory');
  }

  for (const previousPath of options?.previousSourcePaths ?? []) {
    await verifyOutputNotSameAsInput(projectRoot, safeOutput, previousPath);
  }

  const bytes = Buffer.from(canonicalTranscriptManifestToString(canonical) + '\n', 'utf8');
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  return publishAtomicNoReplace(bytes, projectRoot, normalized, inputRoot, [], {
    __testHooks: options?.__testHooks,
    previousSourcePaths: options?.previousSourcePaths,
    expectedSha256,
  });
}

export interface GenerateAndWriteTranscriptManifestOptions {
  projectRoot: string;
  inputRoot: string;
  mediaSegmentManifestRel: string;
  transcriptSourceRel: string;
  outputRel?: string;
  maxBytes?: number;
  __testHooks?: PublishAtomicTestHooks;
}

export interface GenerateAndWriteTranscriptManifestResult {
  manifest: TranscriptManifest;
  outputPath: string;
  mediaSegmentManifestSha256: string;
  transcriptSourceSha256: string;
}

export function normalizeTranscriptOutputRel(outputRel: string): string {
  if (typeof outputRel !== 'string') {
    throw new Error('Output path must be a string');
  }
  if (outputRel.includes('\0')) {
    throw new Error(`Null bytes are not allowed in output path: ${outputRel}`);
  }
  if (/^[A-Za-z]:/.test(outputRel)) {
    throw new Error(`Windows drive paths are not allowed: ${outputRel}`);
  }
  if (outputRel.startsWith('\\')) {
    throw new Error(`UNC paths are not allowed: ${outputRel}`);
  }
  const normalized = outputRel.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new Error(`Absolute paths are not allowed: ${outputRel}`);
  }
  if (normalized.includes('//')) {
    throw new Error(`Double separators are not allowed in output path: ${outputRel}`);
  }
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`Invalid output path component: ${outputRel}`);
  }
  if (parts.length > 0 && parts[0] === 'output') {
    parts.shift();
  }
  if (
    parts.length !== 2 ||
    parts[0] !== 'transcripts' ||
    !parts[1].toLowerCase().endsWith('.json') ||
    parts[1].length <= 5 ||
    parts[1].startsWith('.')
  ) {
    throw new Error(`Output path must be output/transcripts/<file>.json: ${outputRel}`);
  }
  return parts.join('/');
}

export async function generateAndWriteTranscriptManifest(
  options: GenerateAndWriteTranscriptManifestOptions,
): Promise<GenerateAndWriteTranscriptManifestResult> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);

  const media = await readMediaSegmentManifest(projectRoot, options.mediaSegmentManifestRel, {
    maxBytes: options.maxBytes,
  });
  await options.__testHooks?.beforeInputSnapshot?.('Media segment manifest');
  const mediaSnapshot = await captureInputSnapshot(
    projectRoot,
    media.resolved,
    media.realpath,
    media.stat,
    media.sha256,
    'Media segment manifest',
    media.parentStat,
    media.parentRealpath,
  );

  const source = await readTranscriptSource(projectRoot, options.transcriptSourceRel, {
    maxBytes: options.maxBytes,
  });
  await options.__testHooks?.beforeInputSnapshot?.('Transcript source');
  const sourceSnapshot = await captureInputSnapshot(
    projectRoot,
    source.resolved,
    source.realpath,
    source.stat,
    source.sha256,
    'Transcript source',
    source.parentStat,
    source.parentRealpath,
  );

  const verifiedSegments = await verifyMediaSegmentManifest(
    media.manifest,
    inputRoot,
    projectRoot,
  );

  const assetSnapshots = new Map<string, AssetPublishInput>();
  for (const segment of media.manifest.segments) {
    const verified = verifiedSegments.get(segment.segmentId);
    if (!verified) {
      throw new Error(`Segment disappeared during verification: ${segment.segmentId}`);
    }
    await options.__testHooks?.beforeInputSnapshot?.(`Asset ${segment.relativePath}`);
    const base = await captureInputSnapshot(
      projectRoot,
      verified.assetResolved,
      verified.assetRealpath,
      verified.assetStat,
      verified.assetSha256,
      `Asset ${segment.relativePath}`,
      verified.assetParentStat,
      verified.assetParentRealpath,
    );
    assetSnapshots.set(segment.segmentId, {
      ...base,
      segment,
    });
  }

  const manifest = buildTranscriptManifest({
    mediaSegmentManifest: media.manifest,
    mediaSegmentManifestIdentifier: media.identifier,
    mediaSegmentManifestSha256: media.sha256,
    transcriptSource: source.source,
    transcriptSourceIdentifier: source.identifier,
    transcriptSourceSha256: source.sha256,
  });

  const outputRel = normalizeTranscriptOutputRel(options.outputRel ?? 'transcripts/manifest.json');
  const previousSourcePaths = [media.resolved, source.resolved];
  for (const [, verified] of verifiedSegments) {
    previousSourcePaths.push(verified.assetResolved);
  }

  const outputPath = await publishAtomicNoReplace(
    Buffer.from(canonicalTranscriptManifestToString(manifest) + '\n', 'utf8'),
    projectRoot,
    outputRel,
    inputRoot,
    [mediaSnapshot, sourceSnapshot, ...assetSnapshots.values()],
    {
      previousSourcePaths,
      __testHooks: options.__testHooks,
    },
  );

  return {
    manifest,
    outputPath,
    mediaSegmentManifestSha256: media.sha256,
    transcriptSourceSha256: source.sha256,
  };
}
