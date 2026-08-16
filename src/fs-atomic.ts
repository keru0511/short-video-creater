import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, fstatSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isInside } from './utils.js';

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isErrorCode(err: unknown, code: string): boolean {
  return isErrnoException(err) && err.code === code;
}

export function isEEXIST(err: unknown): boolean {
  return isErrorCode(err, 'EEXIST');
}

export function isEISDIR(err: unknown): boolean {
  return isErrorCode(err, 'EISDIR');
}

export function isENOENT(err: unknown): boolean {
  return isErrorCode(err, 'ENOENT');
}

export function isENOTEMPTY(err: unknown): boolean {
  return isErrorCode(err, 'ENOTEMPTY');
}

export interface StatsEqualOptions {
  compareCtime?: boolean;
}

export function statsEqual(
  a: Stats | BigIntStats,
  b: Stats | BigIntStats,
  options?: StatsEqualOptions,
): boolean {
  const { compareCtime = true } = options ?? {};
  if (String(a.dev) !== String(b.dev)) return false;
  if (String(a.ino) !== String(b.ino)) return false;
  if (String(a.size) !== String(b.size)) return false;
  const aMtime = String((a as BigIntStats).mtimeNs ?? a.mtimeMs);
  const bMtime = String((b as BigIntStats).mtimeNs ?? b.mtimeMs);
  if (aMtime !== bMtime) return false;
  if (compareCtime) {
    const aCtime = String((a as BigIntStats).ctimeNs ?? a.ctimeMs);
    const bCtime = String((b as BigIntStats).ctimeNs ?? b.ctimeMs);
    if (aCtime !== bCtime) return false;
  }
  return true;
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

export async function readFdTarget(fh: FileHandle): Promise<string | null> {
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

export interface VerifyLocationOptions {
  makeError?: (message: string) => Error;
  /** When false, require the directory to still be reachable at `expected`. */
  useFdTarget?: boolean;
}

export async function verifyDirLocation(
  fh: FileHandle,
  expected: string,
  projectRoot: string,
  options?: VerifyLocationOptions,
): Promise<void> {
  const err = options?.makeError ?? ((m: string) => new Error(m));
  const fdStat = (await fh.stat({ bigint: true })) as BigIntStats;
  if (!fdStat.isDirectory()) {
    throw err(`not a directory fd: ${expected}`);
  }
  const useFdTarget = options?.useFdTarget ?? true;
  const fdTarget = useFdTarget ? await readFdTarget(fh) : null;
  const pathToCheck = fdTarget ?? expected;
  const pathStat = (await lstat(pathToCheck, { bigint: true }).catch(() => null)) as BigIntStats | null;
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    String(pathStat.dev) !== String(fdStat.dev) ||
    String(pathStat.ino) !== String(fdStat.ino)
  ) {
    throw err(`directory location does not match: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(projectRoot, real)) {
    throw err(`directory outside project root: ${expected}`);
  }
}

export function verifyDirLocationSync(
  fh: FileHandle,
  expected: string,
  projectRoot: string,
  options?: VerifyLocationOptions,
): void {
  const err = options?.makeError ?? ((m: string) => new Error(m));
  let fdStat: BigIntStats;
  try {
    fdStat = fstatSync(fh.fd, { bigint: true }) as BigIntStats;
  } catch {
    throw err(`directory fd stat failed: ${expected}`);
  }
  if (!fdStat.isDirectory()) {
    throw err(`not a directory fd: ${expected}`);
  }
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(expected, { bigint: true }) as BigIntStats;
  } catch {
    throw err(`directory location does not match: ${expected}`);
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    String(pathStat.dev) !== String(fdStat.dev) ||
    String(pathStat.ino) !== String(fdStat.ino)
  ) {
    throw err(`directory location does not match: ${expected}`);
  }
  let real: string;
  try {
    real = realpathSync(expected);
  } catch {
    throw err(`directory realpath failed: ${expected}`);
  }
  if (!isInside(projectRoot, real)) {
    throw err(`directory outside project root: ${expected}`);
  }
}

export async function verifyFileLocation(
  fh: FileHandle,
  expected: string,
  boundaryRoot: string,
  options?: VerifyLocationOptions,
): Promise<void> {
  const err = options?.makeError ?? ((m: string) => new Error(m));
  const fdStat = (await fh.stat({ bigint: true })) as BigIntStats;
  const fdTarget = await readFdTarget(fh);
  const pathToCheck = fdTarget ?? expected;
  const pathStat = (await lstat(pathToCheck, { bigint: true }).catch(() => null)) as BigIntStats | null;
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    String(pathStat.dev) !== String(fdStat.dev) ||
    String(pathStat.ino) !== String(fdStat.ino) ||
    String(pathStat.size) !== String(fdStat.size)
  ) {
    throw err(`file location does not match: ${expected}`);
  }
  const real = fdTarget ?? (await realpath(expected).catch(() => null));
  if (!real || !isInside(boundaryRoot, real)) {
    throw err(`file outside boundary: ${expected}`);
  }
}

export async function mkdirAt(
  parentFh: FileHandle,
  component: string,
  fallbackPath: string,
): Promise<boolean> {
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

export interface OpenAtOptions extends VerifyLocationOptions {}

export async function openAt(
  parentFh: FileHandle,
  component: string,
  flags: number,
  fallbackPath: string,
  projectRoot: string,
  mode?: number,
  options?: OpenAtOptions,
): Promise<FileHandle> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    if (mode !== undefined) {
      return open(`${base}/${component}`, flags, mode);
    }
    return open(`${base}/${component}`, flags);
  }
  // Fallback for platforms without fd-relative directory capabilities. We
  // re-verify the directory fd matches its pathname before every use. This
  // cannot close the remaining pathname race window on such platforms.
  await verifyDirLocation(parentFh, fallbackPath, projectRoot, options);
  const target = resolve(fallbackPath, component);
  if (mode !== undefined) {
    return open(target, flags, mode);
  }
  return open(target, flags);
}

export interface RemoveAtOptions {
  ignoreErrors?: boolean;
}

export async function unlinkAt(
  parentFh: FileHandle,
  name: string,
  fallbackPath: string,
  options?: RemoveAtOptions,
): Promise<void> {
  const base = fdRelativeBase(parentFh);
  const target = base ? `${base}/${name}` : resolve(fallbackPath, name);
  try {
    await unlink(target);
  } catch (err) {
    if (!(options?.ignoreErrors ?? false)) throw err;
  }
}

export async function rmdirAt(
  parentFh: FileHandle,
  name: string,
  fallbackPath: string,
  options?: RemoveAtOptions,
): Promise<void> {
  const base = fdRelativeBase(parentFh);
  const target = base ? `${base}/${name}` : resolve(fallbackPath, name);
  try {
    await rmdir(target);
  } catch (err) {
    if (!(options?.ignoreErrors ?? false)) throw err;
  }
}

export async function renameAt(
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

export async function linkAt(
  parentFh: FileHandle,
  oldName: string,
  newName: string,
  fallbackPath: string,
): Promise<void> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    await link(`${base}/${oldName}`, `${base}/${newName}`);
  } else {
    await link(resolve(fallbackPath, oldName), resolve(fallbackPath, newName));
  }
}

export async function lstatAt(
  parentFh: FileHandle,
  name: string,
  fallbackPath: string,
): Promise<BigIntStats> {
  const base = fdRelativeBase(parentFh);
  if (base) {
    return (await lstat(`${base}/${name}`, { bigint: true })) as BigIntStats;
  }
  return (await lstat(resolve(fallbackPath, name), { bigint: true })) as BigIntStats;
}

export async function atPath(
  dirFh: FileHandle,
  component: string,
  fallbackDir: string,
  projectRoot: string,
  options?: VerifyLocationOptions,
): Promise<string> {
  const base = fdRelativeBase(dirFh);
  if (base) {
    return `${base}/${component}`;
  }
  // Fallback for platforms without fd-relative directory capabilities. We
  // re-verify the directory path is still the same inode and inside the project
  // root before every use. This cannot eliminate the path-name race window on
  // such platforms; the threat model therefore requires a separate OS identity
  // or immutable storage for adversarial same-user deployments.
  await verifyDirLocation(dirFh, fallbackDir, projectRoot, options);
  return resolve(fallbackDir, component);
}

export async function readFileAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
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

export interface HashFileOptions {
  knownSize?: number;
  chunkSize?: number;
  label?: string;
}

export async function hashFileFromFh(
  fh: FileHandle,
  options?: HashFileOptions,
): Promise<{ sha256: string; size: number }> {
  const CHUNK = options?.chunkSize ?? 64 * 1024;
  const label = options?.label ?? 'File';
  const hash = createHash('sha256');
  const stat = options?.knownSize === undefined ? ((await fh.stat({ bigint: true })) as BigIntStats) : undefined;
  if (stat && !stat.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  const fileSize = options?.knownSize ?? Number(stat!.size);
  const readBuffer = Buffer.alloc(CHUNK);
  let offset = 0;
  while (offset < fileSize) {
    const toRead = Math.min(CHUNK, fileSize - offset);
    const { bytesRead } = await fh.read(readBuffer, 0, toRead, offset);
    if (bytesRead === 0) {
      throw new Error(`${label} shrank during hash read: ${offset} of ${fileSize} bytes`);
    }
    hash.update(readBuffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const eofBuf = Buffer.alloc(1);
  const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, fileSize);
  if (eofRead !== 0) {
    throw new Error(`${label} grew during hash read`);
  }
  return { sha256: hash.digest('hex'), size: fileSize };
}
