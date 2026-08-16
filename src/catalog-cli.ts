import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalog, writeCatalog } from './catalog.js';
import { computeCatalogDiff, loadPreviousCatalog, writeCatalogDiff } from './catalog-diff.js';
import { resolveSafePath } from './core.js';
import { verifyThumbnail } from './thumbnails.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage =
  'Usage: npx tsx src/catalog-cli.ts <input-dir> <output-relative.json>\n' +
  '       npx tsx src/catalog-cli.ts diff <previous-catalog.json> <input-dir> <output-relative.json>';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function normalizeOutputRel(outputRel: string): string {
  // Normalize all path separators to '/' first, then strip a single leading
  // 'output/' prefix. This makes the CLI behave the same on POSIX and Windows
  // regardless of whether the user types 'output/catalog.json' or
  // 'output\\catalog.json'. Strings like 'outputting/catalog.json' are left
  // untouched because the prefix requires a trailing separator.
  const normalized = outputRel.replace(/\\/g, '/');
  if (normalized === 'output' || normalized.startsWith('output/')) {
    return normalized.slice('output/'.length);
  }
  return normalized;
}

interface GenerateArgs {
  mode: 'generate';
  inputDir: string;
  outputRel: string;
}

interface DiffArgs {
  mode: 'diff';
  prevCatalogRel: string;
  inputDir: string;
  outputRel: string;
}

type CatalogArgs = GenerateArgs | DiffArgs;

function parseArgs(args: string[]): CatalogArgs {
  if (args.length >= 1 && args[0] === 'diff') {
    if (args.length !== 4) {
      throw new CliUsageError();
    }
    const [, prevCatalogRel, inputDir, rawOutputRel] = args;
    return {
      mode: 'diff',
      prevCatalogRel,
      inputDir,
      outputRel: normalizeOutputRel(rawOutputRel),
    };
  }

  if (args.length !== 2) {
    throw new CliUsageError();
  }
  const [inputDir, rawOutputRel] = args;
  return {
    mode: 'generate',
    inputDir,
    outputRel: normalizeOutputRel(rawOutputRel),
  };
}

async function generateAndWriteCatalog(inputDir: string, outputRel: string): Promise<void> {
  const inputRoot = resolve(inputDir);
  const thumbnailDir = resolve(root, 'output', 'catalog-thumbnails');

  const catalog = await generateCatalog(inputDir, {
    catalogRoot: basename(inputRoot),
    thumbnailDir,
    projectRoot: root,
  });

  // Pre-write consistency check: every thumbnail referenced by the catalog is
  // verified against its recorded SHA-256 and checked to be a regular file
  // inside the project root before we persist the JSON. This catches accidental
  // corruption and cooperative races, but it is NOT an immutable boundary
  // against a malicious same-user process that can replace the path after this
  // check completes. For adversarial same-user deployments, use separate OS
  // identities, immutable storage, or re-verify thumbnails at the actual point
  // of consumption.
  for (const asset of catalog.assets) {
    if (asset.thumbnail && !(await verifyThumbnail(root, asset.thumbnail))) {
      throw new Error(`thumbnail verification failed for ${asset.relativePath}: ${asset.thumbnail.identifier}`);
    }
  }

  const outPath = await writeCatalog(catalog, root, outputRel, inputRoot);
  console.log(`Catalog written to ${outPath} (${catalog.count} assets)`);
}

async function generateAndWriteDiff(prevCatalogRel: string, inputDir: string, outputRel: string): Promise<void> {
  const inputRoot = resolve(inputDir);
  const thumbnailDir = resolve(root, 'output', 'catalog-thumbnails');

  const previousPath = resolveSafePath(root, prevCatalogRel);
  const previous = await loadPreviousCatalog(root, prevCatalogRel);
  const current = await generateCatalog(inputDir, {
    catalogRoot: basename(inputRoot),
    thumbnailDir,
    projectRoot: root,
  });
  const diff = computeCatalogDiff(previous, current);
  const outPath = await writeCatalogDiff(diff, root, outputRel, inputRoot, {
    previousCatalogPath: previousPath,
  });
  console.log(`Catalog diff written to ${outPath}`);
}

async function main(args: CatalogArgs): Promise<void> {
  if (args.mode === 'diff') {
    await generateAndWriteDiff(args.prevCatalogRel, args.inputDir, args.outputRel);
    return;
  }
  await generateAndWriteCatalog(args.inputDir, args.outputRel);
}

runCli({ argv: process.argv, parseArgs, main, usage });
