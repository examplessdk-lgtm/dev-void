import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vite-plus/test';

const exec = promisify(execFile);

it('reuses a UTC database template across processes with different local timezones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'void-api-template-timezone-'));
  const script = `
    import { PGlite } from ${JSON.stringify(import.meta.resolve('@electric-sql/pglite'))};
    import {
      ensurePGliteTemplateBundlePath,
      loadPGliteTemplateBundle,
    } from ${JSON.stringify(new URL('./db-template.ts', import.meta.url).href)};
    const path = await ensurePGliteTemplateBundlePath();
    if (process.argv[1] === 'create') {
      console.log(JSON.stringify({ path }));
    } else {
      const db = new PGlite({ loadDataDir: await loadPGliteTemplateBundle() });
      try {
        const { rows } = await db.query('SHOW TimeZone');
        console.log(JSON.stringify({ path, timezone: rows[0].TimeZone }));
      } finally {
        await db.close();
      }
    }
  `;
  try {
    const run = async (timezone: string, mode: 'create' | 'restore') => {
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script, mode], {
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory, TZ: timezone },
        timeout: 10_000,
      });
      return JSON.parse(stdout) as { path: string; timezone: string };
    };
    const created = await run('Australia/Melbourne', 'create');
    const reused = await run('America/Los_Angeles', 'restore');
    expect(reused.timezone).toBe('UTC');
    expect(reused.path).toBe(created.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
