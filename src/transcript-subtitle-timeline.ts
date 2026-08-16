import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  buildTimelineFromManifestAndSelection,
  deriveTimelineOutputPath,
  normalizeTimelineOutputRel,
  readJsonFileSafe,
  SegmentSelectionSchema,
  stableStringify,
  toDeterministicObject,
  type ReadJsonFileResult,
} from './segment-selection.js';
import {
  buildTranscriptManifest,
  computeUtteranceId,
  DEFAULT_MAX_SOURCE_BYTES,
  readMediaSegmentManifest,
  TranscriptManifestSchema,
  verifySegmentIntegrity,
  assertNoDuplicateKeys,
  captureInputSnapshot,
  publishAtomicNoReplace,
  type PublishAtomicTestHooks,
  type PublishInput,
  type TranscriptManifest,
  type TranscriptUtterance,
  type VerifiedMediaSegment,
} from './transcript-manifest.js';
import { validateCues, verifyFontGlyphs, withSubtitleDefaults, type SubtitleCue } from './subtitles.js';
import { TimelineSchema, type Timeline } from './core.js';
import { isInside } from './thumbnails.js';
import { resolveSafePath, sha256File } from './utils.js';
import { UserError } from './user-error.js';
import type { MediaSegment, MediaSegmentManifest } from './media-segments.js';

const O_RDONLY = constants.O_RDONLY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CHUNK_SIZE = 64 * 1024;

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const HEX_COLOR = z.string().regex(/^#?[0-9A-Fa-f]{6}$/);

const SubtitleStyleSchema = z
  .object({
    font: z.string().min(1),
    fontHash: HexSha256Schema,
    x: z.number().int().finite(),
    y: z.number().int().finite(),
    fontSize: z.number().int().min(1).max(200),
    fontColor: HEX_COLOR.optional(),
    fontAlpha: z.number().min(0).max(1).optional(),
    borderWidth: z.number().int().min(0).max(20).optional(),
    borderColor: HEX_COLOR.optional(),
    box: z.boolean().optional(),
    boxColor: HEX_COLOR.optional(),
    boxAlpha: z.number().min(0).max(1).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict()
  .refine((s) => /\.(ttf|otf)$/i.test(s.font), {
    message: 'font must be a single-face .ttf or .otf file',
    path: ['font'],
  });

export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

export interface ReadTranscriptManifestResult extends ReadJsonFileResult {
  manifest: TranscriptManifest;
  identifier: string;
}

export interface ReadSubtitleStyleResult extends ReadJsonFileResult {
  style: SubtitleStyle;
}

export interface GenerateAndWriteSubtitleTimelineOptions {
  projectRoot: string;
  inputRoot: string;
  mediaManifestRel: string;
  selectionRel: string;
  transcriptManifestRel: string;
  styleRel: string;
  outputRel?: string;
  fontsDir?: string;
  maxBytes?: number;
  /**
   * If true, an existing final at the output path with nlink=1 and the exact
   * expected SHA-256 is accepted as a successful idempotent publish. This is
   * intended only for the fixture-generation route; other callers should leave
   * it false to preserve the strict no-replace contract.
   */
  allowExistingFinal?: boolean;
  __testHooks?: SubtitleTimelineTestHooks;
}

export interface GenerateAndWriteSubtitleTimelineResult {
  timeline: Timeline;
  outputPath: string;
  timelineSha256: string;
  manifestSha256: string;
  selectionSha256: string;
  transcriptManifestSha256: string;
  styleSha256: string;
}

function validateMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SOURCE_BYTES;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('maxBytes must be a finite positive safe integer');
  }
  return value;
}

function canonicalizeProjectRelative(projectRoot: string, absoluteRealpath: string): string {
  const root = resolve(projectRoot);
  const real = resolve(absoluteRealpath);
  const rel = relative(root, real).replace(/\\/g, '/');
  if (rel === '' || rel === '..' || rel.startsWith('..')) {
    throw new Error(`Path escaped project root: ${absoluteRealpath}`);
  }
  return rel;
}

function assertCanonicalRelativePath(relPath: string, label: string): void {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (relPath.includes('\0')) {
    throw new Error(`${label} contains null bytes: ${relPath}`);
  }
  if (/^[A-Za-z]:[/\\]/.test(relPath)) {
    throw new Error(`${label} cannot be a Windows drive path: ${relPath}`);
  }
  if (relPath.startsWith('\\\\')) {
    throw new Error(`${label} cannot be a UNC path: ${relPath}`);
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error(`${label} cannot be an absolute path: ${relPath}`);
  }

  const normalized = relPath.replace(/\\/g, '/');
  for (const part of normalized.split('/')) {
    if (part === '') {
      throw new Error(`${label} contains an empty path component: ${relPath}`);
    }
    if (part === '.' || part === '..') {
      throw new Error(`${label} contains a . or .. component: ${relPath}`);
    }
  }
}

function assertNotHardLinked(stat: Stats, label: string): void {
  if (stat.nlink > 1) {
    throw new Error(`${label} is a hard link or has multiple links`);
  }
}

function trackUniqueInode(stat: Stats, label: string, seen: Map<string, string>): void {
  const key = `${stat.dev}:${stat.ino}`;
  const existing = seen.get(key);
  if (existing !== undefined) {
    throw new Error(`${label} shares an inode with ${existing}`);
  }
  seen.set(key, label);
}

export async function readTranscriptManifest(
  projectRoot: string,
  relPath: string,
  options?: { maxBytes?: number },
): Promise<ReadTranscriptManifestResult> {
  assertCanonicalRelativePath(relPath, 'Transcript manifest path');
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Transcript manifest',
    maxBytes: validateMaxBytes(options?.maxBytes),
  });
  assertNoDuplicateKeys(result.text);
  const manifest = TranscriptManifestSchema.parse(result.data);
  const identifier = canonicalizeProjectRelative(projectRoot, result.realpath);
  return { ...result, manifest, identifier };
}

