import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMediaPreviews } from './media-preview.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx src/media-preview-cli.ts <catalog-json> <asset-root>');
    process.exit(1);
  }

  const [catalogPath, assetRoot] = args;
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

  const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot });
  const failed = manifest.summary.failed;
  console.log(`Previews written to ${manifest.previewRoot}`);
  console.log(`  canonical manifest: ${manifest.canonicalPath} (${manifest.canonicalSha256})`);
  console.log(`  run metadata: ${manifest.runPath}`);
  console.log(`  ${manifest.summary.succeeded} succeeded, ${failed} failed`);
  if (failed > 0) {
    console.error(`${failed} preview(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
