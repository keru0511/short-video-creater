import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface SpawnedProcess {
  proc: ReturnType<typeof spawn>;
  port: number;
  tempDir: string;
}

async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server did not start on port ${port} in time`));
        return;
      }
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(tryConnect, 100);
        }
      });
      req.on('error', () => setTimeout(tryConnect, 100));
      req.end();
    }
    tryConnect();
  });
}

function killProcess(proc: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<number | null> {
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
    proc.on('error', () => done(proc.exitCode));

    const start = Date.now();
    const interval = setInterval(() => {
      if (proc.exitCode !== null) {
        done(proc.exitCode);
        clearInterval(interval);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        if (proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        } else {
          proc.kill('SIGKILL');
        }
        setTimeout(() => done(proc.exitCode ?? null), 500).unref();
      }
    }, 100).unref();

    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    } else {
      proc.kill('SIGTERM');
    }
  });
}

function waitForNaturalExit(
  proc: ReturnType<typeof spawn>,
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function makeTempProject(): Promise<{ tempDir: string; binDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'launcher-test-'));
  const binDir = join(tempDir, 'bin');
  const srcDir = join(tempDir, 'src', 'gui');
  await mkdir(binDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });
  await cp(join(repoRoot, 'src', 'gui', 'launcher-bootstrap.mjs'), join(srcDir, 'launcher-bootstrap.mjs'));
  await cp(join(repoRoot, 'package.json'), join(tempDir, 'package.json'));
  await cp(join(repoRoot, 'package-lock.json'), join(tempDir, 'package-lock.json'));
  return { tempDir, binDir };
}

async function writeFakeNpm(binDir: string): Promise<void> {
  const npm = join(binDir, 'npm');
  await writeFile(
    npm,
    `#!/bin/sh
set -e
cmd="$1"
shift
case "$cmd" in
  ls)
    for dep in @types/node tsx typescript vitest zod; do
      if [ ! -f "node_modules/$dep/package.json" ]; then
        exit 1
      fi
    done
    exit 0
    ;;
  ci)
    rm -rf node_modules
    mkdir -p node_modules/.bin
    mkdir -p node_modules/@types/node
    mkdir -p node_modules/tsx
    mkdir -p node_modules/typescript
    mkdir -p node_modules/vitest
    mkdir -p node_modules/zod
    cat > node_modules/.bin/tsx <<'TSX'
#!/bin/sh
exec node "$@"
TSX
    chmod +x node_modules/.bin/tsx
    printf '{"name":"@types/node","version":"0.0.0"}' > node_modules/@types/node/package.json
    printf '{"name":"tsx","version":"0.0.0"}' > node_modules/tsx/package.json
    printf '{"name":"typescript","version":"0.0.0"}' > node_modules/typescript/package.json
    printf '{"name":"vitest","version":"0.0.0"}' > node_modules/vitest/package.json
    printf '{"name":"zod","version":"0.0.0"}' > node_modules/zod/package.json
    if [ "$FAIL_CI" = "1" ]; then exit 1; fi
    touch npm-ci-ran
    ;;
  run)
    exec node -e "const http=require('http'),fs=require('fs'); const s=http.createServer((req,res)=>{res.statusCode=200;res.end('ok');}); s.listen(parseInt(process.env['TEST_PORT']||'3456',10),'127.0.0.1',()=>{fs.writeFileSync('server.pid',String(process.pid));console.log('ready');});"
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  await chmod(npm, 0o755);
}

async function writeFakeMise(binDir: string): Promise<void> {
  const mise = join(binDir, 'mise');
  await writeFile(
    mise,
    `#!/bin/sh
if [ "$1" = "x" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
`,
  );
  await chmod(mise, 0o755);
}

