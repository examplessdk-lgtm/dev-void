import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import type { InferredBindings } from "../../src/inference/walk";

import { readWranglerCompat, syncWranglerBindings } from "../../src/cli/wrangler";

const tmpDir = join(import.meta.dirname, ".tmp-wrangler-test");

function setup(filename: string, content: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, filename), content);
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readWranglerCompat", () => {
  it("returns empty when no wrangler config exists", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(readWranglerCompat(tmpDir)).toEqual({});
  });

  it("reads from wrangler.json", () => {
    setup(
      "wrangler.json",
      JSON.stringify({
        name: "test",
        compatibility_date: "2026-02-24",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: "2026-02-24",
      compatibilityFlags: ["nodejs_compat"],
    });
  });

  it("reads from wrangler.jsonc with comments", () => {
    setup(
      "wrangler.jsonc",
      `{
  // This is a comment
  "name": "test",
  "compatibility_date": "2026-02-24",
  /* Multi-line
     comment */
  "compatibility_flags": [
    "nodejs_compat",
    "nodejs_als"
  ]
}`,
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: "2026-02-24",
      compatibilityFlags: ["nodejs_compat", "nodejs_als"],
    });
  });

  it("prefers wrangler.jsonc over wrangler.json", () => {
    setup("wrangler.jsonc", '{ "compatibility_date": "2026-01-01" }');
    writeFileSync(join(tmpDir, "wrangler.json"), '{ "compatibility_date": "2025-01-01" }');
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: "2026-01-01",
    });
  });

  it("returns empty when fields are missing", () => {
    setup("wrangler.json", '{ "name": "test" }');
    expect(readWranglerCompat(tmpDir)).toEqual({});
  });

  it("handles strings containing // without stripping them", () => {
    setup(
      "wrangler.jsonc",
      `{
  // real comment
  "compatibility_date": "2026-02-24",
  "name": "my-app"
}`,
    );
    const result = readWranglerCompat(tmpDir);
    expect(result.compatibilityDate).toBe("2026-02-24");
  });
});

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
};

describe("syncWranglerBindings", () => {
  it("returns false when no wrangler config exists", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(false);
  });

  it("adds D1 binding when needsD1 is true", () => {
    setup("wrangler.jsonc", '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, "wrangler.jsonc"), "utf-8"));
    expect(parsed.d1_databases).toEqual([
      { binding: "DB", database_name: "default", database_id: "local" },
    ]);
  });

  it("adds KV and R2 bindings", () => {
    setup("wrangler.json", '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsKV: true, needsR2: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, "wrangler.json"), "utf-8"));
    expect(parsed.kv_namespaces).toEqual([{ binding: "KV", id: "local" }]);
    expect(parsed.r2_buckets).toEqual([{ binding: "STORAGE", bucket_name: "default" }]);
  });

  it("adds AUTH_KV when auth is enabled", () => {
    setup("wrangler.jsonc", '{ "name": "test" }');
    syncWranglerBindings(tmpDir, noBindings, { auth: true });
    const parsed = JSON.parse(readFileSync(join(tmpDir, "wrangler.jsonc"), "utf-8"));
    expect(parsed.d1_databases).toEqual([
      { binding: "DB", database_name: "default", database_id: "local" },
    ]);
    expect(parsed.kv_namespaces).toEqual([{ binding: "AUTH_KV", id: "auth-local" }]);
  });

  it("uses custom binding names", () => {
    setup("wrangler.jsonc", '{ "name": "test" }');
    syncWranglerBindings(
      tmpDir,
      { ...noBindings, needsD1: true, needsKV: true },
      { bindingNames: { d1: "MY_DB", kv: "MY_KV" } },
    );
    const parsed = JSON.parse(readFileSync(join(tmpDir, "wrangler.jsonc"), "utf-8"));
    expect(parsed.d1_databases[0].binding).toBe("MY_DB");
    expect(parsed.kv_namespaces[0].binding).toBe("MY_KV");
  });

  it("does not duplicate existing bindings", () => {
    setup(
      "wrangler.jsonc",
      JSON.stringify({
        name: "test",
        d1_databases: [{ binding: "DB", database_name: "prod", database_id: "real-id" }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(false);
  });

  it("returns false when no bindings needed", () => {
    setup("wrangler.jsonc", '{ "name": "test" }');
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(false);
  });
});
