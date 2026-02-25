import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { detectPreset } from "../../src/cli/preset";

const TMP = join(import.meta.dirname, ".tmp-preset");

function setupProject(opts: {
  pkg?: Record<string, unknown>;
  dirs?: string[];
  files?: Record<string, string>;
}): string {
  mkdirSync(TMP, { recursive: true });
  if (opts.pkg) {
    writeFileSync(join(TMP, "package.json"), JSON.stringify(opts.pkg));
  }
  for (const dir of opts.dirs ?? []) {
    mkdirSync(join(TMP, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(TMP, name, ".."), { recursive: true });
    writeFileSync(join(TMP, name), content);
  }
  return TMP;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("detectPreset", () => {
  it("returns explicit dir preset with --dir flag", () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: "public" });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, "public"),
      mode: "ssg",
    });
  });

  it("returns SPA mode when --dir and --spa are combined", () => {
    const root = setupProject({});
    const result = detectPreset(root, { dir: "build", spa: true });
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, "build"),
      mode: "spa",
    });
  });

  it("detects VitePress (root .vitepress)", () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: "^1.0.0" } },
      dirs: [".vitepress"],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: "vitepress build",
      outputDir: resolve(root, ".vitepress/dist"),
      mode: "ssg",
    });
  });

  it("detects VitePress (docs/ subdir)", () => {
    const root = setupProject({
      pkg: { devDependencies: { vitepress: "^1.0.0" } },
      dirs: ["docs/.vitepress"],
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: "vitepress build docs",
      outputDir: resolve(root, "docs/.vitepress/dist"),
      mode: "ssg",
    });
  });

  it("returns null when routes/ dir exists (backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
      dirs: ["routes"],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it("returns null when crons/ dir exists (backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
      dirs: ["crons"],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it("returns null when middleware/ dir exists (backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
      dirs: ["middleware"],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it("returns null when pages/ dir exists (backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
      dirs: ["pages"],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it("returns null when queues/ dir exists (backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
      dirs: ["queues"],
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });

  it("detects plain Vite SPA (no backend files)", () => {
    const root = setupProject({
      pkg: { dependencies: { vite: "^6.0.0" } },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: "vite build",
      outputDir: resolve(root, "dist"),
      mode: "spa",
    });
  });

  it("detects pre-built dist/index.html as SSG", () => {
    const root = setupProject({
      files: { "dist/index.html": "<html></html>" },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: resolve(root, "dist"),
      mode: "ssg",
    });
  });

  it("detects root index.html as SSG", () => {
    const root = setupProject({
      files: { "index.html": "<html></html>" },
    });
    const result = detectPreset(root);
    expect(result).toEqual({
      buildCommand: null,
      outputDir: root,
      mode: "ssg",
    });
  });

  it("returns null when no build tool and no output found", () => {
    const root = setupProject({
      pkg: { name: "empty" },
    });
    const result = detectPreset(root);
    expect(result).toBeNull();
  });
});
