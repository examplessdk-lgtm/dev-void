import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

it('waits for the expected islands and every independent hydration', async () => {
  const page = await browser.newPage();
  try {
    // Empty SSR output must not make an all-elements check pass vacuously.
    await page.setContent('<main></main>');
    await expect(waitForIslandsHydrated(page, 1, 500)).rejects.toThrow('Timeout');

    await page.setContent('<div data-island="counter" data-hydrated="true"></div>');
    await expect(waitForIslandsHydrated(page, 2, 500)).rejects.toThrow('Timeout');

    await page.setContent(
      '<div data-island="counter" data-hydrated="true"></div><div data-island="form"></div>',
    );
    // One hydrated island must not satisfy the wait while a sibling is still unhydrated.
    await expect(waitForIslandsHydrated(page, 2, 500)).rejects.toThrow('Timeout');

    await page.locator('[data-island="form"]').evaluate((el) => {
      el.setAttribute('data-hydrated', 'true');
    });
    await waitForIslandsHydrated(page, 2);
  } finally {
    await page.close();
  }
});
