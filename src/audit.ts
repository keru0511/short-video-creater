import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, link, lstat, mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { GenerateResult, ProbeInfo, Timeline } from './core.js';
import { ffprobe, resolveSafePath, sha256File, timelineHash } from './core.js';

const SCHEMA_VERSION = '1.0.0';

export type AuditSource = 'CLI' | 'GUI';

interface AuditInputEntry {
  role: 'visual' | 'audio' | 'bgm' | 'font';
  identifier: string;
  sha256: string;
  timelineSource?: string;
}

interface AuditOutputEntry {
  identifier: string;
  sha256: string;
  probe: ProbeInfo;
}

interface AuditErrorEntry {
  code: string;
  message: string;
}

interface AuditFfmpegEntry {
  version: string;
  argv: string[];
  outputPreset: string;
}

export interface AuditManifest {
  schemaVersion: string;
  jobId: string;
  source: AuditSource;
  status: 'success' | 'failure';
  startedAt: string;
  finishedAt: string;
  timelineHash: string | null;
  originalTimelineHash: string | null;
  timeline: unknown;
  inputs: AuditInputEntry[];
  output: AuditOutputEntry | null;
  ffmpeg: AuditFfmpegEntry | null;
  error: AuditErrorEntry | null;
}

export interface AuditAssetEntry {
  role: 'visual' | 'audio' | 'bgm' | 'font';
  originalSource: string;
  assetName: string;
  absPath: string;
  hash?: string;
}

export interface AuditAssetInfo {
  assetsDir: string;
  assetTimeline: Timeline;
  originalTimelineHash: string | null;
  assetMap: AuditAssetEntry[];
}

export interface AuditWriteOptions {
  jobId?: string;
  source: AuditSource;
  startedAt: string;
  finishedAt: string;
  rootDir: string;
  outputDir: string;
  fixturesDir: string;
  fontsDir: string;
  timeline?: Timeline | Record<string, unknown> | null;
  result?: GenerateResult;
  error?: unknown;
  assetMap?: AuditAssetEntry[];
  originalTimelineHash?: string | null;
  hooks?: {
    onAfterSnapshot?: () => Promise<void> | void;
  };
}

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const AuditSourceSchema = z.enum(['CLI', 'GUI']);

const ProbeInfoSchema = z
  .object({
    width: z.union([z.number().int().nonnegative(), z.undefined()]),
    height: z.union([z.number().int().nonnegative(), z.undefined()]),
    fps: z.union([z.number().nonnegative(), z.undefined()]),
    videoCodec: z.union([z.string(), z.undefined()]),
    audioCodec: z.union([z.string(), z.undefined()]),
    sampleRate: z.union([z.number().int().nonnegative(), z.undefined()]),
    duration: z.number().nonnegative(),
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
  })
  .strict();

const AuditInputEntrySchema = z
  .object({
    role: z.enum(['visual', 'audio', 'bgm', 'font']),
    identifier: z.string().min(1),
    sha256: HexSha256Schema,
    timelineSource: z.string().optional(),
  })
  .strict();

const AuditOutputEntrySchema = z
  .object({
    identifier: z.string().min(1),
    sha256: HexSha256Schema,
    probe: ProbeInfoSchema,
  })
  .strict();

const AuditErrorEntrySchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const AuditFfmpegEntrySchema = z
  .object({
    version: z.string().min(1),
    argv: z.array(z.string()),
    outputPreset: z.string().min(1),
  })
  .strict();

export const AuditManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    jobId: z.string().min(1),
    source: AuditSourceSchema,
    status: z.enum(['success', 'failure']),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    timelineHash: z.union([HexSha256Schema, z.null()]),
    originalTimelineHash: z.union([HexSha256Schema, z.null()]),
    timeline: z.unknown(),
    inputs: z.array(AuditInputEntrySchema),
    output: z.union([AuditOutputEntrySchema, z.null()]),
    ffmpeg: z.union([AuditFfmpegEntrySchema, z.null()]),
    error: z.union([AuditErrorEntrySchema, z.null()]),
  })
  .strict();

const CONTROL_CHARS = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g;
const API_KEY_PATTERN =
  /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|credentials|auth|bearer|sk-|sk_|private[_-]?key)[\s=:]*["']?[a-zA-Z0-9_+\-=]{8,}["']?/gi;
const SHELL_METACHARACTERS_PATH = /[;|&$`><!*?{}[\]()]/g;
const SHELL_METACHARACTERS_TEXT = /[;|&$`><!]/g;
const MULTIPLE_DOTS = /\.{2,}/g;
const ABSOLUTE_PATH_PATTERN =
  /(?<![A-Za-z0-9_.])(\/(?:[A-Za-z0-9_.\/+\-@\[\]]*\/)*[A-Za-z0-9_.+\-@\[\]]*|[A-Za-z]:\\(?:[A-Za-z0-9_.\\+\-@]*\\)*[A-Za-z0-9_.+\-@]*)/g;

function maskSensitive(value: string): string {
  return value.replace(API_KEY_PATTERN, '[REDACTED]');
}

function replaceControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '?');
}

