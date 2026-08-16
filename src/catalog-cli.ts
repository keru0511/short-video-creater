import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalog, writeCatalog } from './catalog.js';
import { computeCatalogDiff, loadPreviousCatalog, writeCatalogDiff } from './catalog-diff.js';
import { resolveSafePath } from './core.js';
import { verifyThumbnail } from './thumbnails.js';

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

async function generateAndWriteCatalog(inputDir: string, rawOutputRel: string): Promise<void> {
  const outputRel = normalizeOutputRel(rawOutputRel);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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

async function generateAndWriteDiff(
  prevCatalogRel: string,
  inputDir: string,
  rawOutputRel: string,
): Promise<void> {
  const outputRel = normalizeOutputRel(rawOutputRel);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const inputRoot = resolve(inputDir);
  const thumbnailDir = resolve(root, 'output', 'catalog-thumbnails');

  // Resolve the previous catalog path first, and pass it to the writer so we
  // can fail closed if the output path aliases the previous catalog (same path,
  // same realpath, same inode, or a hard link).
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length >= 1 && args[0] === 'diff') {
    if (args.length < 4) {
      console.error(
        'Usage: npx tsx src/catalog-cli.ts diff <previous-catalog.json> <input-dir> <output-relative.json>',
      );
      process.exit(1);
    }
    const [, prevCatalogRel, inputDir, rawOutputRel] = args;
    await generateAndWriteDiff(prevCatalogRel, inputDir, rawOutputRel);
    return;
  }

  if (args.length < 2) {
    console.error('Usage: npx tsx src/catalog-cli.ts <input-dir> <output-relative.json>');
    process.exit(1);
  }

  const [inputDir, rawOutputRel] = args;
  await generateAndWriteCatalog(inputDir, rawOutputRel);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
