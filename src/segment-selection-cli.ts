import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteTimeline } from './segment-selection.js';

function printUsage(): void {
  console.error(
    'Usage: npx tsx src/segment-selection-cli.ts <manifest-relative.json> <selection-relative.json> <input-dir> [output-relative.json]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    printUsage();
    process.exit(1);
  }

  const [manifestRel, selectionRel, inputDir, outputRel = 'timelines/selection.json'] = args;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

  const result = await generateAndWriteTimeline({
    projectRoot: root,
    manifestRel,
    selectionRel,
    inputRoot: resolve(inputDir),
    outputRel,
  });

  console.log(`Timeline JSON written to ${result.outputPath}`);
  console.log(`Timeline video output path: ${result.timeline.outputPath}`);
  console.log(`Timeline SHA-256: ${result.timelineSha256}`);
  console.log(`Input manifest SHA-256: ${result.manifestSha256}`);
  console.log(`Input selection SHA-256: ${result.selectionSha256}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
