import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const isWindows = process.platform === 'win32';

function npmCommand() {
  return isWindows ? 'npm.cmd' : 'npm';
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

function runCommandSilent(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'ignore', shell: false });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function hasAllDependencies() {
  const code = await runCommandSilent(npmCommand(), ['ls', '--depth=0'], { cwd: root });
  return code === 0;
}

async function ensureDependencies() {
  if (await hasAllDependencies()) {
    return;
  }
  console.log('初回起動: 依存パッケージをインストールしています...');
  const code = await runCommand(npmCommand(), ['ci'], { cwd: root });
  if (code !== 0) {
    throw new Error(`npm ci が失敗しました（終了コード ${code}）。ターミナルから手動で npm ci を実行してください。`);
  }
  if (!(await hasAllDependencies())) {
    throw new Error('npm ci 後も依存パッケージが揃っていません。node_modules が壊れている可能性があります。削除して npm ci を再実行してください。');
  }
}

async function main() {
  await ensureDependencies();
  const code = await runCommand(npmCommand(), ['run', 'gui:launch'], { cwd: root });
  process.exit(code ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
