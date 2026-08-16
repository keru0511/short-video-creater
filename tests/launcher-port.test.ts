import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function httpGetStatus(url: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('http get timeout')));
    req.setTimeout(timeoutMs);
    req.end();
  });
}

function waitForLine(
  proc: ChildProcessWithoutNullStreams,
  prefix: string,
  timeoutMs = 10000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new Error(`did not see "${prefix}" within ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const idx = stdout.indexOf(prefix);
      if (idx !== -1) {
        clearTimeout(timer);
        const end = stdout.indexOf('\n', idx);
        resolve(stdout.slice(idx, end === -1 ? undefined : end));
      }
    });
    proc.stderr.on('data', (data) => {
      stdout += data.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`launcher exited early with code ${code}`));
    });
  });
}

async function waitForOpenerUrl(openerOut: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await readFile(openerOut, 'utf8');
    } catch {
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  throw new Error(`opener did not write URL to ${openerOut} within ${timeoutMs}ms`);
}

function killProcess(proc: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    function done(code: number | null) {
      if (settled) return;
      settled = true;
      resolve(code);
    }
    if (proc.exitCode !== null) {
      done(proc.exitCode);
      return;
    }
    proc.on('exit', (c) => done(c ?? null));
    proc.on('error', () => done(proc.exitCode ?? null));
    proc.kill('SIGTERM');
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      setTimeout(() => done(proc.exitCode ?? null), 500);
    }, timeoutMs);
    timer.unref?.();
  });
}

describe('launcher port fallback', () => {
  let launcherProc: ChildProcessWithoutNullStreams | undefined;
  let occupiedServer: ReturnType<typeof createServer> | undefined;
  let binDir: string | undefined;

  afterEach(async () => {
    if (launcherProc) {
      await killProcess(launcherProc);
      launcherProc = undefined;
    }
    if (occupiedServer) {
      await new Promise((resolve) => {
        occupiedServer!.close(() => resolve(undefined));
        occupiedServer!.unref?.();
      });
      occupiedServer = undefined;
    }
    if (binDir) {
      await rm(binDir, { recursive: true, force: true });
      binDir = undefined;
    }
  });

  it('uses an available port and passes the selected URL to the OS opener', async () => {
    occupiedServer = createServer((req, res) => {
      res.statusCode = 200;
      res.end('occupied');
    });
    await new Promise<void>((resolve, reject) => {
      occupiedServer!.once('error', reject);
      occupiedServer!.listen(3000, '127.0.0.1', () => {
        occupiedServer!.removeListener('error', reject);
        resolve();
      });
    });

    binDir = await mkdtemp(join(tmpdir(), 'opener-test-'));
    const openerOut = join(binDir, 'opener-url');
    const fakeXdgOpen = join(binDir, 'xdg-open');
    await writeFile(
      fakeXdgOpen,
      `#!/bin/sh\nprintf '%s' "$1" > "${openerOut}"\n`,
    );
    await chmod(fakeXdgOpen, 0o755);

    const pathEnv = `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`;

    launcherProc = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(root, 'src', 'gui', 'launcher.ts')],
      {
        cwd: root,
        env: { ...process.env, GUI_PORT: '', PATH: pathEnv },
        stdio: 'pipe',
      },
    );

    const line = await waitForLine(launcherProc, 'ローカルGUI: ', 15000);
    const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    expect(match).toBeTruthy();
    const url = match![0];
    const port = Number(match![1]);
    expect(port).not.toBe(3000);
    expect(await httpGetStatus(url)).toBe(200);

    const openerUrl = await waitForOpenerUrl(openerOut, 5000);
    expect(openerUrl).toBe(url);
  }, 25000);
});
