import type { Browser, Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from './browser-helpers.ts';

/** Keep independent island coverage for every adapter without copying the tests. */
export function defineSharedIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  options: {
    waitForValidation?: (page: Page) => Promise<unknown>;
    coverage?: 'smoke' | 'full';
  } = {},
): void {
  describe.concurrent('shared island behavior', () =>
    registerIslandTests(
      getBase,
      getBrowser,
      options.waitForValidation ??
        ((page) =>
          page.waitForFunction(() => document.body?.textContent?.includes('Title is required'))),
      options.coverage ?? 'full',
    ));
}

function registerIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  waitForValidation: (page: Page) => Promise<unknown>,
  coverage: 'smoke' | 'full',
) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  async function newPage(): Promise<Page> {
    const context = await getBrowser().newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
  }

  it('island hydration and interaction: counter increments on click', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page, 2);

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

  // The dev island check exercises loading and hydration as well as browser
  // interaction. The remaining scenarios run against each production build.
  if (coverage === 'smoke') {
    return;
  }

  it('island form: validation errors display', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page, 2);

      await page.click('button:has-text("Add Post")');
      await waitForValidation(page);

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
      await waitForIslandsHydrated(page, 2);

      await page.fill('input:near(:text("Title:"))', 'New Post');
      await page.fill('textarea:near(:text("Body:"))', 'Some content');

      await page.click('button:has-text("Add Post")');
      await page.waitForFunction(() => document.body?.textContent?.includes('New Post'));

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
        (window as Window & { __SPA_MARKER?: boolean }).__SPA_MARKER = true;
      });

      // Click Blog link (goes through Void Router visit)
      await page.click('a[href="/blog"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Blog'));

      expect(page.url()).toBe(BASE + '/blog');

      // SPA marker should be gone — full page navigation happened
      const marker = await page.evaluate(
        () => (window as Window & { __SPA_MARKER?: boolean }).__SPA_MARKER,
      );
      expect(marker).toBeUndefined();

      await waitForIslandsHydrated(page, 2);
    } finally {
      await page.context().close();
    }
  });
}