function redactAbsolutePaths(value: string): string {
  return value.replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]');
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown error');
}

function sanitizeFreeText(value: string): string {
  let out = replaceControlChars(value);
  out = maskSensitive(out);
  out = out.replace(SHELL_METACHARACTERS_TEXT, '_');
  return out;
}

export function sanitizePathIdentifier(value: string): string | null {
  let out = value.replace(/\\/g, '/');
  out = replaceControlChars(out);
  out = out.replace(SHELL_METACHARACTERS_PATH, '_');
  out = maskSensitive(out);
  out = redactAbsolutePaths(out);
  if (isAbsolute(out) || containsTraversal(out)) return null;
  out = out.replace(MULTIPLE_DOTS, '_');
  out = out.replace(/\s+/g, '_');
  out = out.replace(/_+/g, '_');
  return out;
}

function containsTraversal(value: string): boolean {
  return value.includes('../') || value === '..' || value.startsWith('..') || value.endsWith('/..');
}

function encodeSafeIdentifier(value: string): string | null {
  if (isAbsolute(value) || containsTraversal(value)) return null;
  const parts = value.replace(/\\/g, '/').split('/');
  // Use standard encodeURIComponent per path segment so Unicode, emoji, and
  // combining characters are encoded as UTF-8 percent-escapes and can be
  // recovered with decodeURIComponent.
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function safeString(value: string): string {
  let out = replaceControlChars(value);
  out = maskSensitive(out);
  out = redactAbsolutePaths(out);
  out = out.replace(SHELL_METACHARACTERS_TEXT, '_');
  if (isAbsolute(out) || containsTraversal(out)) {
    return '[REDACTED]';
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[safeString(k)] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

function sanitizeClip(clip: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(clip)) {
    const safeKey = safeString(key);
    if (key === 'source' && typeof value === 'string') {
      out[safeKey] = sanitizePathIdentifier(value) ?? '[REDACTED]';
    } else {
      out[safeKey] = sanitizeValue(value);
    }
  }
  return out;
}

function sanitizeSubtitle(sub: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sub)) {
    const safeKey = safeString(key);
    if (key === 'text' && typeof value === 'string') {
      out[safeKey] = safeString(value);
    } else {
      out[safeKey] = sanitizeValue(value);
    }
  }
  return out;
}

function sanitizeTimeline(timeline: unknown): unknown {
  if (!timeline || typeof timeline !== 'object') return sanitizeValue(timeline);
  const t = timeline as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(t)) {
    const safeKey = safeString(key);
    if ((key === 'outputPath' || key === 'font') && typeof value === 'string') {
      out[safeKey] = sanitizePathIdentifier(value) ?? '[REDACTED]';
    } else if (key === 'bgm' && value && typeof value === 'object') {
      const bgm = value as Record<string, unknown>;
      const safeBgm: Record<string, unknown> = {};
      for (const [bgmKey, bgmValue] of Object.entries(bgm)) {
        const safeBgmKey = safeString(bgmKey);
        if (bgmKey === 'source' && typeof bgmValue === 'string') {
          safeBgm[safeBgmKey] = sanitizePathIdentifier(bgmValue) ?? '[REDACTED]';
        } else {
          safeBgm[safeBgmKey] = sanitizeValue(bgmValue);
        }
      }
      out[safeKey] = safeBgm;
    } else if (key === 'clips' && Array.isArray(value)) {
      out[safeKey] = value.map((c) =>
        c && typeof c === 'object' ? sanitizeClip(c as Record<string, unknown>) : sanitizeValue(c),
      );
    } else if (key === 'subtitles' && Array.isArray(value)) {
      out[safeKey] = value.map((s) =>
        s && typeof s === 'object' ? sanitizeSubtitle(s as Record<string, unknown>) : sanitizeValue(s),
      );
    } else {
      out[safeKey] = sanitizeValue(value);
    }
  }
  return out;
}

async function realRoot(rootDir: string): Promise<string> {
  return resolve(rootDir);
}

