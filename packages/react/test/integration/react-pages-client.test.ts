import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium, type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_PORT: number;
let DEV_BASE: string;
let PREVIEW_PORT: number;
let PREVIEW_BASE: string;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

function defineClientTests(getBase: () => string) {
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

  it('hydrates without React errors', async () => {
    const page = await newPage();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('Hydration')) {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    try {
      await page.goto(BASE + '/');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      const text = await page.textContent('body');
      expect(text).toContain('Welcome');
      expect(
        errors.filter((e) => e.includes('Hydration') || e.includes('error while hydrating')),
      ).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation: home → users', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // Set a marker to detect if a full page reload happens
      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');

      const marker = await page.evaluate(() => (window as any).__SPA_MARKER);
      expect(marker).toBe(true);

      const text = await page.textContent('body');
      expect(text).toContain('Alice');
      expect(text).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation: users → user detail', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );

      expect(page.url()).toBe(BASE + '/users/1');

      const text = await page.textContent('body');
      expect(text).toContain('alice@example.com');
    } finally {
      await page.context().close();
    }
  });

  it('layout persists across navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // Stamp the nav element
      await page.evaluate(() => {
        (document.querySelector('nav') as any).__stamp = 1;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      const stamp = await page.evaluate(() => (document.querySelector('nav') as any).__stamp);
      expect(stamp).toBe(1);

      const navText = await page.textContent('nav');
      expect(navText).toContain('React Pages Demo');
    } finally {
      await page.context().close();
    }
  });

  it('browser back/forward navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');

      await page.goForward();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('form validation errors display', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      // Submit form without filling fields
      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes('Name is required'));

      const text = await page.textContent('body');
      expect(text).toContain('Name is required');
      expect(text).toContain('Email is required');

      // User list should still be present (GET re-ran)
      expect(text).toContain('Alice');
      expect(text).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });

  it('form submission adds user', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.fill('input:near(:text("Name:"))', 'Charlie');
      await page.fill('input:near(:text("Email:"))', 'charlie@example.com');

      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes('Charlie'));

      const text = await page.textContent('body');
      expect(text).toContain('Charlie');
      expect(text).not.toContain('Name is required');
      expect(text).not.toContain('Email is required');
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('navigate to newly added user detail', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      // Add a new user
      await page.fill('input:near(:text("Name:"))', 'Dana');
      await page.fill('input:near(:text("Email:"))', 'dana@example.com');
      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes('Dana'));

      // Click the link to the newly added user's detail page
      await page.click('a:has-text("Dana")');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Dana'));

      expect(page.url()).toMatch(/\/users\/\d+$/);
      const text = await page.textContent('body');
      expect(text).toContain('Dana');
      expect(text).toContain('dana@example.com');
    } finally {
      await page.context().close();
    }
  });

  it('deferred props: SPA navigation resolves in browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // SPA navigate to deferred page
      await page.click('a[href="/deferred"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="deferred-resolved"]'));

      const text = await page.textContent('[data-testid="deferred-resolved"]');
      expect(text).toBe('Count: 42');
      expect(page.url()).toBe(BASE + '/deferred');
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation updates document.title from head()', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // Home page title from head() + titleTemplate
      expect(await page.title()).toBe('Home | React Pages Demo');

      // Navigate to user detail — title should update
      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );
      expect(await page.title()).toBe('Alice | React Pages Demo');

      // Go back — title should restore
      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(await page.title()).toBe('Home | React Pages Demo');
    } finally {
      await page.context().close();
    }
  });

  it('Link composes user onClick before SPA navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });
      await page.click('[data-testid="onclick-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(await page.evaluate(() => (window as any).__linkOnClick)).toBe(true);
      expect(await page.evaluate(() => (window as any).__SPA_MARKER)).toBe(true);
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('Link respects onClick preventDefault', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="prevented-click-link"]');
      await page.waitForFunction(() => (window as any).__preventedClick === true);

      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link supports cancellable onNavigate', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="prevented-navigate-link"]');
      await page.waitForFunction(() => (window as any).__preventedNavigate === true);

      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link replace updates the current history entry', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.click('a[href="/link-behavior"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Link Behavior'),
      );
      await waitForHydration(page);

      await page.click('[data-testid="replace-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');
    } finally {
      await page.context().close();
    }
  });

  it('Link reloadDocument uses browser navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });
      await page.click('[data-testid="reload-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as any).__SPA_MARKER)).toBeUndefined();
    } finally {
      await page.context().close();
    }
  });

  it('Link leaves target and download links to the browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const popupPromise = page.context().waitForEvent('page');
      await page.click('[data-testid="blank-link"]');
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(page.url()).toBe(BASE + '/link-behavior');
      expect(popup.url()).toBe(BASE + '/users');
      await popup.close();

      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="download-link"]');
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('users.html');
      expect(page.url()).toBe(BASE + '/link-behavior');
      await download.delete();
    } finally {
      await page.context().close();
    }
  });

  it('Link merges GET data into href and navigation URL', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const href = await page.getAttribute('[data-testid="query-data-link"]', 'href');
      expect(href).toBe('/link-behavior?tag=a&tag=b&page=2&active=true');

      await page.click('[data-testid="query-data-link"]');
      await page.waitForURL(BASE + '/link-behavior?tag=a&tag=b&page=2&active=true');
      expect(page.url()).toBe(BASE + '/link-behavior?tag=a&tag=b&page=2&active=true');
    } finally {
      await page.context().close();
    }
  });
}

