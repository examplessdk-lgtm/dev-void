import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateVoidAuthDrizzleSchema } from '../../src/auth/drizzle.ts';
import { getDeploySchemaDriftMessage } from '../../src/cli/deploy-drift.ts';
import { hasDeploySchemaDrift, validateAuthMigrationSchema } from '../../src/cli/deploy.ts';
import { writeDrizzleConfig } from '../../src/drizzle/config.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const tempDirs: Array<string> = [];

/**
 * Wrangler's FULL credential env-var set (canonical names + deprecated `CF_*` aliases),
 * mirroring `WRANGLER_AUTH_CREDENTIAL_ENV_VARS` in deploy.ts.
 */
const WRANGLER_AUTH_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'WRANGLER_R2_SQL_AUTH_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
];

// These cases run real Drizzle processes (up to three per test). Windows CI can take
// over five seconds even when every operation succeeds; keep that budget local to this suite.
const driftTestTimeout = process.platform === 'win32' ? 30_000 : 10_000;
describe('hasDeploySchemaDrift', { timeout: driftTestTimeout }, () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns false when schema and migrations are already in sync', () => {
    const root = createTempApp();
    writeSqliteSchema(root);
    generateMigrations(root);

    const before = snapshotDir(join(root, 'db', 'migrations'));

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(false);
    expect(snapshotDir(join(root, 'db', 'migrations'))).toEqual(before);
    expect(existsSync(join(root, '.void', 'deploy-drift-check'))).toBe(false);
  });

  it('returns true for schema drift without mutating db/migrations', () => {
    const root = createTempApp();
    writeSqliteSchema(root);
    generateMigrations(root);

    const migrationsDir = join(root, 'db', 'migrations');
    const before = snapshotDir(migrationsDir);

    writeSqliteSchema(root, { includeEmail: true });

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(true);
    expect(snapshotDir(migrationsDir)).toEqual(before);
    expect(existsSync(join(root, '.void', 'deploy-drift-check'))).toBe(false);
  });

  it('keeps generated Better Auth tables in the deploy drift check', () => {
    const root = createTempApp();
    writeSqliteSchema(root);
    writeAuthSchema(root);
    generateMigrations(root, { includeAuth: true });

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(false);
    expect(existsSync(join(root, '.void', 'deploy-drift-check'))).toBe(false);
  });

  it('checks auth-only migration history without requiring an application schema', () => {
    const root = createTempApp();
    writeAuthSchema(root);
    generateMigrations(root, { includeAuth: true });

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(false);

    writeAuthSchema(root, { includeDisplayName: true });
    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(true);
  });

  it('generates SQL that satisfies the production Better Auth deploy gate', async () => {
    const root = createTempApp();
    const outDir = join(root, '.void');
    mkdirSync(outDir, { recursive: true });
    const generated = generateVoidAuthDrizzleSchema({
      dialect: 'sqlite',
      providers: ['email'],
    }).replace('"void/schema-d1"', '"drizzle-orm/sqlite-core"');
    writeFileSync(join(outDir, 'better-auth-schema.ts'), generated);

    generateMigrations(root, { includeAuth: true });

    const migrations = collectMigrations(join(root, 'db', 'migrations'));
    expect(migrations).toHaveLength(1);
    expect(migrations[0].sql).toContain('CREATE TABLE `user`');
    expect(migrations[0].sql).toContain('CREATE TABLE `session`');
    await expect(validateAuthMigrationSchema(root, migrations)).resolves.toBeUndefined();
    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(false);
  });

  it('spawns drizzle-kit without any wrangler auth credential (it loads user schema code)', () => {
    const root = createTempApp();
    const leakFile = join(root, 'leaked-env.json');
    // drizzle-kit imports the user's schema module, so this side effect runs inside the
    // child and records exactly what it can read. Generating migrations authenticates
    // against nothing, so none of these may be visible.
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      [
        'import { writeFileSync } from "node:fs";',
        'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
        '',
        `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
        ...WRANGLER_AUTH_VARS.map(
          (name) => `  ${name}: process.env[${JSON.stringify(name)}] ?? null,`,
        ),
        '}));',
        '',
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey({ autoIncrement: true }),',
        '  name: text("name").notNull(),',
        '});',
        '',
      ].join('\n'),
    );

    const saved: Record<string, string | undefined> = {};
    for (const name of WRANGLER_AUTH_VARS) {
      saved[name] = process.env[name];
      process.env[name] = `secret-${name}`;
    }
    try {
      // The managed path reaches this helper too, and never loads the provision module —
      // so this also proves the scrub does not depend on that module being present.
      hasDeploySchemaDrift(root, 'sqlite');
      const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as Record<string, string | null>;
      for (const name of WRANGLER_AUTH_VARS) {
        expect(leaked[name]).toBeNull();
      }
    } finally {
      for (const name of WRANGLER_AUTH_VARS) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    }
  });

  it('explains how to add Drizzle metadata when SQL migrations have none', () => {
    const root = createTempApp();
    writeSqliteSchema(root);
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'migrations', '001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);\n',
    );

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(true);

    const message = getDeploySchemaDriftMessage(root);
    expect(message).toContain('db/migrations/ has SQL migrations without Drizzle metadata');
    expect(message).toContain('`void db generate` cannot fix this');
    expect(message).toContain('scratch copy');
    expect(message).toContain('meta/_journal.json');
    expect(message).not.toContain('Run `void db generate`, review');
  });

  it('keeps the generate advice when Drizzle metadata exists', () => {
    const root = createTempApp();
    writeSqliteSchema(root);
    generateMigrations(root);
    writeSqliteSchema(root, { includeEmail: true });

    expect(hasDeploySchemaDrift(root, 'sqlite')).toBe(true);
    expect(getDeploySchemaDriftMessage(root)).toContain(
      'Run `void db generate`, review the generated migration',
    );
  });

  it('throws when drizzle-kit cannot evaluate the schema', () => {
    const root = createTempApp();
    writeFileSync(
      join(root, 'db', 'schema.ts'),
      [
        'import { missingTable } from "missing-drizzle-schema-package";',
        '',
        'export const users = missingTable("users");',
        '',
      ].join('\n'),
    );

    expect(() => hasDeploySchemaDrift(root, 'sqlite')).toThrow(
      'Failed to check Drizzle schema drift during deploy.',
    );
    expect(existsSync(join(root, '.void', 'deploy-drift-check'))).toBe(false);
  });
});

function createTempApp(): string {
  const root = mkdtempSync(join(packageRoot, '.tmp-deploy-drift-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'db'), { recursive: true });
  return root;
}

function writeSqliteSchema(root: string, options?: { includeEmail?: boolean }): void {
  const extraColumn = options?.includeEmail ? '  email: text("email"),\n' : '';
  writeFileSync(
    join(root, 'db', 'schema.ts'),
    [
      'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
      '',
      'export const users = sqliteTable("users", {',
      '  id: integer("id").primaryKey({ autoIncrement: true }),',
      '  name: text("name").notNull(),',
      extraColumn.trimEnd(),
      '});',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function writeAuthSchema(root: string, options?: { includeDisplayName?: boolean }): void {
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const extraColumn = options?.includeDisplayName ? '  displayName: text("display_name"),\n' : '';
  writeFileSync(
    join(outDir, 'better-auth-schema.ts'),
    [
      'import { sqliteTable, text } from "drizzle-orm/sqlite-core";',
      '',
      'export const user = sqliteTable("user", {',
      '  id: text("id").primaryKey().notNull(),',
      extraColumn.trimEnd(),
      '});',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function generateMigrations(root: string, options?: { includeAuth?: boolean }): void {
  const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
  const configPath = writeDrizzleConfig(root, ':memory:', 'sqlite', {
    additionalSchemas: options?.includeAuth ? [authSchemaPath] : undefined,
  });
  execFileSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    stdio: 'pipe',
  });
}

function snapshotDir(root: string): Record<string, string> {
  if (!existsSync(root)) {
    return {};
  }

  const snapshot: Record<string, string> = {};
  collectFiles(root, root, snapshot);
  return snapshot;
}

function collectFiles(current: string, root: string, snapshot: Record<string, string>): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, root, snapshot);
      continue;
    }
    snapshot[relative(root, fullPath)] = readFileSync(fullPath, 'utf-8');
  }
}
