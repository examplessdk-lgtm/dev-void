import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathe';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/nuxt';
let DEV_PORT: number;
let DEV_BASE: string;

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

describe('playground/nuxt build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, '.output'), { recursive: true, force: true });
    rmSync(join(pg, '.nuxt'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces expected build artifacts', () => {
    const serverEntry = join(ROOT, `${PLAYGROUND}/.output/server/index.mjs`);
    expect(existsSync(serverEntry)).toBe(true);

    const publicDir = join(ROOT, `${PLAYGROUND}/.output/public`);
    expect(existsSync(publicDir)).toBe(true);
  });
});

describe(
  'playground/nuxt dev',
  () => {
    let child: ReturnType<typeof spawn>;
    let stderr = '';

    beforeAll(
      async () => {
        const pg = join(ROOT, PLAYGROUND);
        rmSync(join(pg, '.void'), { recursive: true, force: true });
        rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
        removeWranglerConfig(pg);

        DEV_PORT = await getPort();
        DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            `./${PLAYGROUND}`,
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

        const serverTimeout = process.platform === 'win32' ? 60_000 : 30_000;
        await waitForServer(DEV_BASE, serverTimeout);
      },
      process.platform === 'win32' ? 75_000 : 45_000,
    );

    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
    });

    it('syncs wrangler.jsonc with bindings from void.json', () => {
      const wranglerConfig = JSON.parse(
        readFileSync(join(ROOT, `${PLAYGROUND}/wrangler.jsonc`), 'utf-8'),
      ) as {
        d1_databases?: Array<{ binding: string }>;
        kv_namespaces?: Array<{ binding: string }>;
      };

      expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
      expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    });

    it('renders home page with SSR', async () => {
      const response = await fetch(`${DEV_BASE}/`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Nuxt + Void');
    });

    it('navigates to smoke route via SPA from home page', async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(DEV_BASE);
        await page.waitForLoadState('networkidle');

        // Mark the document to detect full page reloads
        await page.evaluate(() => {
          (window as Window & { __spa_marker?: boolean }).__spa_marker = true;
        });

        await page.click('a[href="/smoke"]');
        await page.waitForURL('**/smoke');
        await page.waitForSelector('[data-testid="d1-user"]');

        // Assert SPA navigation (no full reload)
        const spaMarker = await page.evaluate(
          () => (window as Window & { __spa_marker?: boolean }).__spa_marker,
        );
        expect(spaMarker).toBe(true);

        const d1User = await page.textContent('[data-testid="d1-user"]');
        const kvValue = await page.textContent('[data-testid="kv-value"]');
        expect(d1User).toBe('Alice');
        expect(kvValue).toBe('ok');
      } finally {
        await browser.close();
      }
    });
  },
  process.platform === 'win32' ? 120_000 : 60_000,
);