export async function readSubtitleStyle(
  projectRoot: string,
  relPath: string,
  options?: { maxBytes?: number },
): Promise<ReadSubtitleStyleResult> {
  assertCanonicalRelativePath(relPath, 'Subtitle style path');
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label: 'Subtitle style',
    maxBytes: validateMaxBytes(options?.maxBytes),
  });
  assertNoDuplicateKeys(result.text);
  const style = SubtitleStyleSchema.parse(result.data);
  return { ...result, style };
}

function buildSegmentMap(manifest: MediaSegmentManifest): Map<string, MediaSegment> {
  const map = new Map<string, MediaSegment>();
  for (const segment of manifest.segments) {
    if (map.has(segment.segmentId)) {
      throw new Error(`Duplicate segment ID in media manifest: ${segment.segmentId}`);
    }
    map.set(segment.segmentId, segment);
  }
  return map;
}

function verifyTranscriptManifestAgainstMedia(
  transcript: TranscriptManifest,
  mediaManifest: MediaSegmentManifest,
  mediaIdentifier: string,
  mediaSha256: string,
): void {
  if (transcript.mediaSegmentManifest.identifier !== mediaIdentifier) {
    throw new Error(
      `Transcript manifest media identifier mismatch: expected ${mediaIdentifier}, got ${transcript.mediaSegmentManifest.identifier}`,
    );
  }
  if (transcript.mediaSegmentManifest.sha256 !== mediaSha256) {
    throw new Error(
      `Transcript manifest media SHA-256 mismatch: expected ${mediaSha256}, got ${transcript.mediaSegmentManifest.sha256}`,
    );
  }

  const segmentMap = buildSegmentMap(mediaManifest);

  for (const utterance of transcript.utterances) {
    const segment = segmentMap.get(utterance.segmentId);
    if (!segment) {
      throw new Error(`Unknown segment ID in transcript manifest: ${utterance.segmentId}`);
    }
    if (utterance.assetContentId !== segment.assetContentId) {
      throw new Error(
        `Asset content ID mismatch for utterance ${utterance.utteranceId} segment ${utterance.segmentId}`,
      );
    }
    if (utterance.relativePath !== segment.relativePath) {
      throw new Error(
        `Relative path mismatch for utterance ${utterance.utteranceId} segment ${utterance.segmentId}`,
      );
    }
    if (utterance.segmentStart !== segment.start) {
      throw new Error(
        `Segment start mismatch for utterance ${utterance.utteranceId}: expected ${segment.start}, got ${utterance.segmentStart}`,
      );
    }
    if (utterance.segmentEnd !== segment.end) {
      throw new Error(
        `Segment end mismatch for utterance ${utterance.utteranceId}: expected ${segment.end}, got ${utterance.segmentEnd}`,
      );
    }
    if (utterance.segmentDuration !== segment.duration) {
      throw new Error(
        `Segment duration mismatch for utterance ${utterance.utteranceId}: expected ${segment.duration}, got ${utterance.segmentDuration}`,
      );
    }

    if (
      utterance.start < segment.start ||
      utterance.end > segment.end ||
      utterance.start >= utterance.end
    ) {
      throw new Error(
        `Utterance ${utterance.utteranceId} timestamps out of segment range ${segment.start}-${segment.end}`,
      );
    }

    const expectedUtteranceId = computeUtteranceId({
      schemaVersion: 'v1',
      segmentId: utterance.segmentId,
      start: utterance.start,
      end: utterance.end,
      text: utterance.text,
      speaker: utterance.speaker ?? null,
      confidence: utterance.confidence ?? null,
    });
    if (utterance.utteranceId !== expectedUtteranceId) {
      throw new Error(
        `Utterance ID mismatch for utterance in segment ${utterance.segmentId}: expected ${expectedUtteranceId}, got ${utterance.utteranceId}`,
      );
    }
  }
}

