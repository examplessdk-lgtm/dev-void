import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  ENV_VALIDATION_TEST_KEY,
  captureChildOutput,
  getPort,
  installEnvValidationFixture,
  killChild,
  waitForEnvValidation,
  waitForServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/sveltekit';
let DEV_PORT: number;
let DEV_BASE: string;

const MINIMAL_WRANGLER = JSON.stringify(
  { name: 'playground-sveltekit', compatibility_date: '2026-02-24' },
  null,
  2,
);

describe('playground/sveltekit build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, '.svelte-kit'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    writeFileSync(join(pg, 'wrangler.jsonc'), MINIMAL_WRANGLER);
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces expected build artifacts', () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/.svelte-kit/cloudflare/_worker.js`);
    expect(existsSync(workerEntry)).toBe(true);
  });
});

describe('playground/sveltekit dev', () => {
  let child: ReturnType<typeof spawn>;
  let cleanupEnvFixture: (() => void) | undefined;
  let readDevOutput = () => '';
  let stderr = '';

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    cleanupEnvFixture = installEnvValidationFixture(pg);
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    writeFileSync(join(pg, 'wrangler.jsonc'), MINIMAL_WRANGLER);

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
    readDevOutput = captureChildOutput(child);

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(DEV_BASE, 20_000);
    await waitForEnvValidation();
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    cleanupEnvFixture?.();
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('accepts required env values from .env.local without warning', () => {
    expect(readDevOutput()).not.toContain(`${ENV_VALIDATION_TEST_KEY} is required but missing`);
  });

  it('syncs wrangler.jsonc with inferred bindings', () => {
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
    expect(html).toContain('SvelteKit + Void');
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
});
