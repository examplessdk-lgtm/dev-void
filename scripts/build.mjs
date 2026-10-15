import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '../docs');
const vitepressBin = resolve(docsDir, 'node_modules/.bin/vitepress');

const result = spawnSync(
  process.execPath,
  [vitepressBin, 'build'],
  { cwd: docsDir, stdio: 'inherit' }
);

process.exit(result.status ?? 0);
