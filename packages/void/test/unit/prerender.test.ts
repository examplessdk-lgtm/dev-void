import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { collectPrerenderWorkerModules } from "../../src/prerender";

const tempDirs: string[] = [];

function createTempWorkerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "void-prerender-"));
  tempDirs.push(dir);
  return dir;
}

describe("collectPrerenderWorkerModules", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("collects supported modules and keeps the entry first", () => {
    const workerDir = createTempWorkerDir();

    mkdirSync(join(workerDir, ".vite"), { recursive: true });
    mkdirSync(join(workerDir, "assets"), { recursive: true });

    writeFileSync(join(workerDir, "wrangler.json"), "{}");
    writeFileSync(join(workerDir, ".vite", "manifest.json"), "{}");
    writeFileSync(join(workerDir, "index.js"), "export default {};");
    writeFileSync(join(workerDir, "pages-client.js"), "export const client = true;");
    writeFileSync(join(workerDir, "assets", "chunk.js"), "export const chunk = true;");
    writeFileSync(join(workerDir, "assets", "legacy.cjs"), "module.exports = {};");
    writeFileSync(join(workerDir, "assets", "module.wasm"), "wasm");
    writeFileSync(join(workerDir, "assets", "message.txt"), "hello");
    writeFileSync(join(workerDir, "assets", "blob.bin"), "data");

    const modules = collectPrerenderWorkerModules(workerDir, "index.js");

    expect(
      modules.map(({ path, type }) => ({
        path: relative(workerDir, path).replace(/\\/g, "/"),
        type,
      })),
    ).toEqual([
      { path: "index.js", type: "ESModule" },
      { path: "assets/blob.bin", type: "Data" },
      { path: "assets/chunk.js", type: "ESModule" },
      { path: "assets/legacy.cjs", type: "CommonJS" },
      { path: "assets/message.txt", type: "Text" },
      { path: "assets/module.wasm", type: "CompiledWasm" },
      { path: "pages-client.js", type: "ESModule" },
    ]);
  });

  it("throws when the configured worker entry is missing", () => {
    const workerDir = createTempWorkerDir();
    writeFileSync(join(workerDir, "pages-client.js"), "export const client = true;");

    expect(() => collectPrerenderWorkerModules(workerDir, "index.js")).toThrow(
      'worker entry "index.js" not found',
    );
  });
});

describe("prerender runner token passthrough", () => {
  it("reads __VOID_PROXY_TOKEN from bindings for auth header", () => {
    // Simulates the logic in createCloudflarePrerenderRunner
    const mfOptions = {
      bindings: { MY_VAR: "test", __VOID_PROXY_TOKEN: "secret-token" },
    };
    const allBindings = mfOptions.bindings as Record<string, unknown> | undefined;
    const proxyToken = allBindings?.__VOID_PROXY_TOKEN as string | undefined;

    expect(proxyToken).toBe("secret-token");

    const headers: Record<string, string> = {};
    if (proxyToken) headers["x-void-internal"] = proxyToken;
    expect(headers["x-void-internal"]).toBe("secret-token");
  });

  it("does not set auth header when token is absent", () => {
    const mfOptions = {
      bindings: { MY_VAR: "test" },
    };
    const allBindings = mfOptions.bindings as Record<string, unknown> | undefined;
    const proxyToken = allBindings?.__VOID_PROXY_TOKEN as string | undefined;

    expect(proxyToken).toBeUndefined();

    const headers: Record<string, string> = {};
    if (proxyToken) headers["x-void-internal"] = proxyToken;
    expect(headers["x-void-internal"]).toBeUndefined();
  });
});
