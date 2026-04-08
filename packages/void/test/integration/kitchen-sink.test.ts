import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import spawn from "cross-spawn";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { getPort, waitForServer, killChild } from "../../../../test/integration-helpers";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

let PORT: number;
let BASE: string;
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]', { timeout: 20_000 });
}

describe("playground/kitchen-sink", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    PORT = await getPort();
    BASE = `http://127.0.0.1:${PORT}`;

    // Build first — deterministic, all deps resolved at build time.
    // Eliminates the dev-mode dep optimization cascade that caused
    // flaky CI failures (server crashes, hydration timeouts).
    const pg = join(ROOT, "playground/kitchen-sink");
    rmSync(join(pg, "dist"), { recursive: true, force: true });
    execSync("pnpm --dir playground/kitchen-sink build", {
      cwd: ROOT,
      stdio: "pipe",
    });

    // Start preview server — pre-built assets, no lazy optimization.
    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/kitchen-sink",
        "exec",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForServer(BASE, 30_000, { expectBody: "Kitchen Sink" });

    // Preview mode doesn't auto-run migrations (dev mode's migrationPlugin
    // handles this via configureServer). Apply them directly to the local
    // D1 database so pages that query DB/Auth tables work.
    const { runMigrations, getMiniflareDatabasePath } = await import("../../src/migrations/runner");
    const dbPath = getMiniflareDatabasePath(join(pg, ".void"), "local");
    await runMigrations(join(pg, "db", "migrations"), dbPath);

    const { runLocalVoidAuthMigrations } = await import("../../src/auth/node");
    await runLocalVoidAuthMigrations(pg, "sqlite", join(pg, ".void"), "local", null);
  }, 120_000);

  afterAll(async () => {
    if (child) await killChild(child);
  });

  // -- SSR + SPA navigation --

  it("serves SSR home page and hydrates", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      const text = await page.textContent("body");
      expect(text).toContain("Kitchen Sink");
      expect(text).toContain("Auth");
    } finally {
      await page.context().close();
    }
  });

  it("SPA navigates between pages without full reload", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      // Set a marker to detect full reload
      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });

      await page.click('a[href="/db"]');
      await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("DB"));
      expect(page.url()).toBe(`${BASE}/db`);

      // Marker survives = SPA navigation (no reload)
      const marker = await page.evaluate(() => (window as any).__SPA_MARKER);
      expect(marker).toBe(true);

      // Navigate to another page
      await page.click('a[href="/kv"]');
      await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("KV"));
      expect(page.url()).toBe(`${BASE}/kv`);
    } finally {
      await page.context().close();
    }
  });

  it("layout persists across navigation", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      await page.evaluate(() => {
        (document.querySelector("nav") as any).__stamp = 1;
      });

      await page.click('a[href="/env"]');
      await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Env"));

      const stamp = await page.evaluate(() => (document.querySelector("nav") as any).__stamp);
      expect(stamp).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  // -- DB --

  it("DB: create and delete a note via the UI", async () => {
    const page = await newPage();
    const title = `e2e-${Date.now()}`;

    try {
      await page.goto(`${BASE}/db`);
      await waitForHydration(page);

      // Fill the form and submit
      await page.fill('input[placeholder="Note title"]', title);
      await page.fill('input[placeholder="Note body"]', "test body");
      await page.click('button:has-text("Add Note")');

      // Wait for the note to appear in the table
      await page.waitForFunction((t) => document.body.textContent?.includes(t), title);
      const text = await page.textContent("body");
      expect(text).toContain(title);
      expect(text).toContain("test body");

      // Delete it — find the row with our title and click its Delete button
      const row = page.locator("tr", { hasText: title });
      await row.locator('button:has-text("Delete")').click();

      // Wait for it to disappear
      await page.waitForFunction((t) => !document.body.textContent?.includes(t), title);
    } finally {
      await page.context().close();
    }
  });

  // -- KV --

  it("KV: set and delete a key via the UI", async () => {
    const page = await newPage();
    const key = `e2e-kv-${Date.now()}`;

    try {
      await page.goto(`${BASE}/kv`);
      await waitForHydration(page);

      // Set a key
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', "hello");
      await page.click('button:has-text("Set")');

      // Wait for it to appear in the keys list
      await page.waitForFunction((k) => document.body.textContent?.includes(k), key);
      let text = await page.textContent("body");
      expect(text).toContain(key);

      // Delete it
      const row = page.locator("tr", { hasText: key });
      await row.locator('button:has-text("Delete")').click();

      await page.waitForFunction((k) => !document.body.textContent?.includes(k), key);
      text = await page.textContent("body");
      expect(text).not.toContain(key);
    } finally {
      await page.context().close();
    }
  });

  // -- Storage (R2) --

  it("Storage: upload and delete a file via the UI", async () => {
    const page = await newPage();

    try {
      await page.goto(`${BASE}/storage`);
      await waitForHydration(page);

      // Create a temp file via the file input
      const fileChooserPromise = page.waitForEvent("filechooser");
      await page.click('input[type="file"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: "e2e-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello world"),
      });

      await page.click('button:has-text("Upload")');

      // Wait for it to appear
      await page.waitForFunction(() => document.body.textContent?.includes("e2e-test.txt"));
      const text = await page.textContent("body");
      expect(text).toContain("e2e-test.txt");

      // Delete it
      const row = page.locator("tr", { hasText: "e2e-test.txt" });
      await row.locator('button:has-text("Delete")').click();

      await page.waitForFunction(() => !document.body.textContent?.includes("e2e-test.txt"));
    } finally {
      await page.context().close();
    }
  });

  // -- Env --

  it("Env: displays bindings including DB and KV", async () => {
    const page = await newPage();

    try {
      await page.goto(`${BASE}/env`);
      await waitForHydration(page);

      const text = await page.textContent("body");
      expect(text).toContain("DB");
      expect(text).toContain("KV");
    } finally {
      await page.context().close();
    }
  });

  // -- Queues --

  it("Queues: send message and see consumer result", async () => {
    const page = await newPage();
    const key = `e2e-q-${Date.now()}`;

    try {
      await page.goto(`${BASE}/queues`);
      await waitForHydration(page);

      // Send a message
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', "queued");
      await page.click('button:has-text("Send to Queue")');

      // Poll for the result — the consumer writes to KV and the page
      // shows it under "Processed Results". Reload to pick up the result.
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        // SPA-reload the page to re-run the loader
        await page.goto(`${BASE}/queues`);
        await waitForHydration(page);
        const text = await page.textContent("body");
        if (text?.includes(key)) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  // -- Auth --

  it("Auth: register, login, protected route, logout via the UI", async () => {
    const page = await newPage();
    const email = `e2e-${Date.now()}@example.com`;
    const password = "s3cureP@ss!";

    try {
      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);

      // Should show "Not logged in"
      await page.waitForFunction(() => document.body.textContent?.includes("Not logged in"));

      // Switch to Register tab
      const registerTab = page.locator("button", { hasText: "Register" }).first();
      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');

      // Fill and submit the register form
      const regSection = page.locator("section", {
        has: page.locator('h2:has-text("Email Register")'),
      });
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill("E2E User");
      await regSection.locator('button[type="submit"]').click();

      // After register + reload, status should update (wait for "Not logged in" to disappear)
      await page.waitForFunction(() => !document.body.textContent?.includes("Not logged in"));
      const statusText = await page.textContent("body");
      expect(statusText).toContain(email);

      // Test protected route
      await page.click('button:has-text("GET /api/profile")');
      await page.waitForFunction(() =>
        document.querySelector("pre")?.textContent?.includes('"user"'),
      );
      const responseText = await page.textContent("pre");
      expect(responseText).toContain(email);

      // Logout
      await page.click('button:has-text("Logout")');
      await page.waitForFunction(() => document.body.textContent?.includes("Not logged in"));

      // Switch to Login tab and log back in
      const loginTab = page.locator("button", { hasText: "Login" }).first();
      await loginTab.click();

      const loginSection = page.locator("section", {
        has: page.locator('h2:has-text("Email Login")'),
      });
      await loginSection.locator('input[type="email"]').fill(email);
      await loginSection.locator('input[type="password"]').fill(password);
      await loginSection.locator('button[type="submit"]').click();

      // Should be logged in again
      await page.waitForFunction(() => !document.body.textContent?.includes("Not logged in"));
    } finally {
      await page.context().close();
    }
  });

  it("Reset: clears Better Auth users so the same email can register again", async () => {
    const page = await newPage();
    const email = `reset-${Date.now()}@example.com`;
    const password = "s3cureP@ss!";

    try {
      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);
      await page.waitForFunction(() => document.body.textContent?.includes("Not logged in"));

      const registerTab = page.locator("button", { hasText: "Register" }).first();
      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');

      const regSection = page.locator("section", {
        has: page.locator('h2:has-text("Email Register")'),
      });
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill("Reset User");
      await regSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes("Not logged in"));
      expect(await page.textContent("body")).toContain(email);

      const resetResult = await page.evaluate(async () => {
        const res = await fetch("/api/reset", { method: "POST" });
        return {
          status: res.status,
          body: await res.json(),
        };
      });
      expect(resetResult.status).toBe(200);
      expect(resetResult.body).toEqual({ ok: true });

      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);
      await page.waitForFunction(() => document.body.textContent?.includes("Not logged in"));

      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill("Reset User");
      await regSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes("Not logged in"));
      expect(await page.textContent("body")).toContain(email);
    } finally {
      await page.context().close();
    }
  });

  // -- 404 handling --

  it("returns 404 for paths with standard file extensions", async () => {
    const res = await fetch(`${BASE}/missing.css`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for dotfiles like /.env", async () => {
    const res = await fetch(`${BASE}/.env`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for nested dotfiles like /laravel/.env", async () => {
    const res = await fetch(`${BASE}/laravel/.env`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for dot-prefixed directory segments like /.well-known/traffic-advice", async () => {
    const res = await fetch(`${BASE}/.well-known/traffic-advice`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /.git/HEAD", async () => {
    const res = await fetch(`${BASE}/.git/HEAD`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /.htaccess", async () => {
    const res = await fetch(`${BASE}/.htaccess`);
    expect(res.status).toBe(404);
  });

  // File extension paths caught by last-segment dot check
  it("returns 404 for /wp-login.php", async () => {
    const res = await fetch(`${BASE}/wp-login.php`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /xmlrpc.php", async () => {
    const res = await fetch(`${BASE}/xmlrpc.php`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /robots.txt", async () => {
    const res = await fetch(`${BASE}/robots.txt`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /favicon.ico", async () => {
    const res = await fetch(`${BASE}/favicon.ico`);
    expect(res.status).toBe(404);
  });

  // Bot probes — single-segment paths without dots, caught by notFound fallback
  it("returns 404 for /wp-admin", async () => {
    const res = await fetch(`${BASE}/wp-admin`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /phpmyadmin", async () => {
    const res = await fetch(`${BASE}/phpmyadmin`);
    expect(res.status).toBe(404);
  });

  // Multi-segment unknown paths
  it("returns 404 for /foo/bar/baz", async () => {
    const res = await fetch(`${BASE}/foo/bar/baz`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for /wp-content/plugins/exploit", async () => {
    const res = await fetch(`${BASE}/wp-content/plugins/exploit`);
    expect(res.status).toBe(404);
  });

  // API prefix returns 404 text (not HTML)
  it("returns 404 for unknown API routes", async () => {
    const res = await fetch(`${BASE}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  // Non-GET methods to unknown paths
  it("returns 404 for POST to unknown paths", async () => {
    const res = await fetch(`${BASE}/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("redirects trailing slash to non-trailing-slash path", async () => {
    const res = await fetch(`${BASE}/wp-content/`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toContain("/wp-content");
  });

  // Cron: skipped — __scheduled endpoint is only available via wrangler, not Vite dev/preview
}, 120_000);
