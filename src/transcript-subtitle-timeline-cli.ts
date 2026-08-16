import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteSubtitleTimeline } from './transcript-subtitle-timeline.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage =
  'Usage: npx tsx src/transcript-subtitle-timeline-cli.ts <media-manifest-rel.json> <selection-rel.json> <transcript-manifest-rel.json> <style-rel.json> <input-dir> [output-rel.json]';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface SubtitleTimelineArgs {
  mediaManifestRel: string;
  selectionRel: string;
  transcriptManifestRel: string;
  styleRel: string;
  inputDir: string;
  outputRel: string;
}

function parseArgs(args: string[]): SubtitleTimelineArgs {
  if (args.length < 5 || args.length > 6) {
    throw new CliUsageError();
  }
  const [
    mediaManifestRel,
    selectionRel,
    transcriptManifestRel,
    styleRel,
    inputDir,
    outputRel = 'timelines/subtitled.json',
  ] = args;
  return { mediaManifestRel, selectionRel, transcriptManifestRel, styleRel, inputDir, outputRel };
}

async function main({
  mediaManifestRel,
  selectionRel,
  transcriptManifestRel,
  styleRel,
  inputDir,
  outputRel,
}: SubtitleTimelineArgs): Promise<void> {
  const result = await generateAndWriteSubtitleTimeline({
    projectRoot: root,
    inputRoot: resolve(inputDir),
    mediaManifestRel,
    selectionRel,
    transcriptManifestRel,
    styleRel,
    outputRel,
  });

  console.log(`Subtitle Timeline JSON written to ${result.outputPath}`);
  console.log(`Timeline video output path: ${result.timeline.outputPath}`);
  console.log(`Timeline SHA-256: ${result.timelineSha256}`);
  console.log(`Media manifest SHA-256: ${result.manifestSha256}`);
  console.log(`Selection SHA-256: ${result.selectionSha256}`);
  console.log(`Transcript manifest SHA-256: ${result.transcriptManifestSha256}`);
  console.log(`Style SHA-256: ${result.styleSha256}`);
}

runCli({ argv: process.argv, parseArgs, main, usage });