async function makeSafeIdentifier(rootDir: string, absPath: string): Promise<string | null> {
  if (!isAbsolute(absPath)) return null;
  const root = await realRoot(rootDir);
  let rel = relative(root, absPath);
  rel = rel.split(sep).join('/');
  if (isAbsolute(rel) || rel.startsWith('../') || rel === '..' || containsTraversal(rel)) {
    return null;
  }
  rel = rel.replace(/^\.\//, '');
  if (!rel) return null;
  const id = encodeSafeIdentifier(rel);
  return id;
}

function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function ensureTrustedDirectory(dir: string, rootDir: string, create = false): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(dir);
  if (!isInside(root, target)) {
    throw new Error('directory outside project root');
  }

  const rel = relative(root, target);
  const components = rel.split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    const stat = await lstat(current).catch(() => null);
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error('path is a symbolic link');
      }
      if (!stat.isDirectory()) {
        throw new Error('path is not a directory');
      }
      const realCurrent = await realpath(current);
      if (!isInside(root, realCurrent)) {
        throw new Error('path resolves outside project root');
      }
    } else if (create) {
      try {
        await mkdir(current, { recursive: false, mode: 0o755 });
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EEXIST') {
          const retry = await lstat(current).catch(() => null);
          if (!retry?.isDirectory() || retry.isSymbolicLink()) {
            throw new Error('path is not a directory');
          }
        } else {
          throw err;
        }
      }
    }
  }

  const finalStat = await lstat(target).catch(() => null);
  if (!finalStat) {
    throw new Error('directory does not exist');
  }
  if (finalStat.isSymbolicLink()) {
    throw new Error('directory is a symbolic link');
  }
  if (!finalStat.isDirectory()) {
    throw new Error('path is not a directory');
  }
  const realTarget = await realpath(target);
  if (!isInside(root, realTarget)) {
    throw new Error('directory resolves outside project root');
  }
}

export async function prepareJobAssetDir(dir: string, rootDir: string): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(dir);
  if (!isInside(root, target)) {
    throw new Error('job asset directory outside project root');
  }

  const parent = dirname(target);
  await ensureTrustedDirectory(parent, rootDir, true);

  const leafStat = await lstat(target).catch(() => null);
  if (leafStat) {
    throw new Error('job asset directory already exists');
  }

  try {
    await mkdir(target, { recursive: false, mode: 0o755 });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      throw new Error('job asset directory already exists');
    }
    throw err;
  }

  const finalStat = await lstat(target).catch(() => null);
  if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw new Error('job asset directory is not a directory');
  }
  const realTarget = await realpath(target);
  if (!isInside(root, realTarget)) {
    throw new Error('job asset directory resolves outside project root');
  }
}

function makeAssetName(role: string, ext: string, counters: Record<string, number>): string {
  const index = counters[role] ?? 0;
  counters[role] = index + 1;
  const e = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `asset-${role}-${index}${e}`;
}

async function copySourceToAssets(
  absPath: string,
  role: string,
  originalExt: string,
  counters: Record<string, number>,
  assetsDir: string,
): Promise<string> {
  const assetName = makeAssetName(role, originalExt, counters);
  const dest = resolve(assetsDir, assetName);
  const existing = await lstat(dest).catch(() => null);
  if (existing) {
    throw new Error(`asset file already exists: ${assetName}`);
  }
  if (absPath !== dest) {
    await cp(absPath, dest, { preserveTimestamps: true });
  }
  return assetName;
}

