import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';

const roots: Array<string> = [];

function createProjectRoot(options?: { schema?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-drizzle-'));
  if (options?.schema !== false) {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db', 'schema.ts'), 'export {};\n');
  }
  roots.push(root);
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('drizzlePlugin db typing generation', () => {
  it('keeps sqlite projects on the D1 internal db entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { DrizzleD1Database } from "void/_db";');
    expect(dts).not.toContain('void/_db-pg');
  });

  it('keeps postgres-only types off the shared db runtime entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'postgresql');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain('export type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain(
      `export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from "void/_db";`,
    );
  });

  it('serves schema imports of void/db from an operator-only virtual module', () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const schemaPath = join(root, 'db', 'schema.ts');
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', schemaPath, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db-schema');

    const code = load.call({}, '\0virtual:void-db-schema');
    expect(code).toContain('export const db = {};');
    expect(code).toContain(
      'export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max }',
    );
    expect(code).not.toContain('requireRuntimeBinding');
  });

  it('can virtualize void/db without a user schema when forced', () => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, 'postgresql', { forceVirtualDb: true });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('NodePgDatabase<Record<string, never>>');
    expect(dts).not.toContain('@schema');

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
    expect(tsconfig.compilerOptions.paths['@schema']).toBeUndefined();

    const code = load.call({}, '\0virtual:void-db');
    expect(code).toContain('import { drizzle } from "');
    expect(code).not.toContain('import * as schema');
    expect(code).toContain('drizzle(getConnectionString())');
  });

  it('can keep void/db off tsconfig paths for metaframeworks that materialize aliases', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite', { redirectDbTypePaths: false });

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toBeUndefined();
    expect(tsconfig.compilerOptions.paths['@schema']).toEqual(['../db/schema.ts']);
  });
});
