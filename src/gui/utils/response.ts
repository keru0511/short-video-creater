import { extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Runtime allowlist set when the server starts. Host/Origin are fixed to the
// bound loopback address so DNS rebinding cannot be used to bypass CSRF checks.
export const allowedOrigins = new Set<string>();
export const allowedHosts = new Set<string>();

export function refreshAllowedOrigins(port: number): void {
  allowedOrigins.clear();
  allowedHosts.clear();
  allowedOrigins.add(`http://127.0.0.1:${port}`);
  allowedOrigins.add(`http://localhost:${port}`);
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
}

export function getContentType(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

export function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  afterEnd?: () => void,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body, afterEnd);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  afterEnd?: () => void,
): void {
  if (res.headersSent) {
    if (afterEnd) afterEnd();
    return;
  }
  json(res, status, { ok: false, error: message }, afterEnd);
}

export function checkHost(req: IncomingMessage, res: ServerResponse): boolean {
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(host)) {
    sendError(res, 403, '許可されていない host です');
    return false;
  }
  return true;
}

export function checkOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!checkHost(req, res)) return false;
  const origin = req.headers.origin;
  if (origin) {
    if (allowedOrigins.has(origin)) return true;
    sendError(res, 403, '許可されていない origin です');
    return false;
  }
  const referer = req.headers.referer;
  if (referer) {
    for (const o of allowedOrigins) {
      if (referer.startsWith(`${o}/`)) return true;
    }
  }
  sendError(res, 403, 'Origin または Referer が必要です');
  return false;
}
