import { describe, expect, it, beforeAll, afterEach } from 'vitest';

import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  generateFixtures,
  buildMediaSubrangeInputFixtures,
  verifyMediaSubrangeInputFixtures,
  safeReadFinalOutput,
} from '../src/fixtures.js';

const blackMp4Hash = '0'.repeat(64);
const dejavuHash = '1'.repeat(64);

describe('verifyMediaSubrangeInputFixtures', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'fixtures-test-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    base = await mkdtemp(join(tmpdir(), 'fixtures-test-'));
  });

  async function writeCanonical(baseDir: string, black: string, dejavu: string) {
    const fixtures = buildMediaSubrangeInputFixtures(black, dejavu);
    const dir = join(baseDir, 'fixtures', 'media-subrange-input');
    await mkdir(dir, { recursive: true });
    for (const { name, bytes } of fixtures) {
      await writeFile(join(dir, name), bytes);
    }
  }

  it('accepts the four canonical README sub-range fixture inputs', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    const verified = await verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash);
    const inputDir = join(base, 'fixtures', 'media-subrange-input');
    expect(verified.sort()).toEqual([
      join(inputDir, 'selection.json'),
      join(inputDir, 'style.json'),
      join(inputDir, 'subranges.json'),
      join(inputDir, 'transcript-source.json'),
    ]);

    const subranges = JSON.parse(await readFile(join(inputDir, 'subranges.json'), 'utf8'));
    expect(subranges.schemaVersion).toBe('v1');
    expect(subranges.ranges).toHaveLength(2);

    const selection = JSON.parse(await readFile(join(inputDir, 'selection.json'), 'utf8'));
    expect(selection.segmentIds).toHaveLength(2);
  });

  it('rejects a missing fixture input file', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    await rm(join(base, 'fixtures', 'media-subrange-input', 'subranges.json'));

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /File not found|canonical bytes|regular file/i,
    );
  });

  it('rejects a fixture input with modified bytes', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    await writeFile(join(base, 'fixtures', 'media-subrange-input', 'transcript-source.json'), 'foreign');

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /does not match canonical bytes/i,
    );

    expect(await readFile(join(base, 'fixtures', 'media-subrange-input', 'transcript-source.json'), 'utf8')).toBe('foreign');
  });

  it('rejects a fixture input that is a symbolic link', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    const transcriptPath = join(base, 'fixtures', 'media-subrange-input', 'transcript-source.json');
    const target = resolve(transcriptPath);
    await rm(transcriptPath);
    await symlink(target, transcriptPath);

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /symbolic link|not a regular file|single link/i,
    );
  });

  it('rejects a fixture input that is a hard link', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    const inputDir = join(base, 'fixtures', 'media-subrange-input');
    const subrangesPath = join(inputDir, 'subranges.json');
    const transcriptPath = join(inputDir, 'transcript-source.json');
    await rm(transcriptPath);
    await link(subrangesPath, transcriptPath);

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /single link|hard link|regular file/i,
    );
  });

  it('rejects a fixture input that is a directory', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);
    const transcriptPath = join(base, 'fixtures', 'media-subrange-input', 'transcript-source.json');
    await rm(transcriptPath);
    await mkdir(transcriptPath);

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /not a regular file|single link/i,
    );
  });

  it('rejects a fixtures directory that is a symbolic link outside the project root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'fixtures-outside-'));
    const fixturesPath = join(base, 'fixtures');
    await symlink(outsideDir, fixturesPath);

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /symbolic link|directory location|base directory/i,
    );

    const entries = await readdir(outsideDir).catch(() => [] as string[]);
    expect(entries).toHaveLength(0);
  });

  it('rejects a fixtures directory that is a symbolic link inside the project root', async () => {
    const realDir = join(base, 'fixtures.real');
    const fixturesPath = join(base, 'fixtures');
    await mkdir(realDir);
    await symlink(realDir, fixturesPath);

    await expect(verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash)).rejects.toThrow(
      /symbolic link|directory location|base directory/i,
    );
  });

  it('rejects when fd-relative directory primitives are unavailable', async () => {
    await writeCanonical(base, blackMp4Hash, dejavuHash);

    await expect(
      verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash, {
        __testHooks: { fdRelativeBase: () => null },
      }),
    ).rejects.toThrow(/fd-relative directory primitives are not available/);

    const fixtures = buildMediaSubrangeInputFixtures(blackMp4Hash, dejavuHash);
    const inputDir = join(base, 'fixtures', 'media-subrange-input');
    for (const { name, bytes } of fixtures) {
      expect(await readFile(join(inputDir, name))).toEqual(bytes);
    }
    const entries = await readdir(inputDir);
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  });
});

const adversarialBlackHash = blackMp4Hash;
const adversarialDejavuHash = dejavuHash;

