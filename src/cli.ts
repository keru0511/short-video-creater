import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, ffprobe, resolveSafePath } from './core.js';
import { ensureTrustedDirectory, getErrorMessage, maskErrorMessage, prepareAuditAssets, prepareJobAssetDir, writeAuditManifest, type AuditSource } from './audit.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = resolve(root, 'fixtures');
const outputDir = resolve(root, 'output');
const fontsDir = resolve(root, 'fonts');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--verify-only') {
    const file = args[1] ?? 'output/video.mp4';
    const probe = await ffprobe(resolve(root, file));
    console.log(JSON.stringify(probe, null, 2));
    return;
  }

  const timelinePath = args[0] ?? 'fixtures/timeline.json';
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  let input: unknown;

  try {
    const safeTimelinePath = resolveSafePath(root, timelinePath);
    const timelineStat = await lstat(safeTimelinePath);
    if (!timelineStat.isFile()) {
      throw new Error('Timeline path is not a regular file');
    }
    const raw = await readFile(safeTimelinePath, 'utf8');
    input = JSON.parse(raw);
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'CLI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir,
      fontsDir,
      timeline: undefined,
      error: err,
    });
    console.error('Audit job ID:', jobId);
    console.error('Audit manifest:', manifestPath);
    throw err;
  }

  const artifactDir = resolve(outputDir, 'artifacts', jobId);

  let assetInfo: Awaited<ReturnType<typeof prepareAuditAssets>> | undefined;
  try {
    await prepareJobAssetDir(artifactDir, root);
    assetInfo = await prepareAuditAssets({
      jobId,
      rootDir: root,
      outputDir,
      fixturesDir,
      fontsDir,
      timeline: input as Record<string, unknown>,
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'CLI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir,
      fontsDir,
      timeline: input as Record<string, unknown> | undefined,
      error: err,
    });
    console.error('Audit job ID:', jobId);
    console.error('Audit manifest:', manifestPath);
    throw err;
  }

  let result: Awaited<ReturnType<typeof generate>> | undefined;
  try {
    result = await generate(assetInfo.assetTimeline, {
      rootDir: root,
      fixturesDir: assetInfo.assetsDir,
      outputDir: artifactDir,
      fontsDir: assetInfo.assetsDir,
    });

    // Keep the requested outputPath usable as a stable, root-relative path
    // while the audit record points to the immutable job artifact.
    const baseOutputPath = resolveSafePath(outputDir, String(result.timeline.outputPath), {
      allowNonexistent: true,
    });
    const baseOutputParent = dirname(baseOutputPath);
    await ensureTrustedDirectory(baseOutputParent, root, true);
    const existing = await lstat(baseOutputPath).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Output destination is not a regular file');
    }
    await cp(result.outputPath, baseOutputPath, { preserveTimestamps: true, force: true });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'CLI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir: assetInfo.assetsDir,
      fontsDir: assetInfo.assetsDir,
      timeline: input as Record<string, unknown> | undefined,
      assetMap: assetInfo.assetMap,
      originalTimelineHash: assetInfo.originalTimelineHash,
      error: err,
    });
    console.error('Audit job ID:', jobId);
    console.error('Audit manifest:', manifestPath);
    throw err;
  }

  const finishedAt = new Date().toISOString();
  const manifestPath = await writeAuditManifest({
    jobId,
    source: 'CLI' as AuditSource,
    startedAt,
    finishedAt,
    rootDir: root,
    outputDir,
    fixturesDir: assetInfo.assetsDir,
    fontsDir: assetInfo.assetsDir,
    result,
    assetMap: assetInfo.assetMap,
    originalTimelineHash: assetInfo.originalTimelineHash,
  });

  console.log('Generated:', result.outputPath);
  console.log('Timeline hash:', result.timelineHash);
  console.log('FFmpeg version:', result.ffmpegVersion);
  console.log('Output preset:', result.outputPreset);
  console.log('Effective encoding settings:', JSON.stringify(result.effectiveEncoding, null, 2));
  if (result.fontFile) {
    console.log('Font family:', result.fontFamily);
    console.log('Font file:', result.fontFile);
    console.log('Font hash:', result.fontHash);
  }
  console.log('FFmpeg argv:', JSON.stringify(result.args, null, 2));
  console.log('Probe:', JSON.stringify(result.probe, null, 2));
  console.log('Source hashes:', JSON.stringify(result.sourceHashes, null, 2));
  console.log('Audit job ID:', jobId);
  console.log('Audit manifest:', manifestPath);
}

main().catch((err) => {
  console.error(maskErrorMessage(getErrorMessage(err), root));
  process.exit(1);
});
