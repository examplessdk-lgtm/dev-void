import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { killChild, startServer, waitForServer } from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import { registerSharedClientTests } from '../../../../test/pages-client-contract.ts';
import { defineSharedIslandTests } from '../../../../test/pages-island-contract.ts';

declare global {
  interface Window {
    __hmr_marker?: boolean;
  }
}

type NavElement = HTMLElement & { __stamp?: number };

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

  it('hydrates without errors', async () => {
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

  it('layout persists across navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.evaluate(() => {
        (document.querySelector('nav') as NavElement | null)!.__stamp = 1;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      const stamp = await page.evaluate(
        () => (document.querySelector('nav') as NavElement | null)?.__stamp,
      );
      expect(stamp).toBe(1);

      const navText = await page.textContent('nav');
      expect(navText).toContain('Svelte Pages Demo');
    } finally {
      await page.context().close();
    }
  });
}

describe('svelte-pages client (dev)', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/svelte-pages',
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
      stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += String(chunk);
      });
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('dev: SSR pages, Inertia protocol, form handling, API coexistence', async () => {
    // 1. Initial page load returns SSR HTML with embedded page data
    const rootRes = await fetch(`${DEV_BASE}/`);
    expect(rootRes.status).toBe(200);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain('__VOID_PAGE_DATA__');
    expect(rootHtml).toContain('Welcome');
    expect(rootHtml).toContain('Svelte Pages Demo'); // shared data from middleware

    // scriptProbe must round-trip through the inline <script> tag without closing it early.
    const probe = '</script><script>alert(1)</script>\u2028\u2029&';
    const probeMatch = rootHtml.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(probeMatch).not.toBeNull();
    const probeJson = probeMatch![1];
    expect(probeJson).not.toMatch(/<\/script/i);
    expect(JSON.parse(probeJson).shared.scriptProbe).toBe(probe);

    // 2. SSR content contains server-rendered props
    expect(rootHtml).toContain('This is the Svelte Pages playground.');

    // 3. Users page SSR — server-rendered user list
    const usersRes = await fetch(`${DEV_BASE}/users`);
    expect(usersRes.status).toBe(200);
    const usersHtml = await usersRes.text();
    expect(usersHtml).toContain('__VOID_PAGE_DATA__');
    expect(usersHtml).toContain('Alice');
    expect(usersHtml).toContain('Bob');
    expect(usersHtml).toContain('Svelte Pages Demo'); // layout with shared data

    // 4. User detail page SSR
    const userRes = await fetch(`${DEV_BASE}/users/1`);
    expect(userRes.status).toBe(200);
    const userHtml = await userRes.text();
    expect(userHtml).toContain('Alice');
    expect(userHtml).toContain('alice@example.com');

    // 5. Inertia navigation — GET / with X-VoidPages header returns JSON page object
    const inertiaRoot = await fetch(`${DEV_BASE}/`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaRoot.status).toBe(200);
    expect(inertiaRoot.headers.get('X-VoidPages')).toBe('true');
    const rootPage = (await inertiaRoot.json()) as {
      component: string;
      props: Record<string, unknown>;
      shared: Record<string, unknown>;
      url: string;
    };
    expect(rootPage.component).toBe('index');
    expect(rootPage.props).toHaveProperty('title', 'Home');
    expect(rootPage.shared).toHaveProperty('appName', 'Svelte Pages Demo');
    expect(rootPage.url).toBe('/');

    // 6. Inertia navigation — GET /users returns user list in props
    const inertiaUsers = await fetch(`${DEV_BASE}/users`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaUsers.status).toBe(200);
    const usersPage = (await inertiaUsers.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
    };
    expect(usersPage.component).toBe('users');
    expect(usersPage.props.users).toHaveLength(2);
    expect(usersPage.props.users[0].name).toBe('Alice');

    // 7. API coexistence — /api/health returns JSON (not a page object)
    const healthRes = await fetch(`${DEV_BASE}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { status: string };
    expect(healthBody.status).toBe('ok');

    // 8. Form submission — POST /users with valid data
    const postValid = await fetch(`${DEV_BASE}/users`, {
      method: 'POST',
      headers: { 'X-VoidPages': 'true', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
    });
    expect(postValid.status).toBe(200);
    const validPage = (await postValid.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
      errors: Record<string, string> | null;
    };
    expect(validPage.errors).toBeNull();
    expect(validPage.props.users).toHaveLength(3);
    expect(validPage.props.users[2].name).toBe('Charlie');

    // 9. Form submission — POST /users with invalid data returns validation errors
    const postInvalid = await fetch(`${DEV_BASE}/users`, {
      method: 'POST',
      headers: { 'X-VoidPages': 'true', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: '' }),
    });
    expect(postInvalid.status).toBe(200);
    const invalidPage = (await postInvalid.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
      errors: Record<string, string> | null;
    };
    expect(invalidPage.errors).not.toBeNull();
    expect(invalidPage.errors!.name).toBe('Name is required');
    expect(invalidPage.errors!.email).toBe('Email is required');
    // Props should still be populated (re-ran GET)
    expect(invalidPage.props.users.length).toBeGreaterThanOrEqual(2);

    // 10. User detail via Inertia
    const inertiaUser = await fetch(`${DEV_BASE}/users/1`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaUser.status).toBe(200);
    const userPage = (await inertiaUser.json()) as {
      component: string;
      props: { user: { id: number; name: string; email: string } };
    };
    expect(userPage.component).toBe('users/[id]');
    expect(userPage.props.user.name).toBe('Alice');

    // 11. Newly added user is accessible via detail page
    const inertiaCharlie = await fetch(`${DEV_BASE}/users/3`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaCharlie.status).toBe(200);
    const charliePage = (await inertiaCharlie.json()) as {
      component: string;
      props: { user: { id: number; name: string; email: string } };
    };
    expect(charliePage.component).toBe('users/[id]');
    expect(charliePage.props.user.name).toBe('Charlie');
    expect(charliePage.props.user.email).toBe('charlie@example.com');

    // --- Island pages ---

    // 12. Island page SSR — HTML with data-island markers, NOT embedded page data
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

    // 13. Island page always returns HTML even with X-VoidPages header
    const inertiaBlog = await fetch(`${DEV_BASE}/blog`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaBlog.status).toBe(200);
    expect(inertiaBlog.headers.get('content-type')).toContain('text/html');
    expect(inertiaBlog.headers.get('X-VoidPages')).toBeNull();
    const inertiaBlogHtml = await inertiaBlog.text();
    expect(inertiaBlogHtml).toContain('data-island=');

    // 14. Island mutation — validation errors return JSON 422
    const blogPostInvalid = await fetch(`${DEV_BASE}/blog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', body: '' }),
    });
    expect(blogPostInvalid.status).toBe(422);
    const invalidBlog = (await blogPostInvalid.json()) as { errors: Record<string, string> };
    expect(invalidBlog.errors.title).toBe('Title is required');
    expect(invalidBlog.errors.body).toBe('Body is required');

    // 15. Island mutation — success returns JSON 200
    const blogPostValid = await fetch(`${DEV_BASE}/blog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Third Post', body: 'Content here' }),
    });
    expect(blogPostValid.status).toBe(200);
    const validBlog = (await blogPostValid.json()) as { success: boolean };
    expect(validBlog.success).toBe(true);

    // 16. Island detail page with dynamic param
    const detailRes = await fetch(`${DEV_BASE}/blog/hello-world`);
    expect(detailRes.status).toBe(200);
    const detailHtml = await detailRes.text();
    expect(detailHtml).toContain('Hello World');
    expect(detailHtml).toContain('First post');
    expect(detailHtml).not.toContain('__VOID_PAGE_DATA__');

    // --- Deferred props ---

    // 17. Deferred props: SPA navigation streams NDJSON
    const deferredInertia = await fetch(`${DEV_BASE}/deferred`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(deferredInertia.headers.get('content-type')).toContain('application/x-ndjson');
    const ndjsonText = await deferredInertia.text();
    const ndjsonLines = ndjsonText.trim().split('\n');
    expect(ndjsonLines.length).toBe(2);
    const pageObj = JSON.parse(ndjsonLines[0]);
    expect(pageObj.component).toBe('deferred');
    expect(pageObj.props.title).toBe('Deferred Page');
    expect(pageObj.deferredKeys).toEqual({ stats: 'stats' });
    const deferredLine = JSON.parse(ndjsonLines[1]);
    expect(deferredLine.__deferred).toBe('stats');
    expect(deferredLine.data).toEqual({ count: 42 });

    // 18. Deferred props: SSR includes resolution script tags
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
    { coverage: 'smoke' },
  );

  it('island component HMR updates without full page reload', { retry: 2 }, async () => {
    const counterFile = join(ROOT, 'playground/svelte-pages/pages/blog/_Counter.svelte');
    const original = readFileSync(counterFile, 'utf-8');

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${DEV_BASE}/blog`);
      await waitForIslandsHydrated(page, 2);

      // Interact to establish client state — count becomes 1
      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      // Set a window marker to detect full page reload
      await page.evaluate(() => {
        window.__hmr_marker = true;
      });

      const modified = original.replace('Count: {count}', 'Total: {count}');
      writeFileSync(counterFile, modified);

      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent?.startsWith('Total:'),
        { timeout: 10_000 },
      );

      const markerSurvived = await page.evaluate(() => window.__hmr_marker === true);
      expect(markerSurvived).toBe(true);

      // Svelte HMR resets component state (unlike React Fast Refresh / Vue HMR)
      const text = await page.textContent('[data-testid="count"]');
      expect(text).toBe('Total: 0');
    } finally {
      await page.context().close();
      writeFileSync(counterFile, original);
      await waitForServer(`${DEV_BASE}/blog`, 10_000, { expectBody: 'Count:' });
    }
  });

  it('island file edit triggers reload with updated content', { retry: 2 }, async () => {
    const islandFile = join(ROOT, 'playground/svelte-pages/pages/blog/index.island.svelte');
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

describe('svelte-pages client (preview)', { retry: 2 }, () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/svelte-pages/dist'))) {
      execSync('vp run --filter ./playground/svelte-pages build', {
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
          './playground/svelte-pages',
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
  );
});
