import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './core.js';
import { getOutputSnapshotPath, prepareJobAssetDir, writeAuditManifest, type AuditSource } from './audit.js';
import { toUserMessage } from './user-error.js';
import {
  addProjectClip,
  autofillTimelineWithTrendingClips,
  buildProjectTimeline,
  getProjectAsset,
  getProjectPaths,
  getTrendingClipSuggestions,
  importTranscriptSubtitles,
  listProjectAssets,
  loadProjectConfig,
  moveProjectClip,
  recordProjectUsage,
  removeProjectClip,
  resolveFontsForTimeline,
  resolveProjectRoot,
  saveProjectAsset,
  saveProjectConfig,
  setProjectClip,
  splitProjectClip,
  type ProjectClipConfig,
  type ProjectTimelineConfig,
} from './gui/project.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const guiDir = resolve(root, 'gui');
const outputDir = resolve(guiDir, 'output');

let initialized = false;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id: string | number | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}

function parseArgs(params: unknown): Record<string, unknown> {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function getString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${key} は必須です`);
  return v;
}

function getNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} は数値で指定してください`);
  return n;
}

function validateProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error('プロジェクトIDに使用できない文字が含まれています');
  }
}

async function listProjects(): Promise<string[]> {
  const projectsDir = resolve(root, 'gui', 'projects');
  const entries = await readdir(projectsDir).catch(() => []);
  const projects: string[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(resolve(projectsDir, entry));
      if (s.isDirectory()) projects.push(entry);
    } catch {
      // ignore
    }
  }
  return projects;
}

async function exportVideo(projectId: string, config: ProjectTimelineConfig): Promise<unknown> {
  let timeline = await buildProjectTimeline(root, projectId, config);

  if (timeline.subtitles && timeline.subtitles.length > 0) {
    await resolveFontsForTimeline(root, projectId, timeline);
  }

  const projectRoot = resolveProjectRoot(root, projectId);
  const paths = getProjectPaths(projectRoot);
  const jobId = randomUUID();
  const artifactDir = resolve(guiDir, 'output', 'artifacts', jobId);
  await prepareJobAssetDir(artifactDir, root);

  const startedAt = new Date().toISOString();
  const result = await generate(timeline, {
    rootDir: projectRoot,
    fixturesDir: paths.inputDir,
    outputDir: artifactDir,
    fontsDir: resolve(projectRoot, 'fonts'),
  });
  const finishedAt = new Date().toISOString();

  const manifestPath = await writeAuditManifest({
    jobId,
    source: 'CODEX' as AuditSource,
    startedAt,
    finishedAt,
    rootDir: root,
    outputDir,
    fixturesDir: paths.inputDir,
    fontsDir: resolve(projectRoot, 'fonts'),
    result,
  });

  const snapshotPath = getOutputSnapshotPath(outputDir, jobId, result.outputPath);
  const outputUrlPath = relative(outputDir, snapshotPath).replace(/\\/g, '/');

  await recordProjectUsage(root, projectId, config);

  return {
    outputUrl: `/api/output/${encodeURIComponent(outputUrlPath)}`,
    outputPath: outputUrlPath,
    auditJobId: jobId,
    auditManifestPath: manifestPath,
    timelineHash: result.timelineHash,
    probe: result.probe,
    outputPreset: result.outputPreset,
    effectiveEncoding: result.effectiveEncoding,
    ffmpegVersion: result.ffmpegVersion,
  };
}

