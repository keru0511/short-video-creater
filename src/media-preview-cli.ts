import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMediaPreviews } from './media-preview.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage = 'Usage: npx tsx src/media-preview-cli.ts [--project-root <dir>] <catalog-json> <asset-root>';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(args: string[]): { catalogPath: string; assetRoot: string; projectRoot?: string } {
  let projectRoot: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project-root') {
      projectRoot = args[++i];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    }
    positional.push(arg);
  }
  if (positional.length < 2) {
    throw new CliUsageError();
  }
  return { catalogPath: positional[0], assetRoot: positional[1], projectRoot };
}

async function main({ catalogPath, assetRoot, projectRoot }: { catalogPath: string; assetRoot: string; projectRoot?: string }): Promise<void> {
  const manifest = await generateMediaPreviews(catalogPath, assetRoot, { projectRoot: projectRoot ?? root });
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
