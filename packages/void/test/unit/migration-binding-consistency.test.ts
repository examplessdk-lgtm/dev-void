import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packageBuild, packageFrameworkBuild } from "../../src/cli/package";
import { collectMigrations } from "../../src/migrations/collect";
import { validateMigrations } from "../../src/migrations/validate";
import { inferBindingsFromSource, mergeBindings } from "../../src/inference/walk";
import type { InferredBindings } from "../../src/inference/walk";
import type { MigrationFile } from "../../src/migrations/validate";
import type { DeployManifest } from "../../src/cli/types";
import {
  createMigrationHandler,
  type MigrationResponse,
} from "../../src/runtime/migration-handler";

const TMP = join(import.meta.dirname, ".tmp-migration-binding-test");

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
};

const sampleMigrations: MigrationFile[] = [
  {
    name: "0001_create_users.sql",
    sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);",
    destructive: false,
  },
];

function setupWorkerDir() {
  const workerDir = join(TMP, "worker");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "index.js"), "export default {}");
  return workerDir;
}

function getManifest(form: FormData): DeployManifest {
  return JSON.parse(form.get("manifest") as string);
}

function getMigrationEntries(form: FormData): string[] {
  const keys: string[] = [];
  for (const [key] of form.entries()) {
    if (key.startsWith("migration:")) {
      keys.push(key.slice("migration:".length));
    }
  }
  return keys;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// packageBuild: migration ↔ binding consistency
// ---------------------------------------------------------------------------

describe("packageBuild migration-binding consistency", () => {
  it("includes both d1 binding and migrations when needsD1 is true", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", { ...noBindings, needsD1: true }, sampleMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
    expect(getMigrationEntries(form)).toEqual(["0001_create_users.sql"]);
  });

  it("forces d1 binding when migrations exist even if needsD1 is false", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", noBindings, sampleMigrations);
    const manifest = getManifest(form);

    // Migrations imply a database is needed — d1 binding must be present
    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
    expect(getMigrationEntries(form)).toEqual(["0001_create_users.sql"]);
  });

  it("has no migrations and no d1 binding when both are absent", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", noBindings);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
    expect(getMigrationEntries(form)).toEqual([]);
  });

  it("has no migrations when migrations array is empty", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", noBindings, []);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
    expect(getMigrationEntries(form)).toEqual([]);
  });

  it("has d1 binding but no migrations when needsD1 is true with no migration files", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", { ...noBindings, needsD1: true });
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toBeUndefined();
  });

  it("includes d1 binding when auth forces needsD1 even without explicit D1 usage", () => {
    setupWorkerDir();
    const form = packageBuild(TMP, "worker", { ...noBindings, needsAuth: true }, sampleMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
  });

  it("forces d1 binding when multiple migrations exist without D1 usage", () => {
    setupWorkerDir();
    const migrations: MigrationFile[] = [
      {
        name: "0001_create_users.sql",
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY);",
        destructive: false,
      },
      {
        name: "0002_create_posts.sql",
        sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
        destructive: false,
      },
      {
        name: "0003_add_email.sql",
        sql: "ALTER TABLE users ADD COLUMN email TEXT;",
        destructive: false,
      },
    ];

    const form = packageBuild(TMP, "worker", noBindings, migrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 3 });
    expect(getMigrationEntries(form).sort()).toEqual([
      "0001_create_users.sql",
      "0002_create_posts.sql",
      "0003_add_email.sql",
    ]);
  });

  it("uses custom d1 binding name when provided", () => {
    setupWorkerDir();
    const form = packageBuild(
      TMP,
      "worker",
      { ...noBindings, needsD1: true },
      sampleMigrations,
      /* schedules */ undefined,
      /* ssr */ undefined,
      /* framework */ undefined,
      /* revalidate */ undefined,
      /* vars */ undefined,
      /* queues */ undefined,
      /* prerender */ undefined,
      /* assetConfig */ undefined,
      /* options */ { bindingNames: { d1: "MY_DB" } },
    );
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["MY_DB"]);
  });
});

// ---------------------------------------------------------------------------
// packageBuild: postgresql / hyperdrive variant
// ---------------------------------------------------------------------------

