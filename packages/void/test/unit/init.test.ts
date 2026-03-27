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

  it("scaffolds a React Pages starter with D1 in an empty directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      mockSelect
        .mockResolvedValueOnce("react")
        .mockResolvedValueOnce("sqlite")
        .mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies["react-dom"]).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.vite).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies.typescript).toBeDefined();
      expect(pkg.devDependencies["@void/react"]).toBeDefined();
      expect(pkg.devDependencies["@types/react"]).toBeDefined();
      expect(pkg.devDependencies["@types/react-dom"]).toBeDefined();

      const reactViteConfig = readFileSync(join(root, "vite.config.ts"), "utf-8");
      expect(reactViteConfig).toContain('from "@void/react/plugin"');
      expect(reactViteConfig).toContain("voidReact()");
      expect(readFileSync(join(root, "pages", "index.tsx"), "utf-8")).toContain("Welcome to Void");
      expect(readFileSync(join(root, "pages", "index.server.ts"), "utf-8")).toContain(
        'import { messages } from "@schema";',
      );
      expect(readFileSync(join(root, "routes", "api", "hello.ts"), "utf-8")).toContain(
        "export const GET = defineHandler",
      );
      expect(readFileSync(join(root, "db", "schema.ts"), "utf-8")).toContain(
        'from "void/schema-d1"',
      );
      expect(readFileSync(join(root, "db", "migrations", "0000_initial.sql"), "utf-8")).toContain(
        "CREATE TABLE IF NOT EXISTS messages",
      );

      expect(() => readFileSync(join(root, "routes", "api", "hello.get.ts"), "utf-8")).toThrow();
      expect(() => readFileSync(join(root, "index.html"), "utf-8")).toThrow();
      expect(() => readFileSync(join(root, "src", "main.ts"), "utf-8")).toThrow();
      expect(() => readFileSync(join(root, "void.json"), "utf-8")).toThrow();

      const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8"));
      expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
      expect(tsconfig.include).toContain("pages");
      expect(tsconfig.include).toContain("db");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scaffolds a Vue Pages starter with PostgreSQL config", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      mockSelect
        .mockResolvedValueOnce("vue")
        .mockResolvedValueOnce("postgresql")
        .mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(pkg.dependencies.vue).toBeDefined();
      expect(pkg.devDependencies["@void/vue"]).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();

      expect(JSON.parse(readFileSync(join(root, "void.json"), "utf-8"))).toEqual({
        database: "pg",
      });

      const vueViteConfig = readFileSync(join(root, "vite.config.ts"), "utf-8");
      expect(vueViteConfig).toContain('from "@void/vue/plugin"');
      expect(vueViteConfig).toContain("voidVue()");
      expect(readFileSync(join(root, "pages", "index.vue"), "utf-8")).toContain("Welcome to Void");
      expect(readFileSync(join(root, "db", "schema.ts"), "utf-8")).toContain(
        'from "void/schema-pg"',
      );
      expect(readFileSync(join(root, "db", "migrations", "0000_initial.sql"), "utf-8")).toContain(
        "SERIAL PRIMARY KEY",
      );

      const frameworkPrompt = mockSelect.mock.calls[0]?.[0];
      expect(frameworkPrompt.message).toBe("Choose a Pages framework to scaffold:");
      expect(frameworkPrompt.options).toEqual([
        {
          value: "react",
          label: "React",
          hint: "TSX Pages starter with the React adapter.",
        },
        {
          value: "vue",
          label: "Vue",
          hint: "Vue SFC Pages starter with the Vue adapter.",
        },
        {
          value: "svelte",
          label: "Svelte",
          hint: "Svelte 5 Pages starter with the Svelte adapter.",
        },
        {
          value: "solid",
          label: "Solid",
          hint: "Fine-grained TSX Pages starter with the Solid adapter.",
        },
      ]);

      const starterPrompt = mockSelect.mock.calls[1]?.[0];
      expect(starterPrompt.message).toBe("Choose a Pages starter:");
      expect(starterPrompt.options).toEqual([
        {
          value: "sqlite",
          label: "D1 (SQLite)",
          hint: "Recommended starter. Scaffolds a DB-backed page, schema, migration, and API route.",
        },
        {
          value: "postgresql",
          label: "PostgreSQL",
          hint: 'Scaffolds the same starter with PostgreSQL and writes "database": "pg" to void.json.',
        },
        {
          value: "static",
          label: "Static Pages",
          hint: "No database or server starter files yet. Good for content sites; add Void features later.",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scaffolds a static Pages starter without database files", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      mockSelect
        .mockResolvedValueOnce("react")
        .mockResolvedValueOnce("static")
        .mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(pkg.dependencies.react).toBeDefined();
      expect(pkg.dependencies["react-dom"]).toBeDefined();
      expect(pkg.dependencies.hono).toBeDefined();
      expect(pkg.devDependencies.void).toBeDefined();
      expect(pkg.devDependencies["@void/react"]).toBeDefined();

      expect(readFileSync(join(root, "pages", "index.tsx"), "utf-8")).toContain(
        "no database or server code yet",
      );

      expect(() => readFileSync(join(root, "pages", "index.server.ts"), "utf-8")).toThrow();
      expect(() => readFileSync(join(root, "routes", "api", "hello.ts"), "utf-8")).toThrow();
      expect(() => readFileSync(join(root, "db", "schema.ts"), "utf-8")).toThrow();
      expect(() =>
        readFileSync(join(root, "db", "migrations", "0000_initial.sql"), "utf-8"),
      ).toThrow();
      expect(() => readFileSync(join(root, "void.json"), "utf-8")).toThrow();
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

  it("removes the pg config when choosing no database yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
      writeFileSync(join(root, "void.json"), JSON.stringify({ database: "pg" }, null, 2) + "\n");
      mockSelect.mockResolvedValueOnce("none").mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false);

      await runInitCommand(root);

      expect(() => readFileSync(join(root, "void.json"), "utf-8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the database prompt to D1 when no database is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "void-init-"));
    try {
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
      mockSelect.mockResolvedValueOnce("none").mockResolvedValueOnce("generic");
      mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runInitCommand(root);

      const databasePrompt = mockSelect.mock.calls[0]?.[0];
      expect(databasePrompt.message).toBe("Choose a database setup for this project:");
      expect(databasePrompt.initialValue).toBe("sqlite");
      expect(databasePrompt.options).toEqual([
        {
          value: "sqlite",
          label: "D1 (SQLite)",
          hint: "Zero-config and fully managed by Void; best for prototyping and read-heavy apps.",
        },
        {
          value: "postgresql",
          label: "PostgreSQL",
          hint: "Bring your own Postgres via Hyperdrive; best for write-heavy apps, complex queries, or existing infra.",
        },
        {
          value: "none",
          label: "No Database Yet",
          hint: "Skip database setup for now. You can add D1 or PostgreSQL later as your app grows.",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
