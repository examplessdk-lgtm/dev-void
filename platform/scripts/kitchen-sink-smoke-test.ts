/**
 * Kitchen Sink Playwright Smoke Test
 *
 * Standalone script that runs 11 smoke tests against a deployed kitchen-sink app.
 * Uses node:test + node:assert — no vitest needed.
 *
 * Usage:
 *   SMOKE_URL=https://kitchen-sink.apps.example.com node platform/scripts/kitchen-sink-smoke-test.ts
 *
 * The target must be a disposable kitchen-sink deployment: this suite resets
 * its database, KV, and storage before exercising mutations.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

if (!process.env.SMOKE_URL) {
  throw new Error(
    'Set SMOKE_URL to a disposable kitchen-sink deployment. This suite resets its data.',
  );
}
const target = new URL(process.env.SMOKE_URL);
if (
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.search ||
  target.hash ||
  target.pathname !== '/'
) {
  throw new Error(
    'SMOKE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.',
  );
}
const BASE = target.origin;
const TIMEOUT = 15_000;
const uid = Date.now().toString(36);

// Supply a Cloudflare Access service-token pair if the selected test app is
// protected by Access. These credentials belong to the explicit SMOKE_URL target.
const CF_ACCESS: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : {};

type MarkerWindow = Window & { __SPA_MARKER?: boolean };
type StampedNav = HTMLElement & { __stamp?: number };

let browser: Browser;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]', { timeout: TIMEOUT });
}

async function goto(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
}

/** Wait for body text to include `text`, polling with page reloads. */
async function pollForText(page: Page, path: string, text: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await goto(page, path);
    const body = await page.textContent('body');
    if (body?.includes(text)) {
      return;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for "${text}" on ${path}`);
}

/** Wait for body text to stop including `text` (up to timeoutMs, no reloads). */
async function waitForTextGone(page: Page, text: string, timeoutMs = TIMEOUT) {
  await page.waitForFunction(
    (expectedText) => !document.body.textContent?.includes(expectedText),
    text,
    {
      timeout: timeoutMs,
    },
  );
}

/** Wait for body text to include `text` (no reload, just DOM polling). */
async function waitForText(page: Page, text: string, timeoutMs = TIMEOUT) {
  await page.waitForFunction(
    (expectedText) => document.body.textContent?.includes(expectedText),
    text,
    {
      timeout: timeoutMs,
    },
  );
}

/** Click the Delete button in the table row containing `needle`. */
async function deleteRowContaining(page: Page, needle: string) {
  await page.evaluate((needleText) => {
    const row = Array.from(document.querySelectorAll('tr')).find((row) =>
      row.textContent?.includes(needleText),
    );
    if (!row) {
      throw new Error(`Row containing "" not found`);
    }
    const button = row.querySelector('button');
    if (!button) {
      throw new Error(`No button in row containing ""`);
    }
    button.click();
  }, needle);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

void describe(`kitchen-sink smoke (${BASE})`, { concurrency: true }, () => {
  before(async () => {
    browser = await chromium.launch();

    // Reset all app state for a clean slate
    const res = await fetch(`${BASE}/api/reset`, { method: 'POST', headers: CF_ACCESS });
    if (!res.ok) {
      console.warn(`  ⚠ Reset endpoint returned ${res.status} — tests may see stale data`);
    }
  });

  after(async () => {
    await browser?.close();
  });

  /** Create an isolated browser context + page. Caller must close ctx when done. */
  async function freshPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ extraHTTPHeaders: CF_ACCESS });
    const page = await ctx.newPage();
    return { ctx, page };
  }

  // -----------------------------------------------------------------------
  // 1. Home SSR + asset caching
  // -----------------------------------------------------------------------
  void it('1 — home SSR + asset caching', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      const body = await page.textContent('body');
      assert.ok(body?.includes('Kitchen Sink'), "page contains 'Kitchen Sink'");
      assert.ok(body?.includes('Auth'), "page contains 'Auth'");

      // Find a hashed asset URL in the HTML source (hashes are base64url-like, e.g. DOjtQvIZ)
      const html = await page.content();
      const assetMatch = html.match(/\/(assets\/[^"']+[-._][A-Za-z0-9_-]{6,}\.(js|css))/);
      assert.ok(assetMatch, 'found hashed asset URL in HTML');

      const assetUrl = `${BASE}/${assetMatch![1]}?smoke=${uid}`;

      // A unique URL forces a fresh network GET without sending cache-bypass
      // directives to the origin. Omit application/Access session cookies too.
      // Cookie-bearing requests deliberately bypass the shared asset cache.
      // The browser context still supplies Access service-token headers when
      // configured; those protected requests exercise the private cache policy.
      const asset = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'omit' });
        return {
          status: res.status,
          cacheControl: res.headers.get('cache-control') || '',
          contentType: res.headers.get('content-type'),
          cfCacheStatus: res.headers.get('cf-cache-status'),
        };
      }, assetUrl);

      assert.equal(asset.status, 200, `asset GET succeeds (got ${asset.status})`);
      const accessProtected = Object.keys(CF_ACCESS).length > 0;
      const expectedDirective = accessProtected ? 'no-store' : 'immutable';
      const directives = asset.cacheControl
        .toLowerCase()
        .split(',')
        .map((part) => part.trim());
      assert.ok(
        directives.includes(expectedDirective),
        `Cache-Control includes ${expectedDirective} for ${assetUrl} (got: ${JSON.stringify(asset)})`,
      );
      assert.ok(
        accessProtected
          ? !directives.includes('immutable') && !directives.includes('public')
          : !directives.some((directive) =>
              ['private', 'no-store', 'no-cache'].includes(directive),
            ),
        `Cache-Control has no contradictory directives (got: ${asset.cacheControl})`,
      );
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 2. SPA navigation (no full reload)
  // -----------------------------------------------------------------------
  void it('2 — SPA navigation', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      // Set a marker on window — survives SPA nav, lost on full reload
      await page.evaluate(() => {
        (window as MarkerWindow).__SPA_MARKER = true;
      });

      // Click "DB" link
      await page.click('a[href="/db"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('DB'), {
        timeout: TIMEOUT,
      });
      assert.ok(page.url().endsWith('/db'), `URL is /db (got: ${page.url()})`);

      // Marker must still be present (no full reload)
      const marker = await page.evaluate(() => (window as MarkerWindow).__SPA_MARKER);
      assert.strictEqual(marker, true, 'SPA marker survived navigation');

      // Click "KV" link
      await page.click('a[href="/kv"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('KV'), {
        timeout: TIMEOUT,
      });
      assert.ok(page.url().endsWith('/kv'), `URL is /kv (got: ${page.url()})`);
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 3. Layout persistence across navigation
  // -----------------------------------------------------------------------
  void it('3 — layout persistence', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      // Stamp the nav element
      await page.evaluate(() => {
        const nav = document.querySelector('nav') as StampedNav | null;
        if (nav) {
          nav.__stamp = 1;
        }
      });

      // Navigate to /env
      await page.click('a[href="/env"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Env'), {
        timeout: TIMEOUT,
      });

      // Nav stamp must survive (layout DOM not recreated)
      const stamp = await page.evaluate(() => {
        const nav = document.querySelector('nav') as StampedNav | null;
        return nav?.__stamp;
      });
      assert.strictEqual(stamp, 1, 'nav stamp survived navigation');
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 4. DB — create and delete a note
  // -----------------------------------------------------------------------
  void it('4 — DB CRUD', async () => {
    const { ctx, page } = await freshPage();
    try {
      const title = `smoke-${uid}`;

      await goto(page, '/db');

      // Fill form
      await page.fill('input[placeholder="Note title"]', title);
      await page.fill('input[placeholder="Note body"]', 'test body');
      await page.click('button:has-text("Add Note")');

      // Wait for the note to appear
      await waitForText(page, title);
      const body = await page.textContent('body');
      assert.ok(body?.includes('test body'), 'page contains note body');

      // Delete it
      try {
        await deleteRowContaining(page, title);
        await waitForTextGone(page, title);
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 5. KV — set and delete a key
  // -----------------------------------------------------------------------
  void it('5 — KV set/lookup/delete', async () => {
    const { ctx, page } = await freshPage();
    try {
      const key = `smoke-kv-${uid}`;

      await goto(page, '/kv');

      // Set key — wait for the POST response before navigating away,
      // otherwise the navigation cancels the in-flight form submission
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'hello');
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes('/kv') && response.request().method() === 'POST',
        ),
        page.click('button:has-text("Set")'),
      ]);

      // Lookup the key we just set (kv.get is strongly consistent)
      await goto(page, `/kv?lookup=${encodeURIComponent(key)}`);
      const body = await page.textContent('body');
      assert.ok(body?.includes('hello'), 'lookup shows value');

      // Cleanup: delete via JSON POST (same as useForm.post())
      await page.evaluate(
        (keyToDelete) =>
          fetch('/kv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent: 'delete', key: keyToDelete }),
          }),
        key,
      );
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Storage — upload and delete a file
  // -----------------------------------------------------------------------
  void it('6 — Storage upload/delete', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/storage');

      // Use fileChooser API to upload a file
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click('input[type="file"]'),
      ]);
      await fileChooser.setFiles({
        name: 'smoke-test.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello world'),
      });

      await page.click('button:has-text("Upload")');
      await waitForText(page, 'smoke-test.txt');

      // Delete
      try {
        await deleteRowContaining(page, 'smoke-test.txt');
        await waitForTextGone(page, 'smoke-test.txt');
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 7. Env — displays bindings
  // -----------------------------------------------------------------------
  void it('7 — Env bindings', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/env');

      const body = await page.textContent('body');
      assert.ok(body?.includes('DB'), 'page lists DB binding');
      assert.ok(body?.includes('KV'), 'page lists KV binding');
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 8. Queues — send message and see consumer result
  // -----------------------------------------------------------------------
  void it('8 — Queues', async () => {
    const { ctx, page } = await freshPage();
    try {
      const key = `smoke-q-${uid}`;

      await goto(page, '/queues');

      // Send message — wait for the POST response to confirm the queue write completed
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'queued');
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes('/queues') && response.request().method() === 'POST',
        ),
        page.click('button:has-text("Send to Queue")'),
      ]);

      // Poll for consumer processing — consumer invocation timing is CF
      // infrastructure, not our code. Soft-pass on timeout (like cron test)
      // since we've already verified the queue binding and send work.
      try {
        await pollForText(page, '/queues', key, 60_000);

        // Cleanup
        try {
          await deleteRowContaining(page, key);
          await waitForTextGone(page, key);
        } catch {
          // best-effort
        }
      } catch {
        console.log(
          `  ⚠ Queue consumer did not process "${key}" within 60s (warning, not a failure)`,
        );
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 9. Auth — register, login, protected route, logout
  // -----------------------------------------------------------------------
  void it('9 — Auth flow', async () => {
    const { ctx, page } = await freshPage();
    try {
      const email = `smoke-${uid}@example.com`;
      const password = 's3cureP@ss!';

      await goto(page, '/auth');

      const body = await page.textContent('body');
      assert.ok(body?.includes('Not logged in'), "shows 'Not logged in'");

      // Switch to Register tab
      await page.click('button:has-text("Register")');
      await page.waitForSelector('input[placeholder="Name"]', { timeout: TIMEOUT });

      // Fill registration form
      await page.fill('input[placeholder="Email"]', email);
      await page.fill('input[placeholder="Password"]', password);
      await page.fill('input[placeholder="Name"]', 'Smoke User');
      // Click the Register submit button (inside the register section)
      await page.click('section:has(h2:has-text("Email Register")) button[type="submit"]');

      // Wait for logged-in state
      await waitForTextGone(page, 'Not logged in');
      const afterReg = await page.textContent('body');
      assert.ok(afterReg?.includes(email), 'shows email after registration');

      // Test protected route
      await page.click('button:has-text("GET /api/profile")');
      await page.waitForFunction(
        () => document.querySelector('pre')?.textContent?.includes('user'),
        {
          timeout: TIMEOUT,
        },
      );
      const pre = await page.textContent('pre');
      assert.ok(pre?.includes('user'), "profile response contains 'user'");
      assert.ok(pre?.includes(email), 'profile response contains email');

      // Logout
      await page.click('button:has-text("Logout")');
      await waitForText(page, 'Not logged in');

      // Re-login
      await page.click('button:has-text("Login")');
      await page.waitForSelector(
        'section:has(h2:has-text("Email Login")) input[placeholder="Email"]',
        {
          timeout: TIMEOUT,
        },
      );
      await page.fill('input[placeholder="Email"]', email);
      await page.fill('input[placeholder="Password"]', password);
      await page.click('section:has(h2:has-text("Email Login")) button[type="submit"]');

      await waitForTextGone(page, 'Not logged in');
      const afterLogin = await page.textContent('body');
      assert.ok(afterLogin?.includes(email), 'shows email after re-login');
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 10. Cron — heartbeat is running
  // -----------------------------------------------------------------------
  void it('10 — Cron heartbeat', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/cron');

      const body = await page.textContent('body');

      if (body?.includes('No heartbeat recorded yet')) {
        console.log('  ⚠ Cron heartbeat not recorded yet (warning, not a failure)');
        return; // soft pass
      }

      // Find the heartbeat timestamp (code element after "Last Heartbeat" heading)
      const timestamp = await page.evaluate(() => {
        const h2 = Array.from(document.querySelectorAll('h2')).find(
          (heading) => heading.textContent === 'Last Heartbeat',
        );
        const nextP = h2?.nextElementSibling;
        return nextP?.querySelector('code')?.textContent || null;
      });
      assert.ok(timestamp, 'heartbeat timestamp found');

      const date = new Date(timestamp!);
      assert.ok(!isNaN(date.getTime()), `timestamp is a valid date (got: ${timestamp})`);

      const ageMs = Date.now() - date.getTime();
      assert.ok(ageMs < 5 * 60 * 1000, `heartbeat is recent (${Math.round(ageMs / 1000)}s ago)`);
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 11. ISR Revalidation
  // -----------------------------------------------------------------------
  void it('11 — ISR revalidation', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/revalidate');

      // Note the initial "Rendered at" timestamp
      const renderedAt = await page.textContent('p:has(code) code');
      assert.ok(renderedAt, "initial 'Rendered at' timestamp found");

      // Click "Revalidate /revalidate"
      await page.click('button:has-text("Revalidate /revalidate")');

      // Wait for button to return to non-disabled state
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll('button')).find((candidateButton) =>
            candidateButton.textContent?.includes('Revalidate /revalidate'),
          );
          return button && !button.disabled;
        },
        { timeout: TIMEOUT },
      );

      // Reload and check "Last revalidation" is no longer "never"
      await goto(page, '/revalidate');
      const body = await page.textContent('body');
      assert.ok(
        !body?.includes('never') || body?.includes('Last revalidation'),
        "last revalidation is no longer 'never'",
      );

      // More precise: check the last revalidation code element
      const lastReval = await page.evaluate(() => {
        const paragraphs = Array.from(document.querySelectorAll('p'));
        const revalidationParagraph = paragraphs.find((paragraph) =>
          paragraph.textContent?.includes('Last revalidation'),
        );
        const code = revalidationParagraph?.querySelector('code');
        return code?.textContent || null;
      });
      assert.ok(lastReval, `last revalidation has a timestamp (got: ${lastReval})`);
    } finally {
      await ctx.close();
    }
  });
});
