import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from '../utils/response.js';

export function getMaxRequestBytes(): number {
  return Number(process.env.GUI_MAX_REQUEST_BYTES) || 100 * 1024 * 1024;
}
export function getMaxFileBytes(): number {
  return Number(process.env.GUI_MAX_FILE_BYTES) || 50 * 1024 * 1024;
}
export function getMaxTotalFiles(): number {
  return Number(process.env.GUI_MAX_TOTAL_FILES) || 10;
}

export class RequestTooLargeError extends Error {}

export function readLimitedBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      sendError(res, 413, 'リクエストサイズが大きすぎます', () => {
        req.socket?.destroy();
      });
      reject(new RequestTooLargeError('Content-Length exceeded'));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAbort);
    }

    function onData(chunk: Buffer) {
      received += chunk.length;
      if (received > maxBytes) {
        rejected = true;
        sendError(res, 413, 'リクエストサイズが大きすぎます', () => {
          req.socket?.destroy();
        });
        cleanup();
        reject(new RequestTooLargeError('request body too large'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onAbort() {
      cleanup();
      reject(new Error('リクエストが中断されました'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAbort);
  });
}

export function getBoundary(contentType: string): string | undefined {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const b = (match?.[1] ?? match?.[2])?.trim();
  return b;
}

export interface MultipartFileInfo {
  name: string;
  filename: string;
  data: Buffer;
}

export function parseMultipartBody(body: Buffer, boundary: string): { fields: Record<string, string>; files: MultipartFileInfo[] } {
  const fields: Record<string, string> = {};
  const files: MultipartFileInfo[] = [];
  const token = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (true) {
    const i = body.indexOf(token, cursor);
    if (i === -1) {
      parts.push(body.subarray(cursor));
      break;
    }
    parts.push(body.subarray(cursor, i));
    cursor = i + token.length;
  }

  for (let idx = 1; idx < parts.length - 1; idx++) {
    const part = parts[idx];
    let dataStart = 0;
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) {
      dataStart = 2;
    }
    const sep = Buffer.from('\r\n\r\n');
    const headerEnd = part.indexOf(sep, dataStart);
    if (headerEnd === -1) continue;

    const headers = part.subarray(dataStart, headerEnd).toString('utf8');
    let data = part.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }

    const dispLine = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:')) || '';
    const params = dispLine.split(';').slice(1).map((s) => s.trim());
    let name: string | undefined;
    let filename: string | undefined;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      let value = param.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (key === 'name') name = value;
      if (key === 'filename') filename = value;
    }
    if (!name) continue;

    if (filename) {
      files.push({ name, filename, data });
    } else {
      fields[name] = data.toString('utf8');
    }
  }

  return { fields, files };
}

export async function parseMultipart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ fields: Record<string, string>; files: MultipartFileInfo[] }> {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data 形式でリクエストを送信してください');
  }
  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw new Error('リクエストの boundary が見つかりません');
  }
  const body = await readLimitedBody(req, res, getMaxRequestBytes());
  return parseMultipartBody(body, boundary);
}
