import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { startServer } from './server.js';

const port = Number(process.env.GUI_PORT ?? 0);

function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = request(url, { method: 'GET' }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          scheduleRetry();
        }
      });
      req.on('error', scheduleRetry);
      req.end();
    };
    const scheduleRetry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Server did not become ready in time'));
        return;
      }
      setTimeout(tryConnect, 200);
    };
    tryConnect();
  });
}

function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.error('ブラウザを開けませんでした:', err);
  });
  child.unref();
}

const { url } = await startServer(port);
console.log(`ローカルGUI: ${url}`);
await waitForServer(url);
openBrowser(url);