describe('verifyMediaSubrangeInputFixtures adversarial races', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'fixtures-adversarial-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    base = await mkdtemp(join(tmpdir(), 'fixtures-adversarial-'));
  });

  async function writeCanonical() {
    const fixtures = buildMediaSubrangeInputFixtures(adversarialBlackHash, adversarialDejavuHash);
    const dir = join(base, 'fixtures', 'media-subrange-input');
    await mkdir(dir, { recursive: true });
    for (const { name, bytes } of fixtures) {
      await writeFile(join(dir, name), bytes);
    }
  }

  async function inputDir() {
    return join(base, 'fixtures', 'media-subrange-input');
  }

  function canonicalBytes(name: string): Buffer {
    const fixtures = buildMediaSubrangeInputFixtures(adversarialBlackHash, adversarialDejavuHash);
    const f = fixtures.find((x) => x.name === name);
    if (!f) throw new Error(`unknown fixture: ${name}`);
    return f.bytes;
  }

  it('rejects a leaf swapped to a symlink to an external canonical file after lstat', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const filePath = join(dir, 'subranges.json');
    const outsideDir = await mkdtemp(join(tmpdir(), 'fixtures-adversarial-outside-'));
    const outsideCanonical = join(outsideDir, 'subranges.json');
    await writeFile(outsideCanonical, canonicalBytes('subranges.json'));
    const backupPath = join(dir, 'subranges.json.real');

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          beforeFileOpen: async (name) => {
            if (name !== 'subranges.json') return;
            await rename(filePath, backupPath);
            await symlink(outsideCanonical, filePath);
          },
        },
      }),
    ).rejects.toThrow(/symbolic link|not a regular file|single link|O_NOFOLLOW|does not match/i);

    await rm(filePath, { force: true }).catch(() => {});
    await rename(backupPath, filePath).catch(async () => {
      await writeFile(filePath, canonicalBytes('subranges.json'));
    });
  });

  it('rejects a leaf replaced with a same-bytes file at a different inode after lstat', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const filePath = join(dir, 'subranges.json');
    const copyPath = join(dir, '.subranges-copy.json');
    await writeFile(copyPath, canonicalBytes('subranges.json'));
    const backupPath = join(dir, 'subranges.json.real');

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          beforeFileOpen: async (name) => {
            if (name !== 'subranges.json') return;
            await rename(filePath, backupPath);
            await rename(copyPath, filePath);
          },
        },
      }),
    ).rejects.toThrow(/replaced between stat and open|identity changed|does not match canonical bytes/i);

    // restore
    await rename(filePath, copyPath).catch(() => {});
    await rename(backupPath, filePath).catch(async () => {
      await writeFile(filePath, canonicalBytes('subranges.json'));
    });
  });

  it('rejects a parent directory swap during verification', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const backupDir = join(base, 'fixtures', 'media-subrange-input.real');
    let swapped = false;

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          afterFileRead: async (name) => {
            if (name !== 'subranges.json' || swapped) return;
            swapped = true;
            await rename(dir, backupDir);
            await mkdir(dir);
          },
        },
      }),
    ).rejects.toThrow(/directory location does not match|directory identity|escaped project root|directly inside its parent directory/i);

    // cleanup: restore so afterEach can remove base
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const e of entries) {
      await rm(join(dir, e), { recursive: true, force: true }).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rename(backupDir, dir).catch(() => {});
  });

  it('rejects the leading leaf swapped after the first file has been verified', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const filePath = join(dir, 'subranges.json');
    const outsideDir = await mkdtemp(join(tmpdir(), 'fixtures-adversarial-outside-'));
    const outsideCanonical = join(outsideDir, 'subranges.json');
    await writeFile(outsideCanonical, canonicalBytes('subranges.json'));
    const backupPath = join(dir, 'subranges.json.real');

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          beforeFinalVerify: async () => {
            await rename(filePath, backupPath);
            await symlink(outsideCanonical, filePath);
          },
        },
      }),
    ).rejects.toThrow(/pathname diverged|identity changed|symbolic link|not a regular file|single link/i);

    await rm(filePath, { force: true }).catch(() => {});
    await rename(backupPath, filePath).catch(async () => {
      await writeFile(filePath, canonicalBytes('subranges.json'));
    });
  });

  it('leaves all four fixture inputs unchanged after successful verification', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const before = new Map<string, Buffer>();
    for (const name of ['subranges.json', 'transcript-source.json', 'selection.json', 'style.json']) {
      before.set(name, await readFile(join(dir, name)));
    }
    const verified = await verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash);
    expect(verified.sort()).toEqual(
      [
        'selection.json',
        'style.json',
        'subranges.json',
        'transcript-source.json',
      ].map((n) => join(dir, n)),
    );
    for (const [name, bytes] of before) {
      expect(await readFile(join(dir, name))).toEqual(bytes);
    }
  });

  it('rejects a parent directory ABA swap during the component walk', async () => {
    await writeCanonical();
    const dir = await inputDir();
    const fixturesDir = dirname(dir);
    const backupDir = `${fixturesDir}.real`;
    let triggered = false;

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          beforeDirOpen: async (comp, currentPath) => {
            if (comp !== 'media-subrange-input' || triggered) return;
            triggered = true;
            await rename(currentPath, backupDir);
            await mkdir(currentPath);
            await mkdir(join(currentPath, 'media-subrange-input'));
          },
        },
      }),
    ).rejects.toThrow(
      /directory location does not match|directory identity|escaped project root|directly inside its parent directory|does not match/i,
    );
  });

  it('rejects an ancestor symlink swap during the component walk', async () => {
    await writeCanonical();
    const fixturesDir = join(base, 'fixtures');
    const backupDir = `${fixturesDir}.real`;
    const outsideDir = await mkdtemp(join(tmpdir(), 'fixtures-outside-ancestor-'));
    let triggered = false;

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: {
          beforeDirOpen: async (comp) => {
            if (comp !== 'fixtures' || triggered) return;
            triggered = true;
            await rename(fixturesDir, backupDir);
            await symlink(outsideDir, fixturesDir);
          },
        },
      }),
    ).rejects.toThrow(
      /symbolic link|directory location|directory could not be opened|not a directory|ELOOP|O_NOFOLLOW/i,
    );
  });
});

