import { readdirSync } from 'node:fs';
import { join } from 'pathslash';

/**
 * Every non-directory path under `dir`, depth first. Unlike
 * `readdirSync(dir, { recursive: true })`, it does not descend into
 * symlinked directories.
 */
export function collectFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
