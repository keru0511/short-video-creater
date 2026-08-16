import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonicalSha256 } from '../src/approval.js';
import { sha256File } from '../src/utils.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tsxCli = resolve(repoRoot, 'node_modules/.bin/tsx');

function tmpRoot(): string {
  return mkdtempSync(resolve(tmpdir(), 'approval-cli-'));
}

async function writeJson(root: string, relPath: string, data: unknown): Promise<void> {
  const absPath = resolve(root, relPath);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  await writeFile(absPath, JSON.stringify(data, null, 2) + '\n');
}

async function makeArtifact(root: string, identifier: string, content: string): Promise<string> {
  const absPath = resolve(root, identifier);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  await writeFile(absPath, content);
  return sha256File(absPath);
}

function makeRequest(
  action: 'publish' | 'delete' | 'external-send',
  artifact: string,
  artifactSha256: string,
) {
  return { action, artifact, artifactSha256 };
}

function makeReceipt(
  request: { action: string; artifact: string; artifactSha256: string },
  requestHash: string,
  approved: boolean,
  approver: string,
  approvedAt: string,
  expiresAt: string,
) {
  return {
    requestHash,
    action: request.action,
    artifact: request.artifact,
    artifactSha256: request.artifactSha256,
    approved,
    approver,
    approvedAt,
    expiresAt,
  };
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile('node', [tsxCli, 'src/approval-cli.ts', ...args], { cwd: repoRoot }, (err, stdout, stderr) => {
      const exitCode = err && 'code' in err && typeof err.code === 'number' ? err.code : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
}

describe('approval-cli', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('approves a valid publish request', async () => {
    const now = '2026-07-31T12:00:00Z';
    const artifactSha = await makeArtifact(root, 'output/publish/video.mp4', 'hello world');
    const request = makeRequest('publish', 'output/publish/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      '2026-07-31T11:59:00Z',
      '2026-07-31T12:01:00Z',
    );
    await writeJson(root, 'requests/publish.json', request);
    await writeJson(root, 'receipts/publish.json', receipt);

    const { stdout, stderr, exitCode } = await runCli([
      '--project-root', root,
      '--request', 'requests/publish.json',
      '--receipt', 'receipts/publish.json',
      '--now', now,
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(true);
    expect(result.reasonCode).toBe('APPROVED');
    expect(result.decisionPath).toBe(resolve(root, 'output/approvals', `${requestHash}.json`));
    expect(stderr).toBe('');
  });

  it('denies an expired approval', async () => {
    const now = '2026-07-31T12:00:00Z';
    const artifactSha = await makeArtifact(root, 'output/expired/video.mp4', 'x');
    const request = makeRequest('publish', 'output/expired/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      '2026-07-31T11:55:00Z',
      '2026-07-31T11:56:00Z',
    );
    await writeJson(root, 'requests/expired.json', request);
    await writeJson(root, 'receipts/expired.json', receipt);

    const { stdout, stderr, exitCode } = await runCli([
      '--project-root', root,
      '--request', 'requests/expired.json',
      '--receipt', 'receipts/expired.json',
      '--now', now,
    ]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(false);
    expect(result.decision.decision).toBe('denied');
    expect(result.reasonCode).toBe('APPROVAL_EXPIRED');
  });

  it('fails when required arguments are missing', async () => {
    const { exitCode, stdout } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('Usage:');
  });

  it('fails when the project root does not exist', async () => {
    const { exitCode, stderr } = await runCli([
      '--project-root', resolve(root, 'nonexistent'),
      '--request', 'requests/r.json',
      '--receipt', 'receipts/r.json',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBeTruthy();
  });

  it('fails with a malformed request', async () => {
    await mkdir(resolve(root, 'requests'), { recursive: true });
    await writeFile(resolve(root, 'requests/malformed.json'), '{"action":"publish",}', 'utf-8');

    const { exitCode, stderr } = await runCli([
      '--project-root', root,
      '--request', 'requests/malformed.json',
      '--receipt', 'receipts/malformed.json',
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stderr);
    expect(result.approved).toBe(false);
    expect(result.error).toBe('MALFORMED_REQUEST');
  });

  it('fails with an invalid canonical artifact identifier', async () => {
    const now = '2026-07-31T12:00:00Z';
    const artifactSha = await makeArtifact(root, 'output/x/video.mp4', 'x');
    const request = makeRequest('publish', 'output//x/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      '2026-07-31T11:59:00Z',
      '2026-07-31T12:01:00Z',
    );
    await writeJson(root, 'requests/bad-id.json', request);
    await writeJson(root, 'receipts/bad-id.json', receipt);

    const { exitCode, stdout } = await runCli([
      '--project-root', root,
      '--request', 'requests/bad-id.json',
      '--receipt', 'receipts/bad-id.json',
      '--now', now,
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_PATH_REJECTED');
  });

  it('redacts an absolute-path artifact in a denied decision', async () => {
    const now = '2026-07-31T12:00:00Z';
    const secret = '/home/user/secret-name.mp4';
    const artifactSha = await makeArtifact(root, 'output/secret/video.mp4', 'x');
    const request = makeRequest('publish', secret, '0'.repeat(64));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      false,
      'alice',
      '2026-07-31T11:59:00Z',
      '2026-07-31T12:01:00Z',
    );
    await writeJson(root, 'requests/secret.json', request);
    await writeJson(root, 'receipts/secret.json', receipt);

    const { exitCode, stdout } = await runCli([
      '--project-root', root,
      '--request', 'requests/secret.json',
      '--receipt', 'receipts/secret.json',
      '--now', now,
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(false);
    expect(result.decision.artifact).toBe('[INVALID_ARTIFACT_IDENTIFIER]');
    expect(result.decision.artifactSha256).toBe('0'.repeat(64));
    expect(JSON.stringify(result.decision)).not.toContain(secret);
  });

  it('rejects February 30 as invalid timestamp', async () => {
    const now = '2026-07-31T12:00:00Z';
    const artifactSha = await makeArtifact(root, 'output/cal/video.mp4', 'x');
    const request = makeRequest('publish', 'output/cal/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      '2026-02-30T12:00:00Z',
      '2026-02-30T13:00:00Z',
    );
    await writeJson(root, 'requests/cal.json', request);
    await writeJson(root, 'receipts/cal.json', receipt);

    const { exitCode, stdout } = await runCli([
      '--project-root', root,
      '--request', 'requests/cal.json',
      '--receipt', 'receipts/cal.json',
      '--now', now,
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
  });

  it('accepts leap-year offset timestamp and round-trips', async () => {
    const now = '2024-02-29T12:00:30Z';
    const artifactSha = await makeArtifact(root, 'output/leap-offset/video.mp4', 'x');
    const request = makeRequest('publish', 'output/leap-offset/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      '2024-02-29T21:00:00+09:00',
      '2024-02-29T21:01:00+09:00',
    );
    await writeJson(root, 'requests/leap-offset.json', request);
    await writeJson(root, 'receipts/leap-offset.json', receipt);

    const { exitCode, stdout, stderr } = await runCli([
      '--project-root', root,
      '--request', 'requests/leap-offset.json',
      '--receipt', 'receipts/leap-offset.json',
      '--now', now,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout);
    expect(result.approved).toBe(true);
    expect(result.reasonCode).toBe('APPROVED');
  });

  it('rejects an invalid now timestamp', async () => {
    const artifactSha = await makeArtifact(root, 'output/now-bad/video.mp4', 'x');
    const request = makeRequest('publish', 'output/now-bad/video.mp4', artifactSha);
    await writeJson(root, 'requests/now-bad.json', request);

    const { exitCode, stderr } = await runCli([
      '--project-root', root,
      '--request', 'requests/now-bad.json',
      '--receipt', 'receipts/now-bad.json',
      '--now', '2026-02-30T12:00:00Z',
    ]);
    expect(exitCode).toBe(1);
    const result = JSON.parse(stderr);
    expect(result.error).toBe('INVALID_TIMESTAMP');
  });
});
