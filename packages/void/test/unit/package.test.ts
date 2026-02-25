import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { computeAssetHashes, packageBuild, packageStaticBuild } from "../../src/cli/package";

const TMP = join(import.meta.dirname, ".tmp-package-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("computeAssetHashes", () => {
  it("returns correct SHA-256 hex digests", () => {
    writeFileSync(join(TMP, "index.html"), "<html>hello</html>");
    writeFileSync(join(TMP, "app.js"), "console.log(1)");

    const hashes = computeAssetHashes(TMP);

    expect(hashes["index.html"]).toBe(
      createHash("sha256").update("<html>hello</html>").digest("hex"),
    );
    expect(hashes["app.js"]).toBe(createHash("sha256").update("console.log(1)").digest("hex"));
  });

  it("handles nested directories", () => {
    mkdirSync(join(TMP, "assets"), { recursive: true });
    writeFileSync(join(TMP, "assets", "style.css"), "body{}");

    const hashes = computeAssetHashes(TMP);
    expect(hashes["assets/style.css"]).toBe(createHash("sha256").update("body{}").digest("hex"));
  });

  it("returns empty object for empty directory", () => {
    const hashes = computeAssetHashes(TMP);
    expect(hashes).toEqual({});
  });
});

describe("packageStaticBuild with filtering", () => {
  it("includes only needed asset entries when neededPaths is provided", () => {
    writeFileSync(join(TMP, "index.html"), "<html>hi</html>");
    writeFileSync(join(TMP, "app.js"), "console.log(1)");
    writeFileSync(join(TMP, "style.css"), "body{}");

    const needed = new Set(["index.html"]);
    const hashes = { "index.html": "aaa", "app.js": "bbb", "style.css": "ccc" };

    const form = packageStaticBuild(TMP, "spa", needed, hashes);

    // Collect asset entries
    const assetKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("asset:")) {
        assetKeys.push(key.slice("asset:".length));
      }
    }

    expect(assetKeys).toEqual(["index.html"]);
  });

  it("includes all assets when neededPaths is undefined", () => {
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

  it("includes assetHashes in manifest when provided", () => {
    writeFileSync(join(TMP, "index.html"), "x");
    const hashes = { "index.html": "abc123" };

    const form = packageStaticBuild(TMP, "spa", undefined, hashes);

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetHashes).toEqual(hashes);
  });

  it("does not include assetHashes in manifest when not provided", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "spa");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetHashes).toBeUndefined();
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
});
