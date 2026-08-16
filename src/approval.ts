import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { resolveOutputPath, writeJsonAtomic, type WriteJsonAtomicOptions } from './catalog.js';
import { readJsonFileSafe, type ReadJsonFileOptions } from './segment-selection.js';
import { isInside } from './thumbnails.js';

export const APPROVAL_SCHEMA_VERSION = '1.0.0';

const MAX_APPROVAL_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024; // 500 MiB
const CHUNK_SIZE = 64 * 1024;
const O_RDONLY = constants.O_RDONLY;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const APPROVAL_ACTIONS = ['publish', 'delete', 'external-send'] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export interface ApprovalRequest {
  action: ApprovalAction;
  artifact: string;
  artifactSha256: string;
}

export interface ApprovalReceipt {
  requestHash: string;
  action: ApprovalAction;
  artifact: string;
  artifactSha256: string;
  approved: boolean;
  approver: string;
  approvedAt: string;
  expiresAt: string;
}

export interface ApprovalDecisionRecord {
  schemaVersion: string;
  requestSha256: string;
  action: ApprovalAction;
  artifact: string;
  artifactSha256: string;
  decision: 'approved' | 'denied';
  reasonCode: string;
  approver: string | null;
  verifiedAt: string;
}

export interface ApprovalResult {
  approved: boolean;
  reasonCode: string;
  decision: ApprovalDecisionRecord;
  decisionPath: string;
  decisionSha256: string;
}

export interface VerifyApprovalOptions {
  now?: Date | string | number;
  maxBytes?: number;
  __testHooks?: {
    writeJsonAtomic?: WriteJsonAtomicOptions['__testHooks'];
  };
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly decision?: ApprovalDecisionRecord | null,
    public readonly decisionPath?: string,
  ) {
    super(message);
  }
}

const HexSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ApprovalActionSchema = z.enum(APPROVAL_ACTIONS);
const ApproverSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N}._:@-]{1,128}$/u);
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);

export const ApprovalRequestSchema = z
  .object({
    action: ApprovalActionSchema,
    artifact: z.string().min(1),
    artifactSha256: HexSha256Schema,
  })
  .strict();

export const ApprovalReceiptSchema = z
  .object({
    requestHash: HexSha256Schema,
    action: ApprovalActionSchema,
    artifact: z.string().min(1),
    artifactSha256: HexSha256Schema,
    approved: z.boolean(),
    approver: ApproverSchema,
    approvedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const ApprovalDecisionRecordSchema = z
  .object({
    schemaVersion: z.literal(APPROVAL_SCHEMA_VERSION),
    requestSha256: HexSha256Schema,
    action: ApprovalActionSchema,
    artifact: z.string().min(1),
    artifactSha256: HexSha256Schema,
    decision: z.enum(['approved', 'denied']),
    reasonCode: z.string().min(1),
    approver: z.union([ApproverSchema, z.null()]),
    verifiedAt: TimestampSchema,
  })
  .strict();

function consumeString(text: string, start: number): number {
  // precondition: text[start] === '"'
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= text.length) {
        throw new Error('Unterminated string escape');
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      return i + 1;
    }
    i++;
  }
  throw new Error('Unterminated string');
}

function parseStringValue(text: string, start: number, end: number): string {
  try {
    return JSON.parse(text.slice(start, end)) as string;
  } catch {
    throw new Error('Invalid string value');
  }
}

function consumeLiteral(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\r' ||
      c === '\n' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === ',' ||
      c === ':' ||
      c === '"'
    ) {
      break;
    }
    i++;
  }
  return i;
}

