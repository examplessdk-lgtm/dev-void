import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'pathe';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildVoidManifest, buildFrameworkManifest } from '../../src/cli/package.ts';
import { inferBindingsFromSource, mergeBindings } from '../../src/inference/walk.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';
import { validateMigrations } from '../../src/migrations/validate.ts';
import type { MigrationFile } from '../../src/migrations/validate.ts';
import {
  createMigrationHandler,
  type MigrationResponse,
} from '../../src/runtime/migration-handler.ts';

const TMP = join(import.meta.dirname, '.tmp-migration-binding-test');

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

const sampleMigrations: Array<MigrationFile> = [
  {
    name: '0001_create_users.sql',
    sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    destructive: false,
  },
];

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildVoidManifest: migration ↔ binding consistency
// ---------------------------------------------------------------------------

describe('buildVoidManifest migration-binding consistency', () => {
  it('includes both d1 binding and migrations when needsD1 is true', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('forces d1 binding when migrations exist even if needsD1 is false', () => {
    const manifest = buildVoidManifest({
      bindings: noBindings,
      migrations: sampleMigrations,
    });

    // Migrations imply a database is needed — d1 binding must be present
    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('has no migrations and no d1 binding when both are absent', () => {
    const manifest = buildVoidManifest({ bindings: noBindings });

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
  });

  it('has no migrations when migrations array is empty', () => {
    const manifest = buildVoidManifest({ bindings: noBindings, migrations: [] });

    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toBeUndefined();
  });

  it('has d1 binding but no migrations when needsD1 is true with no migration files', () => {
    const manifest = buildVoidManifest({ bindings: { ...noBindings, needsD1: true } });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toBeUndefined();
  });

  it('includes d1 binding when auth forces needsD1 even without explicit D1 usage', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsAuth: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('forces d1 binding when multiple migrations exist without D1 usage', () => {
    const migrations: Array<MigrationFile> = [
      {
        name: '0001_create_users.sql',
        sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
        destructive: false,
      },
      {
        name: '0002_create_posts.sql',
        sql: 'CREATE TABLE posts (id INTEGER PRIMARY KEY);',
        destructive: false,
      },
      {
        name: '0003_add_email.sql',
        sql: 'ALTER TABLE users ADD COLUMN email TEXT;',
        destructive: false,
      },
    ];

    const manifest = buildVoidManifest({ bindings: noBindings, migrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 3 });
  });

  it('uses custom d1 binding name when provided', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
      options: { bindingNames: { d1: 'MY_DB' } },
    });

    expect(manifest.bindings.d1).toEqual(['MY_DB']);
  });
});

// ---------------------------------------------------------------------------
// buildVoidManifest: postgresql / hyperdrive variant
// ---------------------------------------------------------------------------

describe('buildVoidManifest postgresql migration-binding consistency', () => {
  it('forces hyperdrive binding when migrations exist with postgresql dialect and needsD1 is false', () => {
    const manifest = buildVoidManifest({
      bindings: noBindings,
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    // Migrations with postgresql dialect imply hyperdrive is needed
    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });

  it('includes both hyperdrive binding and migrations when needsD1 is true with postgresql dialect', () => {
    const manifest = buildVoidManifest({
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// buildFrameworkManifest: same consistency requirement
// ---------------------------------------------------------------------------

describe('buildFrameworkManifest migration-binding consistency', () => {
  it('forces d1 binding when migrations exist even if needsD1 is false', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: noBindings,
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('includes both d1 binding and migrations when needsD1 is true', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: { ...noBindings, needsD1: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('includes d1 binding via auth even without explicit D1 usage', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: { ...noBindings, needsAuth: true },
      migrations: sampleMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('forces hyperdrive binding when postgresql migrations exist with needsD1 false', () => {
    const manifest = buildFrameworkManifest({
      frameworkName: 'nuxt',
      workerMain: 'index.js',
      bindings: noBindings,
      migrations: sampleMigrations,
      dialect: 'postgresql',
    });

    expect(manifest.bindings.hyperdrive).toEqual(['HYPERDRIVE']);
    expect(manifest.bindings.d1).toBeUndefined();
    expect(manifest.migrations).toEqual({ dialect: 'postgresql', pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// createMigrationHandler: behavior when D1 binding is missing
// ---------------------------------------------------------------------------

describe('createMigrationHandler with missing D1 binding', () => {
  const proxyToken = 'test-token-123';

  function makeRequest() {
    return new Request('https://example.com/__void/migrate', {
      method: 'POST',
      headers: { 'x-void-internal': proxyToken },
    });
  }

  it('returns error when env.DB is undefined', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no D1 binding found');
    expect(body.migrations).toEqual([]);
  });

  it('returns error when env.DB is null', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken, DB: null },
      sampleMigrations,
      'sqlite',
    );

    const response = await handler(makeRequest());
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no D1 binding found');
  });

  it('rejects requests with wrong proxy token', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const badRequest = new Request('https://example.com/__void/migrate', {
      method: 'POST',
      headers: { 'x-void-internal': 'wrong-token' },
    });
    const response = await handler(badRequest);
    const body = (await response.json()) as MigrationResponse;

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unauthorized');
  });

  it('rejects requests with no proxy token', async () => {
    const handler = createMigrationHandler(
      { __VOID_PROXY_TOKEN: proxyToken },
      sampleMigrations,
      'sqlite',
    );

    const noAuthRequest = new Request('https://example.com/__void/migrate', {
      method: 'POST',
    });
    const response = await handler(noAuthRequest);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: collectMigrations + inference + buildVoidManifest
// ---------------------------------------------------------------------------

describe('end-to-end: D1 removed but migrations remain on disk', () => {
  it('forces d1 binding when user removes D1 usage but keeps migration files', () => {
    // Source code has no void/db imports or env.DB usage
    const sourceCode = `export const GET = defineHandler(() => ({ message: "hello" }));`;
    const bindings = inferBindingsFromSource(sourceCode, 'hello.ts');
    expect(bindings.needsD1).toBe(false);

    // But old migration files still exist on disk
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(1);
    const validatedMigrations = validateMigrations(rawMigrations);

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('works correctly when D1 usage is still present', () => {
    const sourceCode = `
      import { db } from "void/db";
      export const GET = defineHandler(async () => {
        return db.select().from("users");
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, 'users.ts');
    expect(bindings.needsD1).toBe(true);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 1 });
  });

  it('produces clean manifest when both D1 and migrations are removed', () => {
    const sourceCode = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(sourceCode, 'health.ts');

    const migrationsDir = join(TMP, 'db', 'migrations');
    const rawMigrations = collectMigrations(migrationsDir);
    expect(rawMigrations).toHaveLength(0);

    const manifest = buildVoidManifest({ bindings });

    expect(manifest.migrations).toBeUndefined();
    expect(manifest.bindings.d1).toBeUndefined();
  });

  it('forces d1 binding when multiple old migrations remain after removing env.DB', () => {
    const sourceCode = `
      export const GET = defineHandler(async (c) => {
        const data = await fetch("https://api.example.com/users");
        return c.json(await data.json());
      });
    `;
    const bindings = inferBindingsFromSource(sourceCode, 'users.ts');
    expect(bindings.needsD1).toBe(false);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    writeFileSync(
      join(migrationsDir, '0002_add_email.sql'),
      'ALTER TABLE users ADD COLUMN email TEXT;',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations).toEqual({ dialect: 'sqlite', pending: 2 });
  });

  it('auth-enabled project with leftover migrations stays consistent', () => {
    const authSource = `import { auth } from "void/client"; await auth.signOut();`;
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const merged = mergeBindings([
      inferBindingsFromSource(authSource, 'auth.ts'),
      inferBindingsFromSource(routeSource, 'health.ts'),
    ]);
    expect(merged.needsAuth).toBe(true);
    expect(merged.needsD1).toBe(false);

    // Simulate deploy.ts behavior: auth forces needsD1
    const effectiveBindings =
      merged.needsAuth && !merged.needsD1 ? { ...merged, needsD1: true } : merged;

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_auth_tables.sql'),
      'CREATE TABLE auth_users (id TEXT PRIMARY KEY);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({
      bindings: effectiveBindings,
      migrations: validatedMigrations,
    });

    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations!.pending).toBe(1);
  });

  it('forces d1 binding for non-auth project with leftover migrations', () => {
    const routeSource = `export const GET = defineHandler(() => ({ ok: true }));`;
    const bindings = inferBindingsFromSource(routeSource, 'health.ts');
    expect(bindings.needsD1).toBe(false);
    expect(bindings.needsAuth).toBe(false);

    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
      join(migrationsDir, '0001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    );
    const validatedMigrations = validateMigrations(collectMigrations(migrationsDir));

    const manifest = buildVoidManifest({ bindings, migrations: validatedMigrations });

    // Migrations should force the d1 binding even without auth or D1 imports
    expect(manifest.bindings.d1).toEqual(['DB']);
    expect(manifest.migrations!.pending).toBe(1);
  });
});
