import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/astro';
let DEV_PORT: number;
let DEV_BASE: string;

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

function readWranglerConfig(root: string): {
  compatibility_flags?: string[];
  d1_databases?: Array<{ binding: string }>;
  kv_namespaces?: Array<{ binding: string }>;
} {
  const jsoncPath = join(root, 'wrangler.jsonc');
  const jsonPath = join(root, 'wrangler.json');
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  return JSON.parse(readFileSync(configPath, 'utf-8')) as {
    compatibility_flags?: string[];
    d1_databases?: Array<{ binding: string }>;
    kv_namespaces?: Array<{ binding: string }>;
  };
}

describe('playground/astro build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces expected build artifacts', () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/dist/server/entry.mjs`);
    expect(existsSync(workerEntry)).toBe(true);
  });
});

describe('playground/astro dev', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  const startDev = async () => {
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        PLAYGROUND,
        'exec',
        'astro',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEV_PORT),
      ],
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
  };

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    removeWranglerConfig(pg);

    // First boot: void plugin syncs inferred bindings to wrangler.jsonc.
    await startDev();
    await killChild(child);

    // Second boot: adapter reads synced config so runtime bindings are available.
    await startDev();
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('syncs wrangler config with compat flag and inferred bindings', () => {
    const wranglerConfig = readWranglerConfig(join(ROOT, PLAYGROUND));

    expect(wranglerConfig.compatibility_flags?.includes('nodejs_als')).toBe(true);
    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Astro + Void');
  });

  it('navigates to smoke route from home page', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(DEV_BASE);
      await page.click('a[href="/smoke"]');
      await page.waitForURL('**/smoke');
      const d1User = await page.textContent('[data-testid="d1-user"]');
      const kvValue = await page.textContent('[data-testid="kv-value"]');
      expect(d1User).toBe('Alice');
      expect(kvValue).toBe('ok');
    } finally {
      await browser.close();
    }
  });
});