export function assertNoDuplicateKeys(text: string): void {
  type Container = { type: 'object'; keys: Set<string> } | { type: 'array' };
  type State = 'value' | 'object' | 'afterKey' | 'afterValue';

  const stack: Container[] = [];
  let state: State = 'value';
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    switch (state) {
      case 'value': {
        if (c === '{') {
          stack.push({ type: 'object', keys: new Set<string>() });
          state = 'object';
          i++;
        } else if (c === '[') {
          stack.push({ type: 'array' });
          i++;
        } else if (c === '"') {
          i = consumeString(text, i);
          state = 'afterValue';
        } else if (c === '}' || c === ']') {
          throw new Error('Unexpected closing bracket');
        } else {
          i = consumeLiteral(text, i);
          state = 'afterValue';
        }
        break;
      }
      case 'object': {
        if (c === '}') {
          stack.pop();
          state = 'afterValue';
          i++;
        } else if (c === '"') {
          const end = consumeString(text, i);
          const key = parseStringValue(text, i, end);
          const top = stack[stack.length - 1];
          if (top?.type === 'object') {
            if (top.keys.has(key)) {
              throw new Error(`Duplicate key: ${key}`);
            }
            top.keys.add(key);
          }
          i = end;
          state = 'afterKey';
        } else {
          throw new Error('Expected object key');
        }
        break;
      }
      case 'afterKey': {
        if (c === ':') {
          state = 'value';
          i++;
        } else {
          throw new Error('Expected colon');
        }
        break;
      }
      case 'afterValue': {
        if (stack.length === 0) {
          throw new Error('Trailing data after JSON root');
        }
        const top = stack[stack.length - 1];
        if (c === ',') {
          i++;
          state = top.type === 'object' ? 'object' : 'value';
        } else if (c === '}' && top.type === 'object') {
          stack.pop();
          i++;
          state = 'afterValue';
        } else if (c === ']' && top.type === 'array') {
          stack.pop();
          i++;
          state = 'afterValue';
        } else {
          throw new Error('Expected comma or closing bracket');
        }
        break;
      }
    }
  }

  if (state !== 'afterValue' || stack.length !== 0) {
    throw new Error('Unexpected end of JSON');
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const MAX_ARTIFACT_IDENTIFIER_LENGTH = 4096;
const REDACTED_ARTIFACT = '[INVALID_ARTIFACT_IDENTIFIER]';
const REDACTED_ARTIFACT_SHA256 = '0'.repeat(64);

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function formatIsoWithOffset(d: Date, tz: string, offsetMs: number, frac?: string): string {
  const ld = tz === 'Z' ? d : new Date(d.getTime() + offsetMs);
  const year = ld.getUTCFullYear();
  const month = pad(ld.getUTCMonth() + 1);
  const day = pad(ld.getUTCDate());
  const hour = pad(ld.getUTCHours());
  const minute = pad(ld.getUTCMinutes());
  const second = pad(ld.getUTCSeconds());
  let result = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (frac) {
    result += `.${frac}`;
  }
  result += tz;
  return result;
}

export function parseIsoTimestamp(value: string): Date {
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!m) {
    throw new Error('Invalid ISO timestamp format');
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7];
  const tz = m[8];
  let offsetMs = 0;
  if (tz !== 'Z') {
    const sign = m[9] === '+' ? 1 : -1;
    const tzHours = Number(m[10]);
    const tzMinutes = Number(m[11]);
    if (tzHours > 14 || tzMinutes >= 60) {
      throw new Error('Invalid timezone offset');
    }
    offsetMs = sign * (tzHours * 60 + tzMinutes) * 60 * 1000;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error('Invalid calendar date');
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error('Invalid time');
  }
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMs;
  const d = new Date(utcMs);
  if (!Number.isFinite(d.getTime())) {
    throw new Error('Invalid timestamp');
  }
  if (formatIsoWithOffset(d, tz, offsetMs, frac) !== value) {
    throw new Error('Timestamp round-trip mismatch');
  }
  return d;
}

function parseNow(now: Date | string | number | undefined): Date {
  if (now === undefined) {
    return new Date();
  }
  if (now instanceof Date) {
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Invalid now timestamp');
    }
    return new Date(now.getTime());
  }
  if (typeof now === 'number') {
    if (!Number.isFinite(now)) {
      throw new Error('Invalid now timestamp');
    }
    return new Date(now);
  }
  return parseIsoTimestamp(now);
}

interface ReadJsonResult {
  data: unknown;
  resolved: string;
  realpath: string;
  stat: Awaited<ReturnType<typeof lstat>>;
  text: string;
  sha256: string;
}

async function readStrictJson(
  projectRoot: string,
  relPath: string,
  label: string,
  maxBytes?: number,
): Promise<ReadJsonResult> {
  const result = await readJsonFileSafe(projectRoot, relPath, {
    label,
    maxBytes: maxBytes ?? MAX_APPROVAL_JSON_BYTES,
  } as ReadJsonFileOptions);
  assertNoDuplicateKeys(result.text);
  return result as ReadJsonResult;
}

