import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type IncomingHttpHeaders } from 'node:http';
import { generateFixtures } from '../src/fixtures.js';
import { startServer, sanitizeFilename } from '../src/gui/server.js';
import { generate, sha256File, ffprobe, type Timeline } from '../src/core.js';
import type { AuditManifest } from '../src/audit.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const guiDir = join(root, 'gui');
const srcGuiDir = join(root, 'src', 'gui');

let serverInfo: Awaited<ReturnType<typeof startServer>>;

function buildMultipartBody(
  parts: { name: string; filename?: string; contentType?: string; data: Buffer }[],
  boundary: string,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'), part.data, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function httpPost(
  url: string,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
  host?: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'Connection': 'close',
      ...extraHeaders,
    };
    const req = request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    if (host) req.setHeader('Host', host);
    req.on('error', reject);
    req.end(body);
  });
}

function httpPostChunked(
  url: string,
  chunks: Buffer[],
  contentType: string,
  extraHeaders: Record<string, string> = {},
  host?: string,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked',
      'Connection': 'close',
      ...extraHeaders,
    };
    const req = request(url, { method: 'POST', headers }, (res) => {
      const out: Buffer[] = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(out) }));
    });
    if (host) req.setHeader('Host', host);
    req.on('error', reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

function httpPostChunkedSlow(
  url: string,
  chunks: Buffer[],
  contentType: string,
  delayMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Buffer; elapsedMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked',
      'Connection': 'close',
      ...extraHeaders,
    };
    let settled = false;
    const req = request(url, { method: 'POST', headers }, (res) => {
      const out: Buffer[] = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(out), elapsedMs: Date.now() - start });
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    let i = 0;
    function sendNext() {
      if (i >= chunks.length) {
        if (!settled) req.end();
        return;
      }
      req.write(chunks[i]);
      i += 1;
      setTimeout(sendNext, delayMs);
    }
    sendNext();
  });
}

async function withBlockedGuiAudit<T>(fn: () => Promise<T>): Promise<T> {
  const guiOutput = join(guiDir, 'output');
  const auditPath = join(guiOutput, 'audit');
  await rm(auditPath, { recursive: true, force: true });
  await mkdir(guiOutput, { recursive: true });
  await writeFile(auditPath, '');
  try {
    return await fn();
  } finally {
    await rm(auditPath, { force: true });
  }
}

function httpGet(url: string, host?: string): Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { Connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    if (host) req.setHeader('Host', host);
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await rm(guiDir, { recursive: true, force: true });
  await generateFixtures(root);
  serverInfo = await startServer(0);
}, 120000);

afterAll(async () => {
  await serverInfo.stop();
});

afterEach(() => {
  delete process.env.GUI_MAX_REQUEST_BYTES;
  delete process.env.GUI_MAX_FILE_BYTES;
  delete process.env.GUI_MAX_TOTAL_FILES;
});

describe('GUI server', () => {
  it('serves the index page', async () => {
    const { status, body } = await httpGet(`${serverInfo.url}/`);
    expect(status).toBe(200);
    const html = body.toString('utf8');
    expect(html).toContain('short-video-creater ローカルGUI');
    expect(html).toContain('data-field="font"');
    expect(html).toContain('URLSearchParams');
    expect(html).toContain('short-video-creater.projectId');
    expect(html).toContain('クリップに追加');
    expect(html).toContain('主音声に設定');
    expect(html).toContain('BGMに設定');
    expect(html).toContain('[${type}]');
  });

  it('lists available fonts', async () => {
    const { status, body } = await httpGet(`${serverInfo.url}/api/fonts`);
    expect(status).toBe(200);
    const data = JSON.parse(body.toString('utf8'));
    expect(data.ok).toBe(true);
    expect(data.fonts.length).toBeGreaterThan(0);
  });

  it('serves original source files for scrubbing', async () => {
    const projectId = 'source-test';
    const image = await readFile(join(fixturesDir, 'image.png'));
    const boundary = '----SourceTestBoundary' + Date.now();
    const uploadBody = buildMultipartBody([{ name: 'file', filename: 'image.png', contentType: 'image/png', data: image }], boundary);
    const uploadRes = await httpPost(
      `${serverInfo.url}/api/projects/${projectId}/assets`,
      uploadBody,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(uploadRes.status).toBe(200);
    const { asset } = JSON.parse(uploadRes.body.toString('utf8'));

    const sourceRes = await httpGet(`${serverInfo.url}/api/projects/${projectId}/assets/${asset.assetId}/source`);
    expect(sourceRes.status).toBe(200);
    expect(sourceRes.headers['content-type']).toBe('image/png');
    expect(sourceRes.body.length).toBeGreaterThan(0);
  });

  it('generates a 9:16 h264/aac mp4 from uploaded fixtures', async () => {
    const image = await readFile(join(fixturesDir, 'image.png'));
    const audio = await readFile(join(fixturesDir, 'audio.mp3'));
    const bgm = await readFile(join(fixturesDir, 'bgm-880.wav'));
    const boundary = '----FormBoundary' + Date.now();

    const config = {
      outputPreset: 'preview',
      background: '000000',
      clips: [{ duration: 3, fit: 'cover' }],
      bgm: { volume: 0.3 },
      subtitles: [{ start: 0.5, end: 1.5, text: 'Hello', x: 540, y: 1500, fontSize: 100 }],
      crossfade: { enabled: false, duration: 0 },
    };

    const body = buildMultipartBody(
      [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
        { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
        { name: 'mainAudio', filename: 'audio.mp3', contentType: 'audio/mpeg', data: audio },
        { name: 'bgm', filename: 'bgm-880.wav', contentType: 'audio/wav', data: bgm },
      ],
      boundary,
    );

    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.toString('utf8')) as {
      ok: boolean;
      outputUrl: string;
      auditJobId: string;
      auditManifestPath: string;
      probe: { width: number; height: number; videoCodec: string; audioCodec: string; hasAudio: boolean };
    };
    expect(data.ok).toBe(true);
    expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.auditManifestPath).toContain('output/audit/');
    expect(data.probe.width).toBe(1080);
    expect(data.probe.height).toBe(1920);
    expect(data.probe.videoCodec).toBe('h264');
    expect(data.probe.audioCodec).toBe('aac');
    expect(data.probe.hasAudio).toBe(true);

    const manifestPath = resolve(root, data.auditManifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      jobId: string;
      source: string;
      status: string;
      output: { identifier: string };
    };
    expect(manifest.jobId).toBe(data.auditJobId);
    expect(manifest.source).toBe('GUI');
    expect(manifest.status).toBe('success');
    expect(manifest.output.identifier).toContain('gui/output/');

    const fileRes = await httpGet(`${serverInfo.url}${data.outputUrl}`);
    expect(fileRes.status).toBe(200);
    expect(Number(fileRes.headers['content-length'])).toBeGreaterThan(0);
    const fileHead = fileRes.body.subarray(0, 12).toString('hex');
    expect(fileHead).toMatch(/^[0-9a-f]{8}66747970/); // ftyp box in MP4
  }, 120000);

  it('generates an mp4 using clip in/out source ranges', async () => {
    const video = await readFile(join(fixturesDir, 'blue.mp4'));
    const audio = await readFile(join(fixturesDir, 'audio.mp3'));
    const boundary = '----RangeBoundary' + Date.now();

    const config = {
      outputPreset: 'preview',
      background: '000000',
      clips: [{ in: 1, out: 4, fit: 'cover' as const }],
      subtitles: [],
      crossfade: { enabled: false, duration: 0 },
    };

    const body = buildMultipartBody(
      [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
        { name: 'clip-0', filename: 'blue.mp4', contentType: 'video/mp4', data: video },
        { name: 'mainAudio', filename: 'audio.mp3', contentType: 'audio/mpeg', data: audio },
      ],
      boundary,
    );

    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.toString('utf8')) as {
      ok: boolean;
      outputUrl: string;
      outputPath: string;
      probe: { width: number; height: number; duration: number };
    };
    expect(data.ok).toBe(true);
    expect(data.probe.width).toBe(1080);
    expect(data.probe.height).toBe(1920);

    const outputFile = resolve(guiDir, 'output', data.outputPath);
    const probe = await ffprobe(outputFile);
    expect(probe.duration).toBeGreaterThanOrEqual(2.9);
    expect(probe.duration).toBeLessThanOrEqual(3.2);
  }, 120000);

  it('persists uploaded assets and can regenerate from the audit manifest', async () => {
    const image = await readFile(join(fixturesDir, 'image.png'));
    const audio = await readFile(join(fixturesDir, 'audio.mp3'));
    const bgm = await readFile(join(fixturesDir, 'bgm-880.wav'));
    const boundary = '----PersistBoundary' + Date.now();

    const config = {
      outputPreset: 'preview',
      background: '000000',
      clips: [{ duration: 2, fit: 'cover' }],
      bgm: { volume: 0.3 },
      subtitles: [{ start: 0.5, end: 1.5, text: 'Persist', x: 540, y: 1500, fontSize: 100 }],
      crossfade: { enabled: false, duration: 0 },
    };

    const body = buildMultipartBody(
      [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
        { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
        { name: 'mainAudio', filename: 'audio.mp3', contentType: 'audio/mpeg', data: audio },
        { name: 'bgm', filename: 'bgm-880.wav', contentType: 'audio/wav', data: bgm },
      ],
      boundary,
    );

    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.toString('utf8')) as {
      ok: boolean;
      auditJobId: string;
      auditManifestPath: string;
    };
    expect(data.ok).toBe(true);
    expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);

    const manifestPath = resolve(root, data.auditManifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.inputs.length).toBeGreaterThan(0);

    for (const input of manifest.inputs) {
      const inputPath = resolve(root, input.identifier);
      expect(existsSync(inputPath)).toBe(true);
      expect(await sha256File(inputPath)).toBe(input.sha256);
    }

    const assetsDir = resolve(root, manifest.inputs[0].identifier, '..');
    const regenerated = await generate(manifest.timeline as Timeline, {
      rootDir: root,
      fixturesDir: assetsDir,
      outputDir: resolve(guiDir, 'output'),
      fontsDir: assetsDir,
    });
    expect(regenerated.probe.width).toBe(1080);
    expect(regenerated.probe.height).toBe(1920);
    expect(regenerated.probe.videoCodec).toBe('h264');
    expect(regenerated.probe.audioCodec).toBe('aac');
  }, 120000);

  it('rejects requests without visual clips and returns audit job info', async () => {
    const boundary = '----EmptyBoundary';
    const config = { clips: [] };
    const body = buildMultipartBody(
      [{ name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) }],
      boundary,
    );
    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body.toString('utf8')) as {
      ok: boolean;
      error: string;
      auditJobId: string;
      auditManifestPath: string;
    };
    expect(data.ok).toBe(false);
    expect(data.error).toContain('画像');
    expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.auditManifestPath).toContain('output/audit/');
    const manifest = JSON.parse(await readFile(resolve(root, data.auditManifestPath), 'utf8')) as AuditManifest;
    expect(manifest.jobId).toBe(data.auditJobId);
    expect(manifest.source).toBe('GUI');
    expect(manifest.status).toBe('failure');
  });

  it('reports an error for an invalid media file and returns audit job info', async () => {
    const boundary = '----BadBoundary' + Date.now();
    const config = { clips: [{ duration: 2, fit: 'cover' }] };
    const body = buildMultipartBody(
      [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
        { name: 'clip-0', filename: 'fake.mp4', contentType: 'video/mp4', data: Buffer.from('not a video') },
      ],
      boundary,
    );
    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body.toString('utf8')) as {
      ok: boolean;
      error: string;
      auditJobId: string;
      auditManifestPath: string;
    };
    expect(data.ok).toBe(false);
    expect(data.error).toContain('エラー');
    expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.auditManifestPath).toContain('output/audit/');
    const manifestPath = resolve(root, data.auditManifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuditManifest;
    expect(manifest.jobId).toBe(data.auditJobId);
    expect(manifest.source).toBe('GUI');
    expect(manifest.status).toBe('failure');
  }, 120000);

  it('returns 500 when audit write fails for a missing config', async () => {
    await withBlockedGuiAudit(async () => {
      const boundary = '----NoConfigBlock' + Date.now();
      const body = buildMultipartBody([], boundary);
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(500);
      const data = JSON.parse(res.body.toString('utf8')) as {
        ok: boolean;
        error: string;
        auditJobId: string;
        auditManifestPath: string | null;
      };
      expect(data.ok).toBe(false);
      expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.auditManifestPath).toBeNull();
      expect(data.error).toContain('監査ログの書き込みに失敗しました');
    });
  }, 20000);

  it('returns 500 when audit write fails for a malformed JSON config', async () => {
    await withBlockedGuiAudit(async () => {
      const boundary = '----BadJsonBlock' + Date.now();
      const body = buildMultipartBody(
        [{ name: 'config', contentType: 'application/json', data: Buffer.from('not json') }],
        boundary,
      );
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(500);
      const data = JSON.parse(res.body.toString('utf8')) as {
        ok: boolean;
        error: string;
        auditJobId: string;
        auditManifestPath: string | null;
      };
      expect(data.ok).toBe(false);
      expect(data.auditJobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.auditManifestPath).toBeNull();
      expect(data.error).toContain('監査ログの書き込みに失敗しました');
    });
  }, 20000);

  it('rejects generation when the GUI output assets directory is a symlink to outside', async () => {
    const outsideDir = join(guiDir, 'outside-assets');
    const assetsSymlink = join(guiDir, 'output', 'assets');
    await rm(outsideDir, { recursive: true, force: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(join(guiDir, 'output'), { recursive: true });
    await rm(assetsSymlink, { recursive: true, force: true });
    await symlink(outsideDir, assetsSymlink);

    const image = await readFile(join(fixturesDir, 'image.png'));
    const boundary = '----SymlinkBoundary' + Date.now();
    const config = { outputPreset: 'preview', background: '000000', clips: [{ duration: 1, fit: 'cover' }] };
    const body = buildMultipartBody(
      [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
        { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
      ],
      boundary,
    );

    try {
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(500);
      const data = JSON.parse(res.body.toString('utf8')) as {
        ok: boolean;
        auditJobId?: string;
        auditManifestPath?: string | null;
      };
      expect(data.ok).toBe(false);
      if (data.auditManifestPath) {
        expect(data.auditManifestPath).toContain('gui/output/audit');
      }
      const outsideFiles = await readdir(outsideDir);
      expect(outsideFiles).toHaveLength(0);
    } finally {
      await rm(assetsSymlink, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  }, 30000);

  it('rejects cross-origin POST requests', async () => {
    const boundary = '----OriginBoundary';
    const body = buildMultipartBody(
      [{ name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify({ clips: [] })) }],
      boundary,
    );

    const missing = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(missing.status).toBe(403);

    const wrong = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: 'http://evil.example.com' },
    );
    expect(wrong.status).toBe(403);
  });

  it('rejects cross-origin open-output requests', async () => {
    const missing = await httpPost(`${serverInfo.url}/api/open-output`, Buffer.from(''), 'application/json');
    expect(missing.status).toBe(403);

    const wrong = await httpPost(
      `${serverInfo.url}/api/open-output`,
      Buffer.from(''),
      'application/json',
      { Origin: 'http://evil.example.com' },
    );
    expect(wrong.status).toBe(403);
  });

  it('rejects DNS rebinding Host/Origin', async () => {
    const boundary = '----RebindBoundary';
    const body = buildMultipartBody(
      [{ name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify({ clips: [] })) }],
      boundary,
    );
    const res = await httpPost(
      `${serverInfo.url}/api/generate`,
      body,
      `multipart/form-data; boundary=${boundary}`,
      { Origin: `http://evil.local:${serverInfo.port}` },
      `evil.local:${serverInfo.port}`,
    );
    expect(res.status).toBe(403);
  });

  it('rejects DNS rebinding GET requests to all read endpoints', async () => {
    const evilHost = `evil.local:${serverInfo.port}`;
    const paths = [
      '/',
      '/index.html',
      '/api/fonts',
      '/api/projects/dns-test/assets',
      '/api/projects/dns-test/timeline/config',
      '/api/projects/dns-test/previews/preview.jpg',
      '/api/output/artifacts/job/video.mp4',
    ];
    for (const path of paths) {
      const res = await httpGet(`${serverInfo.url}${path}`, evilHost);
      expect(res.status).toBe(403);
      expect(res.body.toString('utf8')).toContain('許可されていない');
    }
  });

  it('allows GET requests from 127.0.0.1 and localhost Host', async () => {
    const localHost = `localhost:${serverInfo.port}`;
    const res127 = await httpGet(`${serverInfo.url}/`, `127.0.0.1:${serverInfo.port}`);
    expect(res127.status).toBe(200);
    const resLocal = await httpGet(`${serverInfo.url}/`, localHost);
    expect(resLocal.status).toBe(200);
    const fontsLocal = await httpGet(`${serverInfo.url}/api/fonts`, localHost);
    expect(fontsLocal.status).toBe(200);
    const fontsData = JSON.parse(fontsLocal.body.toString('utf8')) as { ok: boolean; fonts: string[] };
    expect(fontsData.ok).toBe(true);
    expect(Array.isArray(fontsData.fonts)).toBe(true);
  });

  it('allows same-origin open-output requests', async () => {
    const res = await httpPost(
      `${serverInfo.url}/api/open-output`,
      Buffer.from(''),
      'application/json',
      { Origin: serverInfo.url },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.toString('utf8')) as { opened: boolean };
    expect(data.opened).toBe(true);
  });

  it('returns error when the folder opener command fails', async () => {
    const fakeBin = resolve(guiDir, `fake-xdg-open-${Date.now()}`);
    await mkdir(fakeBin, { recursive: true });
    const fakeScript = resolve(fakeBin, 'xdg-open');
    await writeFile(fakeScript, '#!/bin/sh\nexit 42\n');
    await chmod(fakeScript, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const res = await httpPost(
        `${serverInfo.url}/api/open-output`,
        Buffer.from(''),
        'application/json',
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(500);
      expect(res.body.toString('utf8')).toContain('出力フォルダ');
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('rejects oversized Content-Length', async () => {
    const prev = process.env.GUI_MAX_REQUEST_BYTES;
    process.env.GUI_MAX_REQUEST_BYTES = '200';
    try {
      const res = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = request(
          `${serverInfo.url}/api/generate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'multipart/form-data; boundary=----X',
              'Content-Length': '1000',
              Origin: serverInfo.url,
              Connection: 'close',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          },
        );
        req.on('error', reject);
        req.end(Buffer.from('small'));
      });
      expect(res.status).toBe(413);
      expect(res.body.toString('utf8')).toContain('大きすぎ');
    } finally {
      if (prev === undefined) delete process.env.GUI_MAX_REQUEST_BYTES;
      else process.env.GUI_MAX_REQUEST_BYTES = prev;
    }
  }, 20000);

  it('rejects oversized streaming body', async () => {
    const prev = process.env.GUI_MAX_REQUEST_BYTES;
    process.env.GUI_MAX_REQUEST_BYTES = '200';
    try {
      const res = await httpPostChunked(
        `${serverInfo.url}/api/generate`,
        [Buffer.alloc(150), Buffer.alloc(150)],
        'multipart/form-data; boundary=----X',
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(413);
      expect(res.body.toString('utf8')).toContain('大きすぎ');
    } finally {
      if (prev === undefined) delete process.env.GUI_MAX_REQUEST_BYTES;
      else process.env.GUI_MAX_REQUEST_BYTES = prev;
    }
  }, 20000);

  it('rejects too many uploaded files', async () => {
    const prev = process.env.GUI_MAX_TOTAL_FILES;
    process.env.GUI_MAX_TOTAL_FILES = '2';
    try {
      const boundary = '----CountBoundary';
      const parts: Parameters<typeof buildMultipartBody>[0] = [
        { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify({ clips: [] })) },
      ];
      for (let i = 0; i < 3; i++) {
        parts.push({ name: `clip-${i}`, filename: 'x.png', contentType: 'image/png', data: Buffer.alloc(10) });
      }
      const body = buildMultipartBody(parts, boundary);
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(400);
      expect(res.body.toString('utf8')).toContain('最大');
    } finally {
      if (prev === undefined) delete process.env.GUI_MAX_TOTAL_FILES;
      else process.env.GUI_MAX_TOTAL_FILES = prev;
    }
  }, 20000);

  it('closes the request quickly on slow chunked oversize bodies', async () => {
    const prev = process.env.GUI_MAX_REQUEST_BYTES;
    process.env.GUI_MAX_REQUEST_BYTES = '256';
    try {
      const chunks: Buffer[] = [];
      for (let i = 0; i < 10; i++) {
        chunks.push(Buffer.alloc(64));
      }
      const res = await httpPostChunkedSlow(
        `${serverInfo.url}/api/generate`,
        chunks,
        'multipart/form-data; boundary=----SlowBoundary',
        100,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(413);
      expect(res.body.toString('utf8')).toContain('大きすぎ');
      expect(res.elapsedMs).toBeLessThan(800);
    } finally {
      if (prev === undefined) delete process.env.GUI_MAX_REQUEST_BYTES;
      else process.env.GUI_MAX_REQUEST_BYTES = prev;
    }
  }, 20000);

  it('concurrent generation requests produce isolated outputs', async () => {
    const image = await readFile(join(fixturesDir, 'image.png'));
    const makeBody = (duration: number, boundary: string) => {
      const config = {
        outputPreset: 'preview',
        background: '000000',
        clips: [{ duration, fit: 'cover' }],
        crossfade: { enabled: false, duration: 0 },
      };
      return buildMultipartBody(
        [
          { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
          { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
        ],
        boundary,
      );
    };

    const [resA, resB] = await Promise.all([
      httpPost(
        `${serverInfo.url}/api/generate`,
        makeBody(2, '----ConcurrentA'),
        'multipart/form-data; boundary=----ConcurrentA',
        { Origin: serverInfo.url },
      ),
      httpPost(
        `${serverInfo.url}/api/generate`,
        makeBody(1, '----ConcurrentB'),
        'multipart/form-data; boundary=----ConcurrentB',
        { Origin: serverInfo.url },
      ),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const dataA = JSON.parse(resA.body.toString('utf8')) as { outputUrl: string };
    const dataB = JSON.parse(resB.body.toString('utf8')) as { outputUrl: string };
    expect(dataA.outputUrl).not.toBe(dataB.outputUrl);
  }, 120000);

  it('sanitizes malicious file names', async () => {
    const malicious = '<img src=x onerror=alert(1)>.png';
    const safe = sanitizeFilename(malicious);
    expect(safe).not.toContain('<');
    expect(safe).not.toContain('>');
    expect(safe).toMatch(/\.png$/);
  });

  it('does not expose file names via innerHTML in the GUI page', async () => {
    const html = await readFile(join(srcGuiDir, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script).toContain('textContent');
    expect(script).not.toContain('${clip.file.name}');
    expect(script).not.toContain('${mainAudio.file.name}');
    expect(script).not.toContain('${bgm.file.name}');
  });

  it('starts and generates without local fonts when no subtitles are used', async () => {
    const fontsDir = join(root, 'fonts');
    const backupDir = join(root, `fonts-empty-backup-${Date.now()}`);
    await mkdir(backupDir, { recursive: true });
    const entries = await readdir(fontsDir);
    for (const f of entries) {
      if (/\.(ttf|otf)$/i.test(f)) {
        await rename(join(fontsDir, f), join(backupDir, f));
      }
    }
    try {
      const image = await readFile(join(fixturesDir, 'image.png'));
      const boundary = '----NoFontBoundary' + Date.now();
      const config = {
        outputPreset: 'preview',
        background: '000000',
        clips: [{ duration: 2, fit: 'cover' }],
      };
      const body = buildMultipartBody(
        [
          { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
          { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
        ],
        boundary,
      );
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body.toString('utf8')) as { ok: boolean };
      expect(data.ok).toBe(true);
    } finally {
      const backedUp = await readdir(backupDir);
      for (const f of backedUp) {
        await rename(join(backupDir, f), join(fontsDir, f));
      }
      await rm(backupDir, { recursive: true, force: true });
    }
  }, 120000);

  it('reports a clear font error when subtitles are used without available fonts', async () => {
    const fontsDir = join(root, 'fonts');
    const backupDir = join(root, `fonts-sub-backup-${Date.now()}`);
    await mkdir(backupDir, { recursive: true });
    const entries = await readdir(fontsDir);
    for (const f of entries) {
      if (/\.(ttf|otf)$/i.test(f)) {
        await rename(join(fontsDir, f), join(backupDir, f));
      }
    }
    const originalFontconfig = process.env.FONTCONFIG_FILE;
    process.env.FONTCONFIG_FILE = '/dev/null';
    try {
      const image = await readFile(join(fixturesDir, 'image.png'));
      const boundary = '----SubtitleNoFontBoundary' + Date.now();
      const config = {
        outputPreset: 'preview',
        background: '000000',
        clips: [{ duration: 2, fit: 'cover' }],
        subtitles: [{ start: 0.5, end: 1.0, text: 'Hello', x: 540, y: 1500, fontSize: 100 }],
      };
      const body = buildMultipartBody(
        [
          { name: 'config', contentType: 'application/json', data: Buffer.from(JSON.stringify(config)) },
          { name: 'clip-0', filename: 'image.png', contentType: 'image/png', data: image },
        ],
        boundary,
      );
      const res = await httpPost(
        `${serverInfo.url}/api/generate`,
        body,
        `multipart/form-data; boundary=${boundary}`,
        { Origin: serverInfo.url },
      );
      expect(res.status).toBe(400);
      const text = res.body.toString('utf8');
      expect(text).toContain('フォント');
    } finally {
      process.env.FONTCONFIG_FILE = originalFontconfig;
      const backedUp = await readdir(backupDir);
      for (const f of backedUp) {
        await rename(join(backupDir, f), join(fontsDir, f));
      }
      await rm(backupDir, { recursive: true, force: true });
    }
  }, 120000);

  it('rejects invalid project ID characters with a JSON error', async () => {
    const res = await httpGet(`${serverInfo.url}/api/projects/invalid!id/assets`);
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body.toString('utf8')) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain('プロジェクトID');
  });
});
