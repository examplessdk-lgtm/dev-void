import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Write through a unique temporary file and rename it, so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
