import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'pathslash';

export function writeFileIfChanged(path: string, content: string): boolean {
  let existing: string | null = null;

  try {
    existing = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  if (existing === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}