export async function prepareAuditAssets(options: {
  jobId: string;
  rootDir: string;
  outputDir: string;
  fixturesDir: string;
  fontsDir: string;
  timeline: Timeline | Record<string, unknown>;
}): Promise<AuditAssetInfo> {
  const jobId = options.jobId;
  const rootDir = resolve(options.rootDir);
  const outputDir = resolve(options.outputDir);
  const fixturesDir = resolve(options.fixturesDir);
  const fontsDir = resolve(options.fontsDir);
  const assetsDir = resolve(outputDir, 'assets', jobId);

  await prepareJobAssetDir(assetsDir, rootDir);

  const originalTimeline = JSON.parse(JSON.stringify(options.timeline)) as Record<string, unknown>;
  let originalTimelineHash: string | null = null;
  if (originalTimeline && typeof originalTimeline === 'object') {
    try {
      originalTimelineHash = timelineHash(originalTimeline as Timeline);
    } catch {
      originalTimelineHash = null;
    }
  }

  const assetTimeline = JSON.parse(JSON.stringify(options.timeline)) as Record<string, unknown>;
  const assetMap: AuditAssetEntry[] = [];
  const counters: Record<string, number> = { visual: 0, audio: 0, bgm: 0, font: 0 };

  if (assetTimeline && typeof assetTimeline === 'object') {
    const outputPath = assetTimeline.outputPath;
    if (typeof outputPath === 'string') {
      const normalized = outputPath.replace(/\\/g, '/');
      const sanitized = sanitizePathIdentifier(normalized);
      if (sanitized === null || sanitized !== normalized) {
        assetTimeline.outputPath = `${jobId}.mp4`;
      }
    }

    const clips = Array.isArray(assetTimeline.clips) ? assetTimeline.clips : [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (!clip || typeof clip !== 'object') continue;
      const c = clip as Record<string, unknown>;
      const type = String(c.type ?? '');
      const source = c.source;
      if (typeof source !== 'string') continue;
      let role: 'visual' | 'audio' | undefined;
      if (type === 'image' || type === 'video') role = 'visual';
      else if (type === 'audio') role = 'audio';
      else continue;
      try {
        const absPath = resolveSafePath(fixturesDir, source);
        const assetName = await copySourceToAssets(absPath, role, extname(source), counters, assetsDir);
        c.source = assetName;
        assetMap.push({ role, originalSource: source, assetName, absPath: resolve(assetsDir, assetName) });
      } catch {
        // Leave original source in place so generate reports the actual failure.
      }
    }

    if (assetTimeline.bgm && typeof assetTimeline.bgm === 'object') {
      const bgm = assetTimeline.bgm as Record<string, unknown>;
      const source = bgm.source;
      if (typeof source === 'string') {
        try {
          const absPath = resolveSafePath(fixturesDir, source);
          const assetName = await copySourceToAssets(absPath, 'bgm', extname(source), counters, assetsDir);
          bgm.source = assetName;
          assetMap.push({ role: 'bgm', originalSource: source, assetName, absPath: resolve(assetsDir, assetName) });
        } catch {
          // Leave original source.
        }
      }
    }

    const fontSource = assetTimeline.font;
    if (typeof fontSource === 'string') {
      try {
        const absPath = resolveSafePath(fontsDir, fontSource);
        const assetName = await copySourceToAssets(absPath, 'font', extname(fontSource), counters, assetsDir);
        assetTimeline.font = assetName;
        if (typeof assetTimeline.fontHash !== 'string' || !assetTimeline.fontHash) {
          assetTimeline.fontHash = await sha256File(absPath);
        }
        assetMap.push({
          role: 'font',
          originalSource: fontSource,
          assetName,
          absPath: resolve(assetsDir, assetName),
          hash: String(assetTimeline.fontHash),
        });
      } catch {
        // Leave original source.
      }
    }
  }

  return {
    assetsDir,
    assetTimeline: assetTimeline as Timeline,
    originalTimelineHash,
    assetMap,
  };
}

async function buildInputEntries(
  timeline: Timeline,
  result: GenerateResult,
  rootDir: string,
  fixturesDir: string,
  fontsDir: string,
): Promise<AuditInputEntry[]> {
  const entries: AuditInputEntry[] = [];
  const hashByPath = new Map<string, string>(Object.entries(result.sourceHashes));

  async function add(source: string, role: AuditInputEntry['role'], timelineSource?: string) {
    try {
      const baseDir = role === 'font' ? fontsDir : fixturesDir;
      const absPath = resolveSafePath(baseDir, source);
      const hash = hashByPath.get(absPath) ?? (await sha256File(absPath));
      const identifier = (await makeSafeIdentifier(rootDir, absPath)) ?? '[REDACTED_PATH]';
      const safeTimelineSource = timelineSource ? (sanitizePathIdentifier(timelineSource) ?? '[REDACTED]') : undefined;
      entries.push({ role, identifier, sha256: hash, timelineSource: safeTimelineSource });
    } catch {
      // Skip inputs that cannot be resolved or hashed safely.
    }
  }

  for (const clip of timeline.clips) {
    if (clip.type === 'image' || clip.type === 'video') {
      await add(clip.source, 'visual', clip.source);
    } else if (clip.type === 'audio') {
      await add(clip.source, 'audio', clip.source);
    }
  }
  if (timeline.bgm) await add(timeline.bgm.source, 'bgm', timeline.bgm.source);
  if (timeline.font) await add(timeline.font, 'font', timeline.font);

  return entries;
}

async function buildInputsFromAssetMap(
  assetMap: AuditAssetEntry[],
  result: GenerateResult | undefined,
  rootDir: string,
): Promise<AuditInputEntry[]> {
  const entries: AuditInputEntry[] = [];
  const hashByPath = result ? new Map<string, string>(Object.entries(result.sourceHashes)) : new Map<string, string>();
  for (const asset of assetMap) {
    const hash = asset.hash ?? hashByPath.get(asset.absPath) ?? (await sha256File(asset.absPath).catch(() => undefined));
    if (!hash) continue;
    const identifier = (await makeSafeIdentifier(rootDir, asset.absPath)) ?? '[REDACTED_PATH]';
    const safeTimelineSource = sanitizePathIdentifier(asset.originalSource) ?? '[REDACTED]';
    entries.push({ role: asset.role, identifier, sha256: hash, timelineSource: safeTimelineSource });
  }
  return entries;
}

