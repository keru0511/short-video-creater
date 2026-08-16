import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Catalog, CatalogEntry } from '../src/catalog.js';
import {
  computeCatalogDiff,
  loadPreviousCatalog,
  writeCatalogDiff,
} from '../src/catalog-diff.js';
import { sha256File } from '../src/core.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function hash(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

function entry(relativePath: string, id?: string, extra?: Partial<CatalogEntry>): CatalogEntry {
  return {
    relativePath,
    sizeBytes: 0,
    mtime: 0,
    id,
    ...extra,
  };
}

function catalog(assets: CatalogEntry[], catalogRoot = 'test'): Catalog {
  return { catalogRoot, count: assets.length, assets };
}

async function createPng(filePath: string, color = 'red'): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=1080x1920`,
    '-frames:v',
    '1',
    filePath,
  ]);
}

async function createAudio(filePath: string, duration = 2): Promise<void> {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:duration=${duration}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    filePath,
  ]);
}

describe('computeCatalogDiff', () => {
  it('detects unchanged entries', () => {
    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog([entry('a.png', hash('a'))], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].relativePath).toBe('a.png');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.moved).toHaveLength(0);
    expect(diff.previousCatalogRoot).toBe('prev');
    expect(diff.currentCatalogRoot).toBe('cur');
  });

  it('detects added entries', () => {
    const previous = catalog([], 'prev');
    const current = catalog([entry('a.png', hash('a'))], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].relativePath).toBe('a.png');
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('detects removed entries', () => {
    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog([], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].relativePath).toBe('a.png');
  });

  it('detects changed entries for same path with different content', () => {
    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog([entry('a.png', hash('b'))], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].relativePath).toBe('a.png');
    expect(diff.changed[0].previous.id).toBe(hash('a'));
    expect(diff.changed[0].current.id).toBe(hash('b'));
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.moved).toHaveLength(0);
  });

  it('detects moved entries by content hash', () => {
    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog([entry('b.png', hash('a'))], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.moved).toHaveLength(1);
    expect(diff.moved[0].oldRelativePath).toBe('a.png');
    expect(diff.moved[0].newRelativePath).toBe('b.png');
    expect(diff.moved[0].id).toBe(hash('a'));
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('handles duplicate content deterministically', () => {
    const previous = catalog(
      [entry('copy1/a.png', hash('a')), entry('copy2/a.png', hash('a'))],
      'prev',
    );
    const current = catalog(
      [entry('copy1/a.png', hash('a')), entry('copy3/a.png', hash('a'))],
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].relativePath).toBe('copy1/a.png');
    expect(diff.moved).toHaveLength(1);
    expect(diff.moved[0].oldRelativePath).toBe('copy2/a.png');
    expect(diff.moved[0].newRelativePath).toBe('copy3/a.png');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('is deterministic for identical input', () => {
    const previous = catalog(
      [entry('a.png', hash('a')), entry('b.png', hash('b'))],
      'prev',
    );
    const current = catalog(
      [entry('b.png', hash('a')), entry('c.png', hash('b'))],
      'cur',
    );
    const first = JSON.stringify(computeCatalogDiff(previous, current));
    const second = JSON.stringify(computeCatalogDiff(previous, current));
    expect(second).toBe(first);
  });

  it('keeps unmatched duplicate content as removed and added', () => {
    const previous = catalog(
      [entry('a.png', hash('a')), entry('b.png', hash('a'))],
      'prev',
    );
    const current = catalog([entry('c.png', hash('a'))], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.moved).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed[0].relativePath).toBe('b.png');
    expect(diff.moved[0].oldRelativePath).toBe('a.png');
    expect(diff.moved[0].newRelativePath).toBe('c.png');
  });

  it('does not consume a previous entry twice for moved and changed', () => {
    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog(
      [entry('a.png', hash('b')), entry('b.png', hash('a'))],
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);
    const changedPaths = diff.changed.map((c) => c.relativePath);
    const movedOldPaths = diff.moved.map((m) => m.oldRelativePath);
    const allPreviousPaths = [...changedPaths, ...movedOldPaths];
    expect(new Set(allPreviousPaths).size).toBe(allPreviousPaths.length);
    expect(allPreviousPaths).toContain('a.png');
  });
});

describe('loadPreviousCatalog validation', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'diff-catalog-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function writeCatalogJson(name: string, content: unknown): Promise<string> {
    const filePath = join(base, name);
    await writeFile(filePath, JSON.stringify(content));
    return filePath;
  }

  it('loads a valid previous catalog', async () => {
    const filePath = await writeCatalogJson('valid.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    const loaded = await loadPreviousCatalog(
      root,
      filePath.slice(root.length + 1),
      { maxBytes: 1024, maxAssets: 10 },
    );
    expect(loaded.assets).toHaveLength(1);
    expect(loaded.assets[0].relativePath).toBe('a.png');
  });

  it('rejects an absolute path in asset relativePath', async () => {
    const filePath = await writeCatalogJson('absolute.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [{ relativePath: '/etc/passwd', sizeBytes: 0, mtime: 0 }],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('relativePath');
  });

  it('rejects a relativePath containing ..', async () => {
    const filePath = await writeCatalogJson('traversal.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [{ relativePath: '../secret.png', sizeBytes: 0, mtime: 0 }],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('relativePath');
  });

  it('rejects duplicate relativePaths', async () => {
    const filePath = await writeCatalogJson('duplicate.json', {
      catalogRoot: 'test',
      count: 2,
      assets: [
        { relativePath: 'a.png', sizeBytes: 0, mtime: 0, id: hash('a') },
        { relativePath: 'a.png', sizeBytes: 0, mtime: 0, id: hash('b') },
      ],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('Duplicate');
  });

  it('rejects alias relativePaths with dot segments', async () => {
    const filePath = await writeCatalogJson('alias-dot.json', {
      catalogRoot: 'test',
      count: 2,
      assets: [
        { relativePath: 'a/b.png', sizeBytes: 0, mtime: 0, id: hash('a') },
        { relativePath: 'a/./b.png', sizeBytes: 0, mtime: 0, id: hash('b') },
      ],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('Duplicate');
  });

  it('rejects alias relativePaths with backslash separators', async () => {
    const filePath = await writeCatalogJson('alias-backslash.json', {
      catalogRoot: 'test',
      count: 2,
      assets: [
        { relativePath: 'a/b.png', sizeBytes: 0, mtime: 0, id: hash('a') },
        { relativePath: 'a\\b.png', sizeBytes: 0, mtime: 0, id: hash('b') },
      ],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('Duplicate');
  });

  it('rejects Windows drive-relative and drive-absolute relativePaths', async () => {
    for (const p of ['C:foo.png', 'C:foo/bar.png', 'C:.\\foo.png', 'C:..\\foo.png', 'C:/foo.png', 'C:\\foo.png']) {
      const filePath = await writeCatalogJson(`drive-${p.replace(/[^a-zA-Z0-9]/g, '_')}.json`, {
        catalogRoot: 'test',
        count: 1,
        assets: [{ relativePath: p, sizeBytes: 0, mtime: 0, id: hash('a') }],
      });
      await expect(
        loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
      ).rejects.toThrow();
    }
  });

  it('rejects an invalid id', async () => {
    const filePath = await writeCatalogJson('bad-id.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [{ relativePath: 'a.png', sizeBytes: 0, mtime: 0, id: 'not-a-hash' }],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow();
  });

  it('rejects a malformed catalog', async () => {
    const filePath = await writeCatalogJson('malformed.json', {
      catalogRoot: 'test',
      count: 1,
      assets: 'not-an-array',
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow();
  });

  it('rejects a count mismatch', async () => {
    const filePath = await writeCatalogJson('count.json', {
      catalogRoot: 'test',
      count: 2,
      assets: [entry('a.png', hash('a'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 10 }),
    ).rejects.toThrow('count');
  });

  it('rejects an oversized catalog', async () => {
    const filePath = await writeCatalogJson('big.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1, maxAssets: 10 }),
    ).rejects.toThrow('exceeds');
  });

  it('rejects too many assets', async () => {
    const filePath = await writeCatalogJson('many.json', {
      catalogRoot: 'test',
      count: 3,
      assets: [entry('a.png', hash('a')), entry('b.png', hash('b')), entry('c.png', hash('c'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), { maxBytes: 1024, maxAssets: 2 }),
    ).rejects.toThrow('too many');
  });

  it('rejects a huge assets array at the default maxAssets bound without per-entry validation', async () => {
    const maxAssets = 100_000;
    const assets = [];
    for (let i = 0; i < maxAssets + 1; i++) {
      assets.push({
        id: hash(String(i)),
        relativePath: `a${i}.txt`,
        sizeBytes: 0,
        mtime: 0,
      });
    }
    const filePath = await writeCatalogJson('huge.json', {
      catalogRoot: 'test',
      count: maxAssets + 1,
      assets,
    });

    const start = Date.now();
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 20 * 1024 * 1024,
      }),
    ).rejects.toThrow('too many assets: 100001');
    // It must fail fast, without spending time on per-entry transform / validation.
    expect(Date.now() - start).toBeLessThan(5000);
  }, 30000);
});

describe('writeCatalogDiff', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'diff-project-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('writes a JSON diff file atomically under output/', async () => {
    const diff = computeCatalogDiff(
      catalog([entry('a.png', hash('a'))], 'prev'),
      catalog(
        [entry('a.png', hash('a')), entry('b.png', hash('b'))],
        'cur',
      ),
    );
    const outPath = await writeCatalogDiff(diff, project, 'diff.json', inputDir);
    expect(outPath).toBe(resolve(project, 'output', 'diff.json'));
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    expect(parsed.added).toHaveLength(1);
    expect(parsed.unchanged).toHaveLength(1);
  });

  it('rejects non-JSON output paths', async () => {
    const diff = computeCatalogDiff(catalog([], 'prev'), catalog([], 'cur'));
    await expect(writeCatalogDiff(diff, project, 'diff.mp4', inputDir)).rejects.toThrow('.json');
  });

  it('rejects output path escaping into input directory', async () => {
    const diff = computeCatalogDiff(catalog([], 'prev'), catalog([], 'cur'));
    await expect(writeCatalogDiff(diff, project, '../input/diff.json', inputDir)).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects diff output when a current thumbnail is tampered after generation', async () => {
    const thumbDir = join(project, 'output', 'catalog-thumbnails');
    await mkdir(thumbDir, { recursive: true });
    const thumbPath = join(thumbDir, 'thumb.jpg');
    const thumbContent = Buffer.from('valid-thumb-bytes');
    await writeFile(thumbPath, thumbContent);
    const thumbSha = createHash('sha256').update(thumbContent).digest('hex');

    const previous = catalog([entry('a.png', hash('a'))], 'prev');
    const current = catalog(
      [
        {
          ...entry('a.png', hash('a')),
          thumbnail: {
            identifier: 'output/catalog-thumbnails/thumb.jpg',
            sha256: thumbSha,
            width: 1,
            height: 1,
          },
        },
      ],
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);

    // Tamper: replace the thumbnail with an external symlink before write.
    await rm(thumbPath);
    await symlink('/etc/passwd', thumbPath);

    await expect(writeCatalogDiff(diff, project, 'diff.json', inputDir)).rejects.toThrow(
      'thumbnail verification failed',
    );

    // Ensure the diff output was not written.
    await expect(readFile(resolve(project, 'output', 'diff.json'))).rejects.toThrow('ENOENT');
  });
});

describe('catalog-diff-cli', () => {
  let base: string;
  const outputName = () => `diff-cli-${basename(base)}`;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'diff-cli-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(join(root, 'output', outputName()), { recursive: true, force: true }).catch(() => {});
  });

  it('writes a JSON diff file via CLI', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'red.png'), 'red');
    await createAudio(join(inputDir, 'tone.mp3'), 2);

    const first = join(base, 'first.json');
    const actualRed = await sha256File(join(inputDir, 'red.png'));
    const previous = catalog([entry('red.png', actualRed)], 'first');
    await writeFile(first, JSON.stringify(previous));

    const outputRel = `${outputName()}/diff.json`;

    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'src/catalog-cli.ts', 'diff', first.slice(root.length + 1), inputDir, outputRel],
      { cwd: root },
    );

    expect(stderr).toBeFalsy();
    expect(stdout).toMatch(/Catalog diff written/);
    const outPath = join(root, 'output', outputRel);
    const parsed = JSON.parse(await readFile(outPath, 'utf8'));
    expect(parsed.unchanged).toHaveLength(1);
    expect(parsed.unchanged[0].relativePath).toBe('red.png');
    expect(parsed.added).toHaveLength(1);
    expect(parsed.added[0].relativePath).toBe('tone.mp3');
  }, 60000);

  it('rejects a diff output argument that escapes output/ or is not .json', async () => {
    const inputDir = join(base, 'input');
    await mkdir(inputDir, { recursive: true });
    await createPng(join(inputDir, 'red.png'), 'red');
    const previous = join(base, 'prev.json');
    await writeFile(previous, JSON.stringify(catalog([entry('red.png', hash('a'))], 'prev')));

    await expect(
      execFileAsync(
        'npx',
        [
          'tsx',
          'src/catalog-cli.ts',
          'diff',
          previous.slice(root.length + 1),
          inputDir,
          '../package.json',
        ],
        { cwd: root },
      ),
    ).rejects.toThrow();

    await expect(
      execFileAsync(
        'npx',
        [
          'tsx',
          'src/catalog-cli.ts',
          'diff',
          previous.slice(root.length + 1),
          inputDir,
          'diff.mp4',
        ],
        { cwd: root },
      ),
    ).rejects.toThrow();
  }, 60000);

});

describe('loadPreviousCatalog safe file reads', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'diff-read-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function writeCatalogJson(name: string, content: unknown): Promise<string> {
    const filePath = join(base, name);
    await mkdir(join(base), { recursive: true });
    await writeFile(filePath, JSON.stringify(content));
    return filePath;
  }

  it('rejects sparse append after stat', async () => {
    const filePath = await writeCatalogJson('grow.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
        __testHooks: {
          beforeRead: async ({ path }) => {
            await writeFile(path, 'x', { flag: 'a' });
          },
        },
      }),
    ).rejects.toThrow('grew');
  });

  it('rejects truncation after stat', async () => {
    const filePath = await writeCatalogJson('shrink.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
        __testHooks: {
          beforeRead: async ({ path }) => {
            await truncate(path, 0);
          },
        },
      }),
    ).rejects.toThrow('shrank');
  });

  it('rejects leaf replaced by a symlink after read', async () => {
    const filePath = await writeCatalogJson('symlink.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
        __testHooks: {
          beforeVerify: async ({ path }) => {
            await rm(path);
            await symlink('/etc/passwd', path);
          },
        },
      }),
    ).rejects.toThrow('does not match');
  });

  it('rejects leaf atomically replaced after read', async () => {
    const filePath = await writeCatalogJson('replace.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [entry('a.png', hash('a'))],
    });
    const other = join(base, 'other.json');
    await writeFile(other, JSON.stringify({ different: true }));
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
        __testHooks: {
          beforeVerify: async ({ path }) => {
            await rename(other, path);
          },
        },
      }),
    ).rejects.toThrow('does not match');
  });

  it('rejects an ancestor directory swapped to an external symlink before open', async () => {
    const project = join(base, 'project');
    const projectSub = join(project, 'sub');
    const external = join(base, 'external');
    const projectDir = join(projectSub, 'dir');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(external, 'sub', 'dir'), { recursive: true });

    // A malicious external catalog that would parse as a valid catalog.
    await writeFile(
      join(external, 'sub', 'dir', 'prev.json'),
      JSON.stringify({ catalogRoot: 'evil', count: 0, assets: [] }),
    );
    await writeFile(
      join(projectDir, 'prev.json'),
      JSON.stringify(catalog([entry('a.png', hash('a'))], 'prev')),
    );

    await expect(
      loadPreviousCatalog(project, 'sub/dir/prev.json', {
        maxBytes: 1024,
        maxAssets: 10,
        __testHooks: {
          beforeChildDirOpen: async ({ component }) => {
            if (component === 'sub') {
              await rm(projectSub, { recursive: true, force: true });
              await symlink(external, projectSub);
            }
          },
        },
      }),
    ).rejects.toThrow(/ELOOP|ENOTDIR|symbolic|location|not a directory/i);
  });

  it('rejects a catalog file that is not valid UTF-8', async () => {
    const filePath = join(base, 'invalid-utf8.json');
    await mkdir(base, { recursive: true });
    await writeFile(filePath, Buffer.from([0x7b, 0x0a, 0xff, 0xfe]));

    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
      }),
    ).rejects.toThrow(/not valid UTF-8|valid UTF-8/i);
  });

  it('does not leak file descriptors on repeated leaf verification failures', async () => {
    const filePath = await writeCatalogJson('leak.json', catalog([entry('a.png', hash('a'))], 'leak'));
    const rel = filePath.slice(root.length + 1);
    const original = JSON.stringify(catalog([entry('a.png', hash('a'))], 'leak'));
    const countFds = async () => (await readdir('/proc/self/fd')).length;

    const before = await countFds();
    for (let i = 0; i < 100; i++) {
      await expect(
        loadPreviousCatalog(root, rel, {
          maxBytes: 1024,
          maxAssets: 10,
          __testHooks: {
            beforeLeafVerify: async ({ path }) => {
              await rm(path, { force: true });
              await symlink('/etc/passwd', path);
            },
          },
        }),
      ).rejects.toThrow();
      // Restore the regular file so the next open succeeds and reaches verify.
      await rm(filePath, { force: true });
      await writeFile(filePath, original);
    }
    const after = await countFds();

    expect(after - before).toBeLessThan(50);
    // A final successful load proves the file and descriptors are still usable.
    const result = await loadPreviousCatalog(root, rel, { maxBytes: 1024, maxAssets: 10 });
    expect(result.catalogRoot).toBe('leak');
  });
});

describe('computeCatalogDiff id-less error entries', () => {
  function errorEntry(
    relativePath: string,
    code: string,
    extra?: Partial<CatalogEntry>,
  ): CatalogEntry {
    return entry(relativePath, undefined, {
      error: { code, message: 'err' },
      ...extra,
    });
  }

  it('marks id-less same-path same-fingerprint entries as unchanged', () => {
    const previous = catalog([errorEntry('a.png', 'HASH_FAILED')], 'prev');
    const current = catalog([errorEntry('a.png', 'HASH_FAILED')], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].relativePath).toBe('a.png');
    expect(diff.changed).toHaveLength(0);
  });

  it('marks id-less same-path different-fingerprint entries as changed', () => {
    const previous = catalog(
      [errorEntry('a.png', 'HASH_FAILED', { sizeBytes: 1 })],
      'prev',
    );
    const current = catalog(
      [errorEntry('a.png', 'HASH_FAILED', { sizeBytes: 2 })],
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].relativePath).toBe('a.png');
    expect(diff.unchanged).toHaveLength(0);
  });

  it('does not move id-less entries with different paths', () => {
    const previous = catalog([errorEntry('a.png', 'HASH_FAILED')], 'prev');
    const current = catalog([errorEntry('b.png', 'HASH_FAILED')], 'cur');
    const diff = computeCatalogDiff(previous, current);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].relativePath).toBe('a.png');
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].relativePath).toBe('b.png');
    expect(diff.moved).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });
});

describe('computeCatalogDiff deterministic ordering', () => {
  it('sorts non-ASCII/diacritic paths by UTF-8 bytes', () => {
    const paths = ['Á.png', 'A\u0301.png', 'Z.png', 'あ.png', 'zoo.png'];
    const expected = [...paths].sort((a, b) =>
      Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8')),
    );
    const previous = catalog(
      paths.map((p) => entry(p, hash(p))),
      'prev',
    );
    const current = catalog(
      paths.map((p) => entry(p, hash(p))),
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);
    expect(diff.unchanged.map((e) => e.relativePath)).toEqual(expected);
  });

  it('sorts moved entries deterministically by new then old path', () => {
    const previous = catalog(
      [
        entry('Á.png', hash('a')),
        entry('A\u0301.png', hash('a')),
        entry('Z.png', hash('a')),
      ],
      'prev',
    );
    const current = catalog(
      [
        entry('zz/Á.png', hash('a')),
        entry('zz/A\u0301.png', hash('a')),
        entry('zz/Z.png', hash('a')),
      ],
      'cur',
    );
    const diff = computeCatalogDiff(previous, current);
    const newPaths = diff.moved.map((m) => m.newRelativePath);
    const sortedNew = [...newPaths].sort((a, b) =>
      Buffer.from(a, 'utf8').compare(Buffer.from(b, 'utf8')),
    );
    expect(newPaths).toEqual(sortedNew);
  });
});

describe('loadPreviousCatalog strict entry validation', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(root, 'tests', 'diff-strict-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function writeCatalogJson(name: string, content: unknown): Promise<string> {
    const filePath = join(base, name);
    await writeFile(filePath, JSON.stringify(content));
    return filePath;
  }

  it('rejects a string error', async () => {
    const filePath = await writeCatalogJson('string-error.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [{ relativePath: 'a.png', sizeBytes: 0, mtime: 0, error: 'boom' }],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
      }),
    ).rejects.toThrow();
  });

  it('rejects a null probe', async () => {
    const filePath = await writeCatalogJson('null-probe.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [
        {
          relativePath: 'a.png',
          sizeBytes: 0,
          mtime: 0,
          id: hash('a'),
          probe: null,
        },
      ],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
      }),
    ).rejects.toThrow();
  });

  it('rejects an entry missing both id and error', async () => {
    const filePath = await writeCatalogJson('missing.json', {
      catalogRoot: 'test',
      count: 1,
      assets: [{ relativePath: 'a.png', sizeBytes: 0, mtime: 0 }],
    });
    await expect(
      loadPreviousCatalog(root, filePath.slice(root.length + 1), {
        maxBytes: 1024,
        maxAssets: 10,
      }),
    ).rejects.toThrow('valid id or a structured error');
  });

  it('rejects unsafe thumbnail identifiers', async () => {
    for (const identifier of [
      '/etc/passwd',
      '../secret.jpg',
      'a\\b.jpg',
      'C:thumb.jpg',
      'C:.\\thumb.jpg',
      'C:..\\thumb.jpg',
      'a/./b.jpg',
      'a//b.jpg',
    ]) {
      const filePath = await writeCatalogJson(`unsafe-thumb-${identifier.replace(/[^a-zA-Z0-9]/g, '_')}.json`, {
        catalogRoot: 'test',
        count: 1,
        assets: [
          {
            relativePath: 'a.png',
            sizeBytes: 0,
            mtime: 0,
            id: hash('a'),
            thumbnail: {
              identifier,
              sha256: hash('thumb'),
              width: 1,
              height: 1,
            },
          },
        ],
      });
      await expect(
        loadPreviousCatalog(root, filePath.slice(root.length + 1), {
          maxBytes: 1024,
          maxAssets: 10,
        }),
      ).rejects.toThrow();
    }
  });
});

describe('writeCatalogDiff previous-catalog collision', () => {
  let project: string;
  let inputDir: string;

  beforeEach(async () => {
    project = await mkdtemp(join(root, 'tests', 'diff-collision-'));
    inputDir = join(project, 'input');
    await mkdir(inputDir, { recursive: true });
    await mkdir(join(project, 'output'), { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  const diff = computeCatalogDiff(
    catalog([entry('a.png', hash('a'))], 'prev'),
    catalog([entry('a.png', hash('a'))], 'cur'),
  );

  it('rejects output path that is the same file as the previous catalog', async () => {
    const previousPath = join(project, 'output', 'previous.json');
    await writeFile(previousPath, JSON.stringify(catalog([entry('a.png', hash('a'))], 'prev')));
    await expect(
      writeCatalogDiff(diff, project, 'previous.json', inputDir, {
        previousCatalogPath: previousPath,
      }),
    ).rejects.toThrow('same as');
  });

  it('rejects output path that is a hard link to the previous catalog', async () => {
    const previousPath = join(project, 'output', 'previous.json');
    const outputPath = join(project, 'output', 'diff.json');
    await writeFile(previousPath, JSON.stringify(catalog([entry('a.png', hash('a'))], 'prev')));
    await link(previousPath, outputPath);
    await expect(
      writeCatalogDiff(diff, project, 'diff.json', inputDir, {
        previousCatalogPath: previousPath,
      }),
    ).rejects.toThrow('inode');
  });
});
