import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { killChild, startServer, waitForServer } from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import { registerSharedClientTests } from '../../../../test/pages-client-contract.ts';
import { defineSharedIslandTests } from '../../../../test/pages-island-contract.ts';

declare global {
  interface Window {
    __SPA_MARKER?: boolean;
    __linkOnClick?: boolean;
    __boundClickData?: string;
    __boundClickEventType?: string;
    __preventedClick?: boolean;
    __preventedNavigate?: boolean;
    __hmr_marker?: boolean;
  }
}

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;
let PREVIEW_BASE: string;

let browser: Browser;

beforeAll(async () => {
  browser = await launchPagesBrowser();
});

afterAll(async () => {
  await browser?.close();
});

function defineClientTests(getBase: () => string, coverage: 'smoke' | 'full' = 'full') {
  describe.concurrent('shared client behavior', () => registerClientTests(getBase, coverage));
}

function registerClientTests(getBase: () => string, coverage: 'smoke' | 'full') {
  registerSharedClientTests({ getBase, newPage, waitForHydration, coverage });
  if (coverage === 'smoke') {
    return;
  }

  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
  }

  async function waitForHydration(page: Page) {
    await page.waitForSelector('#app[data-hydrated="true"]');
  }

  it('hydrates without console errors', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    try {
      await page.goto(BASE + '/');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      const text = await page.textContent('body');
      expect(text).toContain('Welcome');
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('deferred props: SPA navigation resolves in browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.click('a[href="/deferred"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="deferred-resolved"]'));

      const text = await page.textContent('[data-testid="deferred-resolved"]');
      expect(text).toBe('Count: 42');
      expect(page.url()).toBe(BASE + '/deferred');
    } finally {
      await page.context().close();
    }
  });

  it('Link preserves Solid bound onClick handler arguments', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="bound-click-link"]');
      await page.waitForFunction(() => window.__boundClickData === 'bound-data');

      expect(await page.evaluate(() => window.__boundClickData)).toBe('bound-data');
      expect(await page.evaluate(() => window.__boundClickEventType)).toBe('click');
      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link rejects dynamic mutation props with prefetch or reloadDocument', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="toggle-prefetch-method"]');
      await page.waitForSelector('[data-testid="reactive-prefetch-error"]');
      expect(await page.textContent('[data-testid="reactive-prefetch-error"]')).toMatch(
        /(?:Link:|Void Link) prefetch only supports GET links/,
      );

      await page.click('[data-testid="toggle-reload-method"]');
      await page.waitForSelector('[data-testid="reactive-reload-error"]');
      expect(await page.textContent('[data-testid="reactive-reload-error"]')).toMatch(
        /(?:Link:|Void Link) reloadDocument only supports GET links/,
      );
    } finally {
      await page.context().close();
    }
  });
}