async function buildFailureInputs(
  timeline: Timeline | Record<string, unknown>,
  rootDir: string,
  outputDir: string,
  jobId: string,
  fixturesDir: string,
  fontsDir: string,
): Promise<AuditInputEntry[]> {
  const entries: AuditInputEntry[] = [];
  const t = timeline as Record<string, unknown>;

  // Snapshot resolvable inputs so the failure manifest identifier never
  // carries the original filename (which may contain secrets or shell chars).
  const snapshotDir = resolve(outputDir, 'audit', jobId, 'inputs');
  await ensureTrustedDirectory(snapshotDir, rootDir, true);

  const counters = new Map<string, number>();
  function nextIndex(role: string): number {
    const idx = counters.get(role) ?? 0;
    counters.set(role, idx + 1);
    return idx;
  }

  async function add(source: unknown, role: AuditInputEntry['role'], timelineSource?: string) {
    if (typeof source !== 'string') return;
    try {
      const baseDir = role === 'font' ? fontsDir : fixturesDir;
      const absPath = resolveSafePath(baseDir, source);
      const hash = await sha256File(absPath);

      // Use a content-addressed snapshot name so the original filename or
      // extension (which may contain secrets, control chars, or shell metachars)
      // is never reflected in the manifest identifier or on disk.
      const snapshotName = `input-${role}-${nextIndex(role)}-${hash}`;
      const snapshotAbsPath = resolve(snapshotDir, snapshotName);
      await cp(absPath, snapshotAbsPath, { preserveTimestamps: true, force: false });

      const snapshotHash = await sha256File(snapshotAbsPath);
      if (snapshotHash !== hash) {
        await rm(snapshotAbsPath, { force: true }).catch(() => {});
        throw new Error('Input snapshot hash mismatch');
      }

      const identifier = (await makeSafeIdentifier(rootDir, snapshotAbsPath)) ?? '[REDACTED_PATH]';
      const safeTimelineSource = sanitizePathIdentifier(source) ?? '[REDACTED]';
      entries.push({ role, identifier, sha256: hash, timelineSource: safeTimelineSource });
    } catch {
      // Missing/invalid files are silently skipped in failure manifests.
    }
  }

  const clips = Array.isArray(t.clips) ? t.clips : [];
  for (const clip of clips) {
    if (!clip || typeof clip !== 'object') continue;
    const c = clip as Record<string, unknown>;
    const type = String(c.type ?? '');
    const source = c.source;
    if (type === 'image' || type === 'video') await add(source, 'visual', typeof source === 'string' ? source : undefined);
    if (type === 'audio') await add(source, 'audio', typeof source === 'string' ? source : undefined);
  }
  if (t.bgm && typeof t.bgm === 'object') {
    const bgm = t.bgm as Record<string, unknown>;
    await add(bgm.source, 'bgm', typeof bgm.source === 'string' ? bgm.source : undefined);
  }
  if (typeof t.font === 'string') await add(t.font, 'font', t.font);

  return entries;
}

async function buildOutputEntry(
  result: GenerateResult,
  rootDir: string,
  snapshotPath: string,
): Promise<AuditOutputEntry> {
  const identifier = (await makeSafeIdentifier(rootDir, snapshotPath)) ?? '[REDACTED_PATH]';
  // Use the frozen provenance hash computed at generation time; do not re-hash
  // after verifyGenerateResultIntegrity() to avoid a TOCTOU window.
  return { identifier, sha256: result.outputSha256, probe: result.probe };
}

async function buildKnownPathMap(
  rootDir: string,
  result: GenerateResult,
  snapshotPath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const outputId = await makeSafeIdentifier(rootDir, snapshotPath);
  if (outputId) {
    map.set(result.outputPath, outputId);
    map.set(snapshotPath, outputId);
  }
  for (const absPath of Object.keys(result.sourceHashes)) {
    const id = await makeSafeIdentifier(rootDir, absPath);
    if (id) map.set(absPath, id);
  }
  if (result.fontFile) {
    const id = await makeSafeIdentifier(rootDir, result.fontFile);
    if (id) map.set(result.fontFile, id);
  }
  return new Map([...map.entries()].sort((a, b) => b[0].length - a[0].length));
}

export function getOutputSnapshotPath(outputDir: string, jobId: string, outputPath: string): string {
  return resolve(outputDir, 'artifacts', jobId, `snapshot-${basename(outputPath)}`);
}

