import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteMediaSubrangeManifest } from './media-subranges.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage =
  'Usage: npx tsx src/media-subranges-cli.ts <range-request-rel.json> <catalog-rel.json> <input-dir> [output-rel.json]';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface MediaSubrangesArgs {
  rangeRequestRel: string;
  catalogRel: string;
  inputDir: string;
  outputRel: string;
}

function parseArgs(args: string[]): MediaSubrangesArgs {
  if (args.length < 3 || args.length > 4) {
    throw new CliUsageError();
  }
  const [rangeRequestRel, catalogRel, inputDir, outputRel = 'media-subranges/manifest.json'] = args;
  return { rangeRequestRel, catalogRel, inputDir, outputRel };
}

async function main({ rangeRequestRel, catalogRel, inputDir, outputRel }: MediaSubrangesArgs): Promise<void> {
  const { manifest, outputPath } = await generateAndWriteMediaSubrangeManifest({
    projectRoot: root,
    inputRoot: resolve(inputDir),
    catalogRel,
    rangeRequestRel,
    outputRel,
  });

  console.log(
    `Media subrange manifest written to ${outputPath} (${manifest.count} segments, ${manifest.excludedCount} excluded)`,
  );
}

runCli({ argv: process.argv, parseArgs, main, usage });
