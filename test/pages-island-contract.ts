import type { Browser, Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from './browser-helpers.ts';

/** Keep independent island coverage for every adapter without copying the tests. */
export function defineSharedIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  waitForValidation: (page: Page) => Promise<unknown> = (page) =>
    page.waitForFunction(() => document.body?.textContent?.includes('Title is required')),
): void {
  describe.concurrent('shared island behavior', () =>
    registerIslandTests(getBase, getBrowser, waitForValidation));
}

function registerIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  waitForValidation: (page: Page) => Promise<unknown>,
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

  it('island hydration: data-hydrated appears after load', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      // This helper asserts the minimum count and every hydration marker in
      // one browser evaluation. Re-reading the same markers adds no coverage
      // and can race a Vite reload between the two browser round trips.
      await waitForIslandsHydrated(page, 2);
    } finally {
      await page.context().close();
    }
  });

  it('island interaction: counter increments on click', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page);

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
      await waitForIslandsHydrated(page);

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
      await waitForIslandsHydrated(page);

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

      // Islands should be hydrated
      await waitForIslandsHydrated(page);
    } finally {
      await page.context().close();
    }
  });
}