describe('solid-pages client (dev)', () => {
  let child: ReturnType<typeof spawn>;
  let serverOutput = () => '';

  beforeAll(async () => {
    const server = await startServer(
      (port) => {
        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            './playground/solid-pages',
            'dev',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
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
        return child;
      },
      45_000,
      { expectStatus: 200, expectBody: '__VOID_PAGE_DATA__' },
    );
    DEV_BASE = server.base;
    serverOutput = server.output;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (serverOutput().includes('error when starting dev server')) {
      throw new Error(serverOutput());
    }
  });

  it('dev: does not prebundle @void/solid in the worker environment', () => {
    const workerDepsDir = join(ROOT, 'playground/solid-pages/node_modules/.vite/deps_void_worker');
    const metadataPath = join(workerDepsDir, '_metadata.json');

    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
      optimized?: Record<string, unknown>;
    };

    expect(metadata.optimized).not.toHaveProperty('@void/solid');
    expect(existsSync(join(workerDepsDir, '@void_solid.js'))).toBe(false);
  });

  it('dev: SSR renders pages, island pages and deferred props', async () => {
    const rootRes = await fetch(`${DEV_BASE}/`);
    expect(rootRes.status).toBe(200);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain('__VOID_PAGE_DATA__');
    expect(rootHtml).toContain('Welcome');
    expect(rootHtml).toContain('Solid Pages Demo'); // shared data from middleware

    // scriptProbe tries to close the inline page-data <script> tag early.
    const probe = '</script><script>alert(1)</script>\u2028\u2029&';
    const probeMatch = rootHtml.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(probeMatch).not.toBeNull();
    const probeJson = probeMatch![1];
    expect(probeJson).not.toMatch(/<\/script/i);
    expect(JSON.parse(probeJson).shared.scriptProbe).toBe(probe);
    expect(rootHtml).toContain('This is the Solid Pages playground.');

    const usersRes = await fetch(`${DEV_BASE}/users`);
    expect(usersRes.status).toBe(200);
    const usersHtml = await usersRes.text();
    expect(usersHtml).toContain('__VOID_PAGE_DATA__');
    expect(usersHtml).toContain('Alice');
    expect(usersHtml).toContain('Bob');
    expect(usersHtml).toContain('Solid Pages Demo'); // layout with shared data

    const userRes = await fetch(`${DEV_BASE}/users/1`);
    expect(userRes.status).toBe(200);
    const userHtml = await userRes.text();
    expect(userHtml).toContain('Alice');
    expect(userHtml).toContain('alice@example.com');

    const blogRes = await fetch(`${DEV_BASE}/blog`);
    expect(blogRes.status).toBe(200);
    const blogHtml = await blogRes.text();
    expect(blogHtml).toContain('data-island=');
    expect(blogHtml).toContain('data-props=');
    expect(blogHtml).toContain('data-hydrate=');
    expect(blogHtml).not.toContain('__VOID_PAGE_DATA__');
    expect(blogHtml).toContain('Hello World');
    expect(blogHtml).toContain('Second Post');
    expect(blogHtml).toContain('Count:');

    const detailRes = await fetch(`${DEV_BASE}/blog/hello-world`);
    expect(detailRes.status).toBe(200);
    const detailHtml = await detailRes.text();
    expect(detailHtml).toContain('Hello World');
    expect(detailHtml).toContain('First post');
    expect(detailHtml).not.toContain('__VOID_PAGE_DATA__');

    const deferredSsr = await fetch(`${DEV_BASE}/deferred`);
    const deferredHtml = await deferredSsr.text();
    expect(deferredHtml).toContain('__VOID_PAGE_DATA__');
    expect(deferredHtml).toContain('Deferred Page');
    expect(deferredHtml).toContain('window.__resolveDeferred("stats"');
    expect(deferredHtml).toContain('"count":42');
  });

  defineClientTests(() => DEV_BASE, 'smoke');
  defineSharedIslandTests(
    () => DEV_BASE,
    () => browser,
    {
      waitForValidation: (page) => page.getByText('Title is required').waitFor({ timeout: 20_000 }),
      coverage: 'smoke',
    },
  );

  it('island component HMR updates without full page reload', { retry: 2 }, async () => {
    const counterFile = join(ROOT, 'playground/solid-pages/pages/blog/_Counter.tsx');
    const original = readFileSync(counterFile, 'utf-8');

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${DEV_BASE}/blog`);
      await waitForIslandsHydrated(page, 2);

      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      await page.evaluate(() => {
        window.__hmr_marker = true;
      });

      const modified = original.replace('Count: {count()}', 'Total: {count()}');
      writeFileSync(counterFile, modified);

      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent?.startsWith('Total:'),
        { timeout: 10_000 },
      );

      const markerSurvived = await page.evaluate(() => window.__hmr_marker === true);
      expect(markerSurvived).toBe(true);

      // Solid HMR resets state — count should be 0
      const text = await page.textContent('[data-testid="count"]');
      expect(text).toBe('Total: 0');
    } finally {
      await page.context().close();
      writeFileSync(counterFile, original);
      await waitForServer(`${DEV_BASE}/blog`, 10_000, { expectBody: 'Count:' });
    }
  });

  it('island file edit triggers reload with updated content', { retry: 2 }, async () => {
    const islandFile = join(ROOT, 'playground/solid-pages/pages/blog/index.island.tsx');
    const original = readFileSync(islandFile, 'utf-8');

    try {
      const initialRes = await fetch(`${DEV_BASE}/blog`);
      expect(initialRes.status).toBe(200);
      const initialHtml = await initialRes.text();
      expect(initialHtml).toContain('<h1>Blog</h1>');

      const modified = original.replace('<h1>Blog</h1>', '<h1>Blog Updated</h1>');
      writeFileSync(islandFile, modified);

      // Poll for updated content — every request must return 200 (no ISE).
      const start = Date.now();
      let updatedHtml = '';
      while (Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
        const res = await fetch(`${DEV_BASE}/blog`);
        expect(res.status).toBe(200);
        updatedHtml = await res.text();
        if (updatedHtml.includes('Blog Updated')) {
          break;
        }
      }

      expect(updatedHtml).toContain('<h1>Blog Updated</h1>');
      expect(updatedHtml).toContain('data-island=');
    } finally {
      writeFileSync(islandFile, original);
      await waitForServer(`${DEV_BASE}/blog`, 10_000, { expectBody: '<h1>Blog</h1>' });
    }
  });
});

describe('solid-pages client (preview)', { retry: 2 }, () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/solid-pages/dist'))) {
      execSync('vp run --filter ./playground/solid-pages build', {
        cwd: ROOT,
        stdio: 'pipe',
      });
    }

    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/solid-pages',
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
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
      stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += String(chunk);
      });
      return child;
    }, 30_000);
    PREVIEW_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting preview server')) {
      throw new Error(stderr);
    }
  });

  defineClientTests(() => PREVIEW_BASE);
  defineSharedIslandTests(
    () => PREVIEW_BASE,
    () => browser,
    {
      waitForValidation: (page) => page.getByText('Title is required').waitFor({ timeout: 20_000 }),
    },
  );
});