async function snapshotOutputArtifact(
  result: GenerateResult,
  rootDir: string,
  outputDir: string,
  jobId: string,
): Promise<string> {
  const snapshotPath = getOutputSnapshotPath(outputDir, jobId, result.outputPath);
  const snapshotDir = dirname(snapshotPath);
  await ensureTrustedDirectory(snapshotDir, rootDir, true);

  await cp(result.outputPath, snapshotPath, { preserveTimestamps: true, force: false });

  const snapshotHash = await sha256File(snapshotPath);
  if (snapshotHash !== result.outputSha256) {
    await rm(snapshotPath, { force: true }).catch(() => {});
    throw new Error('Snapshot hash mismatch: output file was modified after generation');
  }

  const snapshotProbe = await ffprobe(snapshotPath);
  if (
    snapshotProbe.width !== result.probe.width ||
    snapshotProbe.height !== result.probe.height ||
    snapshotProbe.fps !== result.probe.fps ||
    snapshotProbe.videoCodec !== result.probe.videoCodec ||
    snapshotProbe.audioCodec !== result.probe.audioCodec ||
    snapshotProbe.sampleRate !== result.probe.sampleRate ||
    snapshotProbe.duration !== result.probe.duration ||
    snapshotProbe.hasVideo !== result.probe.hasVideo ||
    snapshotProbe.hasAudio !== result.probe.hasAudio
  ) {
    await rm(snapshotPath, { force: true }).catch(() => {});
    throw new Error('Snapshot probe mismatch: output file was modified after generation');
  }

  return snapshotPath;
}

async function verifySnapshotIntegrity(snapshotPath: string, result: GenerateResult, rootDir: string): Promise<void> {
  const stat = await lstat(snapshotPath).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Snapshot integrity: not a regular file');
  }
  const realSnapshot = await realpath(snapshotPath);
  if (!isInside(resolve(rootDir), realSnapshot)) {
    throw new Error('Snapshot integrity: resolves outside project root');
  }
  const hash = await sha256File(snapshotPath);
  if (hash !== result.outputSha256) {
    throw new Error('Snapshot integrity: hash mismatch');
  }
  const probe = await ffprobe(snapshotPath);
  if (
    probe.width !== result.probe.width ||
    probe.height !== result.probe.height ||
    probe.fps !== result.probe.fps ||
    probe.videoCodec !== result.probe.videoCodec ||
    probe.audioCodec !== result.probe.audioCodec ||
    probe.sampleRate !== result.probe.sampleRate ||
    probe.duration !== result.probe.duration ||
    probe.hasVideo !== result.probe.hasVideo ||
    probe.hasAudio !== result.probe.hasAudio
  ) {
    throw new Error('Snapshot integrity: probe mismatch');
  }
}

function sanitizeArgv(args: string[], _rootDir: string, known: Map<string, string>): string[] {
  const unknownPathPattern =
    /(?<![A-Za-z0-9_.])(\/(?:[A-Za-z0-9_.\/+\-@]+\/)+[A-Za-z0-9_.+\-@]+|\/[A-Za-z0-9_.+\-@]+\.[A-Za-z0-9_.+\-@]+|[A-Za-z]:\\(?:[A-Za-z0-9_.\\+\-@]+\\)+[A-Za-z0-9_.+\-@]+|[A-Za-z]:\\[A-Za-z0-9_.+\-@]+\.[A-Za-z0-9_.+\-@]+)/g;

  return args.map((arg) => {
    let out = arg;
    for (const [absPath, identifier] of known) {
      out = out.split(absPath).join(identifier);
    }
    out = out.replace(unknownPathPattern, '[REDACTED_PATH]');
    out = maskSensitive(out);
    out = replaceControlChars(out);
    return out;
  });
}

function buildFfmpegEntry(
  result: GenerateResult,
  rootDir: string,
  known: Map<string, string>,
): AuditFfmpegEntry {
  return {
    version: result.ffmpegVersion,
    argv: sanitizeArgv(result.args, rootDir, known),
    outputPreset: result.outputPreset,
  };
}

export function getErrorCode(err: unknown): string {
  if (err instanceof SyntaxError) return 'TIMELINE_VALIDATION_ERROR';
  if (err instanceof Error && err.name === 'ZodError') return 'TIMELINE_VALIDATION_ERROR';
  const message = getErrorMessage(err).toLowerCase();
  if (message.includes('enoent') || message.includes('no such file or directory')) return 'SOURCE_NOT_FOUND';
  if (message.includes('absolute')) return 'PATH_ABSOLUTE';
  if (
    message.includes('path traversal') ||
    message.includes('escapes base') ||
    message.includes('symbolic link') ||
    message.includes('symbolic links') ||
    message.includes('path escapes')
  )
    return 'PATH_TRAVERSAL';
  if (message.includes('not a regular file')) return 'PATH_NOT_REGULAR';
  if (message.includes('file not found')) return 'SOURCE_NOT_FOUND';
  if (message.includes('source file was modified')) return 'SOURCE_MODIFIED';
  if (message.includes('exceeds source duration')) return 'SOURCE_DURATION_EXCEEDED';
  if (message.includes('ffmpeg exited')) return 'FFMPEG_ERROR';
  if (message.includes('font') || message.includes('フォント')) return 'FONT_ERROR';
  if (message.includes('subtitle')) return 'SUBTITLE_ERROR';
  if (message.includes('bgm')) return 'BGM_ERROR';
  if (message.includes('transition') || message.includes('crossfade')) return 'TRANSITION_ERROR';
  if (
    message.includes('at most 5 visual clips') ||
    message.includes('at least one image') ||
    message.includes('multiple audio clips') ||
    message.includes('gap between') ||
    message.includes('overlap') ||
    message.includes('out of order') ||
    message.includes('invalid in/out') ||
    message.includes('start must be 0') ||
    message.includes('in >= out') ||
    message.includes('start >= end') ||
    message.includes('invalid duration') ||
    message.includes('must match') ||
    message.includes('クリップ')
  )
    return 'TIMELINE_VALIDATION_ERROR';
  if (
    message.includes('expected h264') ||
    message.includes('expected audio stream') ||
    message.includes('expected aac') ||
    message.includes('duration mismatch')
  )
    return 'OUTPUT_PROBE_ERROR';
  return 'GENERATION_ERROR';
}

