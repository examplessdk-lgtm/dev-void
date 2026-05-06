import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { getMiniflareDatabasePath } from '../../src/migrations/runner.ts';
import { migrationPlugin } from '../../src/plugin-migration.ts';

const roots: Array<string> = [];
type HookWithHandler<T> = { handler: T };
type ConfigureServerHook =
  | ((server: unknown) => Promise<void> | void)
  | HookWithHandler<(server: unknown) => Promise<void> | void>;

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-migrations-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, '001_create_users.sql'),
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runConfigureServer(plugin: ReturnType<typeof migrationPlugin>) {
  const hook = plugin.configureServer as ConfigureServerHook | undefined;
  if (!hook) {
    return;
  }
  if (typeof hook === 'function') {
    await hook.call({}, {});
    return;
  }
  await hook.handler.call({}, {});
}

describe('migrationPlugin persistence roots', () => {
  it('uses .void by default', async () => {
    const root = createProjectRoot();
    const plugin = migrationPlugin(root, 'sqlite');

    await runConfigureServer(plugin);

    const dbPath = getMiniflareDatabasePath(join(root, '.void'), 'local');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('supports custom persist root for framework mode', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, '.wrangler', 'state');
    const plugin = migrationPlugin(root, 'sqlite', 'local', persistRoot);

    await runConfigureServer(plugin);

    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    expect(existsSync(dbPath)).toBe(true);
  });
});