function verifyTranscriptManifestCanonical(
  transcript: TranscriptManifest,
  mediaManifest: MediaSegmentManifest,
  mediaIdentifier: string,
  mediaSha256: string,
): void {
  const sourceEntries = transcript.utterances.map((u) => ({
    segmentId: u.segmentId,
    start: u.start,
    end: u.end,
    text: u.text,
    speaker: u.speaker,
    confidence: u.confidence,
  }));

  const reconstructed = buildTranscriptManifest({
    mediaSegmentManifest: mediaManifest,
    mediaSegmentManifestIdentifier: mediaIdentifier,
    mediaSegmentManifestSha256: mediaSha256,
    transcriptSource: { schemaVersion: 'v1', entries: sourceEntries },
    transcriptSourceIdentifier: transcript.sourceManifest.identifier,
    transcriptSourceSha256: transcript.sourceManifest.sha256,
  });

  if (
    stableStringify(toDeterministicObject(reconstructed)) !==
    stableStringify(toDeterministicObject(transcript))
  ) {
    throw new Error('Transcript manifest is not canonical or contains invalid/duplicate utterances');
  }
}

function buildSubtitleCues(
  mediaManifest: MediaSegmentManifest,
  transcript: TranscriptManifest,
  selection: { segmentIds: string[] },
  style: SubtitleStyle,
): SubtitleCue[] {
  const segmentMap = buildSegmentMap(mediaManifest);
  const utterancesBySegment = new Map<string, TranscriptUtterance[]>();
  for (const utterance of transcript.utterances) {
    const list = utterancesBySegment.get(utterance.segmentId) ?? [];
    list.push(utterance);
    utterancesBySegment.set(utterance.segmentId, list);
  }

  const cues: SubtitleCue[] = [];
  let clipStart = 0;

  for (const segmentId of selection.segmentIds) {
    const segment = segmentMap.get(segmentId);
    if (!segment) {
      throw new Error(`Unknown segment ID in selection: ${segmentId}`);
    }
    if (segment.mediaType !== 'video') {
      throw new Error(`Segment ${segmentId} is not a video segment`);
    }

    const utterances = utterancesBySegment.get(segmentId) ?? [];
    for (const utterance of utterances) {
      const cueStart = clipStart + (utterance.start - segment.start);
      const cueEnd = clipStart + (utterance.end - segment.start);
      cues.push(
        withSubtitleDefaults({
          start: cueStart,
          end: cueEnd,
          text: utterance.text,
          x: style.x,
          y: style.y,
          fontSize: style.fontSize,
          fontColor: style.fontColor,
          fontAlpha: style.fontAlpha,
          borderWidth: style.borderWidth,
          borderColor: style.borderColor,
          box: style.box,
          boxColor: style.boxColor,
          boxAlpha: style.boxAlpha,
          align: style.align,
          font: style.font,
          fontHash: style.fontHash,
        }),
      );
    }

    const duration = segment.end - segment.start;
    if (!(duration > 0) || !Number.isFinite(duration)) {
      throw new Error(`Segment ${segmentId} has invalid duration`);
    }
    clipStart += duration;
  }

  return cues;
}

