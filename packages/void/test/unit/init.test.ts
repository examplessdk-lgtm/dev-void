import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isScaffoldableEmptyProject, runInitCommand } from "../../src/cli/init";

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "void-init-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("isScaffoldableEmptyProject", () => {
  it("returns true for an empty directory", () => {
    withTempDir((root) => {
      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it("returns true for npm install -D void shape", () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            name: "my-app",
            devDependencies: {
              void: "^0.0.1",
            },
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(join(root, "package-lock.json"), "{}\n");

      expect(isScaffoldableEmptyProject(root)).toBe(true);
    });
  });

  it("returns false when app files already exist", () => {
    withTempDir((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "console.log('x');\n");
      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it("returns false when package has non-void dependencies", () => {
    withTempDir((root) => {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            name: "my-app",
            devDependencies: {
              void: "^0.0.1",
              vite: "^8.0.0",
            },
          },
          null,
          2,
        ) + "\n",
      );

      expect(isScaffoldableEmptyProject(root)).toBe(false);
    });
  });

  it("scaffolds package.json with runtime dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      await runInitCommand(root, {
        tsconfig: true,
        github: false,
        agents: false,
      });

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(pkg.dependencies.vite).toBeDefined();
      expect(pkg.dependencies["void"]).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
