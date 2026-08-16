import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCatalog, writeCatalog } from '../src/catalog.js';
import { generateFixtures } from '../src/fixtures.js';
import { cleanupOutputDir, isolatedOutputDir } from './helpers.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const bin = resolve(root, 'node_modules', '.bin', 'tsx');

describe('media-preview-cli E2E', () => {
  let projectRoot: string;
  let assetsDir: string;
  let catalogPath: string;

  beforeAll(async () => {
    await generateFixtures(root);
    projectRoot = await isolatedOutputDir(root);
    assetsDir = resolve(projectRoot, 'assets');
    await mkdir(assetsDir, { recursive: true });

    for (const name of ['red.png', 'blue.mp4', 'audio-440.wav']) {
      await cp(resolve(fixturesDir, name), resolve(assetsDir, name));
    }

    const catalog = await generateCatalog(assetsDir, { catalogRoot: 'assets' });
    const catalogRel = await writeCatalog(catalog, projectRoot, 'catalog.json', assetsDir);
    catalogPath = resolve(projectRoot, catalogRel);
  }, 120000);

  afterAll(async () => {
    await cleanupOutputDir(projectRoot);
  });

  it(
    'generates previews for all catalog assets via the CLI',
    async () => {
      const { stdout, stderr } = await execFileAsync(
        'node',
        [bin, 'src/media-preview-cli.ts', '--project-root', projectRoot, catalogPath, assetsDir],
        { cwd: root, maxBuffer: 10 * 1024 * 1024 },
      );

      expect(stderr).toBe('');
      expect(stdout).toContain('Previews written to');
      expect(stdout).toContain('3 succeeded, 0 failed');

      const runPath = resolve(projectRoot, 'output', 'previews', 'run.json');
      const runManifest = JSON.parse(await readFile(runPath, 'utf8'));
      expect(runManifest.summary.succeeded).toBe(3);
      expect(runManifest.summary.failed).toBe(0);
      expect(runManifest.summary.total).toBe(3);

      const canonicalPath = resolve(projectRoot, 'output', 'previews', 'manifest.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf8'));
      expect(canonical.version).toBe(1);
      expect(canonical.previews.length).toBe(3);
      expect(canonical.previewRoot).toBe('output/previews');
    },
    120000,
  );
});