function defineIslandTests(getBase: () => string) {
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

  it('island hydration: data-hydrated appears after load', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await page.waitForSelector('[data-island][data-hydrated="true"]');

      const islands = await page.$$eval('[data-island]', (els) =>
        els.map((el) => ({
          id: el.getAttribute('data-island'),
          hydrated: el.getAttribute('data-hydrated'),
        })),
      );

      expect(islands.length).toBeGreaterThanOrEqual(2);
      for (const island of islands) {
        expect(island.hydrated).toBe('true');
      }
    } finally {
      await page.context().close();
    }
  });

  it('island interaction: counter increments on click', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await page.waitForSelector('[data-island][data-hydrated="true"]');

      const countBefore = await page.textContent('[data-testid="count"]');
      expect(countBefore).toBe('Count: 0');

      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      const countAfter = await page.textContent('[data-testid="count"]');
      expect(countAfter).toBe('Count: 1');
    } finally {
      await page.context().close();
    }
  });

  it('island form: validation errors display', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await page.waitForSelector('[data-island][data-hydrated="true"]');

      await page.click('button:has-text("Add Post")');
      await page.waitForFunction(() => document.body.textContent?.includes('Title is required'));

      const text = await page.textContent('body');
      expect(text).toContain('Title is required');
      expect(text).toContain('Body is required');
    } finally {
      await page.context().close();
    }
  });

  it('island form: successful submission reloads page', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await page.waitForSelector('[data-island][data-hydrated="true"]');

      await page.fill('input:near(:text("Title:"))', 'New Post');
      await page.fill('textarea:near(:text("Body:"))', 'Some content');

      await page.click('button:has-text("Add Post")');
      await page.waitForFunction(() => document.body.textContent?.includes('New Post'));

      const text = await page.textContent('body');
      expect(text).toContain('New Post');
    } finally {
      await page.context().close();
    }
  });

  it('cross-navigation: Inertia page to island page falls back to full navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await page.waitForSelector('#app[data-hydrated="true"]');

      // Set SPA marker to detect full page reload
      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });

      // Click Blog link (goes through Inertia router.visit)
      await page.click('a[href="/blog"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Blog'));

      expect(page.url()).toBe(BASE + '/blog');

      // SPA marker should be gone — full page navigation happened
      const marker = await page.evaluate(() => (window as any).__SPA_MARKER);
      expect(marker).toBeUndefined();

      // Islands should be hydrated
      await page.waitForSelector('[data-island][data-hydrated="true"]');
    } finally {
      await page.context().close();
    }
  });
}