describe('safeReadFinalOutput close errors', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'safe-read-close-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    base = await mkdtemp(join(tmpdir(), 'safe-read-close-'));
  });

  function injectCloseFailure(fh: unknown) {
    const handle = fh as { close: () => Promise<void> };
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      throw new Error('injected close failure');
    };
  }

  it('throws a cleanup error when processing succeeds but close fails', async () => {
    const filePath = join(base, 'final.txt');
    await writeFile(filePath, 'canonical');

    await expect(
      safeReadFinalOutput(filePath, {
        __testHooks: { beforeFileClose: (fh) => injectCloseFailure(fh) },
      }),
    ).rejects.toThrow(/cleanup failed for .*final\.txt/);
  });

  it('preserves both processing and cleanup errors when close fails during processing failure', async () => {
    const dirPath = join(base, 'final-dir');
    await mkdir(dirPath);

    let caught: unknown;
    try {
      await safeReadFinalOutput(dirPath, {
        __testHooks: { beforeFileClose: (fh) => injectCloseFailure(fh) },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors.length).toBeGreaterThanOrEqual(2);
    const messages = aggregate.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    expect(messages.some((m) => /not a regular file|single link/i.test(m))).toBe(true);
    expect(messages.some((m) => /injected close failure/i.test(m))).toBe(true);
  });
});

describe('verifyMediaSubrangeInputFixtures close errors', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'verify-close-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    base = await mkdtemp(join(tmpdir(), 'verify-close-'));
  });

  async function writeCanonical() {
    const fixtures = buildMediaSubrangeInputFixtures(adversarialBlackHash, adversarialDejavuHash);
    const dir = join(base, 'fixtures', 'media-subrange-input');
    await mkdir(dir, { recursive: true });
    for (const { name, bytes } of fixtures) {
      await writeFile(join(dir, name), bytes);
    }
  }

  function injectCloseFailure(fh: unknown) {
    const handle = fh as { close: () => Promise<void> };
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      throw new Error('injected close failure');
    };
  }

  it('throws a cleanup error when verification succeeds but close fails', async () => {
    await writeCanonical();

    await expect(
      verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: { beforeFileClose: (fh) => injectCloseFailure(fh) },
      }),
    ).rejects.toThrow(/cleanup failed for media-subrange-input fixtures/);
  });

  it('preserves both processing and cleanup errors when close fails during verification failure', async () => {
    await writeCanonical();
    await writeFile(join(base, 'fixtures', 'media-subrange-input', 'subranges.json'), 'foreign');

    let caught: unknown;
    try {
      await verifyMediaSubrangeInputFixtures(base, adversarialBlackHash, adversarialDejavuHash, {
        __testHooks: { beforeFileClose: (fh) => injectCloseFailure(fh) },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors.length).toBeGreaterThanOrEqual(2);
    const messages = aggregate.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    expect(messages.some((m) => /does not match canonical bytes|foreign/i.test(m))).toBe(true);
    expect(messages.some((m) => /injected close failure/i.test(m))).toBe(true);
  });
});


