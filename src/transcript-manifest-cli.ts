import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAndWriteTranscriptManifest, normalizeTranscriptOutputRel } from './transcript-manifest.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      'Usage: npx tsx src/transcript-manifest-cli.ts <media-segments-manifest-rel.json> <transcript-source-rel.json> <input-dir> [output-relative.json]',
    );
    process.exit(1);
  }

  const [mediaManifestRel, transcriptSourceRel, inputDir, rawOutputRel = 'transcripts/manifest.json'] = args;
  const outputRel = normalizeTranscriptOutputRel(rawOutputRel);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

  const { outputPath, manifest } = await generateAndWriteTranscriptManifest({
    projectRoot: root,
    inputRoot: resolve(inputDir),
    mediaSegmentManifestRel: mediaManifestRel,
    transcriptSourceRel: transcriptSourceRel,
    outputRel,
  });

  console.log(`Transcript manifest written to ${outputPath} (${manifest.count} utterances)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
