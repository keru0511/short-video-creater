import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteSubtitleTimeline } from './transcript-subtitle-timeline.js';

function printUsage(): void {
  console.error(
    'Usage: npx tsx src/transcript-subtitle-timeline-cli.ts <media-manifest-rel.json> <selection-rel.json> <transcript-manifest-rel.json> <style-rel.json> <input-dir> [output-rel.json]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 5 || args.length > 6) {
    printUsage();
    process.exit(1);
  }

  const [
    mediaManifestRel,
    selectionRel,
    transcriptManifestRel,
    styleRel,
    inputDir,
    outputRel = 'timelines/subtitled.json',
  ] = args;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
