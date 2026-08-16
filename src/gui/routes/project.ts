import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generate, type Timeline } from '../../core.js';
import { getOutputSnapshotPath, prepareJobAssetDir, writeAuditManifest, type AuditSource } from '../../audit.js';
import { resolveSafePath } from '../../utils.js';
import { toUserMessage } from '../../user-error.js';
import { guiDir, outputDir, root } from '../paths.js';
import { checkOrigin, getContentType, json, sendError } from '../utils/response.js';
import { getMaxFileBytes, getMaxRequestBytes, parseMultipart, readLimitedBody } from '../middleware/multipart.js';
import {
  autofillTimelineWithTrendingClips,
  buildProjectTimeline,
  getProjectAsset,
  getProjectPaths,
  getTrendingClipSuggestions,
  importTranscriptSubtitles,
  listProjectAssets,
  loadProjectConfig,
  recordProjectUsage,
  resolveAssetFilePath,
  resolveProjectRoot,
  saveProjectAsset,
  saveProjectConfig,
  resolveFontsForTimeline,
  type ProjectTimelineConfig,
} from '../project.js';

export interface ProjectRoute {
  projectId: string;
  remainder: string;
}

const PROJECT_PATH_RE = /^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/;

export function matchProjectRoute(pathname: string): ProjectRoute | undefined {
  const m = pathname.match(PROJECT_PATH_RE);
  if (!m) return undefined;
  return { projectId: m[1], remainder: m[2] ?? '' };
}

function parseRangeHeader(range: string, total: number): { start: number; end: number } | null {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : NaN;
  const end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    if (Number.isNaN(end) || end <= 0) return null;
    return { start: Math.max(0, total - end), end: total - 1 };
  }
  if (Number.isNaN(end)) return { start, end: total - 1 };
  return { start, end: Math.min(end, total - 1) };
}

