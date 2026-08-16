import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSafePath } from '../utils.js';
import { toUserMessage } from '../user-error.js';
import { indexHtmlPath, outputDir, fontsDir } from './paths.js';
import { checkHost, checkOrigin, getContentType, json, refreshAllowedOrigins, sendError } from './utils/response.js';
import { handleGenerate } from './routes/generate.js';
import { handleProjectRoute, matchProjectRoute } from './routes/project.js';
import { listAvailableFonts } from './utils/fonts.js';

export { sanitizeFilename } from './utils/filename.js';

async function serveIndex(res: import('node:http').ServerResponse): Promise<void> {
  try {
    const html = await readFile(indexHtmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

async function serveOutputFile(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, name: string): Promise<void> {
  try {
    const filePath = resolveSafePath(outputDir, name);
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('リクエストされたコンテンツが見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getContentType(name),
      'Content-Length': info.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

function getOpenCommand(platform: string): string {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

async function handleOpenOutput(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  if (!checkOrigin(req, res)) return;
  const command = getOpenCommand(process.platform);
  const child = spawn(command, [outputDir], { detached: true, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (c) => resolve(c));
    child.on('close', (c) => resolve(c));
  });
  child.unref();
  if (code !== null && code !== 0) {
    res.writeHead(500);
    res.end(`出力フォルダを開けませんでした（終了コード ${code}）`);
    return;
  }
  json(res, 200, { opened: true });
}

async function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  if (!checkHost(req, res)) return;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveIndex(res);
      return;
    }

    const projectRoute = matchProjectRoute(pathname);
    if (projectRoute) {
      await handleProjectRoute(req, res, projectRoute);
      return;
    }

    if (pathname.startsWith('/api/projects/')) {
      const m = pathname.match(/^\/api\/projects\/([^/]+)/);
      if (m && !/^[a-zA-Z0-9_-]+$/.test(m[1])) {
        sendError(res, 400, 'プロジェクトIDには半角英数字、ハイフン、アンダースコアのみ使用できます');
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/api/generate') {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/fonts') {
      const fonts = (await listAvailableFonts()).map((f) => basename(f));
      json(res, 200, { ok: true, fonts });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/output/')) {
      const name = decodeURIComponent(pathname.slice('/api/output/'.length));
      await serveOutputFile(req, res, name);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/open-output') {
      await handleOpenOutput(req, res);
      return;
    }

    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  } catch (err) {
    console.error('リクエスト処理エラー:', err);
    if (!res.headersSent) {
      sendError(res, 500, toUserMessage(err));
    }
  }
}

export function startServer(port = 0): Promise<{ server: ReturnType<typeof createServer>; port: number; url: string; stop: () => Promise<void> }> {
  const server = createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const p = typeof address === 'object' && address ? address.port : port;
      refreshAllowedOrigins(p);
      resolve({
        server,
        port: p,
        url: `http://127.0.0.1:${p}`,
        stop: () => new Promise((res) => server.close((err) => res(err ? undefined : undefined))),
      });
    });
  });
}

async function main(): Promise<void> {
  const { url } = await startServer(Number(process.env.GUI_PORT ?? 0));
  console.log(`ローカルGUI: ${url}`);
}

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