const TOOLS = [
  {
    name: 'upload_media',
    description: '画像・動画・音声ファイルをプロジェクトの素材ライブラリに追加します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        filePath: { type: 'string', description: '読み込むファイルの絶対パスまたはリポジトリルートからの相対パス' },
      },
      required: ['projectId', 'filePath'],
    },
  },
  {
    name: 'list_media',
    description: 'プロジェクトの素材ライブラリ一覧を取得します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'list_projects',
    description: '存在するプロジェクトIDの一覧を取得します。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_clip',
    description: 'タイムラインにクリップを追加します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        assetId: { type: 'string' },
        in: { type: 'number', description: 'ソース上の開始秒（動画のみ、省略時0）' },
        out: { type: 'number', description: 'ソース上の終了秒（省略時は素材の終了）' },
        fit: { type: 'string', enum: ['cover', 'contain'], default: 'cover' },
        scale: { type: 'number', description: '表示倍率（0.1〜5、coverは拡大、containは縮小に使う）', default: 1 },
        x: { type: 'number', description: '中央からのXオフセット（画素）', default: 0 },
        y: { type: 'number', description: '中央からのYオフセット（画素）', default: 0 },
      },
      required: ['projectId', 'assetId'],
    },
  },
  {
    name: 'set_clip_range',
    description: '指定したクリップのin/out/fit/scale/offsetを変更します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        index: { type: 'integer', description: '0始まりのクリップ番号' },
        in: { type: 'number' },
        out: { type: 'number' },
        fit: { type: 'string', enum: ['cover', 'contain'] },
        scale: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['projectId', 'index'],
    },
  },
  {
    name: 'split_clip',
    description: '指定したクリップを指定秒で2つに分割します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        index: { type: 'integer' },
        splitAt: { type: 'number', description: 'ソース上の分割位置（秒）' },
      },
      required: ['projectId', 'index', 'splitAt'],
    },
  },
  {
    name: 'duplicate_clip',
    description: '指定したクリップを複製します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, index: { type: 'integer' } },
      required: ['projectId', 'index'],
    },
  },
  {
    name: 'move_clip',
    description: 'クリップの順番を移動します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, index: { type: 'integer' }, newIndex: { type: 'integer' } },
      required: ['projectId', 'index', 'newIndex'],
    },
  },
  {
    name: 'remove_clip',
    description: '指定したクリップを削除します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, index: { type: 'integer' } },
      required: ['projectId', 'index'],
    },
  },
  {
    name: 'set_main_audio',
    description: '主音声を設定します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        assetId: { type: 'string' },
        in: { type: 'number', default: 0 },
        out: { type: 'number' },
      },
      required: ['projectId', 'assetId'],
    },
  },
  {
    name: 'set_bgm',
    description: 'BGMを設定します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        assetId: { type: 'string' },
        in: { type: 'number', default: 0 },
        out: { type: 'number' },
        start: { type: 'number', default: 0 },
        volume: { type: 'number', default: 0.3 },
      },
      required: ['projectId', 'assetId'],
    },
  },
  {
    name: 'set_crossfade',
    description: 'クリップ間のクロスフェードを設定します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        enabled: { type: 'boolean' },
        duration: { type: 'number' },
      },
      required: ['projectId', 'enabled'],
    },
  },
  {
    name: 'set_output_settings',
    description: '出力品質と背景色を設定します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        outputPreset: { type: 'string', enum: ['preview', 'final'] },
        background: { type: 'string', description: '#RRGGBB または RRGGBB' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'add_subtitle',
    description: '字幕を追加します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        start: { type: 'number' },
        end: { type: 'number' },
        text: { type: 'string' },
        x: { type: 'number', default: 540 },
        y: { type: 'number', default: 1500 },
        fontSize: { type: 'number', default: 100 },
        fontColor: { type: 'string', default: '#FFFFFF' },
        fontAlpha: { type: 'number', default: 1 },
        borderWidth: { type: 'number', default: 0 },
        borderColor: { type: 'string', default: '#000000' },
        box: { type: 'boolean', default: false },
        boxColor: { type: 'string', default: '#000000' },
        boxAlpha: { type: 'number', default: 0.5 },
        align: { type: 'string', enum: ['left', 'center', 'right'], default: 'left' },
        font: { type: 'string', description: 'フォントファイル名（例: IPAGothic.ttf）。未指定時は自動選択' },
      },
      required: ['projectId', 'start', 'end', 'text'],
    },
  },
  {
    name: 'clear_subtitles',
    description: '字幕をすべて削除します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'import_transcript',
    description: 'トランスクリプトから字幕を自動生成します。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        transcript: {
          type: 'array',
          items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } }, required: ['start', 'end', 'text'] },
        },
      },
      required: ['projectId', 'transcript'],
    },
  },
  {
    name: 'get_timeline',
    description: '現在のタイムライン設定を取得します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'suggest_trending_clips',
    description: '素材内で伸びそうなクリップ区間を内部スコアリングで提案します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'autofill_timeline',
    description: '内部スコアリングで選んだクリップをタイムラインに自動追加します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'export_video',
    description: '現在のタイムラインをレンダリングして動画を出力します。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const projectId = getString(args, 'projectId');
  validateProjectId(projectId);

  switch (name) {
    case 'upload_media': {
      const filePath = getString(args, 'filePath');
      const resolvedPath = resolve(root, filePath);
      const data = await readFile(resolvedPath);
      const asset = await saveProjectAsset(root, projectId, basename(resolvedPath), data);
      return textResult(JSON.stringify(asset, null, 2));
    }

    case 'list_media': {
      const assets = await listProjectAssets(root, projectId);
      return textResult(JSON.stringify(assets, null, 2));
    }

    case 'list_projects': {
      const projects = await listProjects();
      return textResult(JSON.stringify(projects, null, 2));
    }

    case 'add_clip': {
      const clip: ProjectClipConfig = {
        assetId: getString(args, 'assetId'),
        in: args.in !== undefined ? getNumber(args, 'in') : undefined,
        out: args.out !== undefined ? getNumber(args, 'out') : undefined,
        fit: args.fit === 'contain' ? 'contain' : 'cover',
        scale: args.scale !== undefined ? getNumber(args, 'scale') : 1,
        x: args.x !== undefined ? getNumber(args, 'x') : 0,
        y: args.y !== undefined ? getNumber(args, 'y') : 0,
      };
      const config = await addProjectClip(root, projectId, clip);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'set_clip_range': {
      const index = getNumber(args, 'index');
      const patch: Partial<ProjectClipConfig> = {};
      if (args.in !== undefined) patch.in = getNumber(args, 'in');
      if (args.out !== undefined) patch.out = getNumber(args, 'out');
      if (args.fit === 'contain') patch.fit = 'contain';
      if (args.fit === 'cover') patch.fit = 'cover';
      if (args.scale !== undefined) patch.scale = getNumber(args, 'scale');
      if (args.x !== undefined) patch.x = getNumber(args, 'x');
      if (args.y !== undefined) patch.y = getNumber(args, 'y');
      const config = await setProjectClip(root, projectId, index, patch);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'split_clip': {
      const config = await splitProjectClip(root, projectId, getNumber(args, 'index'), getNumber(args, 'splitAt'));
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'duplicate_clip': {
      const config = await loadProjectConfig(root, projectId);
      const index = getNumber(args, 'index');
      if (index < 0 || index >= config.clips.length) throw new Error('クリップが見つかりません');
      if (config.clips.length >= 5) throw new Error('画像・動画は最大5つまでです');
      config.clips.splice(index + 1, 0, { ...config.clips[index] });
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'move_clip': {
      const config = await moveProjectClip(root, projectId, getNumber(args, 'index'), getNumber(args, 'newIndex'));
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'remove_clip': {
      const config = await removeProjectClip(root, projectId, getNumber(args, 'index'));
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'set_main_audio': {
      const config = await loadProjectConfig(root, projectId);
      const asset = await getProjectAsset(root, projectId, getString(args, 'assetId'));
      if (!asset || asset.type !== 'audio') throw new Error('音声素材が見つかりません');
      const inTime = args.in !== undefined ? getNumber(args, 'in') : 0;
      const outTime = args.out !== undefined ? getNumber(args, 'out') : (asset.duration ?? inTime + 10);
      config.mainAudio = { assetId: asset.assetId, in: inTime, out: outTime };
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'set_bgm': {
      const config = await loadProjectConfig(root, projectId);
      const asset = await getProjectAsset(root, projectId, getString(args, 'assetId'));
      if (!asset || asset.type !== 'audio') throw new Error('音声素材が見つかりません');
      const inTime = args.in !== undefined ? getNumber(args, 'in') : 0;
      const outTime = args.out !== undefined ? getNumber(args, 'out') : (asset.duration ?? inTime + 10);
      config.bgm = {
        assetId: asset.assetId,
        in: inTime,
        out: outTime,
        start: args.start !== undefined ? getNumber(args, 'start') : 0,
        volume: args.volume !== undefined ? getNumber(args, 'volume') : 0.3,
      };
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'set_crossfade': {
      const config = await loadProjectConfig(root, projectId);
      config.crossfade = {
        enabled: Boolean(args.enabled),
        duration: args.duration !== undefined ? getNumber(args, 'duration') : 0.5,
      };
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'set_output_settings': {
      const config = await loadProjectConfig(root, projectId);
      if (args.outputPreset === 'preview' || args.outputPreset === 'final') {
        config.outputPreset = args.outputPreset;
      }
      if (typeof args.background === 'string') {
        const bg = args.background.replace('#', '');
        if (/^[0-9A-Fa-f]{6}$/.test(bg)) config.background = bg.toLowerCase();
      }
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'add_subtitle': {
      const config = await loadProjectConfig(root, projectId);
      if (!Array.isArray(config.subtitles)) config.subtitles = [];
      if (config.subtitles.length >= 20) throw new Error('字幕は最大20件までです');
      const hexColor = (value: unknown, fallback: string): string => {
        const str = String(value ?? fallback);
        return /^#?[0-9A-Fa-f]{6}$/.test(str) ? str : fallback;
      };
      config.subtitles.push({
        start: getNumber(args, 'start'),
        end: getNumber(args, 'end'),
        text: getString(args, 'text'),
        x: args.x !== undefined ? getNumber(args, 'x') : 540,
        y: args.y !== undefined ? getNumber(args, 'y') : 1500,
        fontSize: args.fontSize !== undefined ? getNumber(args, 'fontSize') : 100,
        fontColor: hexColor(args.fontColor, '#FFFFFF'),
        fontAlpha: args.fontAlpha !== undefined ? getNumber(args, 'fontAlpha') : 1,
        borderWidth: args.borderWidth !== undefined ? getNumber(args, 'borderWidth') : 0,
        borderColor: hexColor(args.borderColor, '#000000'),
        box: args.box !== undefined ? Boolean(args.box) : false,
        boxColor: hexColor(args.boxColor, '#000000'),
        boxAlpha: args.boxAlpha !== undefined ? getNumber(args, 'boxAlpha') : 0.5,
        align: ['left', 'center', 'right'].includes(args.align as string) ? (args.align as 'left' | 'center' | 'right') : 'left',
        font: typeof args.font === 'string' && args.font.length > 0 ? args.font : undefined,
      });
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'clear_subtitles': {
      const config = await loadProjectConfig(root, projectId);
      config.subtitles = undefined;
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'import_transcript': {
      const config = await loadProjectConfig(root, projectId);
      const transcript = args.transcript;
      if (!Array.isArray(transcript)) throw new Error('transcript は配列で指定してください');
      const cues = await importTranscriptSubtitles(root, projectId, transcript as { start: number; end: number; text: string }[], config);
      config.subtitles = cues;
      await saveProjectConfig(root, projectId, config);
      return textResult(JSON.stringify(cues, null, 2));
    }

    case 'get_timeline': {
      const config = await loadProjectConfig(root, projectId);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'suggest_trending_clips': {
      const suggestions = await getTrendingClipSuggestions(root, projectId);
      return textResult(JSON.stringify(suggestions, null, 2));
    }

    case 'autofill_timeline': {
      const config = await autofillTimelineWithTrendingClips(root, projectId);
      return textResult(JSON.stringify(config, null, 2));
    }

    case 'export_video': {
      const config = await loadProjectConfig(root, projectId);
      const result = await exportVideo(projectId, config);
      return textResult(JSON.stringify(result, null, 2));
    }

    default:
      throw new Error(`未知のツールです: ${name}`);
  }
}

async function handleMessage(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;

  if (method === 'initialize') {
    const protocolVersion =
      typeof params === 'object' && params !== null && 'protocolVersion' in params
        ? (params as { protocolVersion?: string }).protocolVersion
        : '2024-11-05';
    if (id === undefined) return;
    initialized = true;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'short-video-creater-mcp', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (!initialized) {
    sendError(id, -32002, 'サーバーが初期化されていません');
    return;
  }

  if (method === 'tools/list') {
    if (id === undefined) return;
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    if (id === undefined) return;
    const args = parseArgs(params);
    const name = typeof args.name === 'string' ? args.name : '';
    const argumentsMap = parseArgs(args.arguments);
    try {
      const result = await handleToolCall(name, argumentsMap);
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const message = toUserMessage(err);
      send({ jsonrpc: '2.0', id, result: textResult(message, true) });
    }
    return;
  }

  sendError(id, -32601, `メソッドが見つかりません: ${method}`);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      await handleMessage(req);
    } catch {
      sendError(-1, -32700, 'リクエストの解析に失敗しました');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