describe('generateFixtures input immutability', () => {
  let fixtureRoot: string;
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function prepareInputDir(
    missingName: string,
    foreignName: string,
    foreignBytes: Buffer,
  ): Promise<string> {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'generate-fixtures-immutability-'));
    const fixturesDir = join(fixtureRoot, 'fixtures');
    const inputDir = join(fixturesDir, 'media-subrange-input');
    const fontsDir = join(fixtureRoot, 'fonts');
    await mkdir(fixturesDir, { recursive: true });
    await mkdir(inputDir, { recursive: true });
    await mkdir(fontsDir, { recursive: true });

    await copyFile(join(repoRoot, 'fixtures', 'black.mp4'), join(fixturesDir, 'black.mp4'));
    await copyFile(
      join(repoRoot, 'fonts', 'DejaVuSans.ttf'),
      join(fontsDir, 'DejaVuSans.ttf'),
    );

    const names = ['subranges.json', 'transcript-source.json', 'selection.json', 'style.json'];
    for (const name of names) {
      if (name === missingName) {
        continue;
      }
      if (name === foreignName) {
        await writeFile(join(inputDir, name), foreignBytes);
        continue;
      }
      await copyFile(join(repoRoot, 'fixtures', 'media-subrange-input', name), join(inputDir, name));
    }

    return inputDir;
  }

  async function snapshotDir(inputDir: string): Promise<Map<string, { stat: Awaited<ReturnType<typeof lstat>>; bytes?: Buffer }>> {
    const entries = await readdir(inputDir);
    const snap = new Map<string, { stat: Awaited<ReturnType<typeof lstat>>; bytes?: Buffer }>();
    for (const name of entries) {
      const p = join(inputDir, name);
      const s = await lstat(p);
      if (s.isFile()) {
        snap.set(name, { stat: s, bytes: await readFile(p) });
      } else {
        snap.set(name, { stat: s });
      }
    }
    return snap;
  }

  it('does not mutate media-subrange-input when the first fixture is missing and the second is foreign', async () => {
    const foreign = Buffer.from('{"foreign":true}\n');
    const inputDir = await prepareInputDir('subranges.json', 'transcript-source.json', foreign);
    const before = await snapshotDir(inputDir);

    await expect(generateFixtures(fixtureRoot)).rejects.toThrow(
      /File not found|canonical bytes|regular file|single link|symbolic link/i,
    );

    const after = await snapshotDir(inputDir);
    expect(after.size).toBe(before.size);
    for (const [name, beforeEntry] of before) {
      const afterEntry = after.get(name);
      expect(afterEntry).toBeDefined();
      expect(afterEntry!.stat.dev).toBe(beforeEntry.stat.dev);
      expect(afterEntry!.stat.ino).toBe(beforeEntry.stat.ino);
      expect(afterEntry!.stat.size).toBe(beforeEntry.stat.size);
      expect(afterEntry!.stat.mtimeMs).toBe(beforeEntry.stat.mtimeMs);
      expect(afterEntry!.stat.ctimeMs).toBe(beforeEntry.stat.ctimeMs);
      if (beforeEntry.bytes) {
        expect(await readFile(join(inputDir, name))).toEqual(beforeEntry.bytes);
      }
    }
    expect(before.has('subranges.json')).toBe(false);
    expect(after.has('subranges.json')).toBe(false);

    const entries = await readdir(inputDir);
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  }, 120000);

  it('does not mutate media-subrange-input when a later fixture is a symlink to a file outside the project', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'fixtures-outside-generate-'));
    const inputDir = await prepareInputDir('none', 'none', Buffer.from(''));
    const target = join(outsideDir, 'style-target.json');
    await copyFile(
      join(repoRoot, 'fixtures', 'media-subrange-input', 'style.json'),
      target,
    );
    await rm(join(inputDir, 'style.json'));
    await symlink(target, join(inputDir, 'style.json'));
    const before = await snapshotDir(inputDir);

    await expect(generateFixtures(fixtureRoot)).rejects.toThrow(
      /symbolic link|directory location|base directory|not a regular file|single link/i,
    );

    const after = await snapshotDir(inputDir);
    expect(after.size).toBe(before.size);
    for (const [name, beforeEntry] of before) {
      const afterEntry = after.get(name);
      expect(afterEntry).toBeDefined();
      expect(afterEntry!.stat.dev).toBe(beforeEntry.stat.dev);
      expect(afterEntry!.stat.ino).toBe(beforeEntry.stat.ino);
      expect(afterEntry!.stat.size).toBe(beforeEntry.stat.size);
      expect(afterEntry!.stat.mtimeMs).toBe(beforeEntry.stat.mtimeMs);
      expect(afterEntry!.stat.ctimeMs).toBe(beforeEntry.stat.ctimeMs);
      if (beforeEntry.bytes) {
        expect(await readFile(join(inputDir, name))).toEqual(beforeEntry.bytes);
      }
    }

    const entries = await readdir(inputDir);
    expect(entries.filter((n) => n.startsWith('.') || n.includes('tmp') || n.startsWith('.cleanup-'))).toHaveLength(0);
  }, 120000);
});