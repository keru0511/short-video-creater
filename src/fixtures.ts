import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isInside } from './core.js';
import { fdRelativeBase, openAt, statsEqual, verifyDirLocation } from './fs-atomic.js';
import { computeSegmentId, MEDIA_SUBRANGE_SCHEMA_VERSION, type MediaSegmentManifest } from './media-segments.js';
import { buildTranscriptManifest, type TranscriptSource } from './transcript-manifest.js';
import { generateAndWriteSubtitleTimeline } from './transcript-subtitle-timeline.js';
import { sha256File } from './utils.js';

const execFileAsync = promisify(execFile);
const O_RDONLY = constants.O_RDONLY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const CHUNK_SIZE = 64 * 1024;

// Only single-face TrueType/OpenType fonts are supported in this slice.
// Collection fonts (.ttc/.otc) would require a face index/name contract.
const SINGLE_FACE_EXTS = new Set(['.ttf', '.otf']);

function isSingleFaceFont(file: string): boolean {
  return SINGLE_FACE_EXTS.has(extname(file).toLowerCase());
}

async function findSystemFont(family: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('fc-list', [
      '-f',
      '%{file}:%{style}\n',
      family,
    ]);
    const entries = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [file, ...rest] = line.split(':');
        return { file: file.trim(), style: rest.join(':').trim() };
      })
      .filter((e) => e.file.length > 0 && existsSync(e.file) && isSingleFaceFont(e.file));
    const preferred = entries.find((e) => /Regular|Book|Roman|Normal/i.test(e.style));
    return preferred ? preferred.file : entries[0]?.file;
  } catch {
    return undefined;
  }
}

async function copySystemFont(family: string, destName: string, fontsDir: string): Promise<string> {
  const src = await findSystemFont(family);
  if (!src) {
    throw new Error(`Required font not installed on this system: ${family}`);
  }
  const dest = join(fontsDir, destName);
  await copyFile(src, dest);
  return dest;
}

export async function prepareFonts(root?: string): Promise<string[]> {
  const base = root ?? resolve(fileURLToPath(new URL('..', import.meta.url)));
  const fontsDir = join(base, 'fonts');

  await mkdir(fontsDir, { recursive: true });

  const candidates: Array<[string, string]> = [
    ['DejaVu Sans', 'DejaVuSans.ttf'],
    ['IPAGothic', 'IPAGothic.ttf'],
  ];
  const copied: string[] = [];
  for (const [family, destName] of candidates) {
    const dest = join(fontsDir, destName);
    if (existsSync(dest)) {
      copied.push(dest);
      continue;
    }
    try {
      await copySystemFont(family, destName, fontsDir);
      copied.push(dest);
    } catch {
      // Skip families not installed on this system.
    }
  }

  if (copied.length === 0) {
    throw new Error(
      'No .ttf/.otf fonts found in fonts/ and no supported system fonts could be copied. Place a font in fonts/ or run npm run setup:fonts (Linux).',
    );
  }
  return copied;
}

export interface SafeFileReadResult {
  bytes: Buffer;
  stat: Stats;
  realpath: string;
}

export interface SafeReadFinalOutputOptions {
  __testHooks?: {
    beforeFileClose?: (fh: FileHandle) => Promise<void> | void;
  };
}

// Read an existing final with O_NOFOLLOW, require a regular file with a single
// link, verify the bytes, and confirm pathname/parent continuity. This closes the
// symlink/hard-link/TOCTOU windows in generateFixtures collision checking.
export async function safeReadFinalOutput(
  path: string,
  options?: SafeReadFinalOutputOptions,
): Promise<SafeFileReadResult> {
  const fh = await open(path, O_RDONLY | O_NOFOLLOW);
  let processingError: unknown;
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Existing final is not a regular file with a single link: ${path}`);
    }
    const pathStat = await lstat(path);
    if (
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino ||
      pathStat.size !== stat.size ||
      pathStat.mtimeMs !== stat.mtimeMs ||
      pathStat.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error(`Existing final pathname identity diverged after open: ${path}`);
    }
    const bytes = await fh.readFile();
    const statAfter = await fh.stat();
    if (
      statAfter.dev !== stat.dev ||
      statAfter.ino !== stat.ino ||
      statAfter.size !== stat.size ||
      statAfter.mtimeMs !== stat.mtimeMs ||
      statAfter.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error(`Existing final changed during read: ${path}`);
    }
    const real = await realpath(path).catch(() => null);
    const parentRealpath = await realpath(dirname(path)).catch(() => null);
    if (!real || !parentRealpath || dirname(real) !== parentRealpath) {
      throw new Error(`Existing final is not directly inside its parent directory: ${path}`);
    }
    return { bytes, stat, realpath: real };
  } catch (err) {
    processingError = err;
    throw err;
  } finally {
    const closeErrors: unknown[] = [];
    try {
      await options?.__testHooks?.beforeFileClose?.(fh);
    } catch {
      // test hook errors are not cleanup failures
    }
    try {
      await fh.close();
    } catch (closeErr) {
      closeErrors.push(closeErr);
    }
    if (closeErrors.length > 0) {
      if (processingError) {
        throw new AggregateError(
          [processingError, ...closeErrors],
          `processing failed and cleanup failed for ${path}`,
        );
      }
      throw new AggregateError(closeErrors, `cleanup failed for ${path}`);
    }
  }
}

export interface MediaSubrangeInputFixture {
  name: string;
  bytes: Buffer;
}

// Build the deterministic README sub-range fixture input bytes.  These files
// are tracked canonical files in the repository, so runtime generation never
// has to perform a directory rename or touch foreign pathnames.
export function buildMediaSubrangeInputFixtures(
  blackMp4Hash: string,
  dejavuHash: string,
): MediaSubrangeInputFixture[] {
  const subrangeSegmentA = computeSegmentId({
    assetContentId: blackMp4Hash,
    relativePath: 'black.mp4',
    mediaType: 'video',
    start: 0,
    end: 2.5,
    duration: 5,
    schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
  });
  const subrangeSegmentB = computeSegmentId({
    assetContentId: blackMp4Hash,
    relativePath: 'black.mp4',
    mediaType: 'video',
    start: 2.5,
    end: 5,
    duration: 5,
    schemaVersion: MEDIA_SUBRANGE_SCHEMA_VERSION,
  });

  const files = [
    {
      name: 'subranges.json',
      content: {
        schemaVersion: 'v1',
        ranges: [
          { assetContentId: blackMp4Hash, relativePath: 'black.mp4', start: 0, end: 2.5 },
          { assetContentId: blackMp4Hash, relativePath: 'black.mp4', start: 2.5, end: 5 },
        ],
      },
    },
    {
      name: 'transcript-source.json',
      content: {
        schemaVersion: 'v1',
        entries: [
          { segmentId: subrangeSegmentA, start: 0.5, end: 2, text: 'Hello' },
          { segmentId: subrangeSegmentB, start: 3, end: 4, text: 'world' },
        ],
      },
    },
    {
      name: 'selection.json',
      content: { segmentIds: [subrangeSegmentA, subrangeSegmentB] },
    },
    {
      name: 'style.json',
      content: {
        font: 'DejaVuSans.ttf',
        fontHash: dejavuHash,
        x: 540,
        y: 1500,
        fontSize: 100,
      },
    },
  ];

  return files.map((file) => ({
    name: file.name,
    bytes: Buffer.from(JSON.stringify(file.content, null, 2) + '\n'),
  }));
}

export interface VerifyMediaSubrangeInputFixturesOptions {
  __testHooks?: {
    beforeDirOpen?: (component: string, currentPath: string) => Promise<void> | void;
    afterDirOpen?: (component: string, currentPath: string) => Promise<void> | void;
    beforeFileLstat?: (name: string, filePath: string) => Promise<void> | void;
    afterFileLstat?: (name: string, filePath: string) => Promise<void> | void;
    beforeFileOpen?: (name: string, filePath: string) => Promise<void> | void;
    afterFileOpen?: (name: string, filePath: string) => Promise<void> | void;
    afterFileRead?: (name: string, filePath: string) => Promise<void> | void;
    beforeFinalVerify?: () => Promise<void> | void;
    beforeFileClose?: (fh: FileHandle) => Promise<void> | void;
    fdRelativeBase?: (fh: FileHandle) => string | null;
  };
}

// Verify the tracked README sub-range fixture inputs are regular files inside
// `fixtures/media-subrange-input/` and byte-for-byte match the canonical content.
// The read uses a project-root O_NOFOLLOW directory-fd walk, fd-relative leaf open,
// and a leaf+parent identity barrier so that symlink / same-bytes-different-inode /
// parent ABA / post-verification swaps are rejected deterministically. This path
// never writes the inputs.
export async function verifyMediaSubrangeInputFixtures(
  base: string,
  blackMp4Hash: string,
  dejavuHash: string,
  options?: VerifyMediaSubrangeInputFixturesOptions,
): Promise<string[]> {
  const projectRoot = resolve(base);
  const expectedFiles = buildMediaSubrangeInputFixtures(blackMp4Hash, dejavuHash);
  const results: string[] = [];

  const handles: FileHandle[] = [];
  const leafFhs: FileHandle[] = [];
  const leafStats: Stats[] = [];
  const leafNames: string[] = [];

  let processingError: unknown;
  try {
    const rootFh = await open(projectRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    handles.push(rootFh);
    await verifyDirLocation(rootFh, projectRoot, projectRoot);

    const dirParts = ['fixtures', 'media-subrange-input'];
    let currentPath = projectRoot;
    let dirFh = rootFh;
    for (const comp of dirParts) {
      await options?.__testHooks?.beforeDirOpen?.(comp, currentPath);
      const nextPath = resolve(currentPath, comp);
      let childFh: FileHandle;
      try {
        childFh = await openAt(dirFh, comp, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, currentPath, projectRoot);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(`Media sub-range fixture input directory not found: ${comp}`);
        }
        if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK') {
          throw new Error(
            `Media sub-range fixture input directory is a symbolic link or not a directory: ${comp}`,
          );
        }
        throw new Error(
          `Media sub-range fixture input directory could not be opened: ${comp}: ${(err as Error).message}`,
        );
      }
      handles.push(childFh);
      await options?.__testHooks?.afterDirOpen?.(comp, nextPath);
      await verifyDirLocation(childFh, nextPath, projectRoot);
      dirFh = childFh;
      currentPath = nextPath;
    }

    const dirStat = await dirFh.stat();
    const fdRelativeBaseHook = options?.__testHooks?.fdRelativeBase;
    const baseFdPath = typeof fdRelativeBaseHook === 'function' ? fdRelativeBaseHook(dirFh) : fdRelativeBase(dirFh);
    if (!baseFdPath) {
      throw new Error(
        'fd-relative directory primitives are not available on this platform; cannot verify media-subrange-input fixtures',
      );
    }

    for (const { name, bytes } of expectedFiles) {
      const filePath = join(currentPath, name);
      await options?.__testHooks?.beforeFileLstat?.(name, filePath);

      let beforeStat: Stats | undefined;
      const leafFdPath = `${baseFdPath}/${name}`;
      const st = await lstat(leafFdPath).catch(() => null);
      if (st && st.isFile()) {
        beforeStat = st;
      }

      await options?.__testHooks?.beforeFileOpen?.(name, filePath);

      let fh: FileHandle;
      try {
        fh = await openAt(dirFh, name, O_RDONLY | O_NOFOLLOW, currentPath, projectRoot);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(`Media sub-range fixture input file not found: ${name}`);
        }
        if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK') {
          throw new Error(`Media sub-range fixture input is a symbolic link or not a regular file: ${name}`);
        }
        throw new Error(
          `Media sub-range fixture input could not be opened: ${name}: ${(err as Error).message}`,
        );
      }
      handles.push(fh);
      leafFhs.push(fh);
      leafNames.push(name);

      const stat = await fh.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Media sub-range fixture input is not a regular file with a single link: ${name}`);
      }
      if (beforeStat && !statsEqual(stat, beforeStat)) {
        throw new Error(`Media sub-range fixture input was replaced between stat and open: ${name}`);
      }

      await options?.__testHooks?.afterFileOpen?.(name, filePath);

      const readBuffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const toRead = Math.min(CHUNK_SIZE, stat.size - offset);
        const { bytesRead } = await fh.read(readBuffer, offset, toRead, offset);
        if (bytesRead === 0) {
          throw new Error(`Media sub-range fixture input shrank during read: ${name}`);
        }
        offset += bytesRead;
      }
      const eofBuf = Buffer.alloc(1);
      const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, stat.size);
      if (eofRead !== 0) {
        throw new Error(`Media sub-range fixture input grew during read: ${name}`);
      }

      if (!readBuffer.equals(bytes)) {
        throw new Error(`Media sub-range fixture input does not match canonical bytes: ${name}`);
      }

      await options?.__testHooks?.afterFileRead?.(name, filePath);

      const statAfter = await fh.stat();
      if (!statAfter.isFile() || statAfter.nlink !== 1 || !statsEqual(statAfter, stat)) {
        throw new Error(`Media sub-range fixture input changed during read: ${name}`);
      }

      const pathStatAfter = await lstat(leafFdPath).catch(() => null);
      if (
        !pathStatAfter ||
        !pathStatAfter.isFile() ||
        pathStatAfter.nlink !== 1 ||
        !statsEqual(pathStatAfter, statAfter)
      ) {
        throw new Error(`Media sub-range fixture input pathname identity diverged after read: ${name}`);
      }

      const real = await realpath(filePath).catch(() => null);
      const parentRealpath = await realpath(currentPath).catch(() => null);
      if (!real || !parentRealpath || dirname(real) !== parentRealpath) {
        throw new Error(`Media sub-range fixture input is not directly inside its parent directory: ${name}`);
      }
      if (!isInside(projectRoot, real) || !isInside(projectRoot, parentRealpath)) {
        throw new Error(`Media sub-range fixture input escaped project root: ${name}`);
      }

      leafStats.push(statAfter);
      results.push(filePath);
    }

    await options?.__testHooks?.beforeFinalVerify?.();

    const dirStatAfter = await dirFh.stat();
    if (!statsEqual(dirStatAfter, dirStat)) {
      throw new Error(`Media sub-range fixture input directory identity changed during verification`);
    }

    await verifyDirLocation(dirFh, currentPath, projectRoot);

    for (let i = 0; i < leafNames.length; i++) {
      const name = leafNames[i];
      const leafFh = leafFhs[i];
      const expectedStat = leafStats[i];

      const finalStat = await leafFh.stat();
      if (!finalStat.isFile() || finalStat.nlink !== 1 || !statsEqual(finalStat, expectedStat)) {
        throw new Error(`Media sub-range fixture input identity changed after read: ${name}`);
      }

      const leafFdPath = `${baseFdPath}/${name}`;
      const finalPathStat = await lstat(leafFdPath).catch(() => null);
      if (
        !finalPathStat ||
        !finalPathStat.isFile() ||
        finalPathStat.nlink !== 1 ||
        !statsEqual(finalPathStat, expectedStat)
      ) {
        throw new Error(`Media sub-range fixture input pathname diverged at final verify: ${name}`);
      }
    }

    return results.sort();
  } catch (err) {
    processingError = err;
    throw err;
  } finally {
    const closeErrors: unknown[] = [];
    for (const h of handles.slice().reverse()) {
      try {
        await options?.__testHooks?.beforeFileClose?.(h);
      } catch {
        // test hook errors are not cleanup failures
      }
      try {
        await h.close();
      } catch (closeErr) {
        closeErrors.push(closeErr);
      }
    }
    if (closeErrors.length > 0) {
      if (processingError) {
        throw new AggregateError(
          [processingError, ...closeErrors],
          'processing failed and cleanup failed for media-subrange-input fixtures',
        );
      }
      throw new AggregateError(closeErrors, 'cleanup failed for media-subrange-input fixtures');
    }
  }
}

