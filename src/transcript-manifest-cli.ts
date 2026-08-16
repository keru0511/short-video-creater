import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteTranscriptManifest, normalizeTranscriptOutputRel } from './transcript-manifest.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage =
  'Usage: npx tsx src/transcript-manifest-cli.ts <media-segments-manifest-rel.json> <transcript-source-rel.json> <input-dir> [output-relative.json]';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface TranscriptManifestArgs {
  mediaManifestRel: string;
  transcriptSourceRel: string;
  inputDir: string;
  outputRel: string;
}

function parseArgs(args: string[]): TranscriptManifestArgs {
  if (args.length < 3) {
    throw new CliUsageError();
  }
  const [mediaManifestRel, transcriptSourceRel, inputDir, rawOutputRel = 'transcripts/manifest.json'] = args;
  const outputRel = normalizeTranscriptOutputRel(rawOutputRel);
  return { mediaManifestRel, transcriptSourceRel, inputDir, outputRel };
}

async function main({ mediaManifestRel, transcriptSourceRel, inputDir, outputRel }: TranscriptManifestArgs): Promise<void> {
  const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
    projectRoot: root,
    inputRoot: resolve(inputDir),
    mediaSegmentManifestRel: mediaManifestRel,
    transcriptSourceRel,
    outputRel,
  });

  console.log(`Transcript manifest written to ${outputPath} (${manifest.count} utterances)`);
}

runCli({ argv: process.argv, parseArgs, main, usage });
