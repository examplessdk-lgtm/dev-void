import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const script = resolve(import.meta.dirname, '../../../scripts/kitchen-sink-smoke-test.ts');

describe('kitchen-sink smoke destination', () => {
  it('exits before launching a browser or resetting data without an explicit target', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_URL: '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set SMOKE_URL to a disposable kitchen-sink deployment');
  });

  it('rejects URLs containing credentials or non-origin components', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_URL: 'https://user:secret@platform.example.com/path' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SMOKE_URL must be an HTTP(S) origin without credentials');
  });
});
