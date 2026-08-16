import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { FileHandle } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog, CatalogEntry, WriteJsonAtomicOptions, WriteJsonAtomicTestHooks } from './catalog.js';
import { resolveOutputPath, writeJsonAtomic } from './catalog.js';
import { isInside, verifyThumbnail } from './thumbnails.js';

export const DEFAULT_MAX_CATALOG_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CATALOG_ASSETS = 100_000;
const CATALOG_READ_CHUNK = 64 * 1024;
const O_RDONLY = constants.O_RDONLY;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

function canonicalizeRelativePath(p: string): string | null {
  if (typeof p !== 'string') return null;
  if (p.includes('\0')) return null;
  if (p === '' || p === '.' || p === '..') return null;
  if (p.startsWith('/') || p.startsWith('\\')) return null;
  // Reject Windows drive-relative and drive-absolute prefixes (C:foo, C:\foo, C:/foo, C:.\foo, etc.).
  if (/^[A-Za-z]:/.test(p)) return null;
  // Normalize to forward slashes, collapse empty and `.` segments, then reject `..`.
  const parts = p.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  if (parts.length === 0) return null;
  return parts.join('/');
}

function isRootRelativePath(p: string): boolean {
  if (typeof p !== 'string') return false;
  if (p.includes('\0')) return false;
  if (p === '' || p === '.' || p === '..') return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  // Reject Windows drive-relative and drive-absolute prefixes.
  if (/^[A-Za-z]:/.test(p)) return false;
  // Only canonical forward-slash form is accepted; backslashes or empty/`.`/`..` segments are unsafe.
  if (p.includes('\\')) return false;
  const parts = p.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return true;
}

const RelativePathSchema = z
  .string()
  .transform((val) => canonicalizeRelativePath(val))
  .refine((val) => val !== null, {
    message: 'Invalid relativePath in catalog',
  });

const RootRelativeIdentifierSchema = z.string().refine(isRootRelativePath, {
  message: 'Invalid thumbnail identifier in catalog',
});

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const CatalogErrorInfoSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const AudioStreamInfoSchema = z
  .object({
    index: z.number().int().optional(),
    codec: z.string(),
    sampleRate: z.number().int().optional(),
    channels: z.number().int().optional(),
  })
  .strict();

const ProbeResultSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio']),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    fps: z.number().nonnegative().optional(),
    duration: z.number().nonnegative().optional(),
    videoCodec: z.string().optional(),
    audioCodec: z.string().optional(),
    hasAudio: z.boolean(),
    audioStreams: z.array(AudioStreamInfoSchema),
  })
  .strict();

const ThumbnailInfoSchema = z
  .object({
    identifier: RootRelativeIdentifierSchema,
    sha256: Sha256Schema,
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();

const CatalogEntrySchema = z
  .object({
    id: Sha256Schema.optional(),
    relativePath: RelativePathSchema,
    sizeBytes: z.number().int().nonnegative(),
    mtime: z.number().int().nonnegative(),
    probe: ProbeResultSchema.optional(),
    thumbnail: ThumbnailInfoSchema.optional(),
    error: CatalogErrorInfoSchema.optional(),
    duplicateOf: RelativePathSchema.optional(),
    duplicatePaths: z.array(RelativePathSchema).optional(),
  })
  .strict()
  .refine(
    (entry) => entry.id !== undefined || entry.error !== undefined,
    {
      message: 'Catalog entry must have a valid id or a structured error',
    },
  );

const CatalogSchema = z
  .object({
    catalogRoot: z.string().min(1),
    count: z.number().int().nonnegative(),
    assets: z.array(CatalogEntrySchema),
  })
  .strict()
  .refine((c) => c.count === c.assets.length, {
    message: 'catalog count does not match assets length',
  })
  .refine(
    (c) => {
      const paths = c.assets.map((a) => a.relativePath);
      return new Set(paths).size === paths.length;
    },
    { message: 'Duplicate relativePath in catalog' },
  );

export interface ChangedEntry {
  relativePath: string;
  previous: CatalogEntry;
  current: CatalogEntry;
}

export interface MovedEntry {
  oldRelativePath: string;
  newRelativePath: string;
  id: string;
  entry: CatalogEntry;
}

export interface CatalogDiff {
  previousCatalogRoot: string;
  currentCatalogRoot: string;
  previousCount: number;
  currentCount: number;
  unchanged: CatalogEntry[];
  added: CatalogEntry[];
  removed: CatalogEntry[];
  changed: ChangedEntry[];
  moved: MovedEntry[];
}

export interface ReadCatalogFileTestHooks {
  afterOpen?: (ctx: {
    fh: FileHandle;
    stat: Stats;
    path: string;
  }) => Promise<void>;
  beforeRead?: (ctx: {
    fh: FileHandle;
    stat: Stats;
    path: string;
  }) => Promise<void>;
  afterRead?: (ctx: {
    fh: FileHandle;
    stat: Stats;
    path: string;
  }) => Promise<void>;
  beforeVerify?: (ctx: {
    fh: FileHandle;
    stat: Stats;
    path: string;
  }) => Promise<void>;
  beforeChildDirOpen?: (ctx: {
    parentFh: FileHandle;
    parentPath: string;
    component: string;
  }) => Promise<void>;
  beforeLeafOpen?: (ctx: {
    parentFh: FileHandle;
    parentPath: string;
    component: string;
  }) => Promise<void>;
  beforeLeafVerify?: (ctx: {
    fh: FileHandle;
    path: string;
  }) => Promise<void>;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8'));
}

function byRelativePath(
  a: { relativePath: string },
  b: { relativePath: string },
): number {
  return compareUtf8(a.relativePath, b.relativePath);
}

function noIdFingerprint(entry: CatalogEntry): string {
  return JSON.stringify({
    sizeBytes: entry.sizeBytes,
    mtime: entry.mtime,
    errorCode: entry.error?.code,
    errorMessage: entry.error?.message,
  });
}

function fdRelativeBase(fh: FileHandle): string | null {
  const platform = process.platform;
  if (platform === 'linux') {
    return `/proc/self/fd/${fh.fd}`;
  }
  if (
    platform === 'darwin' ||
    platform === 'freebsd' ||
    platform === 'netbsd' ||
    platform === 'openbsd'
  ) {
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

async function verifyDirLocation(
  fh: FileHandle,
  expected: string,
  projectRoot: string,
): Promise<void> {
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
    throw new Error(`directory location does not match: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(projectRoot, real)) {
    throw new Error(`directory outside project root: ${expected}`);
  }
}

async function verifyFileLocation(
  fh: FileHandle,
  expected: string,
  projectRoot: string,
): Promise<void> {
  const fdStat = await fh.stat();
  const fdTarget = await readFdTarget(fh);
  const pathToCheck = fdTarget ?? expected;
  const pathStat = await lstat(pathToCheck).catch(() => null);
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.dev !== fdStat.dev ||
    pathStat.ino !== fdStat.ino ||
    pathStat.size !== fdStat.size
  ) {
    throw new Error(`file location does not match: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(projectRoot, real)) {
    throw new Error(`file outside project root: ${expected}`);
  }
}

async function openAt(
  parentFh: FileHandle,
  component: string,
  flags: number,
  fallbackPath: string,
  projectRoot: string,
): Promise<FileHandle> {
  const base = fdRelativeBase(parentFh);
  let target: string;
  if (base) {
    target = `${base}/${component}`;
  } else {
    // Fallback for platforms without fd-relative directory capabilities. We
    // re-verify the directory fd matches its pathname before every use. This
    // cannot close the remaining pathname race window, so the adversarial
    // same-user contract is not supported on such platforms.
    await verifyDirLocation(parentFh, fallbackPath, projectRoot);
    target = resolve(fallbackPath, component);
  }
  return open(target, flags);
}

async function openFileInsideProjectRoot(
  projectRoot: string,
  relPath: string,
  fileFlags: number,
  hooks?: ReadCatalogFileTestHooks,
): Promise<{ fh: FileHandle; resolved: string }> {
  const root = resolve(projectRoot);
  const canonicalRel = canonicalizeRelativePath(relPath);
  if (!canonicalRel) {
    throw new Error(`Invalid relativePath in catalog: ${relPath}`);
  }
  const components = canonicalRel.split('/');

  const handles: FileHandle[] = [];
  let dirFh: FileHandle;
  try {
    dirFh = await open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    handles.push(dirFh);
    await verifyDirLocation(dirFh, root, root);

    let current = root;
    for (let i = 0; i < components.length - 1; i++) {
      const comp = components[i];
      const parentFh = dirFh;
      const parentCurrent = current;
      current = resolve(current, comp);
      await hooks?.beforeChildDirOpen?.({
        parentFh,
        parentPath: parentCurrent,
        component: comp,
      });
      const childFh = await openAt(
        parentFh,
        comp,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
        parentCurrent,
        root,
      );
      handles.push(childFh);
      await verifyDirLocation(childFh, current, root);
      dirFh = childFh;
    }

    const leaf = components[components.length - 1];
    const leafPath = resolve(current, leaf);
    await hooks?.beforeLeafOpen?.({
      parentFh: dirFh,
      parentPath: current,
      component: leaf,
    });
    const fh = await openAt(
      dirFh,
      leaf,
      fileFlags,
      current,
      root,
    );
    try {
      await hooks?.beforeLeafVerify?.({ fh, path: leafPath });
      await verifyFileLocation(fh, leafPath, root);
      return { fh, resolved: leafPath };
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  } finally {
    for (const h of handles) {
      await h.close().catch(() => {});
    }
  }
}

async function readCatalogFileSafe(
  projectRoot: string,
  relPath: string,
  maxBytes: number,
  hooks?: ReadCatalogFileTestHooks,
): Promise<{ text: string; resolved: string }> {
  const { fh, resolved } = await openFileInsideProjectRoot(
    projectRoot,
    relPath,
    O_RDONLY | O_NOFOLLOW,
    hooks,
  );
  try {
    const beforeStat = await fh.stat();
    if (beforeStat.size > maxBytes) {
      throw new Error(`Catalog file exceeds maximum size: ${beforeStat.size}`);
    }
    await hooks?.afterOpen?.({ fh, stat: beforeStat, path: resolved });

    const fileSize = beforeStat.size;
    const buffer = Buffer.alloc(fileSize);
    let offset = 0;
    await hooks?.beforeRead?.({ fh, stat: beforeStat, path: resolved });
    while (offset < fileSize) {
      const toRead = Math.min(CATALOG_READ_CHUNK, fileSize - offset);
      const { bytesRead } = await fh.read(buffer, offset, toRead, offset);
      if (bytesRead === 0) {
        throw new Error(
          `Catalog file shrank during read: read ${offset} of ${fileSize} bytes`,
        );
      }
      offset += bytesRead;
    }

    // Confirm EOF so a sparse grow/append after the initial stat cannot go
    // undetected and end up in the parsed JSON.
    const eofBuf = Buffer.alloc(1);
    const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
    if (eofRead !== 0) {
      throw new Error('Catalog file grew during read');
    }

    await hooks?.afterRead?.({ fh, stat: beforeStat, path: resolved });
    const afterStat = await fh.stat();
    if (
      afterStat.size !== beforeStat.size ||
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.mtimeMs !== beforeStat.mtimeMs
    ) {
      throw new Error('Catalog file changed during read');
    }

    await hooks?.beforeVerify?.({ fh, stat: afterStat, path: resolved });
    await verifyFileLocation(fh, resolved, projectRoot);

    const real = await realpath(resolved).catch(() => null);
    if (!real || !isInside(projectRoot, real)) {
      throw new Error('Catalog file escaped project root after read');
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new Error('Catalog file is not valid UTF-8');
    }

    return { text, resolved };
  } finally {
    await fh.close().catch(() => {});
  }
}

export function parseCatalog(text: string, maxAssets?: number): Catalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Previous catalog is not valid JSON');
  }
  // Fail-closed resource bound: verify the top-level shape and reject catalogs
  // whose assets array exceeds maxAssets before Zod parses every entry. This
  // prevents a small (< maxBytes) hostile catalog with a huge number of
  // entries from causing excessive CPU / heap use during per-entry transform
  // and validation.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Previous catalog is not a JSON object');
  }
  const assetsArray = (parsed as Record<string, unknown>).assets;
  if (!Array.isArray(assetsArray)) {
    throw new Error('Previous catalog assets is not an array');
  }
  const assetLimit = maxAssets ?? DEFAULT_MAX_CATALOG_ASSETS;
  if (assetsArray.length > assetLimit) {
    throw new Error(`Previous catalog has too many assets: ${assetsArray.length}`);
  }
  const validated = CatalogSchema.parse(parsed);
  return validated as Catalog;
}

export async function loadPreviousCatalog(
  projectRoot: string,
  relPath: string,
  options?: {
    maxBytes?: number;
    maxAssets?: number;
    __testHooks?: ReadCatalogFileTestHooks;
  },
): Promise<Catalog> {
  const canonicalRel = canonicalizeRelativePath(relPath);
  if (!canonicalRel) {
    throw new Error(`Invalid relativePath in catalog: ${relPath}`);
  }
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_CATALOG_BYTES;
  const maxAssets = options?.maxAssets ?? DEFAULT_MAX_CATALOG_ASSETS;
  const { text } = await readCatalogFileSafe(
    projectRoot,
    canonicalRel,
    maxBytes,
    options?.__testHooks,
  );
  return parseCatalog(text, maxAssets);
}

export function computeCatalogDiff(
  previous: Catalog,
  current: Catalog,
): CatalogDiff {
  const previousAssets = [...previous.assets].sort(byRelativePath);
  const currentAssets = [...current.assets].sort(byRelativePath);

  const prevMap = new Map<string, CatalogEntry>();
  for (const entry of previousAssets) prevMap.set(entry.relativePath, entry);

  const curMap = new Map<string, CatalogEntry>();
  for (const entry of currentAssets) curMap.set(entry.relativePath, entry);

  const unchanged: CatalogEntry[] = [];
  const changed: ChangedEntry[] = [];

  for (const [path, prev] of prevMap) {
    const cur = curMap.get(path);
    if (cur && prev.id === cur.id) {
      if (prev.id !== undefined) {
        // A stable content id exists on both sides: same hash => unchanged.
        unchanged.push(cur);
      } else if (noIdFingerprint(prev) === noIdFingerprint(cur)) {
        // Both sides are id-less error entries with the same size/mtime/error.
        unchanged.push(cur);
      } else {
        changed.push({ relativePath: path, previous: prev, current: cur });
      }
      prevMap.delete(path);
      curMap.delete(path);
    }
  }

  for (const [path, prev] of prevMap) {
    const cur = curMap.get(path);
    if (cur) {
      changed.push({ relativePath: path, previous: prev, current: cur });
      prevMap.delete(path);
      curMap.delete(path);
    }
  }

  const prevById = new Map<string, CatalogEntry[]>();
  const curById = new Map<string, CatalogEntry[]>();
  const noIdKey = '__NO_ID__';

  for (const entry of prevMap.values()) {
    const key = entry.id ?? noIdKey;
    const list = prevById.get(key) ?? [];
    list.push(entry);
    prevById.set(key, list);
  }
  for (const entry of curMap.values()) {
    const key = entry.id ?? noIdKey;
    const list = curById.get(key) ?? [];
    list.push(entry);
    curById.set(key, list);
  }

  const moved: MovedEntry[] = [];
  const removed: CatalogEntry[] = [];
  const added: CatalogEntry[] = [];

  for (const list of prevById.values()) list.sort(byRelativePath);
  for (const list of curById.values()) list.sort(byRelativePath);

  const allIds = Array.from(
    new Set([...prevById.keys(), ...curById.keys()]),
  ).sort(compareUtf8);
  for (const id of allIds) {
    if (id === noIdKey) {
      // Entries without a stable content id cannot be matched as moves.
      removed.push(...(prevById.get(id) ?? []));
      added.push(...(curById.get(id) ?? []));
      continue;
    }

    const prevs = prevById.get(id) ?? [];
    const curs = curById.get(id) ?? [];
    const min = Math.min(prevs.length, curs.length);
    for (let i = 0; i < min; i++) {
      const oldEntry = prevs[i];
      const newEntry = curs[i];
      moved.push({
        oldRelativePath: oldEntry.relativePath,
        newRelativePath: newEntry.relativePath,
        id,
        entry: newEntry,
      });
    }
    if (prevs.length > curs.length) {
      removed.push(...prevs.slice(min));
    } else if (curs.length > prevs.length) {
      added.push(...curs.slice(min));
    }
  }

  unchanged.sort(byRelativePath);
  changed.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  moved.sort((a, b) => {
    const primary = compareUtf8(a.newRelativePath, b.newRelativePath);
    return primary !== 0
      ? primary
      : compareUtf8(a.oldRelativePath, b.oldRelativePath);
  });
  removed.sort(byRelativePath);
  added.sort(byRelativePath);

  return {
    previousCatalogRoot: previous.catalogRoot,
    currentCatalogRoot: current.catalogRoot,
    previousCount: previous.assets.length,
    currentCount: current.assets.length,
    unchanged,
    added,
    removed,
    changed,
    moved,
  };
}

async function verifyCurrentThumbnails(
  diff: CatalogDiff,
  projectRoot: string,
): Promise<void> {
  const entries: CatalogEntry[] = [
    ...diff.unchanged,
    ...diff.added,
    ...diff.changed.map((c) => c.current),
    ...diff.moved.map((m) => m.entry),
  ];
  for (const entry of entries) {
    if (!entry.thumbnail) continue;
    const ok = await verifyThumbnail(projectRoot, entry.thumbnail);
    if (!ok) {
      throw new Error(
        `thumbnail verification failed for ${entry.relativePath}: ${entry.thumbnail.identifier}`,
      );
    }
  }
}

export async function verifyOutputNotSameAsInput(
  projectRoot: string,
  outputPath: string,
  inputPath: string,
): Promise<void> {
  const inputResolved = resolve(inputPath);
  const outputResolved = resolve(outputPath);
  if (inputResolved === outputResolved) {
    throw new Error('Output path is the same as the input catalog');
  }

  const inputStat = await stat(inputResolved).catch(() => null);
  const outputStat = await lstat(outputResolved).catch(() => null);
  if (inputStat && outputStat && !outputStat.isSymbolicLink()) {
    if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
      throw new Error('Output path points to the same inode as the input catalog');
    }
  }

  const inputReal = await realpath(inputResolved).catch(() => null);
  const outputReal = await realpath(outputResolved).catch(() => null);
  if (inputReal && outputReal) {
    if (!isInside(projectRoot, outputReal)) {
      throw new Error('Output path escaped project root');
    }
    if (inputReal === outputReal) {
      throw new Error('Output path resolves to the same file as the input catalog');
    }
  }
}

export interface WriteCatalogDiffOptions {
  previousCatalogPath?: string;
  __testHooks?: WriteJsonAtomicTestHooks;
}

export async function writeCatalogDiff(
  diff: CatalogDiff,
  projectRoot: string,
  outputRel: string,
  inputRoot: string,
  options?: WriteCatalogDiffOptions,
): Promise<string> {
  // Precompute the canonical output path so we can detect collisions with the
  // previous catalog before writing. We validate against projectRoot/output so
  // the output directory need not exist yet; writeJsonAtomic creates it via a
  // verified directory fd.
  const safeOutput = resolveOutputPath(projectRoot, outputRel);
  if (!basename(safeOutput).toLowerCase().endsWith('.json')) {
    throw new Error('Output path must end with .json');
  }

  if (options?.previousCatalogPath) {
    await verifyOutputNotSameAsInput(projectRoot, safeOutput, options.previousCatalogPath);
  }

  // Verify all current-side thumbnails before persisting the diff, matching the
  // pre-write barrier in the normal catalog write path. A same-user attacker can
  // still swap the path after this check, but the check catches accidental races
  // and cooperative/medium-effort tampering.
  await verifyCurrentThumbnails(diff, projectRoot);

  return writeJsonAtomic(diff, projectRoot, outputRel, inputRoot, {
    __testHooks: options?.__testHooks,
  });
}
