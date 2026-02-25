import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

import { runGenCommand } from "../../src/cli/gen";

const mockSelect = vi.fn();

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  select: (...args: unknown[]) => mockSelect(...args),
  isCancel: (v: unknown) => v === Symbol.for("cancel"),
  cancel: vi.fn(),
}));

const TMP = join(import.meta.dirname, ".tmp-gen-test");

function read(path: string): string {
  return readFileSync(join(TMP, path), "utf-8");
}

function writePkg(deps: Record<string, string>): void {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "package.json"), JSON.stringify({ dependencies: deps }));
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mockSelect.mockReset();
});

// ---------------------------------------------------------------------------
// gen model
// ---------------------------------------------------------------------------

describe("gen model", () => {
  it("generates migration with correct SQL", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [
        { name: "title", type: "string", nullable: false },
        { name: "body", type: "text", nullable: false },
        { name: "published", type: "boolean", nullable: false },
      ],
    });

    const sql = read("migrations/001_create_posts.sql");
    expect(sql).toBe(
      `CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`,
    );
  });

  it("maps all column types correctly in migration", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "t",
      columns: [
        { name: "a", type: "string", nullable: false },
        { name: "b", type: "text", nullable: false },
        { name: "c", type: "datetime", nullable: false },
        { name: "d", type: "integer", nullable: false },
        { name: "e", type: "boolean", nullable: false },
        { name: "f", type: "real", nullable: false },
        { name: "g", type: "blob", nullable: false },
      ],
    });

    const sql = read("migrations/001_create_t.sql");
    expect(sql).toContain("a TEXT NOT NULL");
    expect(sql).toContain("b TEXT NOT NULL");
    expect(sql).toContain("c TEXT NOT NULL");
    expect(sql).toContain("d INTEGER NOT NULL");
    expect(sql).toContain("e INTEGER NOT NULL");
    expect(sql).toContain("f REAL NOT NULL");
    expect(sql).toContain("g BLOB NOT NULL");
  });

  it("handles nullable columns in migration", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [{ name: "bio", type: "text", nullable: true }],
    });

    const sql = read("migrations/001_create_posts.sql");
    expect(sql).toContain("  bio TEXT,");
    expect(sql).not.toContain("bio TEXT NOT NULL");
  });

  it("generates index route with GET and POST", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [
        { name: "title", type: "string", nullable: false },
        { name: "body", type: "text", nullable: false },
      ],
    });

    const route = read("routes/api/posts/index.ts");
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain('import { defineHandler } from "void"');
    expect(route).toContain('import { db } from "void/db"');
    expect(route).toContain("export const GET = defineHandler");
    expect(route).toContain('db.list("posts")');
    expect(route).toContain("export const POST = defineHandler.withValidator");
    expect(route).toContain("title: v.string()");
    expect(route).toContain("body: v.string()");
    expect(route).toContain('db.insert("posts", { title: body.title, body: body.body })');
  });

  it("generates index route without validator when no columns", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "events",
      columns: [],
    });

    const route = read("routes/api/events/index.ts");
    expect(route).not.toContain("valibot");
    expect(route).not.toContain("withValidator");
    expect(route).toContain('db.list("events")');
    expect(route).toContain('db.insert("events", {})');

    // [id] route is still generated even with no columns
    const idRoute = read("routes/api/events/[id].ts");
    expect(idRoute).toContain("params: v.object({ id: v.string() })");
    expect(idRoute).toContain('db.get("events"');

    // db.d.ts is still regenerated
    const dts = read(".void/db.d.ts");
    expect(dts).toContain("export {}");
    expect(dts).toContain("events:");
  });

  it("generates [id] route with 404 handling", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [{ name: "title", type: "string", nullable: false }],
    });

    const route = read("routes/api/posts/[id].ts");
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain("params: v.object({ id: v.string() })");
    expect(route).toContain('db.get("posts", { where: { id: Number(params.id) } })');
    expect(route).toContain('new Response("Not found", { status: 404 })');
  });

  it("uses correct valibot types for each column type", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "t",
      columns: [
        { name: "a", type: "string", nullable: false },
        { name: "b", type: "integer", nullable: false },
        { name: "c", type: "boolean", nullable: false },
        { name: "d", type: "real", nullable: false },
        { name: "e", type: "blob", nullable: false },
        { name: "f", type: "text", nullable: true },
      ],
    });

    const route = read("routes/api/t/index.ts");
    expect(route).toContain("a: v.string()");
    expect(route).toContain("b: v.number()");
    expect(route).toContain("c: v.boolean()");
    expect(route).toContain("d: v.number()");
    expect(route).toContain("e: v.instance(Blob)");
    expect(route).toContain("f: v.optional(v.string())");
  });

  it("regenerates db.d.ts with correct augmentation structure", async () => {
    writePkg({ valibot: "^1.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [{ name: "title", type: "string", nullable: false }],
    });

    const dts = read(".void/db.d.ts");
    // export {} is critical for augmentation semantics (vs ambient declaration)
    expect(dts).toContain("export {}");
    expect(dts).toContain('declare module "void/db"');
    expect(dts).toContain("interface DbTables");
    expect(dts).toContain("interface DbInsertTables");
    expect(dts).toContain("posts:");
    expect(dts).toContain("title: string;");
    expect(dts).toContain("id: number;");
    // id and created_at should be optional in DbInsertTables (PK/default)
    expect(dts).toContain("id?: number;");
    expect(dts).toContain("created_at");
  });

  it("auto-numbers migration after existing ones", async () => {
    writePkg({ valibot: "^1.0.0" });
    mkdirSync(join(TMP, "migrations"), { recursive: true });
    writeFileSync(join(TMP, "migrations/001_create_users.sql"), "CREATE TABLE users (id INTEGER);");
    writeFileSync(join(TMP, "migrations/002_add_email.sql"), "ALTER TABLE users ADD email TEXT;");

    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [],
    });

    expect(existsSync(join(TMP, "migrations/003_create_posts.sql"))).toBe(true);
  });

  it("skips existing files without overwriting", async () => {
    writePkg({ valibot: "^1.0.0" });
    const routePath = join(TMP, "routes/api/posts/index.ts");
    mkdirSync(join(TMP, "routes/api/posts"), { recursive: true });
    writeFileSync(routePath, "existing content");

    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [],
    });

    expect(readFileSync(routePath, "utf-8")).toBe("existing content");
  });

  it("generates zod routes when zod is in package.json", async () => {
    writePkg({ zod: "^3.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [
        { name: "title", type: "string", nullable: false },
        { name: "count", type: "integer", nullable: false },
        { name: "published", type: "boolean", nullable: false },
        { name: "data", type: "blob", nullable: false },
        { name: "bio", type: "text", nullable: true },
      ],
    });

    const index = read("routes/api/posts/index.ts");
    expect(index).toContain('import { z } from "zod"');
    expect(index).toContain("title: z.string()");
    expect(index).toContain("count: z.number()");
    expect(index).toContain("published: z.boolean()");
    expect(index).toContain("data: z.instanceof(Blob)");
    expect(index).toContain("bio: z.string().optional()");
    expect(index).toContain("defineHandler.withValidator");
    expect(index).toContain("z.object(");
    expect(index).not.toContain("valibot");

    const idRoute = read("routes/api/posts/[id].ts");
    expect(idRoute).toContain('import { z } from "zod"');
    expect(idRoute).toContain("z.object({ id: z.string() })");
    expect(idRoute).not.toContain("valibot");
  });

  it("generates arktype routes when arktype is in package.json", async () => {
    writePkg({ arktype: "^2.0.0" });
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [
        { name: "title", type: "string", nullable: false },
        { name: "count", type: "integer", nullable: false },
        { name: "published", type: "boolean", nullable: false },
        { name: "data", type: "blob", nullable: false },
        { name: "bio", type: "text", nullable: true },
      ],
    });

    const index = read("routes/api/posts/index.ts");
    expect(index).toContain('import { type } from "arktype"');
    expect(index).toContain('title: "string"');
    expect(index).toContain('count: "number"');
    expect(index).toContain('published: "boolean"');
    expect(index).toContain('data: "instanceof Blob"');
    expect(index).toContain('bio: "string | undefined"');
    expect(index).toContain("defineHandler.withValidator");
    expect(index).not.toContain("valibot");
    expect(index).not.toContain("zod");

    const idRoute = read("routes/api/posts/[id].ts");
    expect(idRoute).toContain('import { type } from "arktype"');
    expect(idRoute).toContain('type({ id: "string" })');
  });

  it("generates routes without validation when none selected", async () => {
    mockSelect.mockResolvedValueOnce("none");
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [
        { name: "title", type: "string", nullable: false },
        { name: "body", type: "text", nullable: false },
      ],
    });

    const index = read("routes/api/posts/index.ts");
    expect(index).not.toContain("valibot");
    expect(index).not.toContain("zod");
    expect(index).not.toContain("arktype");
    expect(index).not.toContain("withValidator");
    expect(index).toContain("c.req.json()");
    expect(index).toContain('db.insert("posts"');

    const idRoute = read("routes/api/posts/[id].ts");
    expect(idRoute).not.toContain("valibot");
    expect(idRoute).not.toContain("withValidator");
    expect(idRoute).toContain('c.req.param("id")');
    expect(idRoute).toContain('db.get("posts"');
    expect(idRoute).toContain("Number(id)");
  });

  it("prompts when no validator found in package.json", async () => {
    writePkg({ react: "^19.0.0" });
    mockSelect.mockResolvedValueOnce("zod");
    await runGenCommand(TMP, {
      subcommand: "model",
      name: "posts",
      columns: [{ name: "title", type: "string", nullable: false }],
    });

    expect(mockSelect).toHaveBeenCalledOnce();
    const index = read("routes/api/posts/index.ts");
    expect(index).toContain('import { z } from "zod"');
  });

  it("exits when user cancels validator prompt", async () => {
    mockSelect.mockResolvedValueOnce(Symbol.for("cancel"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        runGenCommand(TMP, {
          subcommand: "model",
          name: "posts",
          columns: [],
        }),
      ).rejects.toThrow("process.exit");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// gen migration
// ---------------------------------------------------------------------------

describe("gen migration", () => {
  it("generates numbered migration file", async () => {
    await runGenCommand(TMP, { subcommand: "migration", name: "add_avatar_to_users" });

    const sql = read("migrations/001_add_avatar_to_users.sql");
    expect(sql).toBe("-- add_avatar_to_users\n");
  });

  it("auto-numbers with zero-padded prefix after existing migrations", async () => {
    mkdirSync(join(TMP, "migrations"), { recursive: true });
    writeFileSync(join(TMP, "migrations/005_something.sql"), "");

    await runGenCommand(TMP, { subcommand: "migration", name: "another" });

    expect(existsSync(join(TMP, "migrations/006_another.sql"))).toBe(true);
    // Verify padding — "6_another.sql" should not exist
    expect(existsSync(join(TMP, "migrations/6_another.sql"))).toBe(false);
  });

  it("ignores seed.sql for numbering", async () => {
    mkdirSync(join(TMP, "migrations"), { recursive: true });
    writeFileSync(join(TMP, "migrations/seed.sql"), "");

    await runGenCommand(TMP, { subcommand: "migration", name: "first" });

    expect(existsSync(join(TMP, "migrations/001_first.sql"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gen route
// ---------------------------------------------------------------------------

describe("gen route", () => {
  it("generates route with default GET handler", async () => {
    await runGenCommand(TMP, {
      subcommand: "route",
      path: "api/health",
      methods: ["get"],
    });

    const content = read("routes/api/health.ts");
    expect(content).toContain('import { defineHandler } from "void"');
    expect(content).toContain("export const GET = defineHandler");
    expect(content).toContain('"GET api/health"');
    expect(content).not.toContain("export const POST");
  });

  it("generates route with multiple methods and no extras", async () => {
    await runGenCommand(TMP, {
      subcommand: "route",
      path: "api/users",
      methods: ["get", "post", "delete"],
    });

    const content = read("routes/api/users.ts");
    expect(content).toContain("export const GET = defineHandler");
    expect(content).toContain("export const POST = defineHandler");
    expect(content).toContain("export const DELETE = defineHandler");
    expect(content).toContain('"GET api/users"');
    expect(content).toContain('"POST api/users"');
    expect(content).toContain('"DELETE api/users"');
    // Should not contain methods that weren't requested
    expect(content).not.toContain("export const PUT");
    expect(content).not.toContain("export const PATCH");
  });

  it("generates PUT and PATCH methods", async () => {
    await runGenCommand(TMP, {
      subcommand: "route",
      path: "api/items",
      methods: ["put", "patch"],
    });

    const content = read("routes/api/items.ts");
    expect(content).toContain("export const PUT = defineHandler");
    expect(content).toContain("export const PATCH = defineHandler");
    expect(content).not.toContain("export const GET");
  });

  it("creates nested directory structure", async () => {
    await runGenCommand(TMP, {
      subcommand: "route",
      path: "api/v2/users/profile",
      methods: ["get"],
    });

    expect(existsSync(join(TMP, "routes/api/v2/users/profile.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gen middleware
// ---------------------------------------------------------------------------

describe("gen middleware", () => {
  it("generates numbered middleware file", async () => {
    await runGenCommand(TMP, { subcommand: "middleware", name: "auth" });

    const content = read("middleware/01.auth.ts");
    expect(content).toContain('import { defineMiddleware } from "void"');
    expect(content).toContain("export default defineMiddleware");
    expect(content).toContain("await next()");
    expect(content).toContain("implement auth middleware");
  });

  it("auto-numbers after existing middleware with correct content", async () => {
    mkdirSync(join(TMP, "middleware"), { recursive: true });
    writeFileSync(join(TMP, "middleware/01.logger.ts"), "");
    writeFileSync(join(TMP, "middleware/02.cors.ts"), "");

    await runGenCommand(TMP, { subcommand: "middleware", name: "auth" });

    expect(existsSync(join(TMP, "middleware/03.auth.ts"))).toBe(true);
    const content = read("middleware/03.auth.ts");
    expect(content).toContain("defineMiddleware");
    expect(content).toContain("await next()");
    expect(content).toContain("implement auth middleware");
  });
});

// ---------------------------------------------------------------------------
// gen ssr
// ---------------------------------------------------------------------------

describe("gen ssr", () => {
  it("generates React SSR files", async () => {
    await runGenCommand(TMP, { subcommand: "ssr", framework: "react" });

    const ssr = read("src/main.ssr.tsx");
    expect(ssr).toContain('import { renderToString } from "react-dom/server"');
    expect(ssr).toContain('import { defineRender } from "void"');
    expect(ssr).toContain("export default defineRender");

    const client = read("src/main.client.tsx");
    expect(client).toContain('import { hydrateRoot } from "react-dom/client"');

    const app = read("src/App.tsx");
    expect(app).toContain('import { useState } from "react"');
    expect(app).toContain("export default function App");
  });

  it("generates Vue SSR files", async () => {
    await runGenCommand(TMP, { subcommand: "ssr", framework: "vue" });

    const ssr = read("src/main.ssr.ts");
    expect(ssr).toContain('import { createSSRApp } from "vue"');
    expect(ssr).toContain('import { renderToString } from "vue/server-renderer"');

    const client = read("src/main.client.ts");
    expect(client).toContain('import { createSSRApp } from "vue"');
    expect(client).toContain('app.mount("#app")');

    const app = read("src/App.vue");
    expect(app).toContain("<script setup lang");
    expect(app).toContain("<template>");
  });

  it("generates Svelte SSR files", async () => {
    await runGenCommand(TMP, { subcommand: "ssr", framework: "svelte" });

    const ssr = read("src/main.ssr.ts");
    expect(ssr).toContain('import { render } from "svelte/server"');

    const client = read("src/main.client.ts");
    expect(client).toContain('import { hydrate } from "svelte"');

    const app = read("src/App.svelte");
    expect(app).toContain("$state(0)");
  });

  it("generates Solid SSR files", async () => {
    await runGenCommand(TMP, { subcommand: "ssr", framework: "solid" });

    const ssr = read("src/main.ssr.tsx");
    expect(ssr).toContain('import { renderToString } from "solid-js/web"');

    const client = read("src/main.client.tsx");
    expect(client).toContain('import { hydrate } from "solid-js/web"');

    const app = read("src/App.tsx");
    expect(app).toContain('import { createSignal } from "solid-js"');
    expect(app).toContain("count()");
  });

  it("auto-detects React from package.json", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );

    await runGenCommand(TMP, { subcommand: "ssr", framework: undefined });

    expect(existsSync(join(TMP, "src/main.ssr.tsx"))).toBe(true);
    expect(read("src/main.ssr.tsx")).toContain("react-dom/server");
  });

  it("auto-detects Vue from package.json devDependencies", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ devDependencies: { vue: "^3.0.0" } }),
    );

    await runGenCommand(TMP, { subcommand: "ssr", framework: undefined });

    expect(read("src/main.ssr.ts")).toContain("vue/server-renderer");
  });

  it("does not overwrite existing SSR files", async () => {
    mkdirSync(join(TMP, "src"), { recursive: true });
    writeFileSync(join(TMP, "src/App.tsx"), "// my custom App");

    await runGenCommand(TMP, { subcommand: "ssr", framework: "react" });

    expect(readFileSync(join(TMP, "src/App.tsx"), "utf-8")).toBe("// my custom App");
    // main.ssr.tsx and main.client.tsx are still created since they didn't exist
    expect(existsSync(join(TMP, "src/main.ssr.tsx"))).toBe(true);
    expect(existsSync(join(TMP, "src/main.client.tsx"))).toBe(true);
  });

  it("exits when no package.json and no framework flag", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(runGenCommand(TMP, { subcommand: "ssr", framework: undefined })).rejects.toThrow(
        "process.exit",
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits when package.json has no supported framework", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ dependencies: { angular: "^17.0.0" } }),
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(runGenCommand(TMP, { subcommand: "ssr", framework: undefined })).rejects.toThrow(
        "process.exit",
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// gen cron
// ---------------------------------------------------------------------------

describe("gen cron", () => {
  it("generates cron job file with defineScheduled", async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: "cron", name: "hourly-sync" });

    const content = read("crons/hourly-sync.ts");
    expect(content).toContain('import { defineScheduled } from "void"');
    expect(content).toContain('export const cron = "* * * * *"');
    expect(content).toContain("export default defineScheduled(");
    expect(content).toContain("// TODO: implement hourly-sync");
  });

  it("does not overwrite existing file", async () => {
    mkdirSync(join(TMP, "crons"), { recursive: true });
    writeFileSync(join(TMP, "crons/sync.ts"), "// existing");

    await runGenCommand(TMP, { subcommand: "cron", name: "sync" });

    expect(read("crons/sync.ts")).toBe("// existing");
  });
});

// ---------------------------------------------------------------------------
// gen queue
// ---------------------------------------------------------------------------

describe("gen queue", () => {
  it("generates queue consumer file with defineQueue", async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: "queue", name: "emails" });

    const content = read("queues/emails.ts");
    expect(content).toContain('import { defineQueue } from "void"');
    expect(content).toContain("interface Message {}");
    expect(content).toContain("// export const maxBatchSize = 10;");
    expect(content).toContain("// export const maxBatchTimeout = 5;");
    expect(content).toContain("export default defineQueue<Message>(");
    expect(content).toContain("batch.messages");
  });

  it("does not overwrite existing file", async () => {
    mkdirSync(join(TMP, "queues"), { recursive: true });
    writeFileSync(join(TMP, "queues/emails.ts"), "// existing");

    await runGenCommand(TMP, { subcommand: "queue", name: "emails" });

    expect(read("queues/emails.ts")).toBe("// existing");
  });
});