const TRAVERSAL_PATTERN = /(?:[\\/]?\.\.(?:[\\/]|$))[^\s]*/g;

export function maskErrorMessage(message: string, rootDir: string): string {
  let out = message;
  out = redactAbsolutePaths(out);
  out = out.replaceAll(rootDir, '[ROOT]');
  out = out.replace(TRAVERSAL_PATTERN, '[REDACTED_PATH]');
  out = sanitizeFreeText(out);
  return out;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string';
}

async function verifyGenerateResultIntegrity(
  result: GenerateResult,
  rootDir: string,
  outputDir: string,
  jobId: string,
): Promise<void> {
  const computedTimelineHash = timelineHash(result.timeline);
  if (computedTimelineHash !== result.timelineHash) {
    throw new Error('Timeline hash mismatch: result timeline was modified after generation');
  }

  for (const [path, expected] of Object.entries(result.sourceHashes)) {
    const actual = await sha256File(path);
    if (actual !== expected) {
      throw new Error(`Source hash mismatch: ${path}`);
    }
  }

  const expectedOutput = result.outputPath;

  // Verify the actual artifact path by resolving the timeline's declared
  // outputPath against the trusted outputDir used by generate(). This rejects
  // prefix-drop tampering (e.g. timelines/selected.mp4 -> selected.mp4),
  // same-basename-in-different-directory swaps, traversal, absolute paths,
  // and separator/alias games.
  const timelineOutputPath = String(result.timeline.outputPath).replace(/\\/g, '/');
  let expectedFromTimeline: string;
  try {
    expectedFromTimeline = resolveSafePath(resolve(outputDir), timelineOutputPath, { allowNonexistent: false });
  } catch {
    expectedFromTimeline = '';
  }
  if (expectedFromTimeline !== expectedOutput) {
    const safeJobId = /^[A-Za-z0-9_-]+$/.test(jobId) ? jobId : '';
    const artifactDir = safeJobId ? resolve(resolve(outputDir), 'artifacts', safeJobId) : '';
    if (!artifactDir || !existsSync(artifactDir)) {
      throw new Error('Output path mismatch');
    }
    try {
      expectedFromTimeline = resolveSafePath(artifactDir, timelineOutputPath, { allowNonexistent: false });
    } catch {
      throw new Error('Output path mismatch');
    }
    if (expectedFromTimeline !== expectedOutput) {
      throw new Error('Output path mismatch');
    }
  }
  if (!isInside(resolve(rootDir), expectedFromTimeline)) {
    throw new Error('Output path resolves outside project root');
  }

  const outputStat = await lstat(expectedOutput).catch(() => null);
  if (!outputStat || outputStat.isSymbolicLink() || !outputStat.isFile()) {
    throw new Error('Output path is not a regular file');
  }
  const realOutput = await realpath(expectedOutput);
  if (!isInside(resolve(rootDir), realOutput)) {
    throw new Error('Output path resolves outside project root');
  }

  const actualProbe = await ffprobe(expectedOutput);
  if (
    actualProbe.width !== result.probe.width ||
    actualProbe.height !== result.probe.height ||
    actualProbe.fps !== result.probe.fps ||
    actualProbe.videoCodec !== result.probe.videoCodec ||
    actualProbe.audioCodec !== result.probe.audioCodec ||
    actualProbe.sampleRate !== result.probe.sampleRate ||
    actualProbe.duration !== result.probe.duration ||
    actualProbe.hasVideo !== result.probe.hasVideo ||
    actualProbe.hasAudio !== result.probe.hasAudio
  ) {
    throw new Error('Probe mismatch: output was modified after generation');
  }

  const actualOutputSha256 = await sha256File(expectedOutput);
  if (actualOutputSha256 !== result.outputSha256) {
    throw new Error('Output hash mismatch: output file was modified after generation');
  }
}

