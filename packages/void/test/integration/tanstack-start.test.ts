import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/tanstack-start';
let DEV_PORT: number;
let DEV_BASE: string;

describe('playground/tanstack-start build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces expected build artifacts', () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/dist/server/index.js`);
    expect(existsSync(workerEntry)).toBe(true);

    const clientDir = join(ROOT, `${PLAYGROUND}/dist/client`);
    expect(existsSync(clientDir)).toBe(true);
  });

  it('generates wrangler.json with inferred bindings', () => {
    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, `${PLAYGROUND}/dist/server/wrangler.json`), 'utf-8'),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
      assets?: { directory?: string };
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(wranglerConfig.assets?.directory).toBe('../client');
  });
});

describe('playground/tanstack-start dev', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'pnpm',
      ['--dir', PLAYGROUND, 'exec', 'vite', '--host', '127.0.0.1', '--port', String(DEV_PORT)],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      },
    );

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(DEV_BASE, 20_000);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('TanStack Start + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
