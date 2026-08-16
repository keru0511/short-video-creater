import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function isolatedOutputDir(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, 'tests', 'isolated-output-'));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupOutputDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
