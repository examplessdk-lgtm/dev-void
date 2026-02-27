import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5191;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;
const PREVIEW_PORT = 5192;
const PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_PORT}`;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

async function killChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

describe("playground/ssr dev", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/ssr",
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(DEV_PORT),
        "--strictPort",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: "false",
        },
      },
    );

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(DEV_BASE, 20_000);
  }, 30_000);

  afterAll(async () => {
    if (child) await killChild(child);
    if (stderr.includes("error when starting dev server")) {
      throw new Error(stderr);
    }
  });

  it("serves SSR output for / and non-root paths", async () => {
    const rootResponse = await fetch(`${DEV_BASE}/`);
    expect(rootResponse.status).toBe(200);
    const rootHtml = await rootResponse.text();
    expect(rootHtml).toContain("Void SSR Playground");
    expect(rootHtml).toContain("Rendered URL: <!-- -->/");
    expect(rootHtml).toContain('<script type="module" src="/@vite/client"></script>');
    expect(rootHtml).toContain('<script type="module" src="/src/main.client.tsx"></script>');
    expect(rootHtml).toContain("__vite_plugin_react_preamble_installed__ = true");

    const nestedResponse = await fetch(`${DEV_BASE}/dashboard`);
    expect(nestedResponse.status).toBe(200);
    const nestedHtml = await nestedResponse.text();
    expect(nestedHtml).toContain("Rendered URL: <!-- -->/dashboard");

    const clientEntryResponse = await fetch(`${DEV_BASE}/src/main.client.tsx`);
    expect(clientEntryResponse.status).toBe(200);
    const contentType = clientEntryResponse.headers.get("content-type") ?? "";
    expect(contentType).toContain("javascript");
  });
}, 60_000);

describe("playground/ssr build + preview", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    rmSync(join(ROOT, "playground/ssr/dist"), { recursive: true, force: true });
    execSync("pnpm --dir playground/ssr build", { cwd: ROOT, stdio: "pipe" });

    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/ssr",
        "exec",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PREVIEW_PORT),
        "--strictPort",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(PREVIEW_BASE, 20_000);
  }, 60_000);

  afterAll(async () => {
    if (child) await killChild(child);
    if (stderr.includes("error when starting preview server")) {
      throw new Error(stderr);
    }
  });

  it("emits worker entry and client manifest", () => {
    const workerEntry = join(ROOT, "playground/ssr/dist/playground_ssr/index.js");
    const clientManifest = join(ROOT, "playground/ssr/dist/client/.vite/manifest.json");

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);

    const code = readFileSync(workerEntry, "utf-8");
    expect(code).toContain("renderSsrResponse(c, mod)");
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('SSR_CLIENT_ENTRY_ID = "src/main.client.tsx"');

    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, "playground/ssr/dist/playground_ssr/wrangler.json"), "utf-8"),
    ) as {
      assets?: { run_worker_first?: boolean | string[] };
      kv_namespaces?: Array<{ binding: string }>;
    };
    expect(wranglerConfig.assets?.run_worker_first).toEqual([
      "/**",
      "!/assets/*",
      "!/@*",
      "!/__uno*",
      "!/src/*",
      "!/node_modules/*",
    ]);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === "KV")).toBe(true);
  });

  it("preview serves SSR pages", async () => {
    const rootFirst = await (await fetch(`${PREVIEW_BASE}/`)).text();
    const rootSecond = await (await fetch(`${PREVIEW_BASE}/`)).text();
    expect(rootFirst).toContain("Rendered URL: <!-- -->/");
    expect(rootSecond).toContain("Rendered URL: <!-- -->/");

    const previewAboutHtml = await (await fetch(`${PREVIEW_BASE}/about`)).text();
    expect(previewAboutHtml).toContain("Rendered URL: <!-- -->/about");
  });
}, 60_000);
