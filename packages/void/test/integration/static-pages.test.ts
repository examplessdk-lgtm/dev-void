import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = "playground/static-pages";
const DIST = join(ROOT, PLAYGROUND, "dist");

function removeWranglerConfig(root: string) {
  rmSync(join(root, "wrangler.jsonc"), { force: true });
  rmSync(join(root, "wrangler.json"), { force: true });
}

describe("playground/static-pages build (output: static)", () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, "dist"), { recursive: true, force: true });
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: "pipe" });
  }, 120_000);

  it("emits worker entry and client manifest", () => {
    const workerEntry = join(DIST, "ssr/index.js");
    const clientManifest = join(DIST, "client/.vite/manifest.json");

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);
  });

  it("prerenders index.html with production asset URLs", () => {
    const indexPath = join(DIST, "client/index.html");
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, "utf-8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-testid="home-title"');
    expect(html).toContain("Home");
    expect(html).toContain("static pages playground");

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain("/@vite/client");
    expect(html).not.toContain("/@id/");
  });

  it("prerenders about.html with production asset URLs", () => {
    const aboutPath = join(DIST, "client/about.html");
    expect(existsSync(aboutPath)).toBe(true);

    const html = readFileSync(aboutPath, "utf-8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain("About");
    expect(html).toContain("static HTML");

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain("/@vite/client");
    expect(html).not.toContain("/@id/");
  });

  it("prerenders dynamic pages with getPrerenderPaths", () => {
    // posts/[slug] exports getPrerenderPaths returning [{slug:"hello"},{slug:"world"}]
    const helloPath = join(DIST, "client/posts/hello.html");
    const worldPath = join(DIST, "client/posts/world.html");
    expect(existsSync(helloPath)).toBe(true);
    expect(existsSync(worldPath)).toBe(true);

    const html = readFileSync(helloPath, "utf-8");
    expect(html).toContain('data-testid="post-title"');
    expect(html).toContain("Post hello");
  });

  it("does not prerender dynamic pages without getPrerenderPaths", () => {
    // items/[id] has no getPrerenderPaths, so it should NOT be prerendered
    expect(existsSync(join(DIST, "client/items"))).toBe(false);
  });

  it("wrangler.json has correct asset config", () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, "ssr/wrangler.json"), "utf-8")) as {
      assets?: { run_worker_first?: boolean | string[]; directory?: string };
    };
    expect(wranglerConfig.assets?.directory).toBe("../client");
    expect(wranglerConfig.assets?.run_worker_first).toBeDefined();
  });
}, 120_000);
