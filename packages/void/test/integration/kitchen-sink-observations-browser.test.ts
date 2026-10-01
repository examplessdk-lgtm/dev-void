import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { waitForRenderedText } from '../../../../platform/scripts/kitchen-sink-observations.ts';
import { serializePageData } from '../../src/pages/serialize.ts';

describe('kitchen-sink rendered app observations', () => {
  let browser: Browser;
  const key = 'smoke-q-browser-observation';

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('observes a deleted row while its original SSR hydration data remains in the document', async () => {
    const page = await browser.newPage();
    try {
      const payload = serializePageData({ props: { results: [{ id: 1, key }] } });
      await page.setContent(`<!doctype html><html><body><script id="__VOID_PAGE_DATA__" type="application/json">${payload}</script>
        <div id="app"><table><tbody><tr><td>${key}</td><td><button>Delete</button></td></tr></tbody></table></div></body></html>`);
      await waitForRenderedText(page, key, true, 1_000);
      await page.evaluate(() => {
        const button = document.querySelector('button')!;
        button.addEventListener('click', () => button.closest('tr')!.remove());
      });
      await page.getByRole('button', { name: 'Delete' }).click();

      expect(await page.locator('tr').count()).toBe(0);
      expect(await page.locator('body').textContent()).toContain(key);
      await waitForRenderedText(page, key, false, 1_000);
      expect(await page.locator('#__VOID_PAGE_DATA__').textContent()).toBe(payload);
    } finally {
      await page.close();
    }
  });

  it('does not count hydration-only or hidden text as a visible consumer result', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body><script id="__VOID_PAGE_DATA__" type="application/json">${serializePageData({ props: { key } })}</script>
        <div id="app"><span hidden>${key}</span><p>No results</p></div></body></html>`);
      await expect(waitForRenderedText(page, key, true, 100)).rejects.toThrow('Timeout');
    } finally {
      await page.close();
    }
  });

  it('fails if the rendered row remains after a delete request', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="app"><table><tr><td>${key}</td></tr></table></div>`);
      await expect(waitForRenderedText(page, key, false, 100)).rejects.toThrow('Timeout');
    } finally {
      await page.close();
    }
  });

  it('requires the app to exist before accepting rendered-text absence', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<p>Wrong destination</p>');
      await expect(waitForRenderedText(page, key, false, 100)).rejects.toThrow('Timeout');
    } finally {
      await page.close();
    }
  });
});
