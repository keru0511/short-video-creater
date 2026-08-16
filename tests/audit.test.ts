import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, link, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, sha256File, timelineHash, type Timeline } from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import { getOutputSnapshotPath, prepareAuditAssets, prepareJobAssetDir, writeAuditManifest, type AuditManifest } from '../src/audit.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const fontsDir = join(root, 'fonts');
const auditOutputDir = join(root, 'output', 'audit-run');
const auditDir = join(auditOutputDir, 'audit');
const cliAuditDir = join(root, 'output', 'audit');

beforeAll(async () => {
  await rm(auditOutputDir, { recursive: true, force: true });
  await generateFixtures(root);
}, 120000);

const manifestPathPattern = /Audit manifest: (.+)/;

async function manifestFromOutput(output: string): Promise<{ path: string; data: AuditManifest }> {
  const match = manifestPathPattern.exec(output);
  expect(match).toBeTruthy();
  const rel = match![1].trim().replace(/\\/g, '/');
  const path = resolve(root, rel);
  const data = JSON.parse(await readFile(path, 'utf8')) as AuditManifest;
  return { path, data };
}

function manifestText(manifest: AuditManifest): string {
  return JSON.stringify(manifest);
}

describe('audit manifest', () => {
  it('records a success manifest with all required fields and consistent hashes', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const startedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId: 'success-required',
      source: 'CLI',
      startedAt,
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    });

    expect(manifestPath).toMatch(/audit[/\\]success-required\.json$/);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;

    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.jobId).toBe('success-required');
    expect(manifest.source).toBe('CLI');
    expect(manifest.status).toBe('success');
    expect(typeof manifest.startedAt).toBe('string');
    expect(typeof manifest.finishedAt).toBe('string');
    expect(manifest.timelineHash).toBe(timelineHash(manifest.timeline as Timeline));
    expect(manifest.originalTimelineHash).toBe(result.timelineHash);
    expect(manifest.timeline).toBeDefined();

    const inputs = manifest.inputs;
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(input.identifier).not.toContain(root);
      expect(input.identifier).not.toMatch(/\.\./);
      expect(input.identifier).not.toMatch(/[\x00-\x1F\x7F]/);
      if (input.timelineSource) {
        expect(input.timelineSource).not.toContain(root);
        expect(input.timelineSource).not.toMatch(/\.\./);
      }
    }

    const output = manifest.output!;
    expect(existsSync(result.outputPath)).toBe(true);
    expect(output.sha256).toBe(await sha256File(result.outputPath));
    expect(output.identifier).not.toContain(root);
    expect(output.probe).toEqual(result.probe);

    const ffmpeg = manifest.ffmpeg!;
    expect(ffmpeg.version).toContain('ffmpeg version');
    expect(ffmpeg.outputPreset).toBe(result.outputPreset);
    const argvText = JSON.stringify(ffmpeg.argv);
    expect(argvText).not.toContain(root);
    expect(argvText).toContain('fixtures/image.png');
    expect(argvText).toContain('video.mp4');

    expect(manifest.error).toBeNull();
  }, 120000);

  it('sanitizes timelineSource and resolves audit identifiers to the original input files', async () => {
    const secretName = 'api_key=secret12345678.png'; // gitleaks:allow
    const shellName = 'evil;cmd.png';
    await writeFile(join(fixturesDir, secretName), await readFile(join(fixturesDir, 'image.png')));
    await writeFile(join(fixturesDir, shellName), await readFile(join(fixturesDir, 'image.png')));

    const secretHash = await sha256File(join(fixturesDir, secretName));
    const shellHash = await sha256File(join(fixturesDir, shellName));

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'sanitized.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: secretName, start: 0, end: 0.5, in: 0, out: 0.5, fit: 'cover' },
        { type: 'image', source: shellName, start: 0.5, end: 1, in: 0, out: 0.5, fit: 'cover' },
      ],
    };

    const assetInfo = await prepareAuditAssets({
      jobId: 'sanitize-source',
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: timeline as Timeline,
    });

    const result = await generate(assetInfo.assetTimeline, {
      rootDir: root,
      fixturesDir: assetInfo.assetsDir,
      outputDir: auditOutputDir,
      fontsDir: assetInfo.assetsDir,
    });

    const manifestPath = await writeAuditManifest({
      jobId: 'sanitize-source',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: assetInfo.assetsDir,
      fontsDir: assetInfo.assetsDir,
      result,
      assetMap: assetInfo.assetMap,
      originalTimelineHash: assetInfo.originalTimelineHash,
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const text = manifestText(manifest);
    expect(text).not.toContain('api_key=secret12345678'); // gitleaks:allow
    expect(text).not.toContain('evil;cmd');
    expect(text).toContain('[REDACTED]');

    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(2);

    const secretInput = visualInputs.find((i) => i.timelineSource?.includes('[REDACTED]'));
    const shellInput = visualInputs.find((i) => i.timelineSource === 'evil_cmd.png');

    expect(secretInput).toBeDefined();
    expect(shellInput).toBeDefined();

    for (const input of visualInputs) {
      const fullPath = resolve(root, input.identifier);
      expect(existsSync(fullPath)).toBe(true);
      expect(await sha256File(fullPath)).toBe(input.sha256);
    }
    expect(secretInput!.sha256).toBe(secretHash);
    expect(shellInput!.sha256).toBe(shellHash);

    if (manifest.timeline && typeof manifest.timeline === 'object') {
      const t = manifest.timeline as { clips?: { source?: string }[] };
      for (const clip of t.clips ?? []) {
        expect(clip.source).not.toContain('secret');
        expect(clip.source).not.toContain(';');
      }
    }

    // cleanup
    await rm(join(fixturesDir, secretName), { force: true });
    await rm(join(fixturesDir, shellName), { force: true });
  }, 120000);

  it('rejects API-key-like strings in subtitle text before generation', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'apikey.mp4',
      background: '000000',
      font: 'DejaVuSans.ttf',
      fontHash: await sha256File(join(fontsDir, 'DejaVuSans.ttf')),
      clips: [
        { type: 'image', source: 'black.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 1, in: 0, out: 1 },
      ],
      subtitles: [
        { start: 0.1, end: 0.5, text: 'api_key=supersecrettoken123', x: 540, y: 1500, fontSize: 100 }, // gitleaks:allow
      ],
    };

    await expect(
      generate(timeline as Timeline, {
        rootDir: root,
        fixturesDir,
        outputDir: auditOutputDir,
        fontsDir,
      }),
    ).rejects.toThrow(/secret-like/);
  }, 120000);

  it('preserves exact shell metacharacter subtitle text in success manifest and can regenerate', async () => {
    const text = "Hello; && | $ ` ><!\"'";
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'metachar.mp4',
      background: '000000',
      font: 'DejaVuSans.ttf',
      fontHash: await sha256File(join(fontsDir, 'DejaVuSans.ttf')),
      clips: [
        { type: 'image', source: 'black.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'audio', source: 'audio.mp3', start: 0, end: 1, in: 0, out: 1 },
      ],
      subtitles: [{ start: 0.1, end: 0.5, text, x: 540, y: 1500, fontSize: 100 }],
    };

    const result = await generate(timeline as Timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const manifestPath = await writeAuditManifest({
      jobId: 'metachar-exact',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.timelineHash).toBe(result.timelineHash);
    expect(manifest.timelineHash).toBe(timelineHash(manifest.timeline as Timeline));
    const manifestTimeline = manifest.timeline as { subtitles?: { text?: string }[] };
    expect(manifestTimeline.subtitles?.[0]?.text).toBe(text);

    const regenerated = await generate(manifest.timeline as Timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: resolve(auditOutputDir, 'regen'),
      fontsDir,
    });
    expect(regenerated.timelineHash).toBe(manifest.timelineHash);
  }, 120000);

  it('rejects a success manifest when the result timeline was modified after generation', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    // Clone so we can simulate a caller-side mutation; generate() now returns a deep-frozen result.
    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.timeline.outputPath = 'tampered.mp4';
    // Update the stored hash to match the mutated timeline, simulating a coordinated attack.
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'timeline-mutation',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        result: tampered,
      }),
    ).rejects.toThrow(/Timeline hash mismatch|Source hash mismatch|Probe mismatch|Output path mismatch|File not found/);
  }, 120000);

  it('rejects a success manifest when sourceHashes are modified after generation', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    const paths = Object.keys(tampered.sourceHashes);
    expect(paths.length).toBeGreaterThan(0);
    tampered.sourceHashes[paths[0]] = '0'.repeat(64);

    await expect(
      writeAuditManifest({
        jobId: 'sourcehash-mutation',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        result: tampered,
      }),
    ).rejects.toThrow(/Source hash mismatch/);
  }, 120000);

  it('rejects a success manifest when outputPath is modified after generation', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.outputPath = resolve(root, 'fixtures', 'image.png');

    await expect(
      writeAuditManifest({
        jobId: 'outputpath-mutation',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch|File not found|Probe mismatch/);
  }, 120000);

  it('records a failure manifest with stable error code and masked message', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'fail.mp4',
      background: '000000',
      clips: [],
    };

    let caught: unknown;
    try {
      await generate(timeline as Timeline, { rootDir: root, fixturesDir, outputDir: auditOutputDir, fontsDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const startedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId: 'failure-masked',
      source: 'CLI',
      startedAt,
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline,
      error: caught,
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.status).toBe('failure');
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.output).toBeNull();
    expect(manifest.ffmpeg).toBeNull();

    const error = manifest.error!;
    expect(error).toBeDefined();
    expect(error.code).toBe('TIMELINE_VALIDATION_ERROR');
    expect(error.message).not.toContain(root);
    expect(error.message).not.toMatch(/\.\./);
    expect(error.message).not.toMatch(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/);
  }, 60000);

  it('redacts absolute paths, traversal, and secrets in failure manifest', async () => {
    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: '../etc/passwd',
      background: '000000',
      clips: [
        {
          type: 'image',
          source: '/etc/passwd',
          start: 0,
          end: 1,
          in: 0,
          out: 1,
          fit: 'cover',
        },
      ],
    };

    let caught: unknown;
    try {
      await generate(timeline as Timeline, { rootDir: root, fixturesDir, outputDir: auditOutputDir, fontsDir });
    } catch (err) {
      caught = err;
    }

    const startedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId: 'adversarial-inputs',
      source: 'CLI',
      startedAt,
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline,
      error: caught,
    });

    const text = await readFile(manifestPath, 'utf8');
    expect(text).not.toContain('/etc/passwd');
    expect(text).not.toContain('../etc/passwd');
    expect(text).not.toContain(root);
    expect(text).not.toContain('api_key=secret123456789'); // gitleaks:allow
  }, 60000);

  it('refuses to overwrite an existing manifest with the same jobId', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const baseOptions = {
      jobId: 'duplicate-job',
      source: 'CLI' as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    };

    const first = await writeAuditManifest(baseOptions);
    expect(first).toMatch(/duplicate-job\.json$/);

    await expect(writeAuditManifest(baseOptions)).rejects.toThrow(/already exists/);
  }, 120000);

  it('prevents writing through a symbolic link audit directory', async () => {
    const symlinkDir = join(root, 'output', 'audit-symlink-out');
    const linkPath = join(root, 'output', 'audit-symlink-test', 'audit');
    const outputDirForSymlink = join(root, 'output', 'audit-symlink-test');
    await rm(symlinkDir, { recursive: true, force: true });
    await rm(outputDirForSymlink, { recursive: true, force: true });
    await mkdir(symlinkDir, { recursive: true });
    await mkdir(outputDirForSymlink, { recursive: true });
    await symlink(symlinkDir, linkPath);

    try {
      await expect(
        writeAuditManifest({
          jobId: 'symlink-test',
          source: 'CLI' as const,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          rootDir: root,
          outputDir: outputDirForSymlink,
          fixturesDir,
          fontsDir,
          timeline: { outputPath: 'x.mp4', clips: [] },
          error: new Error('test'),
        }),
      ).rejects.toThrow(/symbolic link|outside output boundary/);
    } finally {
      await rm(outputDirForSymlink, { recursive: true, force: true });
      await rm(symlinkDir, { recursive: true, force: true });
    }
  }, 60000);

  it('prevents concurrent writes with the same jobId from corrupting the record', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const baseOptions = {
      jobId: 'concurrent-job',
      source: 'CLI' as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    };

    const [a, b] = await Promise.allSettled([
      writeAuditManifest(baseOptions),
      writeAuditManifest(baseOptions),
    ]);
    expect([a.status, b.status].filter((s) => s === 'fulfilled').length).toBe(1);
    expect([a.status, b.status].filter((s) => s === 'rejected').length).toBe(1);
  }, 120000);

  it('CLI emits audit job id and writes manifest to output/audit', async () => {
    await rm(cliAuditDir, { recursive: true, force: true });
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', 'src/cli.ts', 'fixtures/timeline.json'], {
      cwd: root,
      env: process.env,
    });
    const output = stdout + stderr;
    expect(output).toMatch(/Audit job ID: [0-9a-f-]{36}/);
    expect(output).toMatch(/Audit manifest: .*output[/\\]audit[/\\][0-9a-f-]+\.json/);

    const manifest = await manifestFromOutput(output);
    expect(manifest.data.status).toBe('success');
    expect(manifest.data.source).toBe('CLI');
    const jobIdMatch = output.match(/Audit job ID: ([0-9a-f-]{36})/);
    expect(manifest.data.jobId).toBe(jobIdMatch?.[1]);

    const manifestText = JSON.stringify(manifest.data);
    expect(manifestText).not.toContain(root);
  }, 180000);

  it('CLI records a failure manifest for a missing timeline file', async () => {
    await rm(cliAuditDir, { recursive: true, force: true });
    let output = '';
    let exitCode = 0;
    try {
      await execFileAsync('npx', ['tsx', 'src/cli.ts', 'fixtures/does-not-exist.json'], {
        cwd: root,
        env: process.env,
      });
    } catch (err: any) {
      exitCode = err.code ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/Audit job ID: [0-9a-f-]{36}/);
    expect(output).toMatch(/Audit manifest: .*output[/\\]audit[/\\][0-9a-f-]+\.json/);
    expect(output).not.toContain(root);

    const manifest = await manifestFromOutput(output);
    expect(manifest.data.status).toBe('failure');
    expect(manifest.data.source).toBe('CLI');
    expect(manifest.data.error?.code).toBe('SOURCE_NOT_FOUND');
  }, 120000);

  it('CLI records a failure manifest for a malformed JSON timeline', async () => {
    await rm(cliAuditDir, { recursive: true, force: true });
    const badRelPath = 'output/malformed-timeline.json';
    const badPath = join(root, badRelPath);
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(badPath, 'not json');

    let output = '';
    let exitCode = 0;
    try {
      await execFileAsync('npx', ['tsx', 'src/cli.ts', badRelPath], {
        cwd: root,
        env: process.env,
      });
    } catch (err: any) {
      exitCode = err.code ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/Audit job ID: [0-9a-f-]{36}/);
    expect(output).toMatch(/Audit manifest: .*output[/\\]audit[/\\][0-9a-f-]+\.json/);

    const manifest = await manifestFromOutput(output);
    expect(manifest.data.status).toBe('failure');
    expect(manifest.data.source).toBe('CLI');
    expect(manifest.data.error?.code).toBe('TIMELINE_VALIDATION_ERROR');
    expect(manifest.data.error?.message).not.toContain(root);

    await rm(badPath, { force: true });
  }, 120000);

  it('CLI rejects absolute, traversal, symlink, and non-file timeline paths with a failure manifest', async () => {
    await rm(cliAuditDir, { recursive: true, force: true });
    await rm(join(root, 'output', 'cli-path-tests'), { recursive: true, force: true });
    const testDir = join(root, 'output', 'cli-path-tests');
    const validTimeline = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8')) as Timeline;
    const validJson = JSON.stringify(validTimeline);

    const absolutePath = join(testDir, 'abs.json');
    const traversalPath = 'output/cli-path-tests/../abs.json';
    const symlinkName = 'link.json';
    const symlinkPath = `output/cli-path-tests/${symlinkName}`;
    const dirPath = 'output/cli-path-tests/dir.json';

    await mkdir(testDir, { recursive: true });
    await writeFile(absolutePath, validJson);
    await mkdir(join(testDir, 'dir.json'), { recursive: true });
    await symlink(absolutePath, join(testDir, symlinkName));

    async function runCli(timelineArg: string): Promise<{ exitCode: number; output: string; manifest: AuditManifest }> {
      let output = '';
      let exitCode = 0;
      try {
        await execFileAsync('npx', ['tsx', 'src/cli.ts', timelineArg], { cwd: root, env: process.env });
      } catch (err: any) {
        exitCode = err.code ?? 1;
        output = (err.stdout ?? '') + (err.stderr ?? '');
      }
      const { data: manifest } = await manifestFromOutput(output);
      return { exitCode, output, manifest };
    }

    // Absolute path must be rejected.
    const absolute = await runCli(absolutePath);
    expect(absolute.exitCode).not.toBe(0);
    expect(absolute.manifest.status).toBe('failure');
    expect(absolute.manifest.error?.code).toBe('PATH_ABSOLUTE');
    expect(absolute.manifest.error?.message).not.toContain(root);
    expect(absolute.manifest.error?.message).not.toMatch(/[A-Za-z]:\\|\/etc\//);

    // Traversal path must be rejected.
    const traversal = await runCli(traversalPath);
    expect(traversal.exitCode).not.toBe(0);
    expect(traversal.manifest.status).toBe('failure');
    expect(traversal.manifest.error?.code).toBe('PATH_TRAVERSAL');
    expect(traversal.manifest.error?.message).not.toContain(root);
    expect(traversal.manifest.error?.message).not.toContain('../');

    // Symlink path must be rejected.
    const symlinkResult = await runCli(symlinkPath);
    expect(symlinkResult.exitCode).not.toBe(0);
    expect(symlinkResult.manifest.status).toBe('failure');
    expect(symlinkResult.manifest.error?.code).toBe('PATH_TRAVERSAL');
    expect(symlinkResult.manifest.error?.message).not.toContain(root);

    // Directory path must be rejected.
    const dir = await runCli(dirPath);
    expect(dir.exitCode).not.toBe(0);
    expect(dir.manifest.status).toBe('failure');
    expect(dir.manifest.error?.code).toBe('PATH_NOT_REGULAR');
    expect(dir.manifest.error?.message).not.toContain(root);

    // Ensure each run produced a distinct manifest.
    const jobIds = new Set([absolute.manifest.jobId, traversal.manifest.jobId, symlinkResult.manifest.jobId, dir.manifest.jobId]);
    expect(jobIds.size).toBe(4);

    await rm(testDir, { recursive: true, force: true });
  }, 120000);

  it('preserves source SHA-256 in manifest and leaves input files unchanged', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const imageBefore = await sha256File(join(fixturesDir, 'image.png'));
    const audioBefore = await sha256File(join(fixturesDir, 'audio.mp3'));

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    await writeAuditManifest({
      jobId: 'hash-invariant',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    });

    expect(await sha256File(join(fixturesDir, 'image.png'))).toBe(imageBefore);
    expect(await sha256File(join(fixturesDir, 'audio.mp3'))).toBe(audioBefore);
  }, 120000);

  it('hashes the original source in failure manifests and resolves each identifier to one unique input', async () => {
    const tmpFixtures = join(root, 'output', 'audit-fixtures-shell');
    await rm(tmpFixtures, { recursive: true, force: true });
    await mkdir(tmpFixtures, { recursive: true });

    const originalName = 'evil;name.png';
    const sanitizedName = 'evil_name.png';
    await writeFile(join(tmpFixtures, originalName), 'original-content');
    await writeFile(join(tmpFixtures, sanitizedName), 'sanitized-content');

    const originalHash = await sha256File(join(tmpFixtures, originalName));
    const sanitizedHash = await sha256File(join(tmpFixtures, sanitizedName));

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'x.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: originalName, start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: sanitizedName, start: 1, end: 2, in: 0, out: 1, fit: 'cover' },
      ],
    };

    const assetInfo = await prepareAuditAssets({
      jobId: 'original-source-hash',
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: tmpFixtures,
      fontsDir,
      timeline: timeline as Timeline,
    });

    const manifestPath = await writeAuditManifest({
      jobId: 'original-source-hash',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: assetInfo.assetsDir,
      fontsDir: assetInfo.assetsDir,
      timeline,
      assetMap: assetInfo.assetMap,
      originalTimelineHash: assetInfo.originalTimelineHash,
      error: new Error('test'),
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(2);

    // prepareAuditAssets processes clips in order, so the first asset is the
    // semicolon-named file and the second is the underscore-named file.
    const [originalInput, sanitizedInput] = visualInputs;
    expect(originalInput.sha256).toBe(originalHash);
    expect(sanitizedInput.sha256).toBe(sanitizedHash);

    const identifiers = new Set(visualInputs.map((i) => i.identifier));
    expect(identifiers.size).toBe(2);

    for (const input of visualInputs) {
      expect(input.identifier).not.toContain(';');
      const fullPath = resolve(root, input.identifier);
      expect(existsSync(fullPath)).toBe(true);
      expect(await sha256File(fullPath)).toBe(input.sha256);
    }

    await rm(tmpFixtures, { recursive: true, force: true });
  }, 60000);

  it('rejects a parent assets directory that is a symlink to outside', async () => {
    const outsideDir = join(root, 'output', 'outside-assets');
    const outputDir = join(root, 'output', 'audit-symlinked-parent');
    const assetsSymlink = join(outputDir, 'assets');
    await rm(outputDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await symlink(outsideDir, assetsSymlink);

    try {
      await expect(
        prepareAuditAssets({
          jobId: 'symlinked-assets-parent',
          rootDir: root,
          outputDir,
          fixturesDir,
          fontsDir,
          timeline: {
            width: 1080,
            height: 1920,
            fps: 30,
            outputPath: 'video.mp4',
            background: '000000',
            clips: [{ type: 'image', source: 'image.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
          } as Timeline,
        }),
      ).rejects.toThrow(/symbolic link|outside project root/);
      const outsideFiles = await readdir(outsideDir);
      expect(outsideFiles).toHaveLength(0);
    } finally {
      await rm(assetsSymlink, { force: true });
      await rm(outputDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects an assetsDir path that is an existing non-directory file', async () => {
    const outputDir = join(root, 'output', 'audit-conflicting-assets');
    const jobId = 'conflict';
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(join(outputDir, 'assets'), { recursive: true });
    await writeFile(join(outputDir, 'assets', jobId), '{\n');

    try {
      await expect(
        prepareAuditAssets({
          jobId,
          rootDir: root,
          outputDir,
          fixturesDir,
          fontsDir,
          timeline: {
            width: 1080,
            height: 1920,
            fps: 30,
            outputPath: 'video.mp4',
            background: '000000',
            clips: [{ type: 'image', source: 'image.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
          } as Timeline,
        }),
      ).rejects.toThrow(/path is not a directory|directory is a symbolic link|already exists/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects a symlinked outputDir before writing the manifest', async () => {
    const outsideDir = join(root, 'output', 'outside-audit-target');
    const symlinkedOutput = join(root, 'output', 'symlinked-output');
    await rm(outsideDir, { recursive: true, force: true });
    await rm(symlinkedOutput, { recursive: true, force: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, symlinkedOutput);

    try {
      await expect(
        writeAuditManifest({
          jobId: 'symlinked-output',
          source: 'CLI',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          rootDir: root,
          outputDir: symlinkedOutput,
          fixturesDir,
          fontsDir,
          timeline: { outputPath: 'x.mp4', clips: [] },
          error: new Error('test'),
        }),
      ).rejects.toThrow(/symbolic link|outputDir|outside/);
    } finally {
      await rm(symlinkedOutput, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  }, 60000);

  it('rejects a success manifest when the output file is replaced with another MP4 of the same probe', async () => {
    const timeline1 = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8')) as Timeline;
    timeline1.outputPath = 'swap1.mp4';

    const result1 = await generate(timeline1, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const timeline2 = JSON.parse(JSON.stringify(timeline1)) as Timeline;
    timeline2.outputPath = 'swap2.mp4';
    timeline2.clips[0].source = 'black.png';

    const result2 = await generate(timeline2, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    await cp(result2.outputPath, result1.outputPath);

    await expect(
      writeAuditManifest({
        jobId: 'output-swap',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: result1.timeline,
        result: result1,
      }),
    ).rejects.toThrow(/Output hash mismatch/);
  }, 120000);

  it('exclusively reserves the job asset directory and refuses reuse', async () => {
    const outputDir = join(root, 'output', 'audit-exclusive-assets');
    const jobId = 'existing-job';
    await rm(outputDir, { recursive: true, force: true });

    const first = await prepareAuditAssets({
      jobId,
      rootDir: root,
      outputDir,
      fixturesDir,
      fontsDir,
      timeline: {
        width: 1080,
        height: 1920,
        fps: 30,
        outputPath: 'video.mp4',
        background: '000000',
        clips: [{ type: 'image', source: 'image.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
      } as Timeline,
    });

    const firstFiles = await readdir(first.assetsDir);
    expect(firstFiles.length).toBeGreaterThan(0);

    await expect(
      prepareAuditAssets({
        jobId,
        rootDir: root,
        outputDir,
        fixturesDir,
        fontsDir,
        timeline: {
          width: 1080,
          height: 1920,
          fps: 30,
          outputPath: 'video.mp4',
          background: '000000',
          clips: [{ type: 'image', source: 'black.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
        } as Timeline,
      }),
    ).rejects.toThrow(/already exists/);

    const afterFiles = await readdir(first.assetsDir);
    expect(afterFiles).toEqual(firstFiles);
  }, 60000);

  it('prevents concurrent reservation of the same job asset directory', async () => {
    const outputDir = join(root, 'output', 'audit-concurrent-assets');
    const jobId = 'concurrent-job';
    await rm(outputDir, { recursive: true, force: true });

    const baseOptions = {
      jobId,
      rootDir: root,
      outputDir,
      fixturesDir,
      fontsDir,
      timeline: {
        width: 1080,
        height: 1920,
        fps: 30,
        outputPath: 'video.mp4',
        background: '000000',
        clips: [{ type: 'image', source: 'image.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
      } as Timeline,
    };

    const [a, b] = await Promise.allSettled([prepareAuditAssets(baseOptions), prepareAuditAssets(baseOptions)]);
    expect([a.status, b.status].filter((s) => s === 'fulfilled').length).toBe(1);
    expect([a.status, b.status].filter((s) => s === 'rejected').length).toBe(1);
  }, 60000);

  it('isolates outputs for two jobs using the same timeline outputPath', async () => {
    const outputDir = join(root, 'output', 'audit-shared-output');
    await rm(outputDir, { recursive: true, force: true });
    const auditDir = join(outputDir, 'audit');

    const baseTimeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    baseTimeline.outputPath = 'shared.mp4';

    async function runJob(jobId: string, imageSource: string) {
      const artifactDir = join(outputDir, 'artifacts', jobId);
      await prepareJobAssetDir(artifactDir, root);

      const timeline = JSON.parse(JSON.stringify(baseTimeline)) as Timeline;
      timeline.clips[0].source = imageSource;

      const result = await generate(timeline, {
        rootDir: root,
        fixturesDir,
        outputDir: artifactDir,
        fontsDir,
      });

      return writeAuditManifest({
        jobId,
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir,
        fixturesDir,
        fontsDir,
        timeline: result.timeline,
        result,
      });
    }

    const manifestPathA = await runJob('shared-output-a', 'image.png');
    const manifestPathB = await runJob('shared-output-b', 'black.png');

    const manifestA = JSON.parse(await readFile(manifestPathA, 'utf8')) as AuditManifest;
    const manifestB = JSON.parse(await readFile(manifestPathB, 'utf8')) as AuditManifest;

    expect(manifestA.output?.identifier).not.toBe(manifestB.output?.identifier);
    const fileA = resolve(root, manifestA.output!.identifier);
    const fileB = resolve(root, manifestB.output!.identifier);

    const hashA1 = await sha256File(fileA);
    const hashB1 = await sha256File(fileB);
    expect(hashA1).toBe(manifestA.output!.sha256);
    expect(hashB1).toBe(manifestB.output!.sha256);
    expect(hashA1).not.toBe(hashB1);

    // A third job with the same outputPath must not alter the first two artifacts.
    const manifestPathC = await runJob('shared-output-c', 'image.png');
    const manifestC = JSON.parse(await readFile(manifestPathC, 'utf8')) as AuditManifest;

    const hashA2 = await sha256File(fileA);
    const hashB2 = await sha256File(fileB);
    expect(hashA2).toBe(hashA1);
    expect(hashB2).toBe(hashB1);
    expect(fileA).not.toBe(fileB);
    expect(manifestC.output?.identifier).not.toBe(manifestA.output?.identifier);
    expect(manifestC.output?.identifier).not.toBe(manifestB.output?.identifier);

    // sanity: a naive shared outputPath in the base outputDir does not clobber artifacts
    const sharedOutput = join(outputDir, 'shared.mp4');
    await cp(fileB, sharedOutput);
    expect(await sha256File(fileA)).toBe(hashA1);
    expect(await sha256File(fileB)).toBe(hashB1);
  }, 180000);

  it('CLI refuses to copy the artifact when the shared output parent is a symlink', async () => {
    const outsideDir = join(root, 'output', 'cli-copy-symlink-outside');
    const symlinkParent = join(root, 'output', 'cli-copy-symlink-parent');
    const timelineRel = 'output/cli-copy-symlink-timeline.json';
    const timelinePath = join(root, timelineRel);

    await rm(outsideDir, { recursive: true, force: true });
    await rm(symlinkParent, { force: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(join(root, 'output'), { recursive: true });
    await symlink(outsideDir, symlinkParent);

    const timeline = JSON.parse(await readFile(join(fixturesDir, 'timeline.json'), 'utf8')) as Timeline;
    timeline.outputPath = 'cli-copy-symlink-parent/video.mp4';
    await writeFile(timelinePath, JSON.stringify(timeline));

    let output = '';
    let exitCode = 0;
    try {
      await execFileAsync('npx', ['tsx', 'src/cli.ts', timelineRel], { cwd: root, env: process.env });
    } catch (err: any) {
      exitCode = err.code ?? 1;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    const { data: manifest } = await manifestFromOutput(output);
    expect(exitCode).not.toBe(0);
    expect(manifest.status).toBe('failure');
    expect(manifest.error?.code).toBe('PATH_TRAVERSAL');

    const outsideFiles = await readdir(outsideDir).catch(() => [] as string[]);
    expect(outsideFiles).toHaveLength(0);
    expect(manifest.error?.message).not.toContain(root);

    await rm(outsideDir, { recursive: true, force: true });
    await rm(symlinkParent, { force: true });
    await rm(timelinePath, { force: true });
  }, 120000);

  it('freezes the output in a snapshot before manifest finalization and survives a post-snapshot overwrite', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const swapTimeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'swap.mp4',
      background: '000000',
      clips: [{ type: 'image', source: 'black.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
    } as Timeline;

    const swapResult = await generate(swapTimeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });
    const swapBuffer = await readFile(swapResult.outputPath);

    const manifestPath = await writeAuditManifest({
      jobId: 'post-snapshot-overwrite',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      result,
      hooks: {
        onAfterSnapshot: async () => {
          await writeFile(result.outputPath, swapBuffer);
        },
      },
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.output).toBeTruthy();

    const outputFile = resolve(root, manifest.output!.identifier);
    expect(outputFile).not.toBe(result.outputPath);
    expect(existsSync(outputFile)).toBe(true);
    expect(await sha256File(outputFile)).toBe(result.outputSha256);
    expect(await sha256File(outputFile)).toBe(manifest.output!.sha256);

    // The original output path was overwritten by the hook, proving the snapshot
    // captured the correct content before the manifest was finalized.
    expect(await sha256File(result.outputPath)).not.toBe(result.outputSha256);

    await rm(swapResult.outputPath, { force: true });
  }, 120000);

  it('uses collision-free safe snapshots for failure inputs without assetMap', async () => {
    const tmpFixtures = join(root, 'output', 'audit-failure-collision-fixtures');
    await rm(tmpFixtures, { recursive: true, force: true });
    await mkdir(tmpFixtures, { recursive: true });

    const originalName = 'evil;name.png';
    const sanitizedName = 'evil_name.png';
    await writeFile(join(tmpFixtures, originalName), 'original-content');
    await writeFile(join(tmpFixtures, sanitizedName), 'sanitized-content');

    const originalHash = await sha256File(join(tmpFixtures, originalName));
    const sanitizedHash = await sha256File(join(tmpFixtures, sanitizedName));

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'x.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: originalName, start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
        { type: 'image', source: sanitizedName, start: 1, end: 2, in: 0, out: 1, fit: 'cover' },
      ],
    } as Timeline;

    const manifestPath = await writeAuditManifest({
      jobId: 'failure-collision',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: tmpFixtures,
      fontsDir,
      timeline,
      error: new Error('test'),
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(2);

    const identifiers = new Set(visualInputs.map((i) => i.identifier));
    expect(identifiers.size).toBe(2);

    for (const input of visualInputs) {
      expect(input.identifier).not.toContain(root);
      expect(input.identifier).not.toMatch(/\.\./);
      expect(input.identifier).not.toMatch(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/);
      // Identifiers point to safe, per-job input snapshots, not the original names.
      const decoded = input.identifier.split('/').map(decodeURIComponent).join('/');
      const fullPath = resolve(root, decoded);
      expect(existsSync(fullPath)).toBe(true);
      expect(await sha256File(fullPath)).toBe(input.sha256);
    }

    const [originalInput, sanitizedInput] = visualInputs;
    expect(originalInput.sha256).toBe(originalHash);
    expect(sanitizedInput.sha256).toBe(sanitizedHash);

    await rm(tmpFixtures, { recursive: true, force: true });
  }, 120000);

  it('rejects manifest when the output snapshot is tampered with after creation', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const swapTimeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'swap.mp4',
      background: '000000',
      clips: [{ type: 'image', source: 'black.png', start: 0, end: 1, in: 0, out: 1, fit: 'cover' }],
    } as Timeline;

    const swapResult = await generate(swapTimeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });
    const swapBuffer = await readFile(swapResult.outputPath);

    const snapshotPath = getOutputSnapshotPath(auditOutputDir, 'snapshot-tamper', result.outputPath);

    await expect(
      writeAuditManifest({
        jobId: 'snapshot-tamper',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        result,
        hooks: {
          onAfterSnapshot: async () => {
            await writeFile(snapshotPath, swapBuffer);
          },
        },
      }),
    ).rejects.toThrow(/Snapshot integrity/);

    await rm(swapResult.outputPath, { force: true });
  }, 120000);

  it('encodes non-ASCII, emoji, and combining-character identifiers reversibly for success inputs', async () => {
    const tmpFixtures = join(root, 'output', 'audit-unicode-fixtures');
    await rm(tmpFixtures, { recursive: true, force: true });
    await mkdir(tmpFixtures, { recursive: true });

    const japaneseName = '日本語ファイル.png';
    const emojiName = 'emoji😀.png';
    const combiningName = 'cafe\u0301.png';
    const imageBuffer = await readFile(join(fixturesDir, 'image.png'));
    await writeFile(join(tmpFixtures, japaneseName), imageBuffer);
    await writeFile(join(tmpFixtures, emojiName), imageBuffer);
    await writeFile(join(tmpFixtures, combiningName), imageBuffer);

    const hashes = new Map<string, string>([
      [japaneseName, await sha256File(join(tmpFixtures, japaneseName))],
      [emojiName, await sha256File(join(tmpFixtures, emojiName))],
      [combiningName, await sha256File(join(tmpFixtures, combiningName))],
    ]);

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'unicode.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: japaneseName, start: 0, end: 0.5, in: 0, out: 0.5, fit: 'cover' },
        { type: 'image', source: emojiName, start: 0.5, end: 1, in: 0, out: 0.5, fit: 'cover' },
        { type: 'image', source: combiningName, start: 1, end: 1.5, in: 0, out: 0.5, fit: 'cover' },
      ],
    } as Timeline;

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir: tmpFixtures,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const manifestPath = await writeAuditManifest({
      jobId: 'unicode-success',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: tmpFixtures,
      fontsDir,
      result,
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const text = JSON.stringify(manifest);
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpFixtures);

    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(3);

    const decodedHashes = new Map<string, string>();
    for (const input of visualInputs) {
      expect(input.identifier).not.toContain(root);
      expect(input.identifier).not.toMatch(/\.\./);
      expect(input.identifier).not.toMatch(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/);
      // encodeURIComponent per path segment is reversible with decodeURIComponent.
      const decoded = input.identifier.split('/').map(decodeURIComponent).join('/');
      const fullPath = resolve(root, decoded);
      expect(existsSync(fullPath)).toBe(true);
      const hash = await sha256File(fullPath);
      expect(hash).toBe(input.sha256);
      decodedHashes.set(input.timelineSource!, hash);
    }

    expect(decodedHashes.get(japaneseName)).toBe(hashes.get(japaneseName));
    expect(decodedHashes.get(emojiName)).toBe(hashes.get(emojiName));
    expect(decodedHashes.get(combiningName)).toBe(hashes.get(combiningName));

    await rm(tmpFixtures, { recursive: true, force: true });
  }, 120000);

  it('does not leak secret-like filenames in early-failure manifests', async () => {
    const tmpFixtures = join(root, 'output', 'audit-secret-failure-fixtures');
    await rm(tmpFixtures, { recursive: true, force: true });
    await mkdir(tmpFixtures, { recursive: true });

    const secretName = 'api_key=supersecrettoken123.png'; // gitleaks:allow
    await writeFile(join(tmpFixtures, secretName), 'secret-file-content');
    const secretHash = await sha256File(join(tmpFixtures, secretName));

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'x.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: secretName, start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
      ],
    } as Timeline;

    const manifestPath = await writeAuditManifest({
      jobId: 'secret-failure',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: tmpFixtures,
      fontsDir,
      timeline,
      error: new Error('test'),
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const text = JSON.stringify(manifest).toLowerCase();
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('supersecrettoken');
    expect(text).toContain('[redacted]');

    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(1);
    const input = visualInputs[0];
    expect(input.identifier).not.toContain('api_key');
    expect(input.identifier).not.toContain('supersecrettoken');
    expect(input.identifier).not.toContain(root);
    expect(input.identifier).not.toMatch(/\.\./);
    expect(input.sha256).toBe(secretHash);

    const snapshotPath = resolve(root, input.identifier);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(await sha256File(snapshotPath)).toBe(secretHash);

    await rm(tmpFixtures, { recursive: true, force: true });
  }, 120000);

  it('does not leak secret-like extensions in failure input snapshot names', async () => {
    const tmpFixtures = join(root, 'output', 'audit-secret-ext-fixtures');
    await rm(tmpFixtures, { recursive: true, force: true });
    await mkdir(tmpFixtures, { recursive: true });

    const secretExtName = 'image.api_key=supersecrettoken123'; // gitleaks:allow
    await writeFile(join(tmpFixtures, secretExtName), 'secret-ext-content');
    const secretExtHash = await sha256File(join(tmpFixtures, secretExtName));

    const timeline = {
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath: 'x.mp4',
      background: '000000',
      clips: [
        { type: 'image', source: secretExtName, start: 0, end: 1, in: 0, out: 1, fit: 'cover' },
      ],
    } as Timeline;

    const manifestPath = await writeAuditManifest({
      jobId: 'secret-ext-failure',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir: tmpFixtures,
      fontsDir,
      timeline,
      error: new Error('test'),
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    const text = JSON.stringify(manifest).toLowerCase();
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('supersecrettoken');

    const visualInputs = manifest.inputs.filter((i) => i.role === 'visual');
    expect(visualInputs).toHaveLength(1);
    const input = visualInputs[0];
    expect(input.identifier).not.toContain('api_key');
    expect(input.identifier).not.toContain('supersecrettoken');
    expect(input.identifier).not.toContain(secretExtName);
    expect(input.identifier).not.toContain(root);
    expect(input.identifier).not.toMatch(/\.\./);
    expect(input.sha256).toBe(secretExtHash);

    const snapshotPath = resolve(root, input.identifier);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(await sha256File(snapshotPath)).toBe(secretExtHash);

    await rm(tmpFixtures, { recursive: true, force: true });
  }, 120000);
});

describe('verifyGenerateResultIntegrity output path', () => {
  it('accepts nested timeline output paths and preserves every directory component', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'nested/clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const manifestPath = await writeAuditManifest({
      jobId: 'nested-output-ok',
      source: 'CLI',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rootDir: root,
      outputDir: auditOutputDir,
      fixturesDir,
      fontsDir,
      timeline: result.timeline,
      result,
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.status).toBe('success');
    expect(manifest.timelineHash).toBe(result.timelineHash);
  }, 120000);

  it('rejects a same-basename output in a different directory', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'nested/clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.timeline.outputPath = 'other/clip.mp4';
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'different-dir-basename',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch/);
  }, 120000);

  it('rejects an absolute timeline outputPath', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'nested/clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.timeline.outputPath = '/tmp/clip.mp4';
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'absolute-outputpath',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch|outside project root/);
  }, 120000);

  it('rejects a traversal timeline outputPath', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'nested/clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.timeline.outputPath = '../evil/clip.mp4';
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'traversal-outputpath',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch/);
  }, 120000);

  it('rejects an actual output path outside the project root', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.outputPath = '/tmp/clip.mp4';

    await expect(
      writeAuditManifest({
        jobId: 'output-outside-root',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path resolves outside project root|Output path mismatch/);
  }, 120000);

  it('rejects prefix-drop tampering of the timeline outputPath', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'timelines/selected.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });
    expect(result.outputPath).toBe(resolve(auditOutputDir, 'timelines', 'selected.mp4'));

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    // Drop the leading `timelines/` directory: the actual artifact is still
    // under `timelines/selected.mp4`, but the timeline now claims `selected.mp4`.
    tampered.timeline.outputPath = 'selected.mp4';
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'prefix-drop-timeline',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch/);
  }, 120000);

  it('rejects dropping a deeper prefix from the timeline outputPath', async () => {
    const timeline = JSON.parse(
      await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
    ) as Timeline;
    timeline.outputPath = 'a/b/clip.mp4';

    const result = await generate(timeline, {
      rootDir: root,
      fixturesDir,
      outputDir: auditOutputDir,
      fontsDir,
    });
    expect(result.outputPath).toBe(resolve(auditOutputDir, 'a', 'b', 'clip.mp4'));

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    tampered.timeline.outputPath = 'b/clip.mp4';
    tampered.timelineHash = timelineHash(tampered.timeline);

    await expect(
      writeAuditManifest({
        jobId: 'prefix-drop-deep',
        source: 'CLI',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rootDir: root,
        outputDir: auditOutputDir,
        fixturesDir,
        fontsDir,
        timeline: tampered.timeline,
        result: tampered,
      }),
    ).rejects.toThrow(/Output path mismatch/);
  }, 120000);
});