async function handleProjectUploadAsset(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const { files } = await parseMultipart(req, res);
    const file = files.find((f) => f.name === 'file');
    if (!file) {
      sendError(res, 400, 'file フィールドが必要です');
      return;
    }
    if (file.data.length > getMaxFileBytes()) {
      sendError(res, 413, `ファイルサイズが大きすぎます`);
      return;
    }
    const asset = await saveProjectAsset(root, projectId, file.filename, file.data);
    json(res, 200, { ok: true, asset });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectListAssets(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const assets = await listProjectAssets(root, projectId);
    json(res, 200, { ok: true, assets });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectGetAsset(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  assetId: string,
): Promise<void> {
  try {
    const asset = await getProjectAsset(root, projectId, assetId);
    if (!asset) {
      sendError(res, 404, '素材が見つかりません');
      return;
    }
    json(res, 200, { ok: true, asset });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectSourceFile(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  assetId: string,
): Promise<void> {
  try {
    const filePath = await resolveAssetFilePath(root, projectId, assetId);
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendError(res, 404, 'ファイルが見つかりません');
      return;
    }
    const total = Number(info.size);
    const contentType = getContentType(filePath);
    const range = req.headers.range;
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }
    if (range) {
      const parsed = parseRangeHeader(range, total);
      if (!parsed || parsed.start >= total || parsed.start > parsed.end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end('Range Not Satisfiable');
        return;
      }
      const { start, end } = parsed;
      const length = end - start + 1;
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    sendError(res, 404, toUserMessage(err));
  }
}

async function handleProjectGetTimeline(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const config = await loadProjectConfig(root, projectId);
    json(res, 200, { ok: true, config });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectSaveTimeline(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const config = JSON.parse(raw.toString('utf8')) as ProjectTimelineConfig;
    await saveProjectConfig(root, projectId, config);
    json(res, 200, { ok: true });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectPreview(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  filename: string,
): Promise<void> {
  try {
    const projectRoot = resolveProjectRoot(root, projectId);
    const previewPath = resolveSafePath(resolve(projectRoot, 'previews'), filename);
    const info = await stat(previewPath);
    if (!info.isFile()) {
      sendError(res, 404, 'リクエストされたコンテンツが見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': getContentType(previewPath),
      'Content-Length': info.size,
    });
    createReadStream(previewPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('リクエストされたコンテンツが見つかりません');
  }
}

async function handleProjectGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  let timeline: Timeline | undefined;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const config = JSON.parse(raw.toString('utf8')) as ProjectTimelineConfig;
    await saveProjectConfig(root, projectId, config);
    timeline = await buildProjectTimeline(root, projectId, config);

    if (timeline.subtitles && timeline.subtitles.length > 0) {
      await resolveFontsForTimeline(root, projectId, timeline);
    }

    const projectRoot = resolveProjectRoot(root, projectId);
    const paths = getProjectPaths(projectRoot);
    const artifactDir = resolve(guiDir, 'output', 'artifacts', jobId);
    await prepareJobAssetDir(artifactDir, root);

    const result = await generate(timeline, {
      rootDir: projectRoot,
      fixturesDir: paths.inputDir,
      outputDir: artifactDir,
      fontsDir: resolve(projectRoot, 'fonts'),
    });

    const finishedAt = new Date().toISOString();
    const manifestPath = await writeAuditManifest({
      jobId,
      source: 'GUI' as AuditSource,
      startedAt,
      finishedAt,
      rootDir: root,
      outputDir,
      fixturesDir: paths.inputDir,
      fontsDir: resolve(projectRoot, 'fonts'),
      result,
    });

    const snapshotPath = getOutputSnapshotPath(outputDir, jobId, result.outputPath);
    const outputUrlPath = resolve(outputDir, snapshotPath).replace(/\\/g, '/');

    await recordProjectUsage(root, projectId, config);

    json(res, 200, {
      ok: true,
      outputUrl: `/api/output/${encodeURIComponent(outputUrlPath)}`,
      outputPath: outputUrlPath,
      auditJobId: jobId,
      auditManifestPath: manifestPath,
      timelineHash: result.timelineHash,
      sourceHashes: result.sourceHashes,
      probe: result.probe,
      outputPreset: result.outputPreset,
      effectiveEncoding: result.effectiveEncoding,
      ffmpegVersion: result.ffmpegVersion,
    });
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 400, toUserMessage(err));
    }
  }
}

async function handleProjectSuggestClips(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  try {
    const suggestions = await getTrendingClipSuggestions(root, projectId);
    json(res, 200, { ok: true, suggestions });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectAutofill(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(_req, res)) return;
  try {
    const config = await autofillTimelineWithTrendingClips(root, projectId);
    json(res, 200, { ok: true, config });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

async function handleProjectTranscriptSubtitles(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  if (!checkOrigin(req, res)) return;
  try {
    const raw = await readLimitedBody(req, res, getMaxRequestBytes());
    const payload = JSON.parse(raw.toString('utf8')) as { transcript: { start: number; end: number; text: string }[]; config: ProjectTimelineConfig };
    const cues = await importTranscriptSubtitles(root, projectId, payload.transcript, payload.config);
    json(res, 200, { ok: true, cues });
  } catch (err) {
    sendError(res, 400, toUserMessage(err));
  }
}

export async function handleProjectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: ProjectRoute,
): Promise<void> {
  const { projectId, remainder } = route;
  const segments = remainder.split('/').filter(Boolean);

  if (req.method === 'POST' && segments.length === 1 && segments[0] === 'assets') {
    await handleProjectUploadAsset(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'assets') {
    await handleProjectListAssets(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'assets') {
    await handleProjectGetAsset(req, res, projectId, segments[1]);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && segments.length === 3 && segments[0] === 'assets' && segments[2] === 'source') {
    await handleProjectSourceFile(req, res, projectId, segments[1]);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'previews') {
    await handleProjectPreview(req, res, projectId, segments[1]);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'config') {
    await handleProjectGetTimeline(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'save') {
    await handleProjectSaveTimeline(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'generate') {
    await handleProjectGenerate(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'subtitles') {
    await handleProjectTranscriptSubtitles(req, res, projectId);
    return;
  }

  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'clips' && segments[1] === 'suggest') {
    await handleProjectSuggestClips(req, res, projectId);
    return;
  }

  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'timeline' && segments[1] === 'autofill') {
    await handleProjectAutofill(req, res, projectId);
    return;
  }

  res.writeHead(404);
  res.end('リクエストされたコンテンツが見つかりません');
}
