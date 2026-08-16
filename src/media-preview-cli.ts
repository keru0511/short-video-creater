import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMediaPreviews } from './media-preview.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage = 'Usage: npx tsx src/media-preview-cli.ts <catalog-json> <asset-root>';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(args: string[]): { catalogPath: string; assetRoot: string } {
  if (args.length < 2) {
    throw new CliUsageError();
  }
  return { catalogPath: args[0], assetRoot: args[1] };
}

async function main({ catalogPath, assetRoot }: { catalogPath: string; assetRoot: string }): Promise<void> {
  const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: root });
  const failed = manifest.summary.failed;
  console.log(`Previews written to ${manifest.previewRoot}`);
  console.log(`  canonical manifest: ${manifest.canonicalPath} (${manifest.canonicalSha256})`);
  console.log(`  run metadata: ${manifest.runPath}`);
  console.log(`  ${manifest.summary.succeeded} succeeded, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`${failed} preview(s) failed`);
  }
}

runCli({ argv: process.argv, parseArgs, main, usage });
