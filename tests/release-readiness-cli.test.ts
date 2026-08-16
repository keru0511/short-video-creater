import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeAuditManifest } from '../src/audit.js';
import { generate, type Timeline } from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(repoRoot, 'fixtures');
const fontsDir = join(repoRoot, 'fonts');
const sharedOutputDir = join(repoRoot, 'output', 'readiness-cli-shared');

let sharedVideoPath: string;
let sharedSha: string;
let sharedAuditPath: string;
let sharedAuditAbsPath: string;
let sharedArtifactIdentifier: string;
let sharedArtifactAbsPath: string;

function tmpRoot(): string {
  return mkdtempSync(resolve(tmpdir(), 'readiness-cli-'));
}

async function makeDecision(
  root: string,
  artifactSha256: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const absPath = resolve(root, 'output/approvals/decision.json');
  await mkdir(resolve(absPath, '..'), { recursive: true });
  const decision = {
    schemaVersion: '1.0.0',
    requestSha256: '0'.repeat(64),
    action: 'publish',
    artifact: 'output/video.mp4',
    artifactSha256,
    decision: 'approved',
    reasonCode: 'APPROVED',
    approver: 'alice',
    verifiedAt: new Date('2026-07-31T12:00:00Z').toISOString(),
    ...overrides,
  };
  await writeFile(absPath, JSON.stringify(decision, null, 2) + '\n');
}

async function runCli(args: string[], cwd = repoRoot): Promise<{ code: number; stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('npx', ['tsx', 'src/release-readiness-cli.ts', ...args], { cwd });
  return { code: 0, stdout, stderr };
}

beforeAll(async () => {
  await rm(sharedOutputDir, { recursive: true, force: true });
  await generateFixtures(repoRoot);
  const timeline = JSON.parse(
    await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
  ) as Timeline;
  timeline.outputPath = 'video.mp4';
  const outputDir = resolve(sharedOutputDir, 'output');
  const result = await generate(timeline, {
    rootDir: sharedOutputDir,
    outputDir,
    fixturesDir,
    fontsDir,
  });
  sharedVideoPath = result.outputPath;
  sharedSha = result.outputSha256;

  const startedAt = new Date('2026-07-31T12:00:00Z').toISOString();
  sharedAuditPath = await writeAuditManifest({
    jobId: 'cli-shared',
    source: 'CLI',
    startedAt,
    finishedAt: startedAt,
    rootDir: sharedOutputDir,
    outputDir,
    fixturesDir,
    fontsDir,
    timeline: result.timeline,
    result,
  });
  sharedAuditAbsPath = resolve(sharedOutputDir, sharedAuditPath);
  const manifest = JSON.parse(await readFile(sharedAuditAbsPath, 'utf8')) as { output: { identifier: string } };
  sharedArtifactIdentifier = manifest.output.identifier;
  sharedArtifactAbsPath = resolve(sharedOutputDir, sharedArtifactIdentifier);
}, 120000);

afterAll(async () => {
  await rm(sharedOutputDir, { recursive: true, force: true });
});

describe('release-readiness CLI', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = tmpRoot();
    await mkdir(resolve(tmp, 'output', 'audit'), { recursive: true });
    await cp(sharedVideoPath, resolve(tmp, 'output', 'video.mp4'));
    await cp(sharedAuditAbsPath, resolve(tmp, 'output', 'audit', 'shared.json'));
    const artifactDest = resolve(tmp, sharedArtifactIdentifier);
    await mkdir(resolve(artifactDest, '..'), { recursive: true });
    await cp(sharedArtifactAbsPath, artifactDest);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('prints a ready=true report for valid inputs', async () => {
    await makeDecision(tmp, sharedSha);

    const { code, stdout } = await runCli([
      '--project-root',
      tmp,
      '--mp4',
      'output/video.mp4',
      '--audit',
      'output/audit/shared.json',
      '--decision',
      'output/approvals/decision.json',
      '--now',
      '2026-07-31T12:00:00.000Z',
      '--output-rel',
      'readiness/cli-report.json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.report.ready).toBe(true);
    expect(parsed.report.reasonCode).toBe('READY');
    expect(parsed.report.mp4.sha256).toBe(sharedSha);
    expect(parsed.reportSha256).toHaveLength(64);
    expect(parsed.reportPath).toBe(resolve(tmp, 'output', 'readiness', 'cli-report.json'));

    const written = JSON.parse(await readFile(parsed.reportPath, 'utf8'));
    expect(written.ready).toBe(true);
  });

  it('exits non-zero for a denied decision', async () => {
    await makeDecision(tmp, sharedSha, { decision: 'denied', reasonCode: 'DENIED' });

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'DECISION_NOT_APPROVED';
    });
  });

  it('exits non-zero for a non-publish action', async () => {
    await makeDecision(tmp, sharedSha, { action: 'delete' });

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'DECISION_ACTION_MISMATCH';
    });
  });

  it('exits non-zero for a sha mismatch', async () => {
    await makeDecision(tmp, '0'.repeat(64));

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'MP4_DECISION_SHA_MISMATCH';
    });
  });

  it('exits non-zero for an invalid timestamp', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--now',
        '2026-02-30T12:00:00Z',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'INVALID_TIMESTAMP';
    });
  });

  it('exits non-zero when --max-json-bytes is too low', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--max-json-bytes',
        '10',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'INVALID_INPUT';
    });
  });

  it('exits non-zero when --max-artifact-bytes is too low', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--max-artifact-bytes',
        '10',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      const parsed = JSON.parse(e.stderr);
      return parsed.ready === false && parsed.error === 'INVALID_MP4';
    });
  });

  it('exits non-zero for NaN --max-json-bytes', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--max-json-bytes',
        'NaN',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      return e.stderr.includes('--max-json-bytes');
    });
  });

  it('exits non-zero for Infinity --max-artifact-bytes', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--max-artifact-bytes',
        'Infinity',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      return e.stderr.includes('--max-artifact-bytes');
    });
  });

  it('exits non-zero for duplicate options', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      return e.stderr.includes('Duplicate option');
    });
  });

  it('exits non-zero for unknown options', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        'output/video.mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
        '--unknown-option',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      return e.stderr.includes('Unknown option');
    });
  });

  it('exits non-zero for a missing option value', async () => {
    await makeDecision(tmp, sharedSha);

    await expect(
      runCli([
        '--project-root',
        tmp,
        '--mp4',
        '--audit',
        'output/audit/shared.json',
        '--decision',
        'output/approvals/decision.json',
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { stderr?: string };
      if (!e.stderr) return false;
      return e.stderr.includes('requires a value');
    });
  });

  for (const invalidRel of [
    'readiness/../audit/escape.json',
    'readiness/./escape.json',
    'readiness//escape.json',
    'readiness',
    'readiness/',
    'output/readiness/../audit/escape.json',
  ]) {
    it(`exits non-zero for an output-rel escape: ${JSON.stringify(invalidRel)}`, async () => {
      await makeDecision(tmp, sharedSha);

      await expect(
        runCli([
          '--project-root',
          tmp,
          '--mp4',
          'output/video.mp4',
          '--audit',
          'output/audit/shared.json',
          '--decision',
          'output/approvals/decision.json',
          '--output-rel',
          invalidRel,
        ]),
      ).rejects.toSatisfy((err: unknown) => {
        const e = err as { stderr?: string };
        if (!e.stderr) return false;
        const parsed = JSON.parse(e.stderr);
        return parsed.ready === false && parsed.error === 'INVALID_OUTPUT_PATH';
      });
    });
  }
});
