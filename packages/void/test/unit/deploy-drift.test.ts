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
import { afterEach, describe, expect, it } from 'vitest';
import { hasDeploySchemaDrift } from '../../src/cli/deploy.ts';
import { writeDrizzleConfig } from '../../src/drizzle/config.ts';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');
const tempDirs: Array<string> = [];

describe('hasDeploySchemaDrift', () => {
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

function generateMigrations(root: string): void {
  const configPath = writeDrizzleConfig(root, ':memory:');
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
