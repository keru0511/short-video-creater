import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteTimeline } from './segment-selection.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage =
  'Usage: npx tsx src/segment-selection-cli.ts <manifest-relative.json> <selection-relative.json> <input-dir> [output-relative.json]';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface SegmentSelectionArgs {
  manifestRel: string;
  selectionRel: string;
  inputDir: string;
  outputRel: string;
}

function parseArgs(args: string[]): SegmentSelectionArgs {
  if (args.length < 3) {
    throw new CliUsageError();
  }
  const [manifestRel, selectionRel, inputDir, outputRel = 'timelines/selection.json'] = args;
  return { manifestRel, selectionRel, inputDir, outputRel };
}

async function main({ manifestRel, selectionRel, inputDir, outputRel }: SegmentSelectionArgs): Promise<void> {
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

runCli({ argv: process.argv, parseArgs, main, usage });