export function validateArtifactIdentifier(identifier: string): void {
  if (typeof identifier !== 'string') {
    throw new Error('Artifact identifier must be a string');
  }
  if (identifier.indexOf('\0') !== -1) {
    throw new Error('Null bytes are not allowed in artifact identifier');
  }
  if (/[\x00-\x1f\x7f]/.test(identifier)) {
    throw new Error('Control characters are not allowed in artifact identifier');
  }
  if (identifier.length > MAX_ARTIFACT_IDENTIFIER_LENGTH) {
    throw new Error('Artifact identifier exceeds maximum length');
  }
  if (identifier.length === 0) {
    throw new Error('Artifact identifier is empty');
  }
  // Only forward slash separators are allowed; backslash is rejected outright
  // to avoid Windows/UNC alias confusion.
  if (identifier.includes('\\')) {
    throw new Error('Backslash is not allowed in artifact identifier');
  }
  if (identifier.startsWith('/')) {
    throw new Error('Absolute paths are not allowed in artifact identifier');
  }
  if (/^[A-Za-z]:/.test(identifier)) {
    throw new Error('Windows drive paths are not allowed in artifact identifier');
  }
  if (identifier.startsWith('\\\\')) {
    throw new Error('UNC paths are not allowed in artifact identifier');
  }
  if (identifier.startsWith('./')) {
    throw new Error('./ alias is not allowed in artifact identifier');
  }
  if (identifier.endsWith('/')) {
    throw new Error('Trailing slash is not allowed in artifact identifier');
  }

  const parts = identifier.split('/');
  for (const part of parts) {
    if (part === '') {
      throw new Error('Empty path component is not allowed in artifact identifier');
    }
    if (part === '.') {
      throw new Error('./ alias is not allowed in artifact identifier');
    }
    if (part === '..') {
      throw new Error('Path traversal is not allowed in artifact identifier');
    }
  }
  if (parts.length < 2 || parts[0] !== 'output') {
    throw new Error('Artifact identifier must be under output/');
  }
}

function artifactResolvedPath(projectRoot: string, identifier: string): string {
  validateArtifactIdentifier(identifier);
  const root = resolve(projectRoot);
  const parts = identifier.split('/');
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
  }
  return current;
}

interface ArtifactInfo {
  resolved: string;
  realpath: string;
  stat: Stats | BigIntStats;
}

export async function resolveArtifact(
  projectRoot: string,
  identifier: string,
  options?: { bigint?: boolean },
): Promise<ArtifactInfo> {
  validateArtifactIdentifier(identifier);
  const root = resolve(projectRoot);
  const parts = identifier.split('/');
  const statOptions = options?.bigint ? { bigint: true } : undefined;

  // Walk each directory component and explicitly reject symbolic links in any
  // parent directory, so `output/...` cannot be an alias for another path.
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = resolve(current, parts[i]);
    const stat = await lstat(current, statOptions).catch(() => null);
    if (!stat) {
      throw new Error('Artifact parent directory does not exist');
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Artifact path contains a symbolic link');
    }
    if (!stat.isDirectory()) {
      throw new Error('Artifact path is not a directory');
    }
  }

  const resolved = resolve(current, parts[parts.length - 1]);
  if (!isInside(root, resolved)) {
    throw new Error('Artifact identifier escapes project root');
  }

  const stat = await lstat(resolved, statOptions).catch(() => null);
  if (!stat) {
    throw new Error('Artifact does not exist');
  }
  if (stat.isSymbolicLink()) {
    throw new Error('Artifact is a symbolic link');
  }
  if (!stat.isFile()) {
    throw new Error('Artifact is not a regular file');
  }

  const real = await realpath(resolved).catch(() => null);
  if (!real || !isInside(root, real)) {
    throw new Error('Artifact realpath escapes project root');
  }

  return { resolved, realpath: real, stat };
}

