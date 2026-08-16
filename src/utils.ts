import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

function isSubPath(base: string, target: string): boolean {
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  const targetWithSep = target.endsWith(sep) ? target : target + sep;
  return targetWithSep === baseWithSep || targetWithSep.startsWith(baseWithSep);
}

export function resolveSafePath(
  baseDir: string,
  relPath: string,
  { allowNonexistent = false } = {},
): string {
  if (isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }
  if (relPath.includes('\0')) {
    throw new Error(`Null bytes are not allowed in path: ${relPath}`);
  }
  const parts = relPath.split(/[/\\]/).filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    throw new Error(`Path traversal is not allowed: ${relPath}`);
  }

  if (!existsSync(baseDir)) {
    throw new Error(`Base directory does not exist: ${baseDir}`);
  }
  const baseLstat = lstatSync(baseDir, { throwIfNoEntry: false });
  if (baseLstat?.isSymbolicLink()) {
    throw new Error(`Base directory is a symbolic link: ${baseDir}`);
  }
  const baseReal = realpathSync(baseDir);

  let current = baseReal;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${relPath}`);
      }
      if (stat.isDirectory()) {
        current = realpathSync(current);
      }
    } else if (i < parts.length - 1) {
      current = resolve(current);
      break;
    }
  }

  const resolved = resolve(baseReal, relPath);
  if (!isSubPath(baseReal, resolved)) {
    throw new Error(`Path escapes base directory: ${relPath}`);
  }
  if (!allowNonexistent && !existsSync(resolved)) {
    throw new Error(`File not found: ${relPath}`);
  }
  return resolved;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