describe('react-pages client (dev)', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        'playground/react-pages',
        'exec',
        'vite',
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
  }, 30_000);

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
    expect(rootHtml).toContain('React Pages Demo'); // shared data from middleware

    // 1b. Head management — SSR HTML contains head tags from void.json + page head()
    expect(rootHtml).toContain('<title>Home | React Pages Demo</title>');
    expect(rootHtml).toContain('<meta charset="utf-8">');
    expect(rootHtml).toContain('<meta name="description" content="React Pages playground home">');
    expect(rootHtml).toContain('<html lang="en"');

    // 2. SSR content contains server-rendered props
    expect(rootHtml).toContain('This is the React Pages playground.');

    // 3. Users page SSR — server-rendered user list
    const usersRes = await fetch(`${DEV_BASE}/users`);
    expect(usersRes.status).toBe(200);
    const usersHtml = await usersRes.text();
    expect(usersHtml).toContain('__VOID_PAGE_DATA__');
    expect(usersHtml).toContain('Alice');
    expect(usersHtml).toContain('Bob');
    expect(usersHtml).toContain('React Pages Demo'); // layout with shared data

    // 4. User detail page SSR
    const userRes = await fetch(`${DEV_BASE}/users/1`);
    expect(userRes.status).toBe(200);
    const userHtml = await userRes.text();
    expect(userHtml).toContain('Alice');
    expect(userHtml).toContain('alice@example.com');

    // 4b. User detail head — dynamic title from head() export
    expect(userHtml).toContain('<title>Alice | React Pages Demo</title>');
    expect(userHtml).toContain('<meta property="og:title" content="Alice">');

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
    expect(rootPage.shared).toHaveProperty('appName', 'React Pages Demo');
    expect(rootPage.url).toBe('/');
    // Head in Inertia JSON
    expect((rootPage as any).head).toBeDefined();
    expect((rootPage as any).head.title).toBe('Home | React Pages Demo');
    expect((rootPage as any).head.meta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'description', content: 'React Pages playground home' }),
      ]),
    );

    // 6. Inertia navigation — GET /users returns user list in props
    const inertiaUsers = await fetch(`${DEV_BASE}/users`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaUsers.status).toBe(200);
    const usersPage = (await inertiaUsers.json()) as {
      component: string;
      props: { users: Array<{ id: number; name: string }> };
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
      props: { users: Array<{ id: number; name: string }> };
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
      props: { users: Array<{ id: number; name: string }> };
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
    // Head in user detail Inertia JSON
    expect((userPage as any).head.title).toBe('Alice | React Pages Demo');

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

  defineClientTests(() => DEV_BASE);
  defineIslandTests(() => DEV_BASE);

  it('island component HMR updates without full page reload', { retry: 2 }, async () => {
    const counterFile = join(ROOT, 'playground/react-pages/pages/blog/_Counter.tsx');
    const original = readFileSync(counterFile, 'utf-8');

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${DEV_BASE}/blog`);
      await page.waitForSelector('[data-island][data-hydrated="true"]');

      // Interact to establish client state — count becomes 1
      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      // Set a window marker to detect full page reload
      await page.evaluate(() => {
        (window as any).__hmr_marker = true;
      });

      // Edit the island component — change the label
      const modified = original.replace('Count: {count}', 'Total: {count}');
      writeFileSync(counterFile, modified);

      // Wait for HMR to update the component text
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent?.startsWith('Total:'),
        { timeout: 10_000 },
      );

      // No full page reload — window marker should still be set
      const markerSurvived = await page.evaluate(() => (window as any).__hmr_marker === true);
      expect(markerSurvived).toBe(true);

      // React Fast Refresh preserves state — count should still be 1
      const text = await page.textContent('[data-testid="count"]');
      expect(text).toBe('Total: 1');
    } finally {
      await page.context().close();
      writeFileSync(counterFile, original);
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  it('island file edit triggers reload with updated content', { retry: 2 }, async () => {
    const islandFile = join(ROOT, 'playground/react-pages/pages/blog/index.island.tsx');
    const original = readFileSync(islandFile, 'utf-8');

    try {
      // Verify initial content renders
      const initialRes = await fetch(`${DEV_BASE}/blog`);
      expect(initialRes.status).toBe(200);
      const initialHtml = await initialRes.text();
      expect(initialHtml).toContain('<h1>Blog</h1>');

      // Edit the island file — change the heading
      const modified = original.replace('<h1>Blog</h1>', '<h1>Blog Updated</h1>');
      writeFileSync(islandFile, modified);

      // Poll for updated content — every request must return 200 (no ISE).
      // The previous bug: sending full-reload to the workerd triggered a
      // program reload that caused React dual-instance errors (500s).
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
      // Wait for restore to be picked up
      await new Promise((r) => setTimeout(r, 500));
    }
  });
}, 60_000);

describe('react-pages client (preview)', { retry: 2, timeout: 60_000 }, () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    execSync('pnpm --dir playground/react-pages build', {
      cwd: ROOT,
      stdio: 'pipe',
    });

    PREVIEW_PORT = await getPort();
    PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        'playground/react-pages',
        'exec',
        'vite',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(PREVIEW_PORT),
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

    await waitForServer(PREVIEW_BASE, 30_000, {
      isAlive: () => child.exitCode === null,
    });
  }, 45_000);

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting preview server')) {
      throw new Error(stderr);
    }
  });

  defineClientTests(() => PREVIEW_BASE);
  defineIslandTests(() => PREVIEW_BASE);
});
