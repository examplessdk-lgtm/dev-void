import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { toSlash } from "../../src/shared/utils";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = "playground/kitchen-sink";
const DIST = join(ROOT, PLAYGROUND, "dist");

let buildOutput = "";

describe("playground/kitchen-sink build", () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, "dist"), { recursive: true, force: true });
    rmSync(join(pg, ".void"), { recursive: true, force: true });

    const result = spawnSync("pnpm", ["--dir", PLAYGROUND, "build"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    buildOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
  }, 120_000);

  it("emits the SSR worker entry", () => {
    expect(existsSync(join(DIST, "ssr/index.js"))).toBe(true);
  });

  it("does not warn about unexpected Node.js imports", () => {
    expect(buildOutput).not.toContain('Unexpected Node.js imports for environment "ssr"');
    expect(buildOutput).not.toContain("pg-pool");
  });

  it("does not emit deploy-blocking top-level await in env or db runtime chunks", () => {
    const jsFiles = collectFiles(join(DIST, "ssr")).filter((file) => file.endsWith(".js"));
    const runtimeFiles = jsFiles.filter(
      (file) => /\/env-[^/]+\.js$/.test(file) || /\/_virtual_void-db-[^/]+\.js$/.test(file),
    );

    expect(runtimeFiles.length).toBeGreaterThan(0);

    for (const file of runtimeFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("await import(");
    }
  });
});

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = toSlash(join(dir, entry.name));
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}