export async function hashArtifactFile(
  filePath: string,
  maxBytes = MAX_ARTIFACT_BYTES,
): Promise<{ sha256: string; stat: Awaited<ReturnType<typeof lstat>> }> {
  const beforeStat = await lstat(filePath).catch((err) => {
    throw new Error(`Artifact stat failed: ${(err as Error).message}`);
  });
  if (beforeStat.isSymbolicLink()) {
    throw new Error('Artifact is a symbolic link');
  }
  if (!beforeStat.isFile()) {
    throw new Error('Artifact is not a regular file');
  }
  if (beforeStat.size > maxBytes) {
    throw new Error('Artifact exceeds maximum size');
  }

  const beforeSize = beforeStat.size;
  const beforeDev = beforeStat.dev;
  const beforeIno = beforeStat.ino;
  const beforeMtime = beforeStat.mtimeMs;

  const fh = await open(filePath, O_RDONLY | O_NOFOLLOW).catch((err) => {
    throw new Error(`Artifact open failed: ${(err as Error).message}`);
  });

  try {
    const statOpen = await fh.stat();
    if (
      statOpen.dev !== beforeDev ||
      statOpen.ino !== beforeIno ||
      statOpen.size !== beforeSize ||
      statOpen.mtimeMs !== beforeMtime
    ) {
      throw new Error('Artifact changed between stat and open');
    }
    if (!statOpen.isFile()) {
      throw new Error('Artifact is not a regular file');
    }

    const hash = createHash('sha256');
    const readBuffer = Buffer.alloc(CHUNK_SIZE);
    let offset = 0;
    while (offset < beforeSize) {
      const toRead = Math.min(CHUNK_SIZE, beforeSize - offset);
      const { bytesRead } = await fh.read(readBuffer, 0, toRead, offset);
      if (bytesRead === 0) {
        throw new Error('Artifact shrank during read');
      }
      hash.update(readBuffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const eofBuf = Buffer.alloc(1);
    const { bytesRead: eofRead } = await fh.read(eofBuf, 0, 1, beforeSize);
    if (eofRead !== 0) {
      throw new Error('Artifact grew during read');
    }

    const afterStat = await fh.stat();
    const afterLstat = await lstat(filePath).catch(() => null);
    if (!afterLstat) {
      throw new Error('Artifact was removed during read');
    }
    if (afterLstat.isSymbolicLink()) {
      throw new Error('Artifact became a symbolic link during read');
    }
    if (
      afterStat.dev !== beforeDev ||
      afterStat.ino !== beforeIno ||
      afterStat.size !== beforeSize ||
      afterStat.mtimeMs !== beforeMtime ||
      afterLstat.dev !== beforeDev ||
      afterLstat.ino !== beforeIno ||
      afterLstat.size !== beforeSize ||
      afterLstat.mtimeMs !== beforeMtime
    ) {
      throw new Error('Artifact changed during read');
    }

    return { sha256: hash.digest('hex'), stat: beforeStat };
  } finally {
    await fh.close().catch(() => {});
  }
}

interface CollisionInput {
  path: string;
  realpath?: string;
  stat?: Awaited<ReturnType<typeof lstat>>;
}

async function verifyNoDecisionCollision(
  projectRoot: string,
  decisionResolved: string,
  inputs: CollisionInput[],
): Promise<void> {
  const root = resolve(projectRoot);
  const decisionStat = await lstat(decisionResolved).catch(() => null);
  const decisionReal = await realpath(decisionResolved).catch(() => null);

  if (decisionReal && !isInside(root, decisionReal)) {
    throw new Error('Decision output resolves outside project root');
  }

  for (const input of inputs) {
    const resolved = resolve(root, input.path);
    const real = input.realpath ?? (await realpath(resolved).catch(() => null));
    if (!isInside(root, resolved) && (!real || !isInside(root, real))) {
      continue;
    }

    const stat = input.stat ?? (await lstat(resolved).catch(() => null));

    if (
      resolved === decisionResolved ||
      (real && (real === decisionResolved || (decisionReal && real === decisionReal)))
    ) {
      throw new Error('Decision output collides with input path');
    }

    if (
      stat &&
      decisionStat &&
      !stat.isSymbolicLink() &&
      !decisionStat.isSymbolicLink() &&
      stat.dev === decisionStat.dev &&
      stat.ino === decisionStat.ino
    ) {
      throw new Error('Decision output shares inode with input');
    }

    if (real && !isInside(root, real)) {
      throw new Error('Input resolves outside project root');
    }
  }
}

function sanitizeArtifactForDecision(request: ApprovalRequest): {
  artifact: string;
  artifactSha256: string;
} {
  try {
    validateArtifactIdentifier(request.artifact);
    return { artifact: request.artifact, artifactSha256: request.artifactSha256 };
  } catch {
    return { artifact: REDACTED_ARTIFACT, artifactSha256: REDACTED_ARTIFACT_SHA256 };
  }
}

function buildDecision(
  request: ApprovalRequest,
  requestSha256: string,
  approved: boolean,
  reasonCode: string,
  approver: string | null,
  now: Date,
): ApprovalDecisionRecord {
  const safe = sanitizeArtifactForDecision(request);
  const record: ApprovalDecisionRecord = {
    action: request.action,
    approver,
    artifact: safe.artifact,
    artifactSha256: safe.artifactSha256,
    decision: approved ? 'approved' : 'denied',
    reasonCode,
    requestSha256,
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    verifiedAt: now.toISOString(),
  };
  // Re-insert in alphabetical key order so JSON.stringify with indentation is deterministic.
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  ) as ApprovalDecisionRecord;
}

async function writeDecision(
  projectRoot: string,
  decision: ApprovalDecisionRecord,
  inputRoot: string,
  requestSha256: string,
  writeOptions?: WriteJsonAtomicOptions,
): Promise<{ path: string; sha256: string }> {
  const decisionRel = `approvals/${requestSha256}.json`;
  const body = JSON.stringify(decision, null, 2) + '\n';
  const decisionPath = await writeJsonAtomic(decision, projectRoot, decisionRel, inputRoot, {
    ...writeOptions,
    verify: {
      expectedBytes: Buffer.from(body),
    },
  });
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { path: decisionPath, sha256 };
}

async function deny(
  projectRoot: string,
  request: ApprovalRequest,
  requestSha256: string,
  reasonCode: string,
  approver: string | null,
  now: Date,
  inputRoot: string,
  writeOptions?: WriteJsonAtomicOptions,
): Promise<ApprovalResult> {
  const decision = buildDecision(request, requestSha256, false, reasonCode, approver, now);
  const { path, sha256 } = await writeDecision(projectRoot, decision, inputRoot, requestSha256, writeOptions);
  return {
    approved: false,
    reasonCode,
    decision,
    decisionPath: path,
    decisionSha256: sha256,
  };
}

function errorToReason(err: unknown): string {
  const message = (err instanceof Error ? err.message : '').toLowerCase();
  if (message.includes('symbolic link')) return 'ARTIFACT_SYMLINK';
  if (message.includes('regular file')) return 'ARTIFACT_NOT_FILE';
  if (message.includes('does not exist')) return 'ARTIFACT_NOT_FOUND';
  if (message.includes('maximum size') || message.includes('maximum length')) return 'ARTIFACT_OVERSIZE';
  if (message.includes('changed') || message.includes('shrank') || message.includes('grew') || message.includes('removed')) {
    return 'ARTIFACT_CHANGED';
  }
  if (
    message.includes('project root') ||
    message.includes('traversal') ||
    message.includes('alias') ||
    message.includes('absolute') ||
    message.includes('unc') ||
    message.includes('null bytes') ||
    message.includes('must be under') ||
    message.includes('backslash') ||
    message.includes('empty') ||
    message.includes('trailing') ||
    message.includes('directory') ||
    message.includes('drive') ||
    message.includes('control')
  ) {
    return 'ARTIFACT_PATH_REJECTED';
  }
  return 'ARTIFACT_VERIFY_FAILED';
}

export async function verifyApproval(
  projectRoot: string,
  requestRel: string,
  receiptRel: string,
  options: VerifyApprovalOptions = {},
): Promise<ApprovalResult> {
  const root = resolve(projectRoot);
  const maxBytes = options.maxBytes ?? MAX_APPROVAL_JSON_BYTES;

  let requestRead: ReadJsonResult;
  try {
    requestRead = await readStrictJson(root, requestRel, 'Approval request', maxBytes);
  } catch (err) {
    throw new ApprovalError(
      err instanceof Error ? err.message : 'Malformed approval request',
      'MALFORMED_REQUEST',
    );
  }

  let request: ApprovalRequest;
  try {
    request = ApprovalRequestSchema.parse(requestRead.data);
  } catch (err) {
    throw new ApprovalError(
      err instanceof Error ? err.message : 'Invalid approval request',
      'INVALID_REQUEST',
    );
  }

  const requestSha256 = canonicalSha256(request);
  const decisionRel = `approvals/${requestSha256}.json`;
  const decisionResolved = resolveOutputPath(root, decisionRel);
  const inputRoot = requestRead.resolved;

  let now: Date;
  try {
    now = parseNow(options.now);
  } catch (err) {
    throw new ApprovalError(
      err instanceof Error ? err.message : 'Invalid now timestamp',
      'INVALID_TIMESTAMP',
    );
  }
  const baseInputs: CollisionInput[] = [
    { path: requestRead.resolved, realpath: requestRead.realpath, stat: requestRead.stat },
  ];

  let receiptRead: ReadJsonResult | null = null;
  let receipt: ApprovalReceipt | null = null;
  let reasonCode: string | null = null;

  try {
    receiptRead = await readStrictJson(root, receiptRel, 'Approval receipt', maxBytes);
  } catch {
    reasonCode = 'MALFORMED_RECEIPT';
  }

  if (receiptRead && !reasonCode) {
    try {
      receipt = ApprovalReceiptSchema.parse(receiptRead.data);
    } catch {
      reasonCode = 'INVALID_RECEIPT';
    }
  }

  const receiptInputPath = receiptRead
    ? receiptRead.resolved
    : resolve(root, receiptRel);
  if (isInside(root, receiptInputPath)) {
    baseInputs.push({
      path: receiptInputPath,
      realpath: receiptRead?.realpath,
      stat: receiptRead?.stat,
    });
  }

  if (!reasonCode && receipt) {
    if (receipt.requestHash !== requestSha256) {
      reasonCode = 'REQUEST_HASH_MISMATCH';
    } else if (receipt.action !== request.action) {
      reasonCode = 'ACTION_MISMATCH';
    } else if (receipt.artifact !== request.artifact) {
      reasonCode = 'ARTIFACT_MISMATCH';
    } else if (receipt.artifactSha256 !== request.artifactSha256) {
      reasonCode = 'ARTIFACT_HASH_MISMATCH';
    } else if (!receipt.approved) {
      reasonCode = 'APPROVAL_DENIED';
    } else {
      try {
        const approvedAt = parseIsoTimestamp(receipt.approvedAt);
        const expiresAt = parseIsoTimestamp(receipt.expiresAt);
        if (expiresAt.getTime() <= approvedAt.getTime()) {
          reasonCode = 'INVALID_TIMESTAMP';
        } else if (now.getTime() < approvedAt.getTime()) {
          reasonCode = 'FUTURE_TIMESTAMP';
        } else if (now.getTime() >= expiresAt.getTime()) {
          reasonCode = 'APPROVAL_EXPIRED';
        }
      } catch {
        reasonCode = 'INVALID_TIMESTAMP';
      }
    }
  }

  let artifactInfo: ArtifactInfo | null = null;
  let artifactHash: string | null = null;

  if (!reasonCode) {
    try {
      artifactInfo = await resolveArtifact(root, request.artifact);
    } catch (err) {
      reasonCode = errorToReason(err);
    }
  }

  if (!reasonCode && artifactInfo) {
    try {
      const hashed = await hashArtifactFile(artifactInfo.resolved, MAX_ARTIFACT_BYTES);
      artifactHash = hashed.sha256;
    } catch (err) {
      reasonCode = errorToReason(err);
    }
  }

  if (!reasonCode && artifactHash !== request.artifactSha256) {
    reasonCode = 'ARTIFACT_HASH_MISMATCH';
  }

  if (!reasonCode && !artifactInfo) {
    // Should not happen: no reason and no artifact means resolveArtifact succeeded but returned null.
    reasonCode = 'ARTIFACT_VERIFY_FAILED';
  }

  const inputs: CollisionInput[] = [...baseInputs];
  if (artifactInfo) {
    inputs.push({ path: artifactInfo.resolved, realpath: artifactInfo.realpath, stat: artifactInfo.stat });
  } else {
    try {
      const artifactResolved = artifactResolvedPath(root, request.artifact);
      if (isInside(root, artifactResolved)) {
        inputs.push({ path: artifactResolved });
      }
    } catch {
      // Invalid artifact identifier; will be caught as an earlier reason in normal flow.
    }
  }

  await verifyNoDecisionCollision(root, decisionResolved, inputs).catch((err) => {
    throw new ApprovalError(
      err instanceof Error ? err.message : 'Decision collision',
      'DECISION_COLLISION',
    );
  });

  // Re-verification barrier executed by writeJsonAtomic immediately before the
  // atomic rename. It re-reads the request, receipt, and artifact and compares
  // their canonical realpath, dev/ino, size, mtime, and SHA-256 snapshots so
  // that no APPROVED decision can be published with stale or swapped inputs.
  async function beforeRenameBarrier(_ctx: {
    dirFh: import('node:fs/promises').FileHandle;
    dirPath: string;
    tempName: string;
    finalName: string;
  }): Promise<void> {
    async function verifyJsonInput(
      relPath: string,
      snapshot: ReadJsonResult,
      label: string,
    ): Promise<void> {
      const reread = await readStrictJson(root, relPath, label, maxBytes);
      if (reread.sha256 !== snapshot.sha256) {
        throw new ApprovalError(`${label} sha256 changed before publish`, 'INPUT_CHANGED');
      }
      if (reread.realpath !== snapshot.realpath) {
        throw new ApprovalError(`${label} realpath changed before publish`, 'INPUT_CHANGED');
      }
      const s1 = reread.stat;
      const s2 = snapshot.stat;
      if (
        s1.dev !== s2.dev ||
        s1.ino !== s2.ino ||
        s1.size !== s2.size ||
        s1.mtimeMs !== s2.mtimeMs
      ) {
        throw new ApprovalError(`${label} stat changed before publish`, 'INPUT_CHANGED');
      }
    }

    await verifyJsonInput(requestRel, requestRead, 'Approval request');
    if (receiptRead) {
      await verifyJsonInput(receiptRel, receiptRead, 'Approval receipt');
    }

    if (artifactInfo) {
      const currentInfo = await resolveArtifact(root, request.artifact);
      const currentHashed = await hashArtifactFile(currentInfo.resolved, MAX_ARTIFACT_BYTES);
      if (artifactHash !== null) {
        if (currentHashed.sha256 !== artifactHash) {
          throw new ApprovalError('Artifact sha256 changed before publish', 'INPUT_CHANGED');
        }
      } else {
        // Initial hash failed, so there is no snapshot hash. Verify the current
        // content matches the expected hash; otherwise the artifact was swapped
        // or changed before publish.
        if (currentHashed.sha256 !== request.artifactSha256) {
          throw new ApprovalError('Artifact content changed before publish', 'INPUT_CHANGED');
        }
      }
      if (currentInfo.realpath !== artifactInfo.realpath) {
        throw new ApprovalError('Artifact realpath changed before publish', 'INPUT_CHANGED');
      }
      const s1 = currentInfo.stat;
      const s2 = artifactInfo.stat;
      if (
        s1.dev !== s2.dev ||
        s1.ino !== s2.ino ||
        s1.size !== s2.size ||
        s1.mtimeMs !== s2.mtimeMs
      ) {
        throw new ApprovalError('Artifact stat changed before publish', 'INPUT_CHANGED');
      }
    }
  }

  const userWriteTestHooks = options.__testHooks?.writeJsonAtomic ?? {};
  const writeOptions: WriteJsonAtomicOptions = {
    __testHooks: {
      ...userWriteTestHooks,
      beforeRename: async (ctx) => {
        if (userWriteTestHooks.beforeRename) {
          await userWriteTestHooks.beforeRename(ctx);
        }
        await beforeRenameBarrier(ctx);
      },
    },
  };

  const approver = receipt ? receipt.approver : null;

  try {
    if (reasonCode) {
      return await deny(root, request, requestSha256, reasonCode, approver, now, inputRoot, writeOptions);
    }

    const decision = buildDecision(request, requestSha256, true, 'APPROVED', approver, now);
    const { path, sha256 } = await writeDecision(root, decision, inputRoot, requestSha256, writeOptions);
    return {
      approved: true,
      reasonCode: 'APPROVED',
      decision,
      decisionPath: path,
      decisionSha256: sha256,
    };
  } catch (err) {
    if (err instanceof ApprovalError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : 'Decision write failed';
    if (reasonCode && message.toLowerCase().includes('symbolic link')) {
      // The output directory itself contains a symlink; preserve the original
      // rejection code instead of masking it as a generic write failure.
      throw new ApprovalError(message, reasonCode);
    }
    throw new ApprovalError(message, 'DECISION_WRITE_FAILED');
  }
}
