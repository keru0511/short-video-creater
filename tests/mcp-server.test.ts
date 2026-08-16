import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixtures } from '../src/fixtures.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectId = `mcp-test-${Date.now()}`;
const bin = resolve(root, 'node_modules', '.bin', 'tsx');

describe('Codex MCP server', () => {
  let proc: ChildProcess;
  let requestId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  beforeAll(async () => {
    await rm(resolve(root, 'gui', 'projects', projectId), { recursive: true, force: true });
    await generateFixtures(root);
  }, 120000);

  afterAll(async () => {
    proc?.stdin?.end();
    proc?.kill();
    await rm(resolve(root, 'gui', 'projects', projectId), { recursive: true, force: true });
  });

  function init(): Promise<void> {
    const serverScript = resolve(root, 'src', 'codex-mcp-server.ts');
    return new Promise<void>((onResolve, onReject) => {
      proc = spawn(bin, [serverScript], { cwd: root, stdio: 'pipe' }) as ChildProcess;
      let buffer = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
            if (msg.id !== undefined && pending.has(msg.id)) {
              const p = pending.get(msg.id)!;
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } catch {
            // ignore malformed lines
          }
        }
      });
      proc.on('error', onReject);
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) onReject(new Error(`MCP server exited with ${code}`));
      });

      send('initialize', { protocolVersion: '2024-11-05', capabilities: {} }).then(() => {
        sendNotification('notifications/initialized', {});
        onResolve();
      }).catch(onReject);
    });
  }

  function send(method: string, params: unknown): Promise<unknown> {
    const id = requestId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    proc.stdin!.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  }

  function sendNotification(method: string, params: unknown): void {
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = (await send('tools/call', { name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  }

  it('initializes and lists tools', async () => {
    await init();
    const result = (await send('tools/list', {})) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('upload_media');
    expect(names).toContain('add_clip');
    expect(names).toContain('set_clip_range');
    expect(names).toContain('split_clip');
    expect(names).toContain('export_video');
    expect(names).toContain('import_transcript');
  }, 30000);

  it('uploads media and builds a timeline via tools', async () => {
    const image = await callTool('upload_media', { projectId, filePath: resolve(root, 'fixtures', 'image.png') });
    expect(image.type).toBe('image');

    const audio = await callTool('upload_media', { projectId, filePath: resolve(root, 'fixtures', 'audio.mp3') });
    expect(audio.type).toBe('audio');

    const timeline = await callTool('add_clip', { projectId, assetId: image.assetId, in: 0, out: 2, fit: 'cover' });
    expect(timeline.clips.length).toBe(1);

    const updated = await callTool('set_main_audio', { projectId, assetId: audio.assetId, in: 0, out: 2 });
    expect(updated.mainAudio.assetId).toBe(audio.assetId);
  }, 30000);

  it('splits a clip and exports video', async () => {
    const config = await callTool('get_timeline', { projectId });
    const assetId = config.clips[0].assetId;

    await callTool('set_clip_range', { projectId, index: 0, in: 0, out: 2 });
    await callTool('split_clip', { projectId, index: 0, splitAt: 1 });

    const after = await callTool('get_timeline', { projectId });
    expect(after.clips.length).toBe(2);
    expect(after.clips[0].out).toBe(1);
    expect(after.clips[1].in).toBe(1);

    await callTool('add_subtitle', { projectId, start: 0.5, end: 1, text: 'Hi' });

    const exported = await callTool('export_video', { projectId });
    expect(exported.outputUrl).toMatch('/api/output/');
    expect(exported.probe.width).toBe(1080);
    expect(exported.probe.height).toBe(1920);
    expect(exported.probe.videoCodec).toBe('h264');
    expect(exported.probe.audioCodec).toBe('aac');
  }, 120000);
});
