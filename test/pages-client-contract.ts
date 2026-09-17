import type { Page } from 'playwright';
import { beforeAll, expect, it } from 'vite-plus/test';

type TestWindow = Window & {
  __SPA_MARKER?: boolean;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

/** Run the same browser contract against every adapter and both dev/preview servers. */
export function registerSharedClientTests({
  getBase,
  newPage,
  waitForHydration,
}: {
  getBase: () => string;
  newPage: () => Promise<Page>;
  waitForHydration: (page: Page) => Promise<void>;
}): void {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('SPA navigation: home → users', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // Set a marker to detect if a full page reload happens
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');

      const marker = await page.evaluate(() => (window as TestWindow).__SPA_MARKER);
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
      await page.waitForFunction(() => document.body?.textContent?.includes('Name is required'));

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

  it.sequential('form submission adds user', async () => {
    const page = await newPage();
    const id = crypto.randomUUID();
    const name = `Browser Charlie ${id}`;

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.fill('input:near(:text("Name:"))', name);
      await page.fill('input:near(:text("Email:"))', `charlie-${id}@example.com`);

      await page.click('button[type="submit"]');
      await page.waitForFunction((value) => document.body?.textContent?.includes(value), name);

      const text = await page.textContent('body');
      expect(text).toContain(name);
      expect(text).not.toContain('Name is required');
      expect(text).not.toContain('Email is required');
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it.sequential('navigate to newly added user detail', async () => {
    const page = await newPage();
    const id = crypto.randomUUID();
    const name = `Browser Dana ${id}`;
    const email = `dana-${id}@example.com`;

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      // Add a new user
      await page.fill('input:near(:text("Name:"))', name);
      await page.fill('input:near(:text("Email:"))', email);
      await page.click('button[type="submit"]');
      await page.waitForFunction((value) => document.body?.textContent?.includes(value), name);

      // Click the link to the newly added user's detail page
      await page.getByRole('link', { name, exact: true }).click();
      await page.waitForFunction(
        (value) => document.querySelector('h1')?.textContent?.includes(value),
        name,
      );

      expect(page.url()).toMatch(/\/users\/\d+$/);
      const text = await page.textContent('body');
      expect(text).toContain(name);
      expect(text).toContain(email);
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
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('[data-testid="onclick-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(await page.evaluate(() => (window as TestWindow).__linkOnClick)).toBe(true);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
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
      await page.waitForFunction(() => (window as TestWindow).__preventedClick === true);

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
      await page.waitForFunction(() => (window as TestWindow).__preventedNavigate === true);

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
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('[data-testid="reload-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBeUndefined();
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
