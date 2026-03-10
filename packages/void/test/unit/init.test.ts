import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isScaffoldableEmptyProject, runInitCommand } from "../../src/cli/init";

const mockSelect = vi.fn();
const mockConfirm = vi.fn();

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  confirm: (...args: unknown[]) => mockConfirm(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  isCancel: (value: unknown) => value === Symbol.for("cancel"),
  cancel: vi.fn(),
}));

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "void-init-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  mockSelect.mockReset();
  mockConfirm.mockReset();
});

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

  it("prompts for a database choice and writes pg config when selected", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      mockSelect.mockResolvedValueOnce("postgresql").mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, "void.json"), "utf-8"))).toEqual({
        database: "pg",
      });

      expect(mockSelect).toHaveBeenCalled();
      const databasePrompt = mockSelect.mock.calls[0]?.[0];
      expect(databasePrompt.message).toBe("Choose a database for this project:");
      expect(databasePrompt.options).toEqual([
        {
          value: "sqlite",
          label: "D1 (SQLite) [current]",
          hint: "Zero-config and fully managed by Void; best for prototyping and read-heavy apps.",
        },
        {
          value: "postgresql",
          label: "PostgreSQL",
          hint: "Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the pg config when switching back to implicit sqlite", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      writeFileSync(join(root, "void.json"), JSON.stringify({ database: "pg" }, null, 2) + "\n");
      mockSelect.mockResolvedValueOnce("sqlite").mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(() => readFileSync(join(root, "void.json"), "utf-8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves other void.json fields when switching from pg to sqlite", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      writeFileSync(
        join(root, "void.json"),
        JSON.stringify(
          {
            database: "pg",
            routing: {
              prerender: ["/"],
            },
          },
          null,
          2,
        ) + "\n",
      );
      mockSelect.mockResolvedValueOnce("sqlite").mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(JSON.parse(readFileSync(join(root, "void.json"), "utf-8"))).toEqual({
        routing: {
          prerender: ["/"],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