export async function generateFixtures(root?: string): Promise<void> {
  const base = root ?? resolve(fileURLToPath(new URL('..', import.meta.url)));
  const fixturesDir = join(base, 'fixtures');
  const outputDir = join(base, 'output');
  const fontsDir = join(base, 'fonts');

  await mkdir(fixturesDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(fontsDir, { recursive: true });

  const jobs: string[][] = [
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=1080x1920:d=1',
      '-frames:v',
      '1',
      join(fixturesDir, 'image.png'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=5',
      join(fixturesDir, 'audio.mp3'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'audio-440.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=5',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'bgm-880.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.49*sin(2*PI*440*t):s=48000:c=stereo:d=5',
      join(fixturesDir, 'loud-main.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.49*sin(2*PI*880*t):s=48000:c=stereo:d=5',
      join(fixturesDir, 'loud-bgm.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(between(t\\,0\\,0.00045)\\,0.95*sin(2*PI*440*t)\\,0.001*sin(2*PI*440*t)):s=48000:c=stereo:d=5',
      join(fixturesDir, 'transient-main.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0:s=48000:c=stereo:d=5',
      join(fixturesDir, 'silent.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.95*sin(2*PI*440*t):s=48000:c=stereo:d=1[1]; aevalsrc=0.05*sin(2*PI*440*t):s=48000:c=stereo:d=1[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'loud-quiet-main.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.95*sin(2*PI*880*t):s=48000:c=stereo:d=1[1]; aevalsrc=0.05*sin(2*PI*880*t):s=48000:c=stereo:d=1[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'loud-quiet-bgm.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.05*sin(2*PI*440*t):s=48000:c=stereo:d=1[1]; aevalsrc=0.95*sin(2*PI*440*t):s=48000:c=stereo:d=4[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'quiet-loud-main.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.95*sin(2*PI*440*t):s=48000:c=stereo:d=1[1]; aevalsrc=0.05*sin(2*PI*440*t):s=48000:c=stereo:d=4[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'loud-quiet-5s.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.05*sin(2*PI*440*t):s=48000:c=stereo:d=3[1]; aevalsrc=0.95*sin(2*PI*440*t):s=48000:c=stereo:d=2[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      '-ac',
      '2',
      join(fixturesDir, 'quiet-loud-5s.wav'),
    ],
    [
      '-y',
      '-filter_complex',
      'aevalsrc=0.2*sin(2*PI*880*t):s=96000:c=stereo:d=1[1]; aevalsrc=0.2*sin(2*PI*1320*t):s=96000:c=stereo:d=1[2]; [1][2]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ar',
      '96000',
      '-ac',
      '2',
      join(fixturesDir, '96k-bgm.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.1*sin(2*PI*880*t):s=44100:c=stereo:d=5',
      '-ac',
      '2',
      join(fixturesDir, '44100-bgm.wav'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=1080x1920:r=30:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      '-an',
      join(fixturesDir, 'video.mp4'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=1080x1920',
      '-frames:v',
      '1',
      join(fixturesDir, 'red.png'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1080x1920',
      '-frames:v',
      '1',
      join(fixturesDir, 'blue.png'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=1080x1920:r=30:d=5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      '-an',
      join(fixturesDir, 'red.mp4'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=1080x1920:r=30:d=5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      '-an',
      join(fixturesDir, 'blue.mp4'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1080x1920',
      '-frames:v',
      '1',
      join(fixturesDir, 'black.png'),
    ],
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1080x1920:r=30:d=5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      '-an',
      join(fixturesDir, 'black.mp4'),
    ],
  ];

  for (const args of jobs) {
    await execFileAsync('ffmpeg', args);
  }

  // Copy approved system fonts into the project-local font root so that
  // font selection is deterministic and can be pinned by SHA-256.
  await prepareFonts(base);

  const dejavuHash = await sha256File(join(fontsDir, 'DejaVuSans.ttf'));

  const blackMp4Path = join(fixturesDir, 'black.mp4');
  const blackMp4Hash = await sha256File(blackMp4Path);

  // Verify the README sub-range fixture inputs are tracked canonical files
  // that match the regenerated black.mp4 hash/segment IDs. Fail closed on any
  // mismatch, symlink, or missing file; this path never writes the inputs.
  await verifyMediaSubrangeInputFixtures(base, blackMp4Hash, dejavuHash);

  // Generate deterministic transcript fixture inputs bound to the regenerated black.mp4.
  // This keeps the README transcript CLI path reproducible after fixture regeneration.
  const blackSegmentId = computeSegmentId({
    assetContentId: blackMp4Hash,
    relativePath: 'black.mp4',
    mediaType: 'video',
    start: 0,
    end: 5,
    duration: 5,
    schemaVersion: 'v1',
  });

  const transcriptMediaSegmentManifest: MediaSegmentManifest = {
    schemaVersion: 'v1',
    count: 1,
    excludedCount: 0,
    excluded: [],
    segments: [
      {
        segmentId: blackSegmentId,
        assetContentId: blackMp4Hash,
        relativePath: 'black.mp4',
        mediaType: 'video',
        start: 0,
        end: 5,
        duration: 5,
      },
    ],
  };

  const transcriptSource: TranscriptSource = {
    schemaVersion: 'v1',
    entries: [
      {
        segmentId: blackSegmentId,
        start: 0.5,
        end: 2,
        text: 'Hello',
        speaker: 'A',
        confidence: 0.95,
      },
      {
        segmentId: blackSegmentId,
        start: 2,
        end: 4,
        text: 'world',
      },
    ],
  };

  await writeFile(
    join(fixturesDir, 'transcript-media-segments.json'),
    JSON.stringify(transcriptMediaSegmentManifest, null, 2) + '\n',
  );
  await writeFile(
    join(fixturesDir, 'transcript-source.json'),
    JSON.stringify(transcriptSource, null, 2) + '\n',
  );

  // Deterministic selection and style fixtures for the README transcript-subtitle CLI path.
  await writeFile(
    join(fixturesDir, 'transcript-selection.json'),
    JSON.stringify({ segmentIds: [blackSegmentId] }, null, 2) + '\n',
  );
  await writeFile(
    join(fixturesDir, 'transcript-subtitle-style.json'),
    JSON.stringify(
      {
        font: 'DejaVuSans.ttf',
        fontHash: dejavuHash,
        x: 540,
        y: 1500,
        fontSize: 100,
      },
      null,
      2,
    ) + '\n',
  );

  // Multi-clip transcript fixture set for the additional multi-clip subtitle route.
  // This uses two distinct source assets to remain within the KER-313 v1 full-range
  // segment contract.  Same-asset multi-segment requires the sub-range foundation
  // that is out of KER-318 scope (see PR discussion).
  const redMp4Path = join(fixturesDir, 'red.mp4');
  const blueMp4Path = join(fixturesDir, 'blue.mp4');
  const redMp4Hash = await sha256File(redMp4Path);
  const blueMp4Hash = await sha256File(blueMp4Path);
  const redSegmentId = computeSegmentId({
    assetContentId: redMp4Hash,
    relativePath: 'red.mp4',
    mediaType: 'video',
    start: 0,
    end: 5,
    duration: 5,
    schemaVersion: 'v1',
  });
  const blueSegmentId = computeSegmentId({
    assetContentId: blueMp4Hash,
    relativePath: 'blue.mp4',
    mediaType: 'video',
    start: 0,
    end: 5,
    duration: 5,
    schemaVersion: 'v1',
  });

  const multiMediaManifest: MediaSegmentManifest = {
    schemaVersion: 'v1',
    count: 2,
    excludedCount: 0,
    excluded: [],
    segments: [
      {
        segmentId: redSegmentId,
        assetContentId: redMp4Hash,
        relativePath: 'red.mp4',
        mediaType: 'video',
        start: 0,
        end: 5,
        duration: 5,
      },
      {
        segmentId: blueSegmentId,
        assetContentId: blueMp4Hash,
        relativePath: 'blue.mp4',
        mediaType: 'video',
        start: 0,
        end: 5,
        duration: 5,
      },
    ],
  };

  const multiSource: TranscriptSource = {
    schemaVersion: 'v1',
    entries: [
      {
        segmentId: redSegmentId,
        start: 0,
        end: 1,
        text: 'First',
      },
      {
        segmentId: redSegmentId,
        start: 1.5,
        end: 2,
        text: 'red',
      },
      {
        segmentId: blueSegmentId,
        start: 0,
        end: 1,
        text: 'second',
      },
      {
        segmentId: blueSegmentId,
        start: 1.5,
        end: 2,
        text: 'clip',
      },
    ],
  };

  const multiMediaManifestPath = join(fixturesDir, 'transcript-media-segments-multi.json');
  const multiSourcePath = join(fixturesDir, 'transcript-source-multi.json');
  await writeFile(multiMediaManifestPath, JSON.stringify(multiMediaManifest, null, 2) + '\n');
  await writeFile(multiSourcePath, JSON.stringify(multiSource, null, 2) + '\n');

  const multiMediaSha = await sha256File(multiMediaManifestPath);
  const multiSourceText = await readFile(multiSourcePath, 'utf8');
  const multiSourceSha = createHash('sha256').update(multiSourceText).digest('hex');
  const multiManifest = buildTranscriptManifest({
    mediaSegmentManifest: multiMediaManifest,
    mediaSegmentManifestIdentifier: 'fixtures/transcript-media-segments-multi.json',
    mediaSegmentManifestSha256: multiMediaSha,
    transcriptSource: multiSource,
    transcriptSourceIdentifier: 'fixtures/transcript-source-multi.json',
    transcriptSourceSha256: multiSourceSha,
  });

  await writeFile(
    join(fixturesDir, 'transcript-manifest-multi.json'),
    JSON.stringify(multiManifest, null, 2) + '\n',
  );
  await writeFile(
    join(fixturesDir, 'transcript-selection-multi.json'),
    JSON.stringify({ segmentIds: [redSegmentId, blueSegmentId] }, null, 2) + '\n',
  );

  // Generate the multi-clip subtitled Timeline JSON deterministically.
  // Never remove an existing published output; fail closed on foreign content.
  // publishAtomicNoReplace uses an anonymous O_TMPFILE and only links it when
  // the final path does not already exist, so there is no named temp file to
  // clean up and the final-pathname TOCTOU surface described in review #4837679983
  // is eliminated.  We pre-check an existing final with O_NOFOLLOW to reject
  // symlinks/hard-links before attempting the publish barrier.
  const finalOutputRel = 'timelines/subtitled-multi.json';
  const finalOutputPath = join(outputDir, 'timelines', 'subtitled-multi.json');
  if (existsSync(finalOutputPath)) {
    await safeReadFinalOutput(finalOutputPath);
    try {
      await generateAndWriteSubtitleTimeline({
        projectRoot: base,
        inputRoot: fixturesDir,
        mediaManifestRel: 'fixtures/transcript-media-segments-multi.json',
        selectionRel: 'fixtures/transcript-selection-multi.json',
        transcriptManifestRel: 'fixtures/transcript-manifest-multi.json',
        styleRel: 'fixtures/transcript-subtitle-style.json',
        outputRel: finalOutputRel,
        fontsDir,
        allowExistingFinal: true,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = String((err as Error).message ?? '');
      if (code === 'OUTPUT_COLLISION' || /output already exists|already exists/i.test(msg)) {
        const finalRead = await safeReadFinalOutput(finalOutputPath);
        const existingSha = createHash('sha256').update(finalRead.bytes).digest('hex');
        throw new Error(
          `Fixture output collision: ${finalOutputRel} already exists with different content (existing=${existingSha})`,
        );
      }
      throw err;
    }
  } else {
    await generateAndWriteSubtitleTimeline({
      projectRoot: base,
      inputRoot: fixturesDir,
      mediaManifestRel: 'fixtures/transcript-media-segments-multi.json',
      selectionRel: 'fixtures/transcript-selection-multi.json',
      transcriptManifestRel: 'fixtures/transcript-manifest-multi.json',
      styleRel: 'fixtures/transcript-subtitle-style.json',
      outputRel: finalOutputRel,
      fontsDir,
      allowExistingFinal: true,
    });
  }

  const timeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'video.mp4',
    background: '1a1a2e',
    clips: [
      {
        type: 'image',
        source: 'image.png',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: 'audio.mp3',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
      },
    ],
  };

  await writeFile(join(fixturesDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');

  const subtitleTimeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'subtitled.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: 3,
        in: 0,
        out: 3,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: 'audio.mp3',
        start: 0,
        end: 3,
        in: 0,
        out: 3,
      },
    ],
    font: 'DejaVuSans.ttf',
    fontHash: dejavuHash,
    subtitles: [
      {
        start: 0.5,
        end: 1.0,
        text: 'Hello',
        x: 540,
        y: 1500,
        fontSize: 100,
      },
      {
        start: 1.5,
        end: 2.0,
        text: 'World',
        x: 540,
        y: 1500,
        fontSize: 100,
      },
    ],
  };

  await writeFile(
    join(fixturesDir, 'subtitles.json'),
    JSON.stringify(subtitleTimeline, null, 2) + '\n',
  );

  const bgmTimeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'bgm.mp4',
    background: '000000',
    clips: [
      {
        type: 'image',
        source: 'black.png',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
        fit: 'cover',
      },
      {
        type: 'audio',
        source: 'audio-440.wav',
        start: 0,
        end: 5,
        in: 0,
        out: 5,
      },
    ],
    bgm: {
      source: 'bgm-880.wav',
      start: 0,
      in: 0,
      out: 2,
      volume: 0.5,
    },
  };

  await writeFile(join(fixturesDir, 'bgm.json'), JSON.stringify(bgmTimeline, null, 2) + '\n');

  const transitionsTimeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'transitions.mp4',
    background: '000000',
    clips: [
      { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
      { type: 'video', source: 'blue.mp4', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      { type: 'image', source: 'black.png', start: 4, end: 6, in: 0, out: 2, fit: 'cover' },
      { type: 'audio', source: 'audio.mp3', start: 0, end: 5, in: 0, out: 5 },
    ],
    transitions: [
      { type: 'crossfade', duration: 0.5 },
      { type: 'crossfade', duration: 0.5 },
    ],
  };

  await writeFile(
    join(fixturesDir, 'transitions.json'),
    JSON.stringify(transitionsTimeline, null, 2) + '\n',
  );

  const ipagothicPath = join(fontsDir, 'IPAGothic.ttf');
  const ipagothicHash = existsSync(ipagothicPath) ? await sha256File(ipagothicPath) : '';

  const integrationTimeline = {
    width: 1080,
    height: 1920,
    fps: 30,
    outputPath: 'pipeline-e2e.mp4',
    outputPreset: 'final',
    background: '000000',
    clips: [
      { type: 'image', source: 'red.png', start: 0, end: 2, in: 0, out: 2, fit: 'cover' },
      { type: 'video', source: 'blue.mp4', start: 2, end: 4, in: 0, out: 2, fit: 'cover' },
      { type: 'image', source: 'black.png', start: 4, end: 6, in: 0, out: 2, fit: 'cover' },
      { type: 'audio', source: 'audio-440.wav', start: 0, end: 5, in: 0, out: 5 },
    ],
    bgm: {
      source: 'bgm-880.wav',
      start: 0,
      in: 0,
      out: 2,
      volume: 0.5,
    },
    subtitles: [
      { start: 0.5, end: 1.0, text: 'Hello', x: 540, y: 1500, fontSize: 100 },
      { start: 3.5, end: 4.0, text: 'World', x: 540, y: 1500, fontSize: 100 },
    ],
    font: 'DejaVuSans.ttf',
    fontHash: dejavuHash,
    transitions: [
      { type: 'crossfade', duration: 0.5 },
      { type: 'crossfade', duration: 0.5 },
    ],
  };

  await writeFile(
    join(fixturesDir, 'pipeline-e2e.json'),
    JSON.stringify(integrationTimeline, null, 2) + '\n',
  );

  // Intentionally unused hash for future font-invariant assertions.
  void ipagothicHash;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateFixtures();
}