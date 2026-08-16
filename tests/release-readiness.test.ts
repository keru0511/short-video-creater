import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { constants, mkdtempSync } from 'node:fs';
import { chmod, cp, link, mkdir, open, readFile, readdir, rename, rmdir, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditManifest, type AuditManifest } from '../src/audit.js';
import { generate, type Timeline } from '../src/core.js';
import { generateFixtures } from '../src/fixtures.js';
import { ffprobeFromBuffer, ReadinessError, verifyReleaseReadiness, type ReadinessReport } from '../src/release-readiness.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(repoRoot, 'fixtures');
const fontsDir = join(repoRoot, 'fonts');
const sharedOutputDir = join(repoRoot, 'output', 'readiness-shared');

let sharedVideoPath: string;
let sharedProbe: unknown;
let sharedSha: string;
let sharedAuditPath: string;
let sharedAuditAbsPath: string;
let sharedArtifactIdentifier: string;
let sharedArtifactAbsPath: string;

function tmpRoot(): string {
  return mkdtempSync(resolve(tmpdir(), 'readiness-'));
}

async function writeJson(root: string, relPath: string, data: unknown): Promise<void> {
  const absPath = resolve(root, relPath);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  await writeFile(absPath, JSON.stringify(data, null, 2) + '\n');
}

async function copySharedVideoTo(tmp: string, relPath = 'output/video.mp4'): Promise<void> {
  const absPath = resolve(tmp, relPath);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  await cp(sharedVideoPath, absPath);
}

async function makeDecision(
  root: string,
  relPath: string,
  artifactSha256: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
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
  await writeJson(root, relPath, decision);
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyAuditTo(
  tmp: string,
  relPath = 'output/audit/shared.json',
  mp4Rel = 'output/video.mp4',
): Promise<AuditManifest> {
  const absPath = resolve(tmp, relPath);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  const text = await readFile(sharedAuditAbsPath, 'utf8');
  const manifest = JSON.parse(text) as AuditManifest;
  // Rewrite the snapshot identifier so it matches the final MP4 basename used in this test.
  if (manifest.output) {
    const basename = mp4Rel.split('/').pop()!;
    manifest.output.identifier = `output/artifacts/${manifest.jobId}/snapshot-${basename}`;
  }
  await writeFile(absPath, JSON.stringify(manifest, null, 2) + '\n');
  // Also copy the audit output artifact snapshot so the verifier can resolve it.
  const artifactDest = resolve(tmp, manifest.output!.identifier);
  await mkdir(resolve(artifactDest, '..'), { recursive: true });
  await cp(sharedArtifactAbsPath, artifactDest);
  return manifest;
}

beforeAll(async () => {
  await rm(sharedOutputDir, { recursive: true, force: true });
  await generateFixtures(repoRoot);
  const timeline = JSON.parse(
    await readFile(join(fixturesDir, 'timeline.json'), 'utf8'),
  ) as Timeline;
  // Use a bare outputPath under output/ so generate() produces output/video.mp4.
  timeline.outputPath = 'video.mp4';
  const outputDir = resolve(sharedOutputDir, 'output');
  const result = await generate(timeline, {
    rootDir: sharedOutputDir,
    outputDir,
    fixturesDir,
    fontsDir,
  });
  sharedVideoPath = result.outputPath;
  sharedProbe = result.probe;
  sharedSha = result.outputSha256;

  const startedAt = new Date('2026-07-31T12:00:00Z').toISOString();
  sharedAuditPath = await writeAuditManifest({
    jobId: 'shared',
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
  const audit = JSON.parse(await readFile(sharedAuditAbsPath, 'utf8')) as AuditManifest;
  sharedArtifactIdentifier = audit.output!.identifier;
  sharedArtifactAbsPath = resolve(sharedOutputDir, sharedArtifactIdentifier);
}, 120000);

afterAll(async () => {
  await rm(sharedOutputDir, { recursive: true, force: true });
});

describe('verifyReleaseReadiness', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = tmpRoot();
    await mkdir(resolve(tmp, 'output', 'audit'), { recursive: true });
    await mkdir(resolve(tmp, 'output', 'approvals'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function waitForAck(ackPath: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const s = await stat(ackPath);
        if (s.isFile()) return;
      } catch {}
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ack ${ackPath}`);
  }

  it(
    'produces ready=true for a matching 9:16 MP4, audit, and approved publish decision',
    async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const result = await verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          now: new Date('2026-07-31T12:00:00Z'),
          readinessOutputRel: 'readiness/report.json',
        },
      );

      expect(result.report.ready).toBe(true);
      expect(result.report.reasonCode).toBe('READY');
      expect(result.report.action).toBe('publish');
      expect(result.report.mp4.sha256).toBe(sharedSha);
      expect(result.report.audit.output.sha256).toBe(sharedSha);
      expect(result.report.decision.artifactSha256).toBe(sharedSha);
      expect(result.reportSha256).toHaveLength(64);
      expect(result.reportPath).toBe(resolve(tmp, 'output', 'readiness', 'report.json'));
      expect(result.mp4Sha256).toBe(sharedSha);

      const written = JSON.parse(await readFile(result.reportPath, 'utf8')) as typeof result.report;
      expect(written.ready).toBe(true);
      expect(written.mp4.probe.width).toBe(1080);
      expect(written.mp4.probe.height).toBe(1920);
      expect(written.mp4.probe.videoCodec).toBe('h264');
      expect(written.mp4.probe.audioCodec).toBe('aac');
    },
    30000,
  );

  it('produces identical report sha256 for identical inputs and now', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const a = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        now: new Date('2026-07-31T12:00:00Z'),
        readinessOutputRel: 'readiness/a.json',
      },
    );
    const b = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        now: new Date('2026-07-31T12:00:00Z'),
        readinessOutputRel: 'readiness/b.json',
      },
    );

    expect(a.reportSha256).toBe(b.reportSha256);
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });

  it('rejects a denied decision', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, {
      decision: 'denied',
      reasonCode: 'DENIED',
    });

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'DECISION_NOT_APPROVED');
  });

  it('rejects a non-publish action', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, { action: 'delete' });

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'DECISION_ACTION_MISMATCH');
  });

  it('rejects an audit with non-success status', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    audit.status = 'failure';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_NOT_SUCCESS');
  });

  it('rejects an MP4 sha that does not match the decision', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', '0'.repeat(64));

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'MP4_DECISION_SHA_MISMATCH');
  });

  it('rejects an audit output sha that does not match the artifact snapshot', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    audit.output!.sha256 = '0'.repeat(64);
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_SHA_MISMATCH');
  });

  it('rejects an audit output probe that does not match the artifact snapshot', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    (audit.output!.probe as { width: number }).width = 999;
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_PROBE_MISMATCH');
  });

  it('rejects duplicate keys in the decision', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    const bad = '{"action":"publish","action":"publish","artifact":"output/video.mp4","artifactSha256":"' + sharedSha + '"}';
    await writeFile(resolve(tmp, 'output/approvals/decision.json'), bad + '\n');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'DUPLICATE_KEY');
  });

  it('rejects malformed JSON in the audit', async () => {
    await copySharedVideoTo(tmp);
    await writeFile(resolve(tmp, 'output/audit/shared.json'), '{"status":"success",}', 'utf8');
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT');
  });

  it('rejects invalid UTF-8 in the decision', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await mkdir(resolve(tmp, 'output/approvals'), { recursive: true });
    await writeFile(resolve(tmp, 'output/approvals/decision.json'), Buffer.from([0xff, 0xfe, 0x00]));

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT');
  });

  it('rejects an oversized file when maxBytes is set low', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { maxBytes: 10 },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT');
  });

  it('rejects an oversized JSON input when maxJsonBytes is set low', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { maxJsonBytes: 10 },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT');
  });

  it('rejects an oversized artifact when maxArtifactBytes is set low', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { maxArtifactBytes: 10 },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4');
  });

  it('rejects a decision with unknown fields', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, { extraField: 1 });

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_DECISION');
  });

  it('rejects a decision with a non-canonical path alias', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        './output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT_PATH');
  });

  it('rejects an MP4 path that is a symbolic link', async () => {
    await copySharedVideoTo(tmp);
    const symlinkPath = resolve(tmp, 'output', 'linked.mp4');
    await mkdir(resolve(symlinkPath, '..'), { recursive: true });
    await cp(sharedVideoPath, resolve(tmp, 'output', 'real.mp4'));
    await symlink(resolve(tmp, 'output', 'real.mp4'), symlinkPath);

    await copyAuditTo(tmp, 'output/audit/shared.json', 'output/linked.mp4');
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, { artifact: 'output/linked.mp4' });

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/linked.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4');
  });

  it('rejects an audit path that is a symbolic link', async () => {
    await copySharedVideoTo(tmp);
    await mkdir(resolve(tmp, 'output'), { recursive: true });
    await writeFile(resolve(tmp, 'output', 'real.json'), JSON.stringify(await copyAuditTo(tmp)));
    await symlink(resolve(tmp, 'output', 'real.json'), resolve(tmp, 'output', 'linked.json'));
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/linked.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT');
  });

  it('rejects an MP4 swapped between stat and read', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                return writeFile(mp4Path, Buffer.from('tampered'));
              }
              return Promise.resolve();
            },
          },
          readinessOutputRel: 'readiness/swapped.json',
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );

    expect(await readFile(mp4Path)).toEqual(Buffer.from('tampered'));
  });

  it('rejects an output path that already exists', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/collision.json';
    const first = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      { readinessOutputRel: outputRel },
    );
    expect(first.report.ready).toBe(true);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: outputRel },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION');
  });

  it('rejects a competing publish of the same readiness output', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/competing.json';
    const results = await Promise.allSettled([
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: outputRel },
      ),
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: outputRel },
      ),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (failure.status === 'rejected') {
      expect(failure.reason).toBeInstanceOf(ReadinessError);
      expect((failure.reason as ReadinessError).code).toBe('OUTPUT_COLLISION');
    }
  });

  it('rejects an output path outside readiness/', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: 'outside.json' },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_OUTPUT_PATH');
  });

  it('rejects an invalid timestamp for now', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { now: '2026-02-30T12:00:00Z' },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_TIMESTAMP');
  });

  it('rejects a same-inode rewrite with restored mtime before the MP4 is read', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const original = await readFile(mp4Path);
    const originalStat = await stat(mp4Path);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                return writeFile(mp4Path, tampered)
                  .then(() => utimes(mp4Path, Number(originalStat.atimeMs) / 1000, Number(originalStat.mtimeMs) / 1000));
              }
              return Promise.resolve();
            },
          },
          readinessOutputRel: 'readiness/rewrite.json',
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );

    const finalStat = await stat(mp4Path);
    expect(finalStat.size).toBe(original.length);
    expect(Math.abs(finalStat.mtime.getTime() - originalStat.mtime.getTime())).toBeLessThanOrEqual(1000);
  });

  it('rejects a missing audit output artifact snapshot', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    // Remove the artifact snapshot, leaving the manifest pointing at it.
    await rm(resolve(tmp, audit.output!.identifier), { force: true });
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT_ARTIFACT');
  });

  it('rejects an audit output artifact that does not match the manifest', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    const artifactPath = resolve(tmp, audit.output!.identifier);
    // Flip a byte in the video payload so ffprobe still reports the same
    // metadata while the SHA-256 no longer matches the audit manifest.
    const buf = Buffer.from(await readFile(artifactPath));
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    await writeFile(artifactPath, buf);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_SHA_MISMATCH');
  });

  it('rejects an audit output identifier that collides with the final MP4', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    // Replace the audit artifact snapshot with a hard link to the final MP4 so they share an inode.
    const artifactPath = resolve(tmp, audit.output!.identifier);
    await rm(artifactPath);
    await link(resolve(tmp, 'output/video.mp4'), artifactPath);
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_COLLISION');
  });

  it('rejects an audit output identifier that is a symbolic link', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    const realPath = resolve(tmp, 'output', 'real-artifact.mp4');
    await cp(sharedArtifactAbsPath, realPath);
    const linkPath = resolve(tmp, audit.output!.identifier);
    await rm(linkPath);
    await symlink(realPath, linkPath);
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT_ARTIFACT');
  });

  it('rejects an audit output identifier with a non-canonical alias', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    audit.output!.identifier = './output/artifacts/shared/snapshot-video.mp4';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_IDENTIFIER_INVALID');
  });

  it('rejects an audit output identifier with a mismatched jobId', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    audit.output!.identifier = 'output/artifacts/other/snapshot-video.mp4';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  });

  it('rejects an audit output identifier with a mismatched snapshot filename', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    audit.output!.identifier = 'output/artifacts/shared/snapshot-other.mp4';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReadinessError && (err as ReadinessError).code === 'AUDIT_OUTPUT_IDENTIFIER_NAMESPACE',
    );
  });

  it('rejects unknown fields in audit output.probe', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    ((audit.output!.probe as unknown) as Record<string, unknown>).unknownField = 1;
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT');
  });

  it('rejects unknown fields in audit output', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    ((audit.output as unknown) as Record<string, unknown>).extra = 'field';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT');
  });

  it('rejects unknown fields in audit inputs', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    ((audit.inputs[0] as unknown) as Record<string, unknown>).extra = 'field';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT');
  });

  it('rejects unknown fields in audit ffmpeg', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    ((audit.ffmpeg as unknown) as Record<string, unknown>).extra = 'field';
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT');
  });

  it('rejects unknown fields in audit error', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    ((audit.error as unknown) as Record<string, unknown>) = { code: 'X', message: 'Y', extra: 'field' };
    await writeJson(tmp, 'output/audit/shared.json', audit);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT');
  });

  it('rejects a parent directory alias swap between resolve and open', async () => {
    await copySharedVideoTo(tmp, 'output/videos/video.mp4');
    const audit = await copyAuditTo(tmp, 'output/audit/shared.json', 'output/videos/video.mp4');
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, {
      artifact: 'output/videos/video.mp4',
    });

    const parent = resolve(tmp, 'output/videos');
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/videos/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          __testHooks: {
            beforeArtifactOpen: async (identifier, resolvedPath) => {
              if (identifier === 'output/videos/video.mp4') {
                const newParent = resolve(tmp, 'output', 'videos-swap');
                await mkdir(newParent, { recursive: true });
                await cp(resolve(parent, 'video.mp4'), resolve(newParent, 'video.mp4'));
                await rename(parent, resolve(tmp, 'output', 'videos-old'));
                await symlink(newParent, parent);
              }
            },
          },
        },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4');
  });

  it('rejects a foreign final created between collision check and atomic publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/foreign-final.json',
          __testHooks: {
            beforeBarrier: async (ctx) => {
              if (ctx) {
                await writeFile(resolve(ctx.dirPath, ctx.finalName), 'foreign bytes');
              }
            },
          },
        },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION');

    const finalPath = resolve(tmp, 'output/readiness/foreign-final.json');
    expect(await readFile(finalPath, 'utf8')).toBe('foreign bytes');
    const leftover = await readdir(resolve(tmp, 'output/readiness'));
    expect(leftover.some((f) => f.startsWith('.'))).toBe(false);
  });

  it('rejects a parent directory swap between stat and open', async () => {
    await copySharedVideoTo(tmp, 'output/videos/video.mp4');
    await copyAuditTo(tmp, 'output/audit/shared.json', 'output/videos/video.mp4');
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, {
      artifact: 'output/videos/video.mp4',
    });

    const parent = resolve(tmp, 'output/videos');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/videos/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/parent-swap.json',
          __testHooks: {
            beforeInputOpen: (label) => {
              if (label === 'MP4') {
                const oldParent = `${parent}-old`;
                return rename(parent, oldParent)
                  .then(() => mkdir(parent, { recursive: true }))
                  .then(() => cp(resolve(oldParent, 'video.mp4'), resolve(parent, 'video.mp4')))
                  .then(() => undefined);
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );
  });

  it('rejects an mtime change between stat and read', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const originalStat = await stat(mp4Path);
    const newMtime = Number(originalStat.mtimeMs) / 1000 + 1;

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/mtime-swap.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                return utimes(mp4Path, Number(originalStat.atimeMs) / 1000, Number(newMtime));
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );
  });

  it('rejects an MP4 swapped between stat and read with a small file', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const tampered = Buffer.from('tampered');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/beforelink-swap.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                return writeFile(mp4Path, tampered).then(() => undefined);
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );

    expect(await readFile(mp4Path)).toEqual(tampered);
  });

  it('rejects a foreign final created after re-verification and preserves its bytes', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/beforelink-foreign.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: {
            beforeBarrier: async (ctx) => {
              if (!ctx) return;
              await writeFile(resolve(ctx.dirPath, ctx.finalName), 'foreign bytes');
            },
          },
        },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION');

    expect(await readFile(outputAbs, 'utf8').catch(() => null)).toBe('foreign bytes');
  });

  it('rejects invalid size limits', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    for (const limit of [
      { maxBytes: NaN },
      { maxBytes: Infinity },
      { maxBytes: -1 },
      { maxBytes: 0 },
      { maxJsonBytes: NaN },
      { maxJsonBytes: Infinity },
      { maxArtifactBytes: NaN },
      { maxArtifactBytes: Infinity },
    ]) {
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          limit,
        ),
      ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_OPTIONS');
    }
  });

  it('rejects an MP4 rewritten between read and publish boundary', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const original = await readFile(mp4Path);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;

    let mp4ReadCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/publish-boundary-rewrite.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                mp4ReadCount++;
                if (mp4ReadCount === 2) {
                  return writeFile(mp4Path, tampered).then(() => undefined);
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an MP4 truncation between read and publish boundary', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    let mp4ReadCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/publish-boundary-truncate.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                mp4ReadCount++;
                if (mp4ReadCount === 2) {
                  return readFile(mp4Path).then((buf) =>
                    writeFile(mp4Path, buf.subarray(0, Math.floor(buf.length / 2))),
                  );
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit manifest rewritten between read and publish boundary', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const auditPath = resolve(tmp, 'output/audit/shared.json');
    const auditText = await readFile(auditPath, 'utf8');
    const audit = JSON.parse(auditText) as AuditManifest;
    let auditReadCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/publish-boundary-audit.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'Generation audit manifest') {
                auditReadCount++;
                if (auditReadCount === 2) {
                  const tampered = { ...audit, status: 'tampered' };
                  return writeFile(auditPath, JSON.stringify(tampered, null, 2) + '\n').then(() => undefined);
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an approval decision rewritten between read and publish boundary', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const decisionPath = resolve(tmp, 'output/approvals/decision.json');
    let decisionReadCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/publish-boundary-decision.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'Approval decision') {
                decisionReadCount++;
                if (decisionReadCount === 2) {
                  return writeFile(decisionPath, JSON.stringify({ action: 'delete' })).then(() => undefined);
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit output artifact rewritten between read and publish boundary', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const artifactPath = resolve(tmp, audit.output!.identifier);
    let artifactReadCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/publish-boundary-artifact.json',
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'Audit output artifact') {
                artifactReadCount++;
                if (artifactReadCount === 2) {
                  return readFile(artifactPath).then((buf) => {
                    const tampered = Buffer.from(buf);
                    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
                    return writeFile(artifactPath, tampered);
                  });
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an MP4 parent directory alias swap between read and publish boundary', async () => {
    await copySharedVideoTo(tmp, 'output/videos/video.mp4');
    await copyAuditTo(tmp, 'output/audit/shared.json', 'output/videos/video.mp4');
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha, {
      artifact: 'output/videos/video.mp4',
    });

    const mp4Path = resolve(tmp, 'output/videos/video.mp4');
    const parent = resolve(mp4Path, '..');
    const newParent = `${parent}-new`;
    let mp4OpenCount = 0;
    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/videos/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/parent-alias-swap.json',
          __testHooks: {
            beforeInputOpen: (label) => {
              if (label === 'MP4') {
                mp4OpenCount++;
                if (mp4OpenCount === 2) {
                  return mkdir(newParent, { recursive: true })
                    .then(() => cp(mp4Path, resolve(newParent, 'video.mp4')))
                    .then(() => rename(parent, `${parent}-old`))
                    .then(() => symlink(newParent, parent))
                    .then(() => undefined);
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit JSON parent directory that is a symbolic link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const realAuditDir = resolve(tmp, 'output', 'audit-real');
    await mkdir(realAuditDir, { recursive: true });
    await cp(resolve(tmp, 'output/audit/shared.json'), resolve(realAuditDir, 'shared.json'));
    await rm(resolve(tmp, 'output/audit'), { recursive: true, force: true });
    await symlink(realAuditDir, resolve(tmp, 'output/audit'));

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: 'readiness/parent-symlink.json' },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT',
    );
  });

  it('rejects an audit JSON parent directory swapped between resolve and open', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const auditParent = resolve(tmp, 'output', 'audit');
    const externalAuditDir = resolve(tmp, 'external', 'audit');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/parent-swap-barrier.json',
          __testHooks: {
            beforeInputOpen: (label) => {
              if (label === 'Generation audit manifest') {
                return mkdir(externalAuditDir, { recursive: true })
                  .then(() => cp(resolve(auditParent, 'shared.json'), resolve(externalAuditDir, 'shared.json')))
                  .then(() => rename(auditParent, `${auditParent}-old`))
                  .then(() => symlink(externalAuditDir, auditParent))
                  .then(() => undefined);
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT',
    );
  });

  it('does not create snapshot files in the OS temp directory', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const osTmp = tmpdir();
    const before = new Set(
      (await readdir(osTmp).catch(() => [] as string[])).filter((f) => f.startsWith('readiness-snap-')),
    );

    const result = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      { readinessOutputRel: 'readiness/no-os-temp.json' },
    );

    expect(result.report.ready).toBe(true);
    const after = new Set(
      (await readdir(osTmp).catch(() => [] as string[])).filter((f) => f.startsWith('readiness-snap-')),
    );
    expect(after).toEqual(before);
  });

  it('does not leave a writable temp alias after publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/no-alias.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    const result = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      { readinessOutputRel: outputRel },
    );

    expect(result.report.ready).toBe(true);
    expect(await readFile(outputAbs, 'utf8')).toContain('"ready": true');

    const finalStat = await stat(outputAbs);
    expect(finalStat.nlink).toBe(1);

    const dir = resolve(tmp, 'output', 'readiness');
    const entries = await readdir(dir);
    for (const entry of entries) {
      expect(entry).not.toMatch(/^\\./);
    }
  });

  it('rejects a competing write attempt on the read-only temp before publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    let beforeRenameCalled = false;
    const result = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/no-writable-temp.json',
        __testHooks: {
          beforeRename: (ctx) => {
            beforeRenameCalled = true;
            // The temp is anonymous; the directory must contain no entries yet.
            return readdir(ctx.dirPath).then(async (entries) => {
              expect(entries).toHaveLength(0);
              await expect(stat(resolve(ctx.dirPath, ctx.finalName))).rejects.toThrow();
            });
          },
        },
      },
    );

    expect(result.report.ready).toBe(true);
    expect(beforeRenameCalled).toBe(true);
  });


  it('rejects an audit JSON parent directory swapped with a hard link between stat and open', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const auditParent = resolve(tmp, 'output', 'audit');

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/parent-hardlink.json',
          __testHooks: {
            beforeInputOpen: (label) => {
              if (label === 'Generation audit manifest') {
                const oldDir = `${auditParent}-olddir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                return rename(auditParent, oldDir)
                  .then(() => mkdir(auditParent, { recursive: true }))
                  .then(() => link(resolve(oldDir, 'shared.json'), resolve(auditParent, 'shared.json')))
                  .then(() => undefined);
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_INPUT',
    );
  });

  it('rejects an audit artifact parent directory swapped with a hard link between stat and open', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const artifactParent = resolve(tmp, 'output', 'artifacts', audit.jobId);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/artifact-parent-hardlink.json',
          __testHooks: {
            beforeInputOpen: (label) => {
              if (label === 'Audit output artifact') {
                const artifactName = `snapshot-${'output/video.mp4'.split('/').pop()}`;
                const oldDir = `${artifactParent}-olddir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                return rename(artifactParent, oldDir)
                  .then(() => mkdir(artifactParent, { recursive: true }))
                  .then(() => link(resolve(oldDir, artifactName), resolve(artifactParent, artifactName)))
                  .then(() => undefined);
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_AUDIT_ARTIFACT',
    );
  });

  it('rejects a same-size rewrite of the MP4 before read', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const original = await readFile(mp4Path);
    const originalStat = await stat(mp4Path);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          __testHooks: {
            beforeInputRead: (label) => {
              if (label === 'MP4') {
                return writeFile(mp4Path, tampered)
                  .then(() => utimes(mp4Path, Number(originalStat.atimeMs) / 1000, Number(originalStat.mtimeMs) / 1000));
              }
              return Promise.resolve();
            },
          },
          readinessOutputRel: 'readiness/same-size-rewrite.json',
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_MP4',
    );
  });

  it('rejects a foreign final created after temp write and before rename, preserving foreign bytes', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/foreign-after-temp.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: {
            beforeRename: (ctx) => {
              return writeFile(resolve(ctx.dirPath, ctx.finalName), 'foreign bytes');
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION',
    );

    expect(await readFile(outputAbs, 'utf8')).toBe('foreign bytes');
    // No partial/temp report should remain.
    const dir = resolve(tmp, 'output', 'readiness');
    for (const entry of await readdir(dir)) {
      expect(entry).not.toMatch(/^\\.readiness-report-.*\\.tmp$/);
    }
  });

  it('cleans up temp and leaves no final when sync fails', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/sync-failure.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: {
            beforeSync: () => {
              throw new Error('injected sync failure');
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
    );

    expect(await stat(outputAbs).catch(() => null)).toBeNull();
    const dir = resolve(tmp, 'output', 'readiness');
    if (await stat(dir).catch(() => null)) {
      for (const entry of await readdir(dir)) {
        expect(entry).not.toMatch(/^\\.readiness-report-.*\\.tmp$/);
      }
    }
  });

  it('cleans up temp and leaves no final when rename fails', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/rename-failure.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: {
            beforeRename: () => {
              throw new Error('injected rename failure');
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
    );

    expect(await stat(outputAbs).catch(() => null)).toBeNull();
    const dir = resolve(tmp, 'output', 'readiness');
    if (await stat(dir).catch(() => null)) {
      for (const entry of await readdir(dir)) {
        expect(entry).not.toMatch(/^\\.readiness-report-.*\\.tmp$/);
      }
    }
  });

  // Adversarial tests for the final pre-link verification window. The helper
  // pauses once before the final re-check, then re-opens each original input
  // through its inherited parent directory fd and verifies stat/realpath/SHA-256.
  // Any tamper must fail closed with INPUT_CHANGED.

  it('rejects an MP4 rewritten in place before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'mp4-rewrite.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/mp4-rewrite.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);

    // Same-inode rewrite: open O_TRUNC and overwrite with different bytes.
    const original = await readFile(mp4Path);
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const fh = await open(mp4Path, 'w');
    try {
      await fh.write(tampered, 0, tampered.length, 0);
    } finally {
      await fh.close();
    }

    expect(await hashFile(mp4Path)).not.toBe(sharedSha);
    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects a same-content MP4 replacement with a different inode before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'mp4-replace.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/mp4-replace.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);

    // Replace the file with an identical copy; dev/ino changes.
    const replacement = resolve(tmp, 'mp4-replacement.mp4');
    await cp(mp4Path, replacement);
    await unlink(mp4Path);
    await cp(replacement, mp4Path);

    expect(await hashFile(mp4Path)).toBe(sharedSha);
    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects a truncated MP4 before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'mp4-truncate.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/mp4-truncate.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);
    const truncated = await readFile(mp4Path);
    await writeFile(mp4Path, truncated.slice(0, Math.floor(truncated.length / 2)));

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects a grown MP4 before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'mp4-grow.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/mp4-grow.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);
    const grown = Buffer.concat([await readFile(mp4Path), Buffer.from([0xff])]);
    await writeFile(mp4Path, grown);

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit JSON rewrite before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'audit-rewrite.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const auditPath = resolve(tmp, 'output/audit/shared.json');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/audit-rewrite.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);
    const manifest = JSON.parse(await readFile(auditPath, 'utf8')) as AuditManifest;
    manifest.schemaVersion = '9.9.9';
    await writeFile(auditPath, JSON.stringify(manifest, null, 2) + '\n');

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit JSON parent directory swap before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'audit-parent-swap.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const auditParent = resolve(tmp, 'output', 'audit');
    const oldAuditParent = `${auditParent}-old`;
    const auditPath = resolve(auditParent, 'shared.json');

    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/audit-parent-swap.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);

    // Swap the parent directory by renaming it and creating a new one with the
    // same name. The helper's inherited dir fd now points to the old inode.
    await rename(auditParent, oldAuditParent);
    await mkdir(auditParent, { recursive: true });
    await link(resolve(oldAuditParent, 'shared.json'), auditPath);

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit artifact rewrite before the final link', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'artifact-rewrite.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const artifactName = `snapshot-${'output/video.mp4'.split('/').pop()}`;
    const artifactPath = resolve(tmp, audit.output!.identifier);

    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/artifact-rewrite.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);
    const bytes = await readFile(artifactPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(artifactPath, bytes);

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an audit artifact parent directory swap before the final link', async () => {
    await copySharedVideoTo(tmp);
    const audit = await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'artifact-parent-swap.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const artifactName = `snapshot-${'output/video.mp4'.split('/').pop()}`;
    const artifactParent = resolve(tmp, 'output', 'artifacts', audit.jobId);
    const oldArtifactParent = `${artifactParent}-old`;
    const artifactPath = resolve(artifactParent, artifactName);

    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/artifact-parent-swap.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);

    await rename(artifactParent, oldArtifactParent);
    await mkdir(artifactParent, { recursive: true });
    await link(resolve(oldArtifactParent, artifactName), artifactPath);

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an approval decision rewrite before the final link', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'decision-rewrite.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const decisionPath = resolve(tmp, 'output/approvals/decision.json');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/decision-rewrite.json',
        __testHooks: { pythonStallBeforeFinalLink: signalPath },
      },
    );

    await waitForAck(ackPath);
    const decision = JSON.parse(await readFile(decisionPath, 'utf8')) as Record<string, unknown>;
    decision.approver = 'mallory';
    await writeFile(decisionPath, JSON.stringify(decision, null, 2) + '\n');

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('rejects an MP4 tamper after it is sealed while a later input is being copied', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const signalPath = resolve(tmp, 'mp4-copy-stall.signal');
    const ackPath = `${signalPath}.ack`;
    await writeFile(signalPath, '');

    const mp4Path = resolve(tmp, 'output/video.mp4');
    const promise = verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: 'readiness/mp4-copy-race.json',
        __testHooks: { pythonStallAfterInputCopy: { MP4: signalPath } },
      },
    );

    await waitForAck(ackPath);
    const tampered = Buffer.from(await readFile(mp4Path));
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await writeFile(mp4Path, tampered);

    await unlink(signalPath);

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('does not expose a partial final: no final path exists before the atomic rename', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputRel = 'readiness/no-partial.json';
    const outputAbs = resolve(tmp, 'output', outputRel);

    const result = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: outputRel,
        __testHooks: {
          beforeRename: (ctx) => {
            // The final path must not exist before renameNoReplace.
            return expect(stat(resolve(ctx.dirPath, ctx.finalName))).rejects.toBeTruthy();
          },
        },
      },
    );

    expect(result.report.ready).toBe(true);
    expect(await readFile(outputAbs, 'utf8')).toContain('"ready": true');
  });

  it('succeeds when all input directories and files are read-only', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    await chmod(resolve(tmp, 'output/video.mp4'), 0o444);
    await chmod(resolve(tmp, 'output/audit'), 0o555);
    await chmod(resolve(tmp, 'output/audit/shared.json'), 0o444);
    await chmod(resolve(tmp, 'output/artifacts'), 0o555);
    await chmod(resolve(tmp, 'output/approvals'), 0o555);
    await chmod(resolve(tmp, 'output/approvals/decision.json'), 0o444);

    const artifactParent = (await readdir(resolve(tmp, 'output/artifacts')))[0];
    const artifactPath = resolve(tmp, 'output/artifacts', artifactParent);
    await chmod(artifactPath, 0o555);
    for (const entry of await readdir(artifactPath)) {
      await chmod(resolve(artifactPath, entry), 0o444);
    }

    try {
      const result = await verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        { readinessOutputRel: 'readiness/readonly-inputs.json' },
      );

      expect(result.report.ready).toBe(true);
    } finally {
      await chmod(resolve(tmp, 'output/video.mp4'), 0o644);
      await chmod(resolve(tmp, 'output/audit'), 0o755);
      await chmod(resolve(tmp, 'output/audit/shared.json'), 0o644);
      await chmod(resolve(tmp, 'output/artifacts'), 0o755);
      await chmod(resolve(tmp, 'output/approvals'), 0o755);
      await chmod(resolve(tmp, 'output/approvals/decision.json'), 0o644);
      await chmod(artifactPath, 0o755);
      for (const entry of await readdir(artifactPath)) {
        await chmod(resolve(artifactPath, entry), 0o644);
      }
    }
  });

  it('leaves input file metadata unchanged on success', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const tracked = [
      resolve(tmp, 'output/video.mp4'),
      resolve(tmp, 'output/audit/shared.json'),
      resolve(tmp, 'output/approvals/decision.json'),
    ];
    const beforeStats: Record<string, { size: number; mtimeMs: number }> = {};
    for (const p of tracked) {
      const s = await stat(p);
      beforeStats[p] = { size: Number(s.size), mtimeMs: s.mtimeMs };
    }

    await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      { readinessOutputRel: 'readiness/input-invariance.json' },
    );

    for (const p of tracked) {
      const s = await stat(p);
      expect(Number(s.size)).toBe(beforeStats[p].size);
      expect(s.mtimeMs).toBe(beforeStats[p].mtimeMs);
    }
  });

  it('rejects a readiness parent directory swap before the final link and does not publish outside the intended directory', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const readinessParent = resolve(tmp, 'output/readiness');
    const readinessParentOld = `${readinessParent}-old`;
    const foreign = resolve(tmp, 'foreign-readiness');
    await mkdir(readinessParent, { recursive: true });
    await mkdir(foreign, { recursive: true });

    const outputRel = 'readiness/parent-swap-link.json';

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: {
            beforeRename: async (ctx) => {
              await rename(readinessParent, readinessParentOld);
              await symlink(foreign, readinessParent);
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION',
    );

    // No report should land in the foreign directory or under the old directory.
    expect((await readdir(foreign)).length).toBe(0);
    for (const entry of await readdir(readinessParentOld)) {
      expect(entry).not.toMatch(/\.json$/);
    }
  });

  it('rejects an MP4 tampered after its own final verification but while another input is being verified', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const mp4Path = resolve(tmp, 'output/video.mp4');
    let auditArtifactHashCount = 0;

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: 'readiness/cross-input-race.json',
          __testHooks: {
            beforeInputHash: (label) => {
              if (label === 'Audit output artifact') {
                auditArtifactHashCount += 1;
                if (auditArtifactHashCount === 2) {
                  // Second hash is during the final publish-boundary verification.
                  // Tamper the MP4 after it has already been re-verified but while
                  // the audit artifact is still being re-verified.
                  return writeFile(mp4Path, Buffer.from('tampered-cross-input'));
                }
              }
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );
  });

  it('makes the temp read-only and leaves no temp alias after atomic publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const readinessRel = 'readiness/no-alias.json';
    const finalName = readinessRel.split('/').pop()!;
    const result = await verifyReleaseReadiness(
      tmp,
      'output/video.mp4',
      'output/audit/shared.json',
      'output/approvals/decision.json',
      {
        readinessOutputRel: readinessRel,
        __testHooks: {
          beforeRename: async ({ dirPath }) => {
            // The temp is anonymous: the directory must contain no entry yet.
            const entries = await readdir(dirPath);
            expect(entries).toHaveLength(0);
          },
        },
      },
    );

    const finalPath = resolve(tmp, 'output', readinessRel);
    const finalStat = await stat(finalPath);
    expect(finalStat.isFile()).toBe(true);
    expect(finalStat.mode & 0o777).toBe(0o400);
    expect(result.reportPath).toBe(finalPath);

    const dirPath = resolve(tmp, 'output', 'readiness');
    const entries = await readdir(dirPath);
    const tmpNames = entries.filter((e) => e.startsWith('.') && e.endsWith('.tmp'));
    expect(tmpNames).toHaveLength(0);
    expect(entries).toContain(finalName);
  });


  it('rejects an unsupported platform before any publish side effect', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          { readinessOutputRel: 'readiness/unsupported.json' },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ReadinessError && (err as ReadinessError).code === 'UNSUPPORTED_PLATFORM',
      );

      const outputDir = resolve(tmp, 'output', 'readiness');
      await expect(stat(outputDir)).rejects.toThrow();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('preserves the original output/readiness directory mode when cleanup cannot create the temp', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    // Pre-create the output/readiness directory so the writer does not remove it on cleanup.
    const dirPath = resolve(tmp, 'output', 'readiness');
    await mkdir(dirPath, { recursive: true });
    const readinessRel = 'readiness/dir-mode.json';

    await expect(
      verifyReleaseReadiness(tmp, 'output/video.mp4', 'output/audit/shared.json', 'output/approvals/decision.json', {
        readinessOutputRel: readinessRel,
        __testHooks: {
          beforeBarrier: async ({ dirFh }) => {
            // Make the directory read-only so temp creation fails.
            await dirFh.chmod(0o500);
          },
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
    );

    const dirStat = await stat(dirPath);
    // The original directory mode must be restored after the failed cleanup.
    expect(dirStat.mode & 0o777).toBe(0o755);
  });

  it('rejects an output ancestor swap before publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputPath = resolve(tmp, 'output');
    const readinessRel = 'readiness/ancestor-swap.json';

    await expect(
      verifyReleaseReadiness(tmp, 'output/video.mp4', 'output/audit/shared.json', 'output/approvals/decision.json', {
        readinessOutputRel: readinessRel,
        __testHooks: {
          beforeBarrier: async () => {
            // Swap the output directory for a new directory with the same path.
            await rename(outputPath, `${outputPath}-real`);
            await mkdir(outputPath, 0o755);
          },
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReadinessError && (err as ReadinessError).code === 'OUTPUT_COLLISION',
    );

    const entries = await readdir(resolve(tmp, 'output', 'readiness')).catch(() => []);
    expect(entries).not.toContain('ancestor-swap.json');
  });

  for (const label of ['MP4', 'Audit output artifact', 'Generation audit manifest', 'Approval decision']) {
    it(`rejects ${label} changed between the initial read and the final publish boundary`, async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const inputPaths: Record<string, string> = {};
      const readinessRel = `readiness/input-changed-${label.replace(/\s+/g, '-').toLowerCase()}.json`;

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: readinessRel,
            __testHooks: {
              beforeInputOpen: (l, resolvedPath) => {
                inputPaths[l] = resolvedPath;
              },
              beforeRename: async () => {
                const targetPath = inputPaths[label];
                if (targetPath) {
                  await writeFile(targetPath, Buffer.from(`tampered-${label}`));
                }
              },
            },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
      );

      const entries = await readdir(resolve(tmp, 'output', 'readiness')).catch(() => []);
      expect(entries).not.toContain(readinessRel.split('/').pop());
    });
  }

  it('does not chmod the output directory to 0 when a failure occurs before the directory mode is captured', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const outputDir = resolve(tmp, 'output');
    await chmod(outputDir, 0o555);

    try {
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: 'readiness/mode-capture-failure.json',
          },
        ),
      ).rejects.toSatisfy((err: unknown) => err instanceof ReadinessError);

      const outputStat = await stat(outputDir);
      // The original read-only mode must be preserved; in particular it must not
      // have been clobbered to 0o000 before the mode was captured.
      expect(outputStat.mode & 0o777).toBe(0o555);
    } finally {
      await chmod(outputDir, 0o755);
    }
  });

  for (const invalidRel of [
    'readiness/../audit/escape.json',
    'readiness/./escape.json',
    'readiness//escape.json',
    'readiness',
    'readiness/',
    'readiness/escape' + String.fromCharCode(0) + '.json',
    '/etc/absolute.json',
    'readiness/sub/../escape.json',
    'output/readiness/../audit/escape.json',
  ]) {
    it(`rejects an invalid readiness output path: ${JSON.stringify(invalidRel)}`, async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: invalidRel,
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ReadinessError && (err as ReadinessError).code === 'INVALID_OUTPUT_PATH',
      );
    });
  }

  it('rejects an input modified between the final re-verification and the no-replace publish', async () => {
    await copySharedVideoTo(tmp);
    await copyAuditTo(tmp);
    await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

    const inputPaths: Record<string, string> = {};
    const readinessRel = 'readiness/input-race-publish.json';

    await expect(
      verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: readinessRel,
          __testHooks: {
            beforeInputOpen: (l, resolvedPath) => {
              inputPaths[l] = resolvedPath;
            },
            beforePublish: async () => {
              const targetPath = inputPaths['MP4'];
              if (targetPath) {
                await writeFile(targetPath, Buffer.from('tampered-at-publish'));
              }
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
    );

    const reportPath = resolve(tmp, 'output', readinessRel);
    await expect(stat(reportPath)).rejects.toThrow();
  });




  for (const label of ['MP4', 'Audit output artifact', 'Generation audit manifest', 'Approval decision']) {
    it(`rejects ${label} modified between the final stat and the renameat2 syscall`, async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const inputPaths: Record<string, string> = {};
      const readinessRel = `readiness/renameat2-race-${label.replace(/\s+/g, '-').toLowerCase()}.json`;

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: readinessRel,
            __testHooks: {
              beforeInputOpen: (l, resolvedPath) => {
                inputPaths[l] = resolvedPath;
              },
              beforeRenameat2: async () => {
                const targetPath = inputPaths[label];
                if (targetPath) {
                  await writeFile(targetPath, Buffer.from(`tampered-${label}`));
                }
              },
            },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ReadinessError && (err as ReadinessError).code === 'INPUT_CHANGED',
      );

      const outputAbs = resolve(tmp, 'output', readinessRel);
      expect(await stat(outputAbs).catch(() => null)).toBeNull();
    });
  }

  describe('ffprobeFromBuffer subprocess contract', () => {
    it('probes a valid MP4 buffer', async () => {
      const probe = await ffprobeFromBuffer(await readFile(sharedVideoPath));
      expect(probe.hasVideo).toBe(true);
      expect(probe.width).toBe(1080);
      expect(probe.height).toBe(1920);
      expect(probe.fps).toBe(30);
    });

    it('rejects stdout flood from a misbehaving child', async () => {
      await expect(
        ffprobeFromBuffer(Buffer.alloc(0), {
          command: 'sh',
          args: ['-c', 'while true; do printf x; done'],
          maxOutputBytes: 1024,
          timeoutMs: 2000,
        }),
      ).rejects.toThrow(/stdout exceeded/);
    });

    it('rejects stderr flood from a misbehaving child', async () => {
      await expect(
        ffprobeFromBuffer(Buffer.alloc(0), {
          command: 'sh',
          args: ['-c', 'while true; do echo error >&2; done'],
          maxStderrBytes: 1024,
          timeoutMs: 2000,
        }),
      ).rejects.toThrow(/stderr exceeded/);
    });

    it('rejects an unresponsive (hang) child with a timeout', async () => {
      const start = Date.now();
      await expect(
        ffprobeFromBuffer(Buffer.alloc(0), {
          command: 'sleep',
          args: ['10'],
          timeoutMs: 100,
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('rejects an early abnormal child exit', async () => {
      await expect(
        ffprobeFromBuffer(Buffer.alloc(0), {
          command: 'false',
        }),
      ).rejects.toThrow(/failed with 1/);
    });
  });

  describe('publish helper subprocess failure paths', () => {
    async function fdCount(): Promise<number> {
      return (await readdir('/proc/self/fd')).length;
    }

    it('does not leak parent directory fds when the helper command is missing', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const baseline = await fdCount();
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: 'readiness/missing-helper.json',
            __testHooks: {
              publishHelperCommand: '/nonexistent/readiness-helper',
            },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );
      expect(await fdCount()).toBe(baseline);

      // A subsequent normal run still succeeds.
      const tmp2 = tmpRoot();
      try {
        await copySharedVideoTo(tmp2);
        await copyAuditTo(tmp2);
        await makeDecision(tmp2, 'output/approvals/decision.json', sharedSha);
        const result = await verifyReleaseReadiness(
          tmp2,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          { readinessOutputRel: 'readiness/after-missing-helper.json' },
        );
        expect(result.report.ready).toBe(true);
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    });

    it('does not leak parent directory fds when the helper times out', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const baseline = await fdCount();
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: 'readiness/timeout-helper.json',
            __testHooks: {
              publishHelperTimeoutMs: 50,
              publishHelperScript: 'import time\ntime.sleep(60)\n',
            },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );
      expect(await fdCount()).toBe(baseline);

      const tmp2 = tmpRoot();
      try {
        await copySharedVideoTo(tmp2);
        await copyAuditTo(tmp2);
        await makeDecision(tmp2, 'output/approvals/decision.json', sharedSha);
        const result = await verifyReleaseReadiness(
          tmp2,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          { readinessOutputRel: 'readiness/after-timeout.json' },
        );
        expect(result.report.ready).toBe(true);
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    });

    it('does not leak parent directory fds when the helper emits malformed JSON', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const baseline = await fdCount();
      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: 'readiness/malformed-helper.json',
            __testHooks: {
              publishHelperScript: 'print("not-json")\n',
            },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );
      expect(await fdCount()).toBe(baseline);

      const tmp2 = tmpRoot();
      try {
        await copySharedVideoTo(tmp2);
        await copyAuditTo(tmp2);
        await makeDecision(tmp2, 'output/approvals/decision.json', sharedSha);
        const result = await verifyReleaseReadiness(
          tmp2,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          { readinessOutputRel: 'readiness/after-malformed.json' },
        );
        expect(result.report.ready).toBe(true);
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    });

    it('seals the report snapshot so a same-owner write returns EPERM', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/seal-check.json';
      const outputAbs = resolve(tmp, 'output', outputRel);
      const result = await verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: { reportSealCheck: true },
        },
      );

      expect(result.report.ready).toBe(true);
      const written = JSON.parse(await readFile(outputAbs, 'utf8')) as ReadinessReport;
      expect(written.ready).toBe(true);
    });

    it('recovers when the helper exits after a successful link and the final matches the expected report', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/post-link-fail.json';
      const outputAbs = resolve(tmp, 'output', outputRel);

      const result = await verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: { postLinkFail: true },
        },
      );

      // os.link is the final commit; the TypeScript caller must verify the
      // linked final and return success when it matches the expected report.
      expect(result.report.ready).toBe(true);
      const finalStat = await stat(outputAbs);
      expect(finalStat.isFile()).toBe(true);
      const finalContent = await readFile(outputAbs, 'utf8');
      expect(finalContent).toContain('"ready": true');
    });

    it('recovers when the helper prints malformed JSON after a successful link', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/post-link-malformed.json';
      const outputAbs = resolve(tmp, 'output', outputRel);

      const result = await verifyReleaseReadiness(
        tmp,
        'output/video.mp4',
        'output/audit/shared.json',
        'output/approvals/decision.json',
        {
          readinessOutputRel: outputRel,
          __testHooks: { postLinkMalformed: true },
        },
      );

      expect(result.report.ready).toBe(true);
      const finalContent = await readFile(outputAbs, 'utf8');
      expect(finalContent).toContain('"ready": true');
    });

    it('rejects and does not delete a foreign final that replaces the linked report', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/post-link-foreign.json';
      const outputAbs = resolve(tmp, 'output', outputRel);

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: outputRel,
            __testHooks: { postLinkForeignReplace: true },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );

      // The foreign replacement must not be deleted by the verifier.
      const finalContent = await readFile(outputAbs, 'utf8');
      expect(finalContent).toBe('foreign replacement');
    });

    it('rejects a same-bytes foreign final that is not the linked report inode', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/post-link-same-bytes.json';
      const outputAbs = resolve(tmp, 'output', outputRel);

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: outputRel,
            __testHooks: { postLinkReplaceSameBytes: true },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );

      // The foreign replacement must not be deleted, and must be a regular file
      // with the expected bytes (i.e. not a stale unlinked inode).
      const finalContent = await readFile(outputAbs, 'utf8');
      expect(finalContent).toContain('"ready": true');
    });

    it('rejects a linked final that grows after the helper links it', async () => {
      await copySharedVideoTo(tmp);
      await copyAuditTo(tmp);
      await makeDecision(tmp, 'output/approvals/decision.json', sharedSha);

      const outputRel = 'readiness/post-link-grow.json';
      const outputAbs = resolve(tmp, 'output', outputRel);

      await expect(
        verifyReleaseReadiness(
          tmp,
          'output/video.mp4',
          'output/audit/shared.json',
          'output/approvals/decision.json',
          {
            readinessOutputRel: outputRel,
            __testHooks: { postLinkGrow: true },
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ReadinessError && (err as ReadinessError).code === 'WRITE_FAILED',
      );

      // The grown final must not be deleted; it should contain the extra bytes.
      const finalContent = await readFile(outputAbs, 'utf8');
      expect(finalContent.endsWith('extra')).toBe(true);
    });
  });
});
