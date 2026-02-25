import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  readConfig,
  convertHeadersConfig,
  normalizeAuth,
  resolveBindingNames,
} from "../../src/config";

const tmpDir = join(import.meta.dirname, ".tmp-config-test");

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, "void.json"), content);
  }
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe("readConfig", () => {
  it("returns empty config when no file exists", () => {
    setup();
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it("reads a valid config with all fields", () => {
    setup(
      JSON.stringify({
        auth: ["github", "email"],
        bindings: { db: true, kv: false },
        headers: {
          "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
          "/*": ["X-Frame-Options: DENY"],
        },
        mode: "spa",
        outputDir: "dist",
        wrangler: {
          compatibility_date: "2025-12-01",
          compatibility_flags: ["nodejs_compat"],
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.auth).toEqual(["github", "email"]);
    expect(config.bindings).toEqual({ db: true, kv: false });
    expect(config.headers).toEqual({
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY"],
    });
    expect(config.mode).toBe("spa");
    expect(config.outputDir).toBe("dist");
    expect(config.wrangler).toEqual({
      compatibility_date: "2025-12-01",
      compatibility_flags: ["nodejs_compat"],
    });
    cleanup();
  });

  it("accepts auth as boolean true", () => {
    setup(JSON.stringify({ auth: true }));
    const config = readConfig(tmpDir);
    expect(config.auth).toBe(true);
    cleanup();
  });

  it("accepts auth as boolean false", () => {
    setup(JSON.stringify({ auth: false }));
    const config = readConfig(tmpDir);
    expect(config.auth).toBe(false);
    cleanup();
  });

  it("accepts empty object", () => {
    setup("{}");
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it("ignores $schema field", () => {
    setup(JSON.stringify({ $schema: "https://unpkg.com/void/schema.json" }));
    const config = readConfig(tmpDir);
    expect(config.$schema).toBe("https://unpkg.com/void/schema.json");
    cleanup();
  });

  it("throws on invalid JSON", () => {
    setup("{not json}");
    expect(() => readConfig(tmpDir)).toThrow("Invalid JSON");
    cleanup();
  });

  it("throws if root is not an object", () => {
    setup('"hello"');
    expect(() => readConfig(tmpDir)).toThrow("must be a JSON object");
    cleanup();
  });

  it("throws on invalid auth provider", () => {
    setup(JSON.stringify({ auth: ["github", "twitter"] }));
    expect(() => readConfig(tmpDir)).toThrow("Invalid auth provider");
    cleanup();
  });

  it("throws on invalid auth type", () => {
    setup(JSON.stringify({ auth: "github" }));
    expect(() => readConfig(tmpDir)).toThrow("must be a boolean or an array");
    cleanup();
  });

  it("throws on invalid bindings type", () => {
    setup(JSON.stringify({ bindings: "db" }));
    expect(() => readConfig(tmpDir)).toThrow('"bindings"');
    cleanup();
  });

  it("throws on unknown binding key", () => {
    setup(JSON.stringify({ bindings: { db: true, queue: true } }));
    expect(() => readConfig(tmpDir)).toThrow('Unknown binding "queue"');
    cleanup();
  });

  it("accepts string binding names for db/kv/storage", () => {
    setup(JSON.stringify({ bindings: { db: "MY_DB", kv: "MY_KV", storage: "MY_R2" } }));
    const config = readConfig(tmpDir);
    expect(config.bindings?.db).toBe("MY_DB");
    expect(config.bindings?.kv).toBe("MY_KV");
    expect(config.bindings?.storage).toBe("MY_R2");
    cleanup();
  });

  it("throws on non-boolean ai binding value", () => {
    setup(JSON.stringify({ bindings: { ai: "yes" } }));
    expect(() => readConfig(tmpDir)).toThrow("must be a boolean");
    cleanup();
  });

  it("throws on invalid binding value type", () => {
    setup(JSON.stringify({ bindings: { db: 42 } }));
    expect(() => readConfig(tmpDir)).toThrow("must be a boolean or a string");
    cleanup();
  });

  it("throws on invalid mode", () => {
    setup(JSON.stringify({ mode: "serverless" }));
    expect(() => readConfig(tmpDir)).toThrow("must be one of: spa, ssg, full");
    cleanup();
  });

  it("throws on non-string outputDir", () => {
    setup(JSON.stringify({ outputDir: 42 }));
    expect(() => readConfig(tmpDir)).toThrow("must be a string");
    cleanup();
  });

  it("throws on header pattern not starting with /", () => {
    setup(JSON.stringify({ headers: { "assets/*": ["Cache-Control: no-cache"] } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it("throws on non-array header values", () => {
    setup(JSON.stringify({ headers: { "/*": "X-Frame-Options: DENY" } }));
    expect(() => readConfig(tmpDir)).toThrow("must be an array of strings");
    cleanup();
  });

  it("throws on invalid wrangler type", () => {
    setup(JSON.stringify({ wrangler: "yes" }));
    expect(() => readConfig(tmpDir)).toThrow('"wrangler"');
    cleanup();
  });

  it("accepts cache.revalidate as a number", () => {
    setup(JSON.stringify({ cache: { revalidate: 60 } }));
    const config = readConfig(tmpDir);
    expect(config.cache?.revalidate).toBe(60);
    cleanup();
  });

  it("accepts cache.revalidate as zero", () => {
    setup(JSON.stringify({ cache: { revalidate: 0 } }));
    const config = readConfig(tmpDir);
    expect(config.cache?.revalidate).toBe(0);
    cleanup();
  });

  it("accepts cache.revalidate as a path map", () => {
    setup(JSON.stringify({ cache: { revalidate: { "/": 60, "/docs/*": 31536000, "*": 30 } } }));
    const config = readConfig(tmpDir);
    expect(config.cache?.revalidate).toEqual({ "/": 60, "/docs/*": 31536000, "*": 30 });
    cleanup();
  });

  it("throws on negative cache.revalidate number", () => {
    setup(JSON.stringify({ cache: { revalidate: -1 } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.revalidate"');
    cleanup();
  });

  it("throws on string cache.revalidate", () => {
    setup(JSON.stringify({ cache: { revalidate: "60" } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.revalidate"');
    cleanup();
  });

  it("throws on non-numeric cache.revalidate path map value", () => {
    setup(JSON.stringify({ cache: { revalidate: { "/": "60" } } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.revalidate"');
    cleanup();
  });

  it("throws on negative cache.revalidate path map value", () => {
    setup(JSON.stringify({ cache: { revalidate: { "/": -10 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.revalidate"');
    cleanup();
  });

  it("throws on cache.revalidate path map key not starting with / or *", () => {
    setup(JSON.stringify({ cache: { revalidate: { docs: 60 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.revalidate"');
    cleanup();
  });

  it("throws migration error when top-level revalidate is used", () => {
    setup(JSON.stringify({ revalidate: 60 }));
    expect(() => readConfig(tmpDir)).toThrow('"revalidate" has moved to "cache.revalidate"');
    cleanup();
  });

  it("throws on invalid cache type", () => {
    setup(JSON.stringify({ cache: "invalid" }));
    expect(() => readConfig(tmpDir)).toThrow('"cache" in void.json must be an object');
    cleanup();
  });

  it("accepts empty cache object", () => {
    setup(JSON.stringify({ cache: {} }));
    const config = readConfig(tmpDir);
    expect(config.cache).toEqual({});
    cleanup();
  });

  it("accepts build command string", () => {
    setup(JSON.stringify({ build: "nuxt build" }));
    const config = readConfig(tmpDir);
    expect(config.build).toBe("nuxt build");
    cleanup();
  });

  it("throws on non-string build", () => {
    setup(JSON.stringify({ build: true }));
    expect(() => readConfig(tmpDir)).toThrow('"build" in void.json must be a string');
    cleanup();
  });

  it("accepts cache.prerender paths", () => {
    setup(JSON.stringify({ cache: { prerender: ["/", "/about", "/docs/intro"] } }));
    const config = readConfig(tmpDir);
    expect(config.cache?.prerender).toEqual(["/", "/about", "/docs/intro"]);
    cleanup();
  });

  it("throws on non-array cache.prerender", () => {
    setup(JSON.stringify({ cache: { prerender: "/about" } }));
    expect(() => readConfig(tmpDir)).toThrow('"cache.prerender" in void.json must be an array');
    cleanup();
  });

  it("throws on cache.prerender path not starting with /", () => {
    setup(JSON.stringify({ cache: { prerender: ["about"] } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it("accepts scanDirs as array of strings", () => {
    setup(JSON.stringify({ scanDirs: ["src", "lib", "server"] }));
    const config = readConfig(tmpDir);
    expect(config.scanDirs).toEqual(["src", "lib", "server"]);
    cleanup();
  });

  it("throws on non-array scanDirs", () => {
    setup(JSON.stringify({ scanDirs: "src" }));
    expect(() => readConfig(tmpDir)).toThrow('"scanDirs" in void.json must be an array');
    cleanup();
  });

  it("throws on absolute path in scanDirs", () => {
    setup(JSON.stringify({ scanDirs: ["/etc/passwd"] }));
    expect(() => readConfig(tmpDir)).toThrow("must be a relative directory");
    cleanup();
  });

  it("throws on parent traversal in scanDirs", () => {
    setup(JSON.stringify({ scanDirs: ["../secrets"] }));
    expect(() => readConfig(tmpDir)).toThrow("must be a relative directory");
    cleanup();
  });
});

describe("normalizeAuth", () => {
  it("returns null for undefined", () => {
    expect(normalizeAuth(undefined)).toBeNull();
  });

  it("returns null for false", () => {
    expect(normalizeAuth(false)).toBeNull();
  });

  it("returns [email] for true", () => {
    expect(normalizeAuth(true)).toEqual(["email"]);
  });

  it("returns null for empty array", () => {
    expect(normalizeAuth([])).toBeNull();
  });

  it("returns the array as-is", () => {
    expect(normalizeAuth(["github", "google"])).toEqual(["github", "google"]);
  });
});

describe("convertHeadersConfig", () => {
  it("returns undefined for undefined input", () => {
    expect(convertHeadersConfig(undefined)).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(convertHeadersConfig({})).toBeUndefined();
  });

  it("converts a single pattern with one header", () => {
    const result = convertHeadersConfig({
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    });
    expect(result).toEqual([
      {
        pattern: "/assets/*",
        headers: [["Cache-Control", "public, max-age=31536000, immutable"]],
      },
    ]);
  });

  it("converts multiple patterns with multiple headers", () => {
    const result = convertHeadersConfig({
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
    });
    expect(result).toEqual([
      {
        pattern: "/assets/*",
        headers: [["Cache-Control", "public, max-age=31536000, immutable"]],
      },
      {
        pattern: "/*",
        headers: [
          ["X-Frame-Options", "DENY"],
          ["X-Content-Type-Options", "nosniff"],
        ],
      },
    ]);
  });

  it("handles header values with colons", () => {
    const result = convertHeadersConfig({
      "/api/*": ['Link: <https://example.com>; rel="preconnect"'],
    });
    expect(result).toEqual([
      {
        pattern: "/api/*",
        headers: [["Link", '<https://example.com>; rel="preconnect"']],
      },
    ]);
  });

  it("skips entries without colons", () => {
    const result = convertHeadersConfig({
      "/*": ["not-a-header", "X-Frame-Options: DENY"],
    });
    expect(result).toEqual([
      {
        pattern: "/*",
        headers: [["X-Frame-Options", "DENY"]],
      },
    ]);
  });

  it("skips patterns with only invalid entries", () => {
    const result = convertHeadersConfig({
      "/assets/*": ["Cache-Control: ok"],
      "/*": ["not-a-header"],
    });
    expect(result).toEqual([
      {
        pattern: "/assets/*",
        headers: [["Cache-Control", "ok"]],
      },
    ]);
  });
});

describe("resolveBindingNames", () => {
  it("returns undefined for no bindings", () => {
    expect(resolveBindingNames(undefined)).toBeUndefined();
  });

  it("returns undefined for boolean-only bindings", () => {
    expect(resolveBindingNames({ db: true, kv: true })).toBeUndefined();
  });

  it("returns custom names for string bindings", () => {
    expect(resolveBindingNames({ db: "MY_DB", kv: true, storage: "BUCKET" })).toEqual({
      d1: "MY_DB",
      r2: "BUCKET",
    });
  });

  it("returns all custom names", () => {
    expect(resolveBindingNames({ db: "D", kv: "K", storage: "S" })).toEqual({
      d1: "D",
      kv: "K",
      r2: "S",
    });
  });
});
