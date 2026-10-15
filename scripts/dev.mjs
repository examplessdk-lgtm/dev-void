import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '../docs');
const vitepressBin = resolve(docsDir, 'node_modules/.bin/vitepress');

const child = spawn(
  process.execPath,
  [vitepressBin, 'dev', '--host', '0.0.0.0', '--port', '3000'],
  {
    cwd: docsDir,
    stdio: 'inherit',
  }
);

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
