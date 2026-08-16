import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteMediaSubrangeManifest } from './media-subranges.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    console.error(
      'Usage: npx tsx src/media-subranges-cli.ts <range-request-rel.json> <catalog-rel.json> <input-dir> [output-rel.json]',
    );
    process.exit(1);
  }

  const [rangeRequestRel, catalogRel, inputDir, outputRel = 'media-subranges/manifest.json'] = args;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

  const { manifest, outputPath } = await generateAndWriteMediaSubrangeManifest({
    projectRoot: root,
    inputRoot: resolve(inputDir),
    catalogRel,
    rangeRequestRel,
    outputRel,
  });

  console.log(`Media subrange manifest written to ${outputPath} (${manifest.count} segments, ${manifest.excludedCount} excluded)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