async function writeAtomic(
  auditDir: string,
  jobId: string,
  rootDir: string,
  outputDir: string,
  manifest: AuditManifest,
): Promise<string> {
  await ensureTrustedDirectory(outputDir, rootDir, true);
  await ensureTrustedDirectory(auditDir, rootDir, true);

  const outputReal = await realpath(outputDir);
  const auditReal = await realpath(auditDir);

  const finalPath = resolve(auditDir, `${jobId}.json`);
  const finalParentReal = await realpath(resolve(finalPath, '..'));
  if (finalParentReal !== auditReal) {
    throw new Error('final manifest path not in audit directory');
  }

  const tmpPath = resolve(auditDir, `.tmp-${jobId}-${randomUUID()}.json`);
  const body = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(tmpPath, body, 'utf8');

  try {
    await link(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (isErrnoException(err) && (err.code === 'EEXIST' || err.code === 'EACCES')) {
      throw new Error(`audit manifest already exists or inaccessible: ${jobId}`);
    }
    throw err;
  }
  await unlink(tmpPath).catch(() => {});

  return (await makeSafeIdentifier(rootDir, finalPath)) ?? 'output/audit/[REDACTED].json';
}

export async function writeAuditManifest(options: AuditWriteOptions): Promise<string> {
  const jobId = options.jobId ?? randomUUID();
  const rootDir = resolve(options.rootDir);
  const outputDir = resolve(options.outputDir);
  const fixturesDir = resolve(options.fixturesDir);
  const fontsDir = resolve(options.fontsDir);
  const auditDir = resolve(outputDir, 'audit');

  const isSuccess = options.result !== undefined && options.error === undefined;
  const startedAt = options.startedAt;
  const finishedAt = options.finishedAt;

  let rawTimeline = options.result ? options.result.timeline : options.timeline ?? null;

  let snapshotPath: string | undefined;
  if (isSuccess && options.result) {
    await verifyGenerateResultIntegrity(options.result, rootDir, outputDir, jobId);
    snapshotPath = await snapshotOutputArtifact(options.result, rootDir, outputDir, jobId);
    await options.hooks?.onAfterSnapshot?.();
    await verifySnapshotIntegrity(snapshotPath, options.result, rootDir);
  }

  const manifestTimeline: Timeline | null = rawTimeline
    ? (isSuccess ? (rawTimeline as Timeline) : (sanitizeTimeline(rawTimeline) as Timeline))
    : null;

  let originalTimelineHash: string | null = null;
  if (options.originalTimelineHash !== undefined) {
    originalTimelineHash = options.originalTimelineHash;
  } else if (rawTimeline) {
    try {
      originalTimelineHash = options.result ? options.result.timelineHash : timelineHash(rawTimeline as Timeline);
    } catch {
      originalTimelineHash = null;
    }
  }

  let manifestTimelineHash: string | null = null;
  if (manifestTimeline) {
    try {
      manifestTimelineHash = isSuccess && options.result ? options.result.timelineHash : timelineHash(manifestTimeline);
    } catch {
      manifestTimelineHash = null;
    }
  }

  let inputs: AuditInputEntry[] = [];
  let output: AuditOutputEntry | null = null;
  let ffmpeg: AuditFfmpegEntry | null = null;
  let error: AuditErrorEntry | null = null;

  if (isSuccess && options.result) {
    if (options.assetMap) {
      inputs = await buildInputsFromAssetMap(options.assetMap, options.result, rootDir);
    } else {
      inputs = await buildInputEntries(
        options.result.timeline,
        options.result,
        rootDir,
        fixturesDir,
        fontsDir,
      );
    }
    output = await buildOutputEntry(options.result, rootDir, snapshotPath!);
    const known = await buildKnownPathMap(rootDir, options.result, snapshotPath!);
    ffmpeg = buildFfmpegEntry(options.result, rootDir, known);
  } else {
    if (options.assetMap) {
      inputs = await buildInputsFromAssetMap(options.assetMap, undefined, rootDir);
    } else if (rawTimeline) {
      inputs = await buildFailureInputs(rawTimeline, rootDir, outputDir, jobId, fixturesDir, fontsDir);
    }
    if (options.error) {
      const rawMessage = getErrorMessage(options.error);
      error = {
        code: getErrorCode(options.error),
        message: maskErrorMessage(rawMessage, rootDir),
      };
    }
  }

  const manifest: AuditManifest = {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    source: options.source,
    status: isSuccess ? 'success' : 'failure',
    startedAt,
    finishedAt,
    timelineHash: manifestTimelineHash,
    originalTimelineHash,
    timeline: manifestTimeline,
    inputs,
    output,
    ffmpeg,
    error,
  };

  return writeAtomic(auditDir, jobId, rootDir, outputDir, manifest);
}