describe("packageBuild postgresql migration-binding consistency", () => {
  it("forces hyperdrive binding when migrations exist with postgresql dialect and needsD1 is false", () => {
    setupWorkerDir();
    const form = packageBuild(
      TMP,
      "worker",
      noBindings,
      sampleMigrations,
      /* schedules */ undefined,
      /* ssr */ undefined,
      /* framework */ undefined,
      /* revalidate */ undefined,
      /* vars */ undefined,
      /* queues */ undefined,
      /* prerender */ undefined,
      /* assetConfig */ undefined,
      /* options */ undefined,
      /* neededAssets */ undefined,
      /* hashedAssetsPrefix */ undefined,
      /* headerRules */ undefined,
      /* redirectRules */ undefined,
      /* dialect */ "postgresql",
    );
    const manifest = getManifest(form);

    // Migrations with postgresql dialect imply hyperdrive is needed
    expect(manifest.bindings.hyperdrive).toEqual(["HYPERDRIVE"]);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: "postgresql", pending: 1 });
  });

  it("includes both hyperdrive binding and migrations when needsD1 is true with postgresql dialect", () => {
    setupWorkerDir();
    const form = packageBuild(
      TMP,
      "worker",
      { ...noBindings, needsD1: true },
      sampleMigrations,
      /* schedules */ undefined,
      /* ssr */ undefined,
      /* framework */ undefined,
      /* revalidate */ undefined,
      /* vars */ undefined,
      /* queues */ undefined,
      /* prerender */ undefined,
      /* assetConfig */ undefined,
      /* options */ undefined,
      /* neededAssets */ undefined,
      /* hashedAssetsPrefix */ undefined,
      /* headerRules */ undefined,
      /* redirectRules */ undefined,
      /* dialect */ "postgresql",
    );
    const manifest = getManifest(form);

    expect(manifest.bindings.hyperdrive).toEqual(["HYPERDRIVE"]);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: "postgresql", pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// packageFrameworkBuild: same consistency requirement
// ---------------------------------------------------------------------------

describe("packageFrameworkBuild migration-binding consistency", () => {
  function setupFrameworkDirs() {
    const workerDir = join(TMP, "server");
    const assetsDir = join(TMP, "public");
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    writeFileSync(join(assetsDir, "index.html"), "<html></html>");
    return { workerDir, assetsDir };
  }

  it("forces d1 binding when migrations exist even if needsD1 is false", () => {
    const { workerDir, assetsDir } = setupFrameworkDirs();
    const form = packageFrameworkBuild({
      frameworkName: "nuxt",
      workerDir,
      workerMain: "index.js",
      assetsDir,
      bindings: noBindings,
      migrations: sampleMigrations,
    });
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
    expect(getMigrationEntries(form)).toEqual(["0001_create_users.sql"]);
  });

  it("includes both d1 binding and migrations when needsD1 is true", () => {
    const { workerDir, assetsDir } = setupFrameworkDirs();
    const form = packageFrameworkBuild({
      frameworkName: "nuxt",
      workerDir,
      workerMain: "index.js",
      assetsDir,
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
    });
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
  });

  it("includes d1 binding via auth even without explicit D1 usage", () => {
    const { workerDir, assetsDir } = setupFrameworkDirs();
    const form = packageFrameworkBuild({
      frameworkName: "nuxt",
      workerDir,
      workerMain: "index.js",
      assetsDir,
      bindings: { ...noBindings, needsAuth: true },
      migrations: sampleMigrations,
    });
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
  });

  it("forces hyperdrive binding when postgresql migrations exist with needsD1 false", () => {
    const { workerDir, assetsDir } = setupFrameworkDirs();
    const form = packageFrameworkBuild({
      frameworkName: "nuxt",
      workerDir,
      workerMain: "index.js",
      assetsDir,
      bindings: noBindings,
      migrations: sampleMigrations,
      dialect: "postgresql",
    });
    const manifest = getManifest(form);

    expect(manifest.bindings.hyperdrive).toEqual(["HYPERDRIVE"]);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: "postgresql", pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// createMigrationHandler: behavior when D1 binding is missing
// ---------------------------------------------------------------------------

describe("createMigrationHandler with missing D1 binding", () => {
  const proxyToken = "test-token-123";

  function makeRequest() {
    return new Request("https://example.com/__void/migrate", {
      method: "POST",
      headers: { "x-void-internal": proxyToken },
    });
  }

  it("returns error when env.DB is undefined", async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      "sqlite",
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("no D1 binding found");
    expect(body.migrations).toEqual([]);
  });

  it("returns error when env.DB is null", async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: null },
      sampleMigrations,
      "sqlite",
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("no D1 binding found");
  });

  it("rejects requests with wrong proxy token", async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      "sqlite",
    );

    const badRequest = new Request("https://example.com/__void/migrate", {
      method: "POST",
      headers: { "x-void-internal": "wrong-token" },
    });
    const response = await handler(badRequest);
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unauthorized");
  });

  it("rejects requests with no proxy token", async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      "sqlite",
    );

    const noAuthRequest = new Request("https://example.com/__void/migrate", {
      method: "POST",
    });
    const response = await handler(noAuthRequest);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: collectMigrations + inference + packageBuild
// ---------------------------------------------------------------------------

describe("end-to-end: D1 removed but migrations remain on disk", () => {
  it("forces d1 binding when user removes D1 usage but keeps migration files", () => {
    // Source code has no void/db imports or env.DB usage
    const sourceCode = `export const GET = defineHandler(() => ({ message: "hello" }));`;
    const bindings = inferBindingsFromSource(sourceCode, "hello.ts");
    expect(bindings.needsD1).toBe(false);

    // But old migration files still exist on disk
    const migrationsDir = join(TMP, "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    );
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(1);
    const validatedMigrations = validateMigrations(rawMigrations);

    // Package build should force d1 binding because migrations exist
    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", bindings, validatedMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
  });

  it("works correctly when D1 usage is still present", () => {
    const sourceCode = `
      import { db } from "void/db";
      export const GET = defineHandler(async () => {
        return db.select().from("users");
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, "users.ts");
    expect(bindings.needsD1).toBe(true);

    const migrationsDir = join(TMP, "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", bindings, validatedMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 1 });
  });

  it("produces clean manifest when both D1 and migrations are removed", () => {
    const sourceCode = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(sourceCode, "health.ts");

    const migrationsDir = join(TMP, "db", "migrations");
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(0);

    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", bindings);
    const manifest = getManifest(form);

    expect(manifest.migrations).toBeUndefined();
    expect(manifest.bindings.d1).toBeUndefined();
  });

  it("forces d1 binding when multiple old migrations remain after removing env.DB", () => {
    const sourceCode = `
      export const GET = defineHandler(async (c) => {
        const data = await fetch("https://api.example.com/users");
        return c.json(await data.json());
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, "users.ts");
    expect(bindings.needsD1).toBe(false);

    const migrationsDir = join(TMP, "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(
      join(migrationsDir, "0002_add_email.sql"),
      "ALTER TABLE users ADD COLUMN email TEXT;",
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", bindings, validatedMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toEqual({ dialect: "sqlite", pending: 2 });
  });

  it("auth-enabled project with leftover migrations stays consistent", () => {
    const authSource = `import { auth } from "void/client"; await auth.signOut();`;
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const merged = mergeBindings([
      inferBindingsFromSource(authSource, "auth.ts"),
      inferBindingsFromSource(routeSource, "health.ts"),
    ]);
    expect(merged.needsAuth).toBe(true);
    expect(merged.needsD1).toBe(false);

    // Simulate deploy.ts behavior: auth forces needsD1
    const effectiveBindings =
      merged.needsAuth && !merged.needsD1 ? { ...merged, needsD1: true } : merged;

    const migrationsDir = join(TMP, "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_auth_tables.sql"),
      "CREATE TABLE auth_users (id TEXT PRIMARY KEY);",
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", effectiveBindings, validatedMigrations);
    const manifest = getManifest(form);

    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations!.pending).toBe(1);
  });

  it("forces d1 binding for non-auth project with leftover migrations", () => {
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(routeSource, "health.ts");
    expect(bindings.needsD1).toBe(false);
    expect(bindings.needsAuth).toBe(false);

    const migrationsDir = join(TMP, "db", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, "0001_create_users.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY);",
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const workerDir = join(TMP, "dist", "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    const distDir = join(TMP, "dist");

    const form = packageBuild(distDir, "worker", bindings, validatedMigrations);
    const manifest = getManifest(form);

    // Migrations should force the d1 binding even without auth or D1 imports
    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations!.pending).toBe(1);
  });
});