async function verifySourceAssets(
  mediaManifest: MediaSegmentManifest,
  selection: { segmentIds: string[] },
  transcript: TranscriptManifest,
  projectRoot: string,
  inputRoot: string,
): Promise<Map<string, VerifiedMediaSegment>> {
  const segmentMap = buildSegmentMap(mediaManifest);
  const needed = new Set<string>(selection.segmentIds);
  for (const utterance of transcript.utterances) {
    needed.add(utterance.segmentId);
  }

  const verified = new Map<string, VerifiedMediaSegment>();
  for (const segmentId of needed) {
    const segment = segmentMap.get(segmentId);
    if (!segment) {
      throw new Error(`Unknown segment ID in source verification: ${segmentId}`);
    }
    if (selection.segmentIds.includes(segmentId) && segment.mediaType !== 'video') {
      throw new Error(`Segment ${segmentId} is not a video segment`);
    }
    assertCanonicalRelativePath(segment.relativePath, 'Asset relative path');
    const result = await verifySegmentIntegrity(segment, inputRoot, projectRoot, mediaManifest.schemaVersion);
    verified.set(segmentId, result);
  }

  return verified;
}

async function sha256FromFh(fh: FileHandle, size: number): Promise<string> {
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

interface VerifiedFont {
  fontFh: FileHandle;
  fontStat: Stats;
  fontHash: string;
  fontResolved: string;
  fontRealpath: string;
  fontParentRealpath: string;
  fontParentStat: Stats;
}

async function verifyFontFile(
  projectRoot: string,
  fontsDir: string,
  style: SubtitleStyle,
): Promise<VerifiedFont> {
  assertCanonicalRelativePath(style.font, 'Font path');
  const fontResolved = resolveSafePath(fontsDir, style.font);
  const fontParent = dirname(fontResolved);

  const fontParentStat = await lstat(fontParent);
  if (fontParentStat.isSymbolicLink() || !fontParentStat.isDirectory()) {
    throw new Error(`Font directory is not a directory: ${fontParent}`);
  }
  const fontParentRealpath = await realpath(fontParent);
  if (!isInside(projectRoot, fontParentRealpath)) {
    throw new Error(`Font directory escaped project root: ${fontParent}`);
  }

  const fontFh = await open(fontResolved, O_RDONLY | O_NOFOLLOW);
  try {
    const fontStat = await fontFh.stat();
    if (!fontStat.isFile()) {
      throw new UserError(
        'FONT_PATH_NOT_REGULAR_FILE',
        `Font path is not a regular file: ${style.font}`,
        'フォントファイルが見つかりません',
      );
    }
    if (fontStat.nlink !== 1) {
      throw new Error(`Font file is a hard link or has multiple links: ${style.font}`);
    }

    const expectedHash = style.fontHash.toLowerCase();
    const fontHash = await sha256FromFh(fontFh, fontStat.size);
    if (fontHash !== expectedHash) {
      throw new UserError(
        'FONT_HASH_MISMATCH',
        `Font hash mismatch for ${style.font}: expected ${expectedHash}, got ${fontHash}`,
        'フォントファイルの内容が変更されました',
      );
    }

    const fontStatAfter = await fontFh.stat();
    if (
      fontStatAfter.dev !== fontStat.dev ||
      fontStatAfter.ino !== fontStat.ino ||
      fontStatAfter.size !== fontStat.size ||
      fontStatAfter.mtimeMs !== fontStat.mtimeMs ||
      fontStatAfter.nlink !== fontStat.nlink
    ) {
      throw new Error(`Font file changed during hash read: ${style.font}`);
    }

    const fontRealpath = await realpath(fontResolved).catch(() => null);
    if (!fontRealpath || dirname(fontRealpath) !== fontParentRealpath) {
      throw new Error(`Font is not directly inside its parent directory: ${style.font}`);
    }
    if (!isInside(projectRoot, fontRealpath)) {
      throw new Error(`Font escaped project root: ${style.font}`);
    }

    return {
      fontFh,
      fontStat,
      fontHash,
      fontResolved,
      fontRealpath,
      fontParentRealpath,
      fontParentStat,
    };
  } catch (err) {
    await fontFh.close().catch(() => {});
    throw err;
  }
}

interface VerifiedFontSnapshot {
  snapshotResolved: string;
  snapshotRealpath: string;
  snapshotStat: Stats;
  snapshotParentStat: Stats;
  snapshotParentRealpath: string;
  snapshotDir: string;
}

export interface SubtitleTimelineTestHooks extends PublishAtomicTestHooks {
  beforeFontSnapshotRehash?: () => Promise<void>;
}

async function createVerifiedFontSnapshot(
  projectRoot: string,
  fontFh: FileHandle,
  fontStat: Stats,
  fontHash: string,
  fontResolved: string,
  allCueText: string,
  __testHooks?: SubtitleTimelineTestHooks,
): Promise<VerifiedFontSnapshot> {
  const snapshotDir = await mkdtemp(join(projectRoot, '.font-snap-'));
  const snapshotName = `verified-${fontHash.slice(0, 16)}-${basename(fontResolved)}`;
  const snapshotResolved = join(snapshotDir, snapshotName);
  let snapshotFh: FileHandle | undefined;

  try {
    // Copy the verified bytes from the open file handle into a project-local
    // immutable snapshot. Reading by fd binds the copy to the original inode that
    // produced the verified hash, regardless of whether the named path is swapped.
    await copyFile(`/proc/self/fd/${fontFh.fd}`, snapshotResolved);
    await chmod(snapshotResolved, 0o444);

    const snapshotStatInitial = await lstat(snapshotResolved);
    if (!snapshotStatInitial.isFile() || snapshotStatInitial.size !== fontStat.size) {
      throw new Error('Font snapshot stat does not match verified font');
    }

    // Open the snapshot copy with O_NOFOLLOW and keep the fd bound through glyph
    // inspection. All identity and hash checks use this fd or a parallel lstat of
    // the same named path, so directory/leaf swaps cannot pass undetected.
    snapshotFh = await open(snapshotResolved, O_RDONLY | O_NOFOLLOW);
    const snapshotStat = await snapshotFh.stat();
    if (
      snapshotStat.dev !== snapshotStatInitial.dev ||
      snapshotStat.ino !== snapshotStatInitial.ino ||
      snapshotStat.size !== snapshotStatInitial.size ||
      snapshotStat.mtimeMs !== snapshotStatInitial.mtimeMs ||
      snapshotStat.ctimeMs !== snapshotStatInitial.ctimeMs
    ) {
      throw new Error('Font snapshot identity changed after open');
    }

    const snapshotHash = await sha256FromFh(snapshotFh, snapshotStat.size);
    if (snapshotHash !== fontHash) {
      throw new Error(`Font snapshot hash mismatch: expected ${fontHash}, got ${snapshotHash}`);
    }

    // Freeze the snapshot directory during glyph inspection. The directory is kept
    // searchable but not writable so an attacker cannot rename the parent or leaf.
    await chmod(snapshotDir, 0o500);
    const snapshotParentStatBefore = await lstat(snapshotDir);
    const snapshotStatAfterHash = await snapshotFh.stat();
    if (
      snapshotStatAfterHash.dev !== snapshotStat.dev ||
      snapshotStatAfterHash.ino !== snapshotStat.ino ||
      snapshotStatAfterHash.size !== snapshotStat.size ||
      snapshotStatAfterHash.mtimeMs !== snapshotStat.mtimeMs ||
      snapshotStatAfterHash.ctimeMs !== snapshotStat.ctimeMs
    ) {
      throw new Error('Font snapshot identity changed before glyph inspection');
    }

    await __testHooks?.beforeFontGlyphInspection?.();
    await verifyFontGlyphs(snapshotResolved, allCueText);

    await __testHooks?.beforeFontSnapshotRehash?.();

    // Re-verify using both the bound fd and the named path, plus the directory.
    // Any directory/leaf swap, truncation, or replacement that occurs during the
    // fc-query window changes at least one of dev/ino/size/mtime/ctime.
    const snapshotStatAfterGlyphFd = await snapshotFh.stat();
    const snapshotStatAfterGlyphPath = await lstat(snapshotResolved);
    const snapshotParentStatAfter = await lstat(snapshotDir);
    if (
      snapshotStatAfterGlyphFd.dev !== snapshotStat.dev ||
      snapshotStatAfterGlyphFd.ino !== snapshotStat.ino ||
      snapshotStatAfterGlyphFd.size !== snapshotStat.size ||
      snapshotStatAfterGlyphFd.mtimeMs !== snapshotStat.mtimeMs ||
      snapshotStatAfterGlyphFd.ctimeMs !== snapshotStat.ctimeMs ||
      snapshotStatAfterGlyphPath.dev !== snapshotStat.dev ||
      snapshotStatAfterGlyphPath.ino !== snapshotStat.ino ||
      snapshotStatAfterGlyphPath.size !== snapshotStat.size ||
      snapshotStatAfterGlyphPath.mtimeMs !== snapshotStat.mtimeMs ||
      snapshotStatAfterGlyphPath.ctimeMs !== snapshotStat.ctimeMs ||
      snapshotParentStatAfter.dev !== snapshotParentStatBefore.dev ||
      snapshotParentStatAfter.ino !== snapshotParentStatBefore.ino ||
      snapshotParentStatAfter.size !== snapshotParentStatBefore.size ||
      snapshotParentStatAfter.mtimeMs !== snapshotParentStatBefore.mtimeMs ||
      snapshotParentStatAfter.ctimeMs !== snapshotParentStatBefore.ctimeMs
    ) {
      throw new Error('Font snapshot identity changed during glyph verification');
    }

    const snapshotHashAfterGlyph = await sha256FromFh(snapshotFh, snapshotStatAfterGlyphFd.size);
    if (snapshotHashAfterGlyph !== fontHash) {
      throw new Error(`Font snapshot hash changed during glyph verification: expected ${fontHash}, got ${snapshotHashAfterGlyph}`);
    }

    // Restore write permission before returning so the caller can clean up.
    await chmod(snapshotDir, 0o700);

    const snapshotRealpath = await realpath(snapshotResolved);
    const snapshotParentStat = await lstat(snapshotDir);
    const snapshotParentRealpath = await realpath(snapshotDir);
    if (dirname(snapshotRealpath) !== snapshotParentRealpath) {
      throw new Error('Font snapshot is not directly inside its parent directory');
    }
    if (!isInside(projectRoot, snapshotRealpath)) {
      throw new Error('Font snapshot escaped project root');
    }

    return {
      snapshotResolved,
      snapshotRealpath,
      snapshotStat: snapshotStatAfterGlyphPath,
      snapshotParentStat,
      snapshotParentRealpath,
      snapshotDir,
    };
  } catch (err) {
    if (snapshotFh) {
      await snapshotFh.close().catch(() => {});
      snapshotFh = undefined;
    }
    await chmod(snapshotDir, 0o700).catch(() => {});
    let cleanupErr: unknown;
    try {
      await rm(snapshotDir, { recursive: true, force: true });
    } catch (e) {
      cleanupErr = e;
    }
    if (cleanupErr !== undefined) {
      throw new AggregateError([err, cleanupErr], `Failed to clean up font snapshot: ${(cleanupErr as Error).message}`);
    }
    throw err;
  } finally {
    await fontFh.close().catch(() => {});
    if (snapshotFh) {
      await snapshotFh.close().catch(() => {});
    }
  }
}

function stableJsonBytes(value: unknown): { bytes: Buffer; sha256: string } {
  const deterministic = toDeterministicObject(value);
  const bytes = Buffer.from(JSON.stringify(deterministic, null, 2) + '\n', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

export async function generateAndWriteSubtitleTimeline(
  options: GenerateAndWriteSubtitleTimelineOptions,
): Promise<GenerateAndWriteSubtitleTimelineResult> {
  const projectRoot = resolve(options.projectRoot);
  const inputRoot = resolve(options.inputRoot);
  if (!isInside(projectRoot, inputRoot)) {
    throw new Error(`Input root escaped project root: ${options.inputRoot}`);
  }

  const fontsDir = options.fontsDir ? resolve(options.fontsDir) : join(projectRoot, 'fonts');
  const fontsDirStat = await lstat(fontsDir).catch(() => null);
  if (!fontsDirStat || fontsDirStat.isSymbolicLink() || !fontsDirStat.isDirectory()) {
    throw new Error(`Fonts directory is not a valid directory: ${options.fontsDir ?? fontsDir}`);
  }
  const fontsDirRealpath = await realpath(fontsDir);
  if (!isInside(projectRoot, fontsDirRealpath)) {
    throw new Error(`Fonts directory escaped project root: ${fontsDir}`);
  }

  const maxBytes = validateMaxBytes(options.maxBytes);

  const outputRel = options.outputRel ?? 'timelines/subtitled.json';
  assertCanonicalRelativePath(outputRel, 'Output path');
  const normalizedOutputRel = normalizeTimelineOutputRel(outputRel);
  const timelineOutputPath = deriveTimelineOutputPath(normalizedOutputRel);

  assertCanonicalRelativePath(options.mediaManifestRel, 'Media manifest path');
  const media = await readMediaSegmentManifest(projectRoot, options.mediaManifestRel, {
    maxBytes,
  });

  assertCanonicalRelativePath(options.selectionRel, 'Segment selection path');
  const selectionResult = await readJsonFileSafe(projectRoot, options.selectionRel, {
    label: 'Segment selection',
    maxBytes,
  });
  assertNoDuplicateKeys(selectionResult.text);
  const selection = SegmentSelectionSchema.parse(selectionResult.data);

  assertCanonicalRelativePath(options.transcriptManifestRel, 'Transcript manifest path');
  const transcriptResult = await readTranscriptManifest(
    projectRoot,
    options.transcriptManifestRel,
    { maxBytes },
  );

  assertCanonicalRelativePath(options.styleRel, 'Subtitle style path');
  const styleResult = await readSubtitleStyle(projectRoot, options.styleRel, { maxBytes });

  const seenInodes = new Map<string, string>();

  assertNotHardLinked(media.stat, 'Media segment manifest');
  trackUniqueInode(media.stat, 'Media segment manifest', seenInodes);
  assertNotHardLinked(selectionResult.stat, 'Segment selection');
  trackUniqueInode(selectionResult.stat, 'Segment selection', seenInodes);
  assertNotHardLinked(transcriptResult.stat, 'Transcript manifest');
  trackUniqueInode(transcriptResult.stat, 'Transcript manifest', seenInodes);
  assertNotHardLinked(styleResult.stat, 'Subtitle style');
  trackUniqueInode(styleResult.stat, 'Subtitle style', seenInodes);

  verifyTranscriptManifestAgainstMedia(
    transcriptResult.manifest,
    media.manifest,
    media.identifier,
    media.sha256,
  );
  verifyTranscriptManifestCanonical(
    transcriptResult.manifest,
    media.manifest,
    media.identifier,
    media.sha256,
  );

  const sourceAssets = await verifySourceAssets(
    media.manifest,
    selection,
    transcriptResult.manifest,
    projectRoot,
    inputRoot,
  );
  const canonicalAssets = new Map<string, VerifiedMediaSegment>();
  const seenAssetInodes = new Map<string, string>();
  for (const [, verified] of sourceAssets) {
    assertNotHardLinked(verified.assetStat, `Asset ${verified.relativePath}`);
    const inodeKey = `${verified.assetStat.dev}:${verified.assetStat.ino}`;
    const existingByInode = seenAssetInodes.get(inodeKey);
    if (existingByInode !== undefined && existingByInode !== verified.assetRealpath) {
      throw new Error(
        `Asset ${verified.relativePath} shares an inode with ${existingByInode} but has a different canonical path`,
      );
    }
    const existingCanonical = canonicalAssets.get(verified.assetRealpath);
    if (existingCanonical !== undefined) {
      if (
        existingCanonical.assetStat.dev !== verified.assetStat.dev ||
        existingCanonical.assetStat.ino !== verified.assetStat.ino
      ) {
        throw new Error(
          `Asset ${verified.relativePath} resolves to ${verified.assetRealpath} but its inode changed between segments`,
        );
      }
      continue;
    }
    if (existingByInode === undefined) {
      seenAssetInodes.set(inodeKey, verified.assetRealpath);
    }
    canonicalAssets.set(verified.assetRealpath, verified);
  }

  const cues = buildSubtitleCues(media.manifest, transcriptResult.manifest, selection, styleResult.style);

  const baseTimeline = buildTimelineFromManifestAndSelection(
    media.manifest,
    selection,
    timelineOutputPath,
  );

  const timeline: Timeline = {
    ...baseTimeline,
    subtitles: cues.length > 0 ? cues : undefined,
    font: styleResult.style.font,
    fontHash: styleResult.style.fontHash,
  };

  const duration = timeline.clips[timeline.clips.length - 1].end;
  validateCues(cues, duration);

  const allCueText = cues.map((c) => c.text).join('');
  const font = await verifyFontFile(projectRoot, fontsDir, styleResult.style);
  trackUniqueInode(font.fontStat, 'Subtitle font', seenInodes);

  const fontSnapshot = await createVerifiedFontSnapshot(
    projectRoot,
    font.fontFh,
    font.fontStat,
    font.fontHash,
    font.fontResolved,
    allCueText,
    options.__testHooks,
  );

  let snapshotCleaned = false;
  async function cleanupFontSnapshot(): Promise<void> {
    if (snapshotCleaned) return;
    snapshotCleaned = true;
    await rm(fontSnapshot.snapshotDir, { recursive: true, force: true });
  }

  let processError: unknown = undefined;
  let result: GenerateAndWriteSubtitleTimelineResult | undefined;
  try {
    const parsedTimeline = TimelineSchema.parse(timeline);
    const { bytes: outputBytes, sha256: expectedSha256 } = stableJsonBytes(parsedTimeline);

    const inputs: PublishInput[] = [];
    const addInput = async (
      result: {
        resolved: string;
        realpath: string;
        sha256: string;
        stat: Stats;
        parentStat: Stats;
        parentRealpath: string;
      },
      label: string,
    ) => {
      await options.__testHooks?.beforeInputSnapshot?.(label);
      inputs.push(
        await captureInputSnapshot(
          projectRoot,
          result.resolved,
          result.realpath,
          result.stat,
          result.sha256,
          label,
          result.parentStat,
          result.parentRealpath,
        ),
      );
    };

    await addInput(media, 'Media segment manifest');
    await addInput(selectionResult, 'Segment selection');
    await addInput(transcriptResult, 'Transcript manifest');
    await addInput(styleResult, 'Subtitle style');

    for (const [, verified] of canonicalAssets) {
      await addInput(
        {
          resolved: verified.assetResolved,
          realpath: verified.assetRealpath,
          sha256: verified.assetSha256,
          stat: verified.assetStat,
          parentStat: verified.assetParentStat,
          parentRealpath: verified.assetParentRealpath,
        },
        `Asset ${verified.relativePath}`,
      );
    }

    // Include the original font file in the publish barrier so the helper
    // re-verifies fd/inode/bytes before the final link, closing the window
    // between beforeRename and the Python contract's input validation.
    await addInput(
      {
        resolved: font.fontResolved,
        realpath: font.fontRealpath,
        sha256: font.fontHash,
        stat: font.fontStat,
        parentStat: font.fontParentStat,
        parentRealpath: font.fontParentRealpath,
      },
      'Original subtitle font',
    );

    await options.__testHooks?.beforeInputSnapshot?.('Subtitle font');
    inputs.push(
      await captureInputSnapshot(
        projectRoot,
        fontSnapshot.snapshotResolved,
        fontSnapshot.snapshotRealpath,
        fontSnapshot.snapshotStat,
        font.fontHash,
        'Subtitle font',
        fontSnapshot.snapshotParentStat,
        fontSnapshot.snapshotParentRealpath,
      ),
    );

    const previousSourcePaths = [
      media.resolved,
      selectionResult.resolved,
      transcriptResult.resolved,
      styleResult.resolved,
      ...[...canonicalAssets.values()].map((v) => v.assetResolved),
      font.fontResolved,
      fontSnapshot.snapshotResolved,
    ];

    const userBeforeRename = options.__testHooks?.beforeRename;
    const beforeRename = async (ctx: {
      dirFh: FileHandle;
      dirPath: string;
      tempName: string;
      finalName: string;
    }) => {
      await userBeforeRename?.(ctx);
      const currentStat = await lstat(font.fontResolved).catch(() => null);
      if (
        !currentStat ||
        currentStat.dev !== font.fontStat.dev ||
        currentStat.ino !== font.fontStat.ino ||
        currentStat.size !== font.fontStat.size ||
        currentStat.mtimeMs !== font.fontStat.mtimeMs ||
        currentStat.ctimeMs !== font.fontStat.ctimeMs
      ) {
        throw new Error('Font path changed after snapshot');
      }
    };

    const outputPath = await publishAtomicNoReplace(
      outputBytes,
      projectRoot,
      normalizedOutputRel,
      inputRoot,
      inputs,
      {
        expectedSha256,
        previousSourcePaths,
        allowExistingFinal: options.allowExistingFinal ?? false,
        __testHooks: { ...options.__testHooks, beforeRename },
      },
    );

    result = {
      timeline: parsedTimeline,
      outputPath,
      timelineSha256: expectedSha256,
      manifestSha256: media.sha256,
      selectionSha256: selectionResult.sha256,
      transcriptManifestSha256: transcriptResult.sha256,
      styleSha256: styleResult.sha256,
    };
  } catch (err) {
    processError = err;
  }

  let cleanupError: unknown = undefined;
  try {
    await cleanupFontSnapshot();
  } catch (err) {
    cleanupError = err;
  }

  if (processError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [processError, cleanupError],
      'Timeline generation failed and font snapshot cleanup also failed',
    );
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (processError !== undefined) {
    throw processError;
  }
  if (result === undefined) {
    throw new Error('Unexpected missing generation result');
  }
  return result;
}
