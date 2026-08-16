import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, rm, writeFile, link, symlink, readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyApproval, ApprovalError, canonicalSha256, APPROVAL_SCHEMA_VERSION } from '../src/approval.js';
import { sha256File } from '../src/utils.js';

function tmpRoot(): string {
  return mkdtempSync(resolve(tmpdir(), 'approval-'));
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

describe('verifyApproval', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('approves a valid publish request', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/publish/video.mp4', 'hello world');
    const request = makeRequest('publish', 'output/publish/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/publish.json', request);
    await writeJson(root, 'receipts/publish.json', receipt);

    const result = await verifyApproval(root, 'requests/publish.json', 'receipts/publish.json', { now: new Date(now) });

    expect(result.approved).toBe(true);
    expect(result.reasonCode).toBe('APPROVED');
    expect(result.decision.action).toBe('publish');
    expect(result.decision.decision).toBe('approved');
    expect(result.decision.artifact).toBe('output/publish/video.mp4');
    expect(result.decision.approver).toBe('alice');
    expect(result.decisionPath).toBe(resolve(root, 'output/approvals', `${requestHash}.json`));
    expect(result.decisionSha256).toHaveLength(64);

    const decisionText = await readFile(result.decisionPath, 'utf-8');
    const decision = JSON.parse(decisionText);
    expect(decision.schemaVersion).toBe(APPROVAL_SCHEMA_VERSION);
    expect(decision.requestSha256).toBe(requestHash);
    expect(decision.action).toBe('publish');
    expect(decision.decision).toBe('approved');
    expect(decision.reasonCode).toBe('APPROVED');
    expect(decision.approver).toBe('alice');
    expect(decision.verifiedAt).toBe(new Date(now).toISOString());
  });

  it('produces identical decision records and SHA-256 for identical inputs and now', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/publish/video.mp4', 'hello world');
    const request = makeRequest('publish', 'output/publish/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/publish.json', request);
    await writeJson(root, 'receipts/publish.json', receipt);

    const a = await verifyApproval(root, 'requests/publish.json', 'receipts/publish.json', { now: new Date(now) });
    await rm(a.decisionPath, { force: true });
    const b = await verifyApproval(root, 'requests/publish.json', 'receipts/publish.json', { now: new Date(now) });

    expect(a.decisionSha256).toBe(b.decisionSha256);
    expect(JSON.stringify(a.decision, Object.keys(a.decision).sort())).toBe(
      JSON.stringify(b.decision, Object.keys(b.decision).sort()),
    );
  });

  it('rejects a denied receipt', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/deny/video.mp4', 'denied content');
    const request = makeRequest('delete', 'output/deny/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      false,
      'bob',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/deny.json', request);
    await writeJson(root, 'receipts/deny.json', receipt);

    const result = await verifyApproval(root, 'requests/deny.json', 'receipts/deny.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('APPROVAL_DENIED');
    expect(result.decision.decision).toBe('denied');
    expect(result.decision.approver).toBe('bob');
  });

  it('rejects a missing receipt', async () => {
    const artifactSha = await makeArtifact(root, 'output/missing/video.mp4', 'x');
    const request = makeRequest('external-send', 'output/missing/video.mp4', artifactSha);
    await writeJson(root, 'requests/missing.json', request);

    const result = await verifyApproval(root, 'requests/missing.json', 'receipts/missing.json');

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
    expect(result.decision.decision).toBe('denied');
    expect(result.decision.approver).toBe(null);
  });

  it('rejects a malformed request', async () => {
    await mkdir(resolve(root, 'requests'), { recursive: true });
    await writeFile(resolve(root, 'requests/malformed.json'), '{"action":"publish",}', 'utf-8');
    await expect(
      verifyApproval(root, 'requests/malformed.json', 'receipts/malformed.json'),
    ).rejects.toBeInstanceOf(ApprovalError);
  });

  it('rejects a request with an unknown action', async () => {
    const artifactSha = await makeArtifact(root, 'output/unknown/video.mp4', 'x');
    const request = { action: 'share', artifact: 'output/unknown/video.mp4', artifactSha256: artifactSha };
    await writeJson(root, 'requests/unknown.json', request);

    await expect(
      verifyApproval(root, 'requests/unknown.json', 'receipts/unknown.json'),
    ).rejects.toSatisfy((err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INVALID_REQUEST');
  });

  it('rejects an unknown field in the request', async () => {
    const artifactSha = await makeArtifact(root, 'output/extra/video.mp4', 'x');
    const request = { action: 'publish', artifact: 'output/extra/video.mp4', artifactSha256: artifactSha, extra: 1 };
    await writeJson(root, 'requests/extra.json', request);

    await expect(verifyApproval(root, 'requests/extra.json', 'receipts/extra.json')).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INVALID_REQUEST',
    );
  });

  it('rejects duplicate keys in the request', async () => {
    await mkdir(resolve(root, 'requests'), { recursive: true });
    const bad = '{"action":"publish","action":"delete","artifact":"output/dup/video.mp4","artifactSha256":"' + '0'.repeat(64) + '"}';
    await writeFile(resolve(root, 'requests/dup.json'), bad, 'utf-8');

    await expect(verifyApproval(root, 'requests/dup.json', 'receipts/dup.json')).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'MALFORMED_REQUEST',
    );
  });

  it('rejects request/receipt hash mismatch', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/hash/video.mp4', 'x');
    const request = makeRequest('publish', 'output/hash/video.mp4', artifactSha);
    const receipt = makeReceipt(
      request,
      '0'.repeat(64),
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/hash.json', request);
    await writeJson(root, 'receipts/hash.json', receipt);

    const result = await verifyApproval(root, 'requests/hash.json', 'receipts/hash.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('REQUEST_HASH_MISMATCH');
  });

  it('rejects action mismatch', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/action/video.mp4', 'x');
    const request = makeRequest('publish', 'output/action/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      { ...request, action: 'delete' },
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/action.json', request);
    await writeJson(root, 'receipts/action.json', receipt);

    const result = await verifyApproval(root, 'requests/action.json', 'receipts/action.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ACTION_MISMATCH');
  });

  it('rejects artifact mismatch', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/artifact-a/video.mp4', 'a');
    const request = makeRequest('publish', 'output/artifact-a/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const otherSha = await sha256File(resolve(root, 'output/artifact-a/video.mp4'));
    const receipt = makeReceipt(
      { ...request, artifact: 'output/artifact-b/video.mp4' },
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/artifact.json', request);
    await writeJson(root, 'receipts/artifact.json', receipt);

    const result = await verifyApproval(root, 'requests/artifact.json', 'receipts/artifact.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_MISMATCH');
  });

  it('rejects artifact hash mismatch', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    await makeArtifact(root, 'output/artifact-hash/video.mp4', 'real');
    const request = makeRequest('publish', 'output/artifact-hash/video.mp4', '0'.repeat(64));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/artifact-hash.json', request);
    await writeJson(root, 'receipts/artifact-hash.json', receipt);

    const result = await verifyApproval(root, 'requests/artifact-hash.json', 'receipts/artifact-hash.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_HASH_MISMATCH');
  });

  it('rejects an expired approval', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/expired/video.mp4', 'x');
    const request = makeRequest('publish', 'output/expired/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 2000).toISOString(),
      new Date(now - 1000).toISOString(),
    );
    await writeJson(root, 'requests/expired.json', request);
    await writeJson(root, 'receipts/expired.json', receipt);

    const result = await verifyApproval(root, 'requests/expired.json', 'receipts/expired.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('APPROVAL_EXPIRED');
  });

  it('rejects a future approvedAt timestamp', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/future/video.mp4', 'x');
    const request = makeRequest('publish', 'output/future/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now + 1000).toISOString(),
      new Date(now + 2000).toISOString(),
    );
    await writeJson(root, 'requests/future.json', request);
    await writeJson(root, 'receipts/future.json', receipt);

    const result = await verifyApproval(root, 'requests/future.json', 'receipts/future.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('FUTURE_TIMESTAMP');
  });

  it('rejects invalid timestamp order', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/ts/video.mp4', 'x');
    const request = makeRequest('publish', 'output/ts/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now - 2000).toISOString(),
    );
    await writeJson(root, 'requests/ts.json', request);
    await writeJson(root, 'receipts/ts.json', receipt);

    const result = await verifyApproval(root, 'requests/ts.json', 'receipts/ts.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
  });

  it('rejects a missing artifact', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const request = makeRequest('publish', 'output/missing-artifact/video.mp4', '0'.repeat(64));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/missing-artifact.json', request);
    await writeJson(root, 'receipts/missing-artifact.json', receipt);

    const result = await verifyApproval(root, 'requests/missing-artifact.json', 'receipts/missing-artifact.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_NOT_FOUND');
  });

  it('rejects an artifact that is a symbolic link', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const target = resolve(root, 'output/real/video.mp4');
    await makeArtifact(root, 'output/real/video.mp4', 'x');
    const symlinkPath = resolve(root, 'output/symlink/video.mp4');
    await mkdir(resolve(symlinkPath, '..'), { recursive: true });
    await symlink(target, symlinkPath);
    const request = makeRequest('publish', 'output/symlink/video.mp4', await sha256File(target));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/symlink.json', request);
    await writeJson(root, 'receipts/symlink.json', receipt);

    const result = await verifyApproval(root, 'requests/symlink.json', 'receipts/symlink.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_SYMLINK');
  });

  it('rejects a decision output path that collides with the request file', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/collision/video.mp4', 'x');
    const request = makeRequest('publish', 'output/collision/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    await writeJson(root, `output/approvals/${requestHash}.json`, request);

    await expect(
      verifyApproval(root, `output/approvals/${requestHash}.json`, 'receipts/collision.json', { now: new Date(now) }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'DECISION_COLLISION',
    );
  });

  it('rejects a decision output path that collides with the receipt file', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/collision/video.mp4', 'x');
    const request = makeRequest('publish', 'output/collision/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/collision.json', request);
    await writeJson(root, `output/approvals/${requestHash}.json`, receipt);

    await expect(
      verifyApproval(root, 'requests/collision.json', `output/approvals/${requestHash}.json`, { now: new Date(now) }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'DECISION_COLLISION',
    );
  });

  it('rejects a decision output path that is a symlink to the artifact', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/symlink/video.mp4', 'x');
    const request = makeRequest('publish', 'output/symlink/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/symlink-decision.json', request);
    await writeJson(root, 'receipts/symlink-decision.json', receipt);
    await mkdir(resolve(root, 'output/approvals'), { recursive: true });
    await symlink(resolve(root, 'output/symlink/video.mp4'), resolve(root, `output/approvals/${requestHash}.json`));

    await expect(
      verifyApproval(root, 'requests/symlink-decision.json', 'receipts/symlink-decision.json', { now: new Date(now) }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'DECISION_COLLISION',
    );
  });

  it('rejects a decision output that shares an inode with the artifact', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/hardlink/video.mp4', 'shared');
    const request = makeRequest('publish', 'output/hardlink/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/hardlink.json', request);
    await writeJson(root, 'receipts/hardlink.json', receipt);
    await mkdir(resolve(root, 'output/approvals'), { recursive: true });
    await link(resolve(root, 'output/hardlink/video.mp4'), resolve(root, `output/approvals/${requestHash}.json`));

    await expect(
      verifyApproval(root, 'requests/hardlink.json', 'receipts/hardlink.json', { now: new Date(now) }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'DECISION_COLLISION',
    );
  });

  it('allows a hidden directory component in the artifact identifier', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/.hidden/video.mp4', 'x');
    const request = makeRequest('publish', 'output/.hidden/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/hidden.json', request);
    await writeJson(root, 'receipts/hidden.json', receipt);

    const result = await verifyApproval(root, 'requests/hidden.json', 'receipts/hidden.json', { now: new Date(now) });

    expect(result.approved).toBe(true);
    expect(result.reasonCode).toBe('APPROVED');
  });

  it.each([
    'output//double/video.mp4',
    'output/trailing/video.mp4/',
    'output/./dot/video.mp4',
    'output/../escape/video.mp4',
    'output\\\\backslash\\\\video.mp4',
    '/output/absolute/video.mp4',
    'C:/output/drive/video.mp4',
    '\\\\\\\\server/share/video.mp4',
    'output',
    'notoutput/video.mp4',
    './output/relative/video.mp4',
  ])('rejects non-canonical artifact identifier %s', async (identifier) => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const request = makeRequest('publish', identifier, '0'.repeat(64));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/noncanon.json', request);
    await writeJson(root, 'receipts/noncanon.json', receipt);

    const result = await verifyApproval(root, 'requests/noncanon.json', 'receipts/noncanon.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_PATH_REJECTED');
  });

  it('rejects an artifact identifier when output is a symbolic link', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    await mkdir(resolve(root, 'realdir'), { recursive: true });
    await symlink(resolve(root, 'realdir'), resolve(root, 'output'));
    const request = makeRequest('publish', 'output/x/video.mp4', '0'.repeat(64));
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/symlink-output.json', request);
    await writeJson(root, 'receipts/symlink-output.json', receipt);

    await expect(
      verifyApproval(root, 'requests/symlink-output.json', 'receipts/symlink-output.json', { now: new Date(now) }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'ARTIFACT_SYMLINK',
    );

    const files = await readdir(resolve(root, 'output/approvals')).catch(() => [] as string[]);
    expect(files).not.toContain(`${requestHash}.json`);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects an artifact identifier that aliases another path through a symlink', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    await makeArtifact(root, 'output/real/x/video.mp4', 'x');
    await symlink(resolve(root, 'output/real'), resolve(root, 'output/alias'));
    const artifactSha = await sha256File(resolve(root, 'output/real/x/video.mp4'));
    const request = makeRequest('publish', 'output/alias/x/video.mp4', artifactSha);
    const requestHash = canonicalSha256(request);
    const receipt = makeReceipt(
      request,
      requestHash,
      true,
      'alice',
      new Date(now - 1000).toISOString(),
      new Date(now + 1000).toISOString(),
    );
    await writeJson(root, 'requests/alias.json', request);
    await writeJson(root, 'receipts/alias.json', receipt);

    const result = await verifyApproval(root, 'requests/alias.json', 'receipts/alias.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('ARTIFACT_SYMLINK');
  });

  it('rejects an oversized request file', async () => {
    await mkdir(resolve(root, 'requests'), { recursive: true });
    await writeFile(resolve(root, 'requests/oversized.json'), 'a'.repeat(2 * 1024 * 1024));

    await expect(
      verifyApproval(root, 'requests/oversized.json', 'receipts/oversized.json'),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'MALFORMED_REQUEST',
    );
  });

  it('rejects an oversized receipt file', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/over-receipt/video.mp4', 'x');
    const request = makeRequest('publish', 'output/over-receipt/video.mp4', artifactSha);
    await writeJson(root, 'requests/over-receipt.json', request);
    await mkdir(resolve(root, 'receipts'), { recursive: true });
    await writeFile(resolve(root, 'receipts/over-receipt.json'), 'a'.repeat(2 * 1024 * 1024));

    const result = await verifyApproval(root, 'requests/over-receipt.json', 'receipts/over-receipt.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
  });

  it('rejects an invalid UTF-8 request file', async () => {
    await mkdir(resolve(root, 'requests'), { recursive: true });
    await writeFile(resolve(root, 'requests/utf8.json'), Buffer.from([0xff, 0xfe, 0x00, 0x00]));

    await expect(
      verifyApproval(root, 'requests/utf8.json', 'receipts/utf8.json'),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'MALFORMED_REQUEST',
    );
  });

  it('rejects an invalid UTF-8 receipt file', async () => {
    const now = new Date('2026-07-31T12:00:00Z').getTime();
    const artifactSha = await makeArtifact(root, 'output/utf8-receipt/video.mp4', 'x');
    const request = makeRequest('publish', 'output/utf8-receipt/video.mp4', artifactSha);
    await writeJson(root, 'requests/utf8-receipt.json', request);
    await mkdir(resolve(root, 'receipts'), { recursive: true });
    await writeFile(resolve(root, 'receipts/utf8-receipt.json'), Buffer.from([0xff, 0xfe, 0x00, 0x00]));

    const result = await verifyApproval(root, 'requests/utf8-receipt.json', 'receipts/utf8-receipt.json', { now: new Date(now) });

    expect(result.approved).toBe(false);
    expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
  });

  describe('beforeRename barrier', () => {
    async function assertNoDecisionOrTemp(rootDir: string, requestHash: string): Promise<void> {
      const files = await readdir(resolve(rootDir, 'output/approvals')).catch(() => [] as string[]);
      expect(files).not.toContain(`${requestHash}.json`);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    }

    it('rejects when the request is swapped before rename', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/race-request/video.mp4', 'x');
      const request = makeRequest('publish', 'output/race-request/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/race-request.json', request);
      await writeJson(root, 'receipts/race-request.json', receipt);

      await expect(
        verifyApproval(root, 'requests/race-request.json', 'receipts/race-request.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(
                  resolve(root, 'requests/race-request.json'),
                  JSON.stringify({ ...request, artifact: 'output/race-request/other.mp4' }) + '\n',
                );
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      await assertNoDecisionOrTemp(root, requestHash);
    });

    it('rejects when the receipt is swapped before rename', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/race-receipt/video.mp4', 'x');
      const request = makeRequest('publish', 'output/race-receipt/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/race-receipt.json', request);
      await writeJson(root, 'receipts/race-receipt.json', receipt);

      await expect(
        verifyApproval(root, 'requests/race-receipt.json', 'receipts/race-receipt.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(
                  resolve(root, 'receipts/race-receipt.json'),
                  JSON.stringify({ ...receipt, approved: false }) + '\n',
                );
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      await assertNoDecisionOrTemp(root, requestHash);
    });

    it('rejects when the artifact content is swapped before rename', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/race-artifact/video.mp4', 'x');
      const request = makeRequest('publish', 'output/race-artifact/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/race-artifact.json', request);
      await writeJson(root, 'receipts/race-artifact.json', receipt);

      await expect(
        verifyApproval(root, 'requests/race-artifact.json', 'receipts/race-artifact.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(resolve(root, 'output/race-artifact/video.mp4'), 'swapped');
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      await assertNoDecisionOrTemp(root, requestHash);
    });

    it('rejects when the artifact is truncated before rename', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/race-truncate/video.mp4', 'hello world');
      const request = makeRequest('publish', 'output/race-truncate/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/race-truncate.json', request);
      await writeJson(root, 'receipts/race-truncate.json', receipt);

      await expect(
        verifyApproval(root, 'requests/race-truncate.json', 'receipts/race-truncate.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(resolve(root, 'output/race-truncate/video.mp4'), 'x');
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      await assertNoDecisionOrTemp(root, requestHash);
    });

    it('preserves an existing decision final when a race is detected', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/preserve/video.mp4', 'x');
      const request = makeRequest('publish', 'output/preserve/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/preserve.json', request);
      await writeJson(root, 'receipts/preserve.json', receipt);

      const first = await verifyApproval(root, 'requests/preserve.json', 'receipts/preserve.json', { now: new Date(now) });
      expect(first.approved).toBe(true);
      const originalContent = await readFile(first.decisionPath, 'utf-8');
      const originalSha = await sha256File(first.decisionPath);

      await expect(
        verifyApproval(root, 'requests/preserve.json', 'receipts/preserve.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(resolve(root, 'output/preserve/video.mp4'), 'swapped');
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      const content = await readFile(first.decisionPath, 'utf-8');
      expect(content).toBe(originalContent);
      expect(await sha256File(first.decisionPath)).toBe(originalSha);
    });
  });

  describe('CLI', () => {
    function runCli(args: string[]): { status: number; output: string } {
      try {
        const stdout = execFileSync('npx', ['tsx', 'src/approval-cli.ts', ...args], {
          cwd: process.cwd(),
          encoding: 'utf-8',
          timeout: 30000,
        });
        return { status: 0, output: stdout };
      } catch (err: any) {
        return {
          status: err.status ?? 1,
          output: (err.stdout ?? '') + (err.stderr ?? ''),
        };
      }
    }

    it('approves a valid request and exits 0', async () => {
      const now = new Date('2026-07-31T12:00:00Z');
      const artifactSha = await makeArtifact(root, 'output/cli/video.mp4', 'x');
      const request = makeRequest('publish', 'output/cli/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now.getTime() - 1000).toISOString(),
        new Date(now.getTime() + 1000).toISOString(),
      );
      await writeJson(root, 'requests/cli.json', request);
      await writeJson(root, 'receipts/cli.json', receipt);

      const { status, output } = runCli([
        '--project-root', root,
        '--request', 'requests/cli.json',
        '--receipt', 'receipts/cli.json',
        '--now', now.toISOString(),
      ]);

      expect(status).toBe(0);
      const result = JSON.parse(output.trim());
      expect(result.approved).toBe(true);
      expect(result.reasonCode).toBe('APPROVED');
      expect(result.decisionPath).toBe(resolve(root, 'output/approvals', `${requestHash}.json`));
    });

    it('rejects a missing receipt and exits 1', async () => {
      const artifactSha = await makeArtifact(root, 'output/cli-missing/video.mp4', 'x');
      const request = makeRequest('publish', 'output/cli-missing/video.mp4', artifactSha);
      await writeJson(root, 'requests/cli-missing.json', request);

      const { status, output } = runCli([
        '--project-root', root,
        '--request', 'requests/cli-missing.json',
        '--receipt', 'receipts/cli-missing.json',
      ]);

      expect(status).toBe(1);
      const result = JSON.parse(output.trim());
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
    });

    it('rejects an invalid request and exits 1', async () => {
      await mkdir(resolve(root, 'requests'), { recursive: true });
      await writeFile(resolve(root, 'requests/cli-invalid.json'), '{invalid json}', 'utf-8');

      const { status, output } = runCli([
        '--project-root', root,
        '--request', 'requests/cli-invalid.json',
        '--receipt', 'receipts/cli-invalid.json',
      ]);

      expect(status).toBe(1);
      const result = JSON.parse(output.trim());
      expect(result.approved).toBe(false);
    });
  });

  describe('decision sanitization', () => {
    const secretArtifact = '/home/user/secret-name.mp4';

    function assertRedacted(result: { decision: { artifact: string; artifactSha256: string } }, secret: string): void {
      expect(result.decision.artifact).toBe('[INVALID_ARTIFACT_IDENTIFIER]');
      expect(result.decision.artifactSha256).toBe('0'.repeat(64));
      const text = JSON.stringify(result.decision);
      expect(text).not.toContain(secret);
    }

    async function assertNoTempOrFinalCorruption(requestHash: string): Promise<void> {
      const files = await readdir(resolve(root, 'output/approvals')).catch(() => [] as string[]);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
      expect(files).not.toContain(`${requestHash}.json.tmp`);
    }

    it('redacts an absolute-path artifact in a missing-receipt decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', secretArtifact, '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      await writeJson(root, 'requests/secret.json', request);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
      assertRedacted(result, secretArtifact);
      await assertNoTempOrFinalCorruption(requestHash);
      const content = await readFile(result.decisionPath, 'utf-8');
      expect(content).not.toContain(secretArtifact);
    });

    it('redacts a traversal artifact in a malformed-receipt decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', 'output/../escape/video.mp4', '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      await writeJson(root, 'requests/secret.json', request);
      await mkdir(resolve(root, 'receipts'), { recursive: true });
      await writeFile(resolve(root, 'receipts/secret.json'), '{invalid json}', 'utf-8');

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('MALFORMED_RECEIPT');
      assertRedacted(result, 'output/../escape');
      await assertNoTempOrFinalCorruption(requestHash);
    });

    it('redacts a backslash artifact in a denied decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', 'output\\x\\video.mp4', '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      const receipt = {
        requestHash,
        action: request.action,
        artifact: request.artifact,
        artifactSha256: request.artifactSha256,
        approved: false,
        approver: 'alice',
        approvedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
      };
      await writeJson(root, 'requests/secret.json', request);
      await writeJson(root, 'receipts/secret.json', receipt);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('APPROVAL_DENIED');
      assertRedacted(result, '\\\\');
      await assertNoTempOrFinalCorruption(requestHash);
    });

    it('redacts an absolute-path artifact in a hash-mismatch decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', secretArtifact, '0'.repeat(64));
      const receipt = {
        requestHash: '1'.repeat(64),
        action: request.action,
        artifact: request.artifact,
        artifactSha256: request.artifactSha256,
        approved: true,
        approver: 'alice',
        approvedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
      };
      await writeJson(root, 'requests/secret.json', request);
      await writeJson(root, 'receipts/secret.json', receipt);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('REQUEST_HASH_MISMATCH');
      assertRedacted(result, secretArtifact);
    });

    it('redacts a traversal artifact in an action-mismatch decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', 'output/../escape/video.mp4', '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      const receipt = {
        requestHash,
        action: 'delete',
        artifact: request.artifact,
        artifactSha256: request.artifactSha256,
        approved: true,
        approver: 'alice',
        approvedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
      };
      await writeJson(root, 'requests/secret.json', request);
      await writeJson(root, 'receipts/secret.json', receipt);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('ACTION_MISMATCH');
      assertRedacted(result, 'output/../escape');
    });

    it('redacts a control-character artifact in an artifact-mismatch decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const request = makeRequest('publish', 'output/\u0001ctrl/video.mp4', '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      const receipt = {
        requestHash,
        action: request.action,
        artifact: 'output/x/video.mp4',
        artifactSha256: request.artifactSha256,
        approved: true,
        approver: 'alice',
        approvedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
      };
      // write raw JSON so the control character is escaped in JSON
      const requestJson = '{"action":"publish","artifact":"output/\\u0001ctrl/video.mp4","artifactSha256":"' + '0'.repeat(64) + '"}\n';
      await mkdir(resolve(root, 'requests'), { recursive: true });
      await writeFile(resolve(root, 'requests/secret.json'), requestJson, 'utf-8');
      await writeJson(root, 'receipts/secret.json', receipt);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('ARTIFACT_MISMATCH');
      assertRedacted(result, '\u0001');
    });

    it('redacts an oversized artifact in an expired decision', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const longArtifact = 'output/' + 'a'.repeat(4096) + '/video.mp4';
      const request = makeRequest('publish', longArtifact, '0'.repeat(64));
      const requestHash = canonicalSha256(request);
      const receipt = {
        requestHash,
        action: request.action,
        artifact: request.artifact,
        artifactSha256: request.artifactSha256,
        approved: true,
        approver: 'alice',
        approvedAt: new Date(now - 2000).toISOString(),
        expiresAt: new Date(now - 1000).toISOString(),
      };
      await writeJson(root, 'requests/secret.json', request);
      await writeJson(root, 'receipts/secret.json', receipt);

      const result = await verifyApproval(root, 'requests/secret.json', 'receipts/secret.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('APPROVAL_EXPIRED');
      assertRedacted(result, 'a'.repeat(4096));
    });

    it('preserves an existing decision final when sanitization write races', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/preserve2/video.mp4', 'x');
      const request = makeRequest('publish', 'output/preserve2/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        new Date(now - 1000).toISOString(),
        new Date(now + 1000).toISOString(),
      );
      await writeJson(root, 'requests/preserve2.json', request);
      await writeJson(root, 'receipts/preserve2.json', receipt);

      const first = await verifyApproval(root, 'requests/preserve2.json', 'receipts/preserve2.json', { now: new Date(now) });
      expect(first.approved).toBe(true);
      const originalContent = await readFile(first.decisionPath, 'utf-8');
      const originalSha = await sha256File(first.decisionPath);

      const badRequest = makeRequest('publish', secretArtifact, artifactSha);
      await writeJson(root, 'requests/preserve2.json', badRequest);
      await expect(
        verifyApproval(root, 'requests/preserve2.json', 'receipts/preserve2.json', {
          now: new Date(now),
          __testHooks: {
            writeJsonAtomic: {
              beforeRename: async () => {
                await writeFile(resolve(root, 'requests/preserve2.json'), JSON.stringify({ ...badRequest, artifact: 'output/swap/video.mp4' }) + '\n');
              },
            },
          },
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INPUT_CHANGED',
      );

      const content = await readFile(first.decisionPath, 'utf-8');
      expect(content).toBe(originalContent);
      expect(await sha256File(first.decisionPath)).toBe(originalSha);
    });
  });

  describe('timestamp calendar validity', () => {
    it('rejects February 30 as invalid timestamp', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
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

      const result = await verifyApproval(root, 'requests/cal.json', 'receipts/cal.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
    });

    it('rejects April 31 as invalid timestamp', async () => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/apr/video.mp4', 'x');
      const request = makeRequest('publish', 'output/apr/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        '2026-04-31T12:00:00Z',
        '2026-04-31T13:00:00Z',
      );
      await writeJson(root, 'requests/apr.json', request);
      await writeJson(root, 'receipts/apr.json', receipt);

      const result = await verifyApproval(root, 'requests/apr.json', 'receipts/apr.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
    });

    it.each([
      ['2023-02-29T12:00:00Z', 'non-leap year February 29'],
      ['1900-02-29T12:00:00Z', 'century non-leap year'],
    ])('rejects %s (%s)', async (approvedAt) => {
      const now = new Date('2026-07-31T12:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/leap/video.mp4', 'x');
      const request = makeRequest('publish', 'output/leap/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = {
        requestHash,
        action: request.action,
        artifact: request.artifact,
        artifactSha256: request.artifactSha256,
        approved: true,
        approver: 'alice',
        approvedAt,
        expiresAt: new Date(now + 1000).toISOString(),
      };
      await writeJson(root, 'requests/leap.json', request);
      await writeJson(root, 'receipts/leap.json', receipt);

      const result = await verifyApproval(root, 'requests/leap.json', 'receipts/leap.json', { now: new Date(now) });

      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('INVALID_TIMESTAMP');
    });

    it('accepts leap-year February 29 and 2000-02-29', async () => {
      const now = new Date('2024-03-01T00:00:00Z').getTime();
      const artifactSha = await makeArtifact(root, 'output/leap-ok/video.mp4', 'x');
      const request = makeRequest('publish', 'output/leap-ok/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        '2024-02-29T12:00:00Z',
        '2024-03-01T12:00:00Z',
      );
      await writeJson(root, 'requests/leap-ok.json', request);
      await writeJson(root, 'receipts/leap-ok.json', receipt);

      const result = await verifyApproval(root, 'requests/leap-ok.json', 'receipts/leap-ok.json', { now: new Date(now) });

      expect(result.approved).toBe(true);
      expect(result.reasonCode).toBe('APPROVED');
    });

    it('round-trips timezone offsets for approvedAt/expiresAt', async () => {
      const now = new Date('2024-02-29T12:00:30Z');
      const artifactSha = await makeArtifact(root, 'output/offset/video.mp4', 'x');
      const request = makeRequest('publish', 'output/offset/video.mp4', artifactSha);
      const requestHash = canonicalSha256(request);
      const receipt = makeReceipt(
        request,
        requestHash,
        true,
        'alice',
        '2024-02-29T21:00:00+09:00',
        '2024-02-29T21:01:00+09:00',
      );
      await writeJson(root, 'requests/offset.json', request);
      await writeJson(root, 'receipts/offset.json', receipt);

      const result = await verifyApproval(root, 'requests/offset.json', 'receipts/offset.json', { now });

      expect(result.approved).toBe(true);
      expect(result.reasonCode).toBe('APPROVED');
    });

    it('rejects an invalid now timestamp', async () => {
      const artifactSha = await makeArtifact(root, 'output/now-bad/video.mp4', 'x');
      const request = makeRequest('publish', 'output/now-bad/video.mp4', artifactSha);
      await writeJson(root, 'requests/now-bad.json', request);

      await expect(
        verifyApproval(root, 'requests/now-bad.json', 'receipts/now-bad.json', { now: '2026-02-30T12:00:00Z' }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApprovalError && (err as ApprovalError).code === 'INVALID_TIMESTAMP',
      );
    });
  });
});
