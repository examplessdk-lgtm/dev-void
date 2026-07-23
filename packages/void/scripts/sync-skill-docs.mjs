import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'pathslash';
import { globSync } from 'tinyglobby';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, '..');
const sourceDir = resolve(packageDir, '../../docs');
const targetDir = resolve(packageDir, 'skills/void/docs');

if (!existsSync(sourceDir)) {
  throw new Error(`docs: Missing source directory '${sourceDir}'.`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

for (const file of globSync('**/*.md', { cwd: sourceDir })) {
  const dest = resolve(targetDir, file);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(resolve(sourceDir, file), dest);
}