async function createInstalledModules(tempDir: string): Promise<void> {
  await mkdir(join(tempDir, 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(tempDir, 'node_modules', '@types', 'node'), { recursive: true });
  await mkdir(join(tempDir, 'node_modules', 'tsx'), { recursive: true });
  await mkdir(join(tempDir, 'node_modules', 'typescript'), { recursive: true });
  await mkdir(join(tempDir, 'node_modules', 'vitest'), { recursive: true });
  await mkdir(join(tempDir, 'node_modules', 'zod'), { recursive: true });

  await writeFile(join(tempDir, 'node_modules', '.bin', 'tsx'), '#!/bin/sh\nexec node "$@"\n');
  await chmod(join(tempDir, 'node_modules', '.bin', 'tsx'), 0o755);

  await writeFile(join(tempDir, 'node_modules', '@types', 'node', 'package.json'), '{"name":"@types/node","version":"0.0.0"}');
  await writeFile(join(tempDir, 'node_modules', 'tsx', 'package.json'), '{"name":"tsx","version":"0.0.0"}');
  await writeFile(join(tempDir, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"0.0.0"}');
  await writeFile(join(tempDir, 'node_modules', 'vitest', 'package.json'), '{"name":"vitest","version":"0.0.0"}');
  await writeFile(join(tempDir, 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"0.0.0"}');
}

async function runBootstrap(
  tempDir: string,
  binDir: string,
  env: Record<string, string> = {},
  useShell = false,
): Promise<SpawnedProcess> {
  const port = await getFreePort();
  const basePath = process.env.PATH ?? '/usr/bin:/bin';
  const pathEnv = `${binDir}:${basePath}`;
  const childEnv = {
    HOME: tempDir,
    PATH: pathEnv,
    TEST_PORT: String(port),
    ...env,
  };
  const cmd = useShell ? 'bash' : 'node';
  const args = useShell ? ['launch-gui.sh'] : ['src/gui/launcher-bootstrap.mjs'];
  const proc = spawn(cmd, args, {
    cwd: tempDir,
    env: childEnv,
    stdio: 'pipe',
    detached: true,
  });
  return { proc, port, tempDir };
}

describe('launcher-bootstrap.mjs', () => {
  let active: SpawnedProcess | undefined;

  afterEach(async () => {
    if (active) {
      await killProcess(active.proc);
      await rm(active.tempDir, { recursive: true, force: true }).catch(() => {});
      active = undefined;
    }
  });

  it('skips npm ci when all dependencies are installed and starts the GUI', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await createInstalledModules(tempDir);
    active = await runBootstrap(tempDir, binDir);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(false);
  }, 15000);

  it('runs npm ci when tsx exists but zod is missing (partial install)', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await createInstalledModules(tempDir);
    await rm(join(tempDir, 'node_modules', 'zod'), { recursive: true, force: true });
    active = await runBootstrap(tempDir, binDir);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(true);
  }, 15000);

  it('runs npm ci when node_modules is empty and starts the GUI', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await mkdir(join(tempDir, 'node_modules'), { recursive: true });
    active = await runBootstrap(tempDir, binDir);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(true);
  }, 15000);

  it('runs npm ci when node_modules is partial (tsx missing) and starts the GUI', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await mkdir(join(tempDir, 'node_modules', 'leftover'), { recursive: true });
    active = await runBootstrap(tempDir, binDir);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(true);
  }, 15000);

  it('exits with an error when npm ci fails', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    active = await runBootstrap(tempDir, binDir, { FAIL_CI: '1' });
    const { code, stderr } = await waitForNaturalExit(active.proc, 5000);
    expect(code).not.toBe(0);
    expect(stderr).toContain('npm ci が失敗しました');
  }, 15000);
});

describe('launcher shell scripts', () => {
  let active: SpawnedProcess | undefined;

  afterEach(async () => {
    if (active) {
      await killProcess(active.proc);
      await rm(active.tempDir, { recursive: true, force: true }).catch(() => {});
      active = undefined;
    }
  });

  it('launch-gui.sh falls back to node when mise is not available', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await cp(join(repoRoot, 'launch-gui.sh'), join(tempDir, 'launch-gui.sh'));
    active = await runBootstrap(tempDir, binDir, {}, true);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(true);
  }, 15000);

  it('launch-gui.sh uses mise when it is available in PATH', async () => {
    const { tempDir, binDir } = await makeTempProject();
    await writeFakeNpm(binDir);
    await writeFakeMise(binDir);
    await cp(join(repoRoot, 'launch-gui.sh'), join(tempDir, 'launch-gui.sh'));
    active = await runBootstrap(tempDir, binDir, {}, true);
    await waitForServer(active.port);
    expect(await exists(join(tempDir, 'npm-ci-ran'))).toBe(true);
  }, 15000);
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
