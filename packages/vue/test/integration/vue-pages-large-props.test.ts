import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = join(ROOT, "playground/vue-pages");
const VOID_JSON = join(PLAYGROUND, "void.json");

describe("x-void-page-data header with large props", () => {
  let voidJsonExisted: boolean;

  beforeAll(() => {
    // Check if void.json already exists (shouldn't, but be safe)
    voidJsonExisted = existsSync(VOID_JSON);
  });

  afterAll(() => {
    // Clean up: remove void.json if we created it
    if (!voidJsonExisted && existsSync(VOID_JSON)) {
      unlinkSync(VOID_JSON);
    }
  });

  it("SSG prerender should not fail for pages with large props (~300KB)", () => {
    // Enable SSG mode so the build prerenders pages via Miniflare.
    // The x-void-page-data header serializes the full page object (~300KB+)
    // into an HTTP response header, which exceeds Miniflare's header size
    // limits and causes "fetch failed" during prerendering.
    //
    // Real-world case: Notion-powered blog (musubi) where each page returns
    // a full ExtendedRecordMap (~30-70KB) + pre-rendered HTML (~50-200KB).
    // All 16 blog post pages fail with "fetch failed" during `vite build`.
    writeFileSync(VOID_JSON, JSON.stringify({ output: "static" }, null, 2));

    let buildOutput: string;
    try {
      buildOutput = execSync("pnpm --dir playground/vue-pages exec vite build", {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60_000,
      });
    } catch (e: any) {
      // Build may "succeed" with warnings for failed prerenders, or may throw
      buildOutput = (e.stdout ?? "") + (e.stderr ?? "");
    }

    // The large-props page should prerender successfully without "fetch failed"
    expect(buildOutput).not.toContain("large-props failed");
    expect(buildOutput).toContain("large-props.html");
  }, 60_000);
});
