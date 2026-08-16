import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreviousCatalog } from './catalog-diff.js';
import { buildMediaSegmentManifest, writeMediaSegmentManifest } from './media-segments.js';
import { resolveSafePath } from './core.js';

function normalizeOutputRel(outputRel: string): string {
  const normalized = outputRel.replace(/\\/g, '/');
  if (normalized === 'output' || normalized.startsWith('output/')) {
    return normalized.slice('output/'.length);
  }
  return normalized;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: npx tsx src/media-segments-cli.ts <catalog-relative.json> <input-dir> [output-relative.json]',
    );
    process.exit(1);
  }

  const [catalogRel, inputDir, rawOutputRel = 'media-segments/manifest.json'] = args;
  const outputRel = normalizeOutputRel(rawOutputRel);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

  // Resolve the catalog input path first so we can fail closed if the manifest
  // output aliases the input catalog (same path, same realpath, same inode, or
  // a hard link). This reuses the same safe-path logic as catalog-cli.
  const previousCatalogPath = resolveSafePath(root, catalogRel);

  const catalog = await loadPreviousCatalog(root, catalogRel);
  const manifest = buildMediaSegmentManifest(catalog);
  const outPath = await writeMediaSegmentManifest(
    manifest,
    root,
    outputRel,
    resolve(inputDir),
    { previousCatalogPath },
  );
  console.log(`Media segment manifest written to ${outPath} (${manifest.count} segments)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
