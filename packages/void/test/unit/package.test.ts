import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  packageBuild,
  packageStaticBuild,
  computeAssetHash,
  collectAndHashAssets,
} from "../../src/cli/package";

const TMP = join(import.meta.dirname, ".tmp-package-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("packageStaticBuild", () => {
  it("includes all assets in form data", () => {
    writeFileSync(join(TMP, "a.html"), "a");
    writeFileSync(join(TMP, "b.js"), "b");

    const form = packageStaticBuild(TMP, "spa");

    const assetKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("asset:")) {
        assetKeys.push(key.slice("asset:".length));
      }
    }

    expect(assetKeys.sort()).toEqual(["a.html", "b.js"]);
  });

  it("sets version 2 in manifest", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "spa");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(3);
  });

  it("sets assetConfig for SPA mode", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "spa");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: "single-page-application",
    });
  });

  it("sets assetConfig for static mode", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "static");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: "404-page",
    });
  });
});

describe("packageBuild", () => {
  it("excludes .vite/ directory from worker files", () => {
    // Set up dist/worker/ with worker files and .vite/manifest.json
    const workerDir = join(TMP, "worker");
    mkdirSync(join(workerDir, ".vite"), { recursive: true });
    mkdirSync(join(workerDir, "assets"), { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    writeFileSync(join(workerDir, "assets", "chunk.js"), "var x = 1");
    writeFileSync(join(workerDir, ".vite", "manifest.json"), '{"key":"value"}');

    const form = packageBuild(TMP, "worker", {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const workerKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("worker:")) {
        workerKeys.push(key.slice("worker:".length));
      }
    }

    expect(workerKeys.sort()).toEqual(["assets/chunk.js", "index.js"]);
    expect(workerKeys).not.toContain(".vite/manifest.json");
  });

  it("sets version 2 in manifest", () => {
    const workerDir = join(TMP, "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");

    const form = packageBuild(TMP, "worker", {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(3);
  });
});

describe("computeAssetHash", () => {
  it("returns a 32-char hex string", () => {
    const hash = computeAssetHash(Buffer.from("hello world"));
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns consistent hashes for same content", () => {
    const a = computeAssetHash(Buffer.from("test content"));
    const b = computeAssetHash(Buffer.from("test content"));
    expect(a).toBe(b);
  });

  it("returns different hashes for different content", () => {
    const a = computeAssetHash(Buffer.from("content a"));
    const b = computeAssetHash(Buffer.from("content b"));
    expect(a).not.toBe(b);
  });

  it("matches Web Crypto API output", async () => {
    const content = Buffer.from("cross-compat test");
    const cliHash = computeAssetHash(content);

    const digest = await crypto.subtle.digest("SHA-256", content);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const apiHash = hex.slice(0, 32);

    expect(cliHash).toBe(apiHash);
  });
});

describe("collectAndHashAssets", () => {
  it("collects files with hashes and sizes", () => {
    mkdirSync(join(TMP, "assets"), { recursive: true });
    writeFileSync(join(TMP, "index.html"), "<html>hello</html>");
    writeFileSync(join(TMP, "assets", "app.js"), "console.log('hi')");

    const { assetManifest, assetFiles } = collectAndHashAssets(TMP);

    expect(Object.keys(assetManifest).sort()).toEqual(["/assets/app.js", "/index.html"]);
    expect(assetManifest["/index.html"].hash).toHaveLength(32);
    expect(assetManifest["/index.html"].size).toBe(Buffer.from("<html>hello</html>").length);
    expect(assetFiles.size).toBe(2);
  });

  it("returns empty manifest for missing directory", () => {
    const { assetManifest, assetFiles } = collectAndHashAssets(join(TMP, "nonexistent"));

    expect(Object.keys(assetManifest)).toHaveLength(0);
    expect(assetFiles.size).toBe(0);
  });
});

describe("packageStaticBuild with neededAssets", () => {
  it("only includes needed assets when set is provided", () => {
    writeFileSync(join(TMP, "a.html"), "a");
    writeFileSync(join(TMP, "b.js"), "b");
    writeFileSync(join(TMP, "c.css"), "c");

    const needed = new Set(["/a.html", "/c.css"]);
    const form = packageStaticBuild(TMP, "spa", needed);

    const assetKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("asset:")) {
        assetKeys.push(key.slice("asset:".length));
      }
    }

    expect(assetKeys.sort()).toEqual(["a.html", "c.css"]);
    expect(form.get("preflight")).toBe("true");
  });

  it("includes all assets when neededAssets is null", () => {
    writeFileSync(join(TMP, "a.html"), "a");
    writeFileSync(join(TMP, "b.js"), "b");

    const form = packageStaticBuild(TMP, "spa", null);

    const assetKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("asset:")) {
        assetKeys.push(key.slice("asset:".length));
      }
    }

    expect(assetKeys.sort()).toEqual(["a.html", "b.js"]);
    expect(form.get("preflight")).toBeNull();
  });
});
