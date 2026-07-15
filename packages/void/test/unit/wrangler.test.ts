import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { join } from 'pathe';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  LATEST_KNOWN_COMPAT_DATE,
  readExistingLiveBindingConfig,
  readWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  writeProvisionedWranglerConfig,
} from '../../src/cli/wrangler.ts';
import type { VoidConfig } from '../../src/config.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';

const tmpDir = join(import.meta.dirname, '.tmp-wrangler-test');

function setup(filename: string, content: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, filename), content);
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readWranglerCompat', () => {
  it('resolves the latest known-good compatibility date without writing void.json', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
  });

  it('reads from wrangler.json', () => {
    setup(
      'wrangler.json',
      JSON.stringify({
        name: 'test',
        compatibility_date: '2026-02-24',
        compatibility_flags: ['nodejs_compat'],
      }),
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('reads from wrangler.jsonc with comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  // This is a comment
  "name": "test",
  "compatibility_date": "2026-02-24",
  /* Multi-line
     comment */
  "compatibility_flags": [
    "nodejs_compat",
    "nodejs_als"
  ]
}`,
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat', 'nodejs_als'],
    });
  });

  it('reads from wrangler.jsonc with trailing commas', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "test",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": [
    "nodejs_compat",
  ],
  "assets": {
    "directory": "dist/client",
  },
}`,
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('prefers wrangler.jsonc over wrangler.json', () => {
    setup('wrangler.jsonc', '{ "compatibility_date": "2026-01-01" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "compatibility_date": "2025-01-01" }');
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-01-01',
    });
  });

  it('uses the default when fields are missing from wrangler config', () => {
    setup('wrangler.json', '{ "name": "test" }');
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
  });

  it('handles strings containing // without stripping them', () => {
    setup(
      'wrangler.jsonc',
      `{
  // real comment
  "compatibility_date": "2026-02-24",
  "name": "my-app"
}`,
    );
    const result = readWranglerCompat(tmpDir);
    expect(result.compatibilityDate).toBe('2026-02-24');
  });

  it('void.json overrides wrangler.jsonc date', () => {
    setup('wrangler.jsonc', '{ "compatibility_date": "2025-01-01" }');
    const config: VoidConfig = { worker: { compatibility_date: '2026-06-01' } };
    expect(readWranglerCompat(tmpDir, config)).toEqual({
      compatibilityDate: '2026-06-01',
    });
  });

  it('void.json overrides wrangler.jsonc flags', () => {
    setup(
      'wrangler.jsonc',
      '{ "compatibility_date": "2026-01-01", "compatibility_flags": ["nodejs_compat"] }',
    );
    const config: VoidConfig = {
      worker: { compatibility_flags: ['nodejs_compat', 'nodejs_als'] },
    };
    const result = readWranglerCompat(tmpDir, config);
    expect(result.compatibilityFlags).toEqual(['nodejs_compat', 'nodejs_als']);
  });

  it('void.json date used when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const config: VoidConfig = { worker: { compatibility_date: '2026-03-15' } };
    expect(readWranglerCompat(tmpDir, config)).toEqual({
      compatibilityDate: '2026-03-15',
    });
  });

  it('throws on invalid date format in wrangler config', () => {
    setup('wrangler.json', '{ "compatibility_date": "not-a-date" }');
    expect(() => readWranglerCompat(tmpDir)).toThrow('YYYY-MM-DD format');
  });

  it('throws on partial date format in wrangler config', () => {
    setup('wrangler.json', '{ "compatibility_date": "2026-02" }');
    expect(() => readWranglerCompat(tmpDir)).toThrow('YYYY-MM-DD format');
  });

  it('falls back to build output wrangler.json when no project config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-03-29',
        compatibility_flags: ['nodejs_als'],
      }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-03-29',
      compatibilityFlags: ['nodejs_als'],
    });
  });

  it('project wrangler.json takes priority over build output', () => {
    setup(
      'wrangler.json',
      JSON.stringify({
        compatibility_date: '2026-04-01',
        compatibility_flags: ['nodejs_compat'],
      }),
    );
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-03-29',
        compatibility_flags: ['nodejs_als'],
      }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('void.json takes priority over both project and build output', () => {
    setup(
      'wrangler.json',
      JSON.stringify({ compatibility_date: '2026-01-01', compatibility_flags: ['flag_a'] }),
    );
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_date: '2026-02-01', compatibility_flags: ['flag_b'] }),
    );
    const config: VoidConfig = {
      worker: { compatibility_date: '2026-06-01', compatibility_flags: ['flag_c'] },
    };
    expect(readWranglerCompat(tmpDir, config, buildDir)).toEqual({
      compatibilityDate: '2026-06-01',
      compatibilityFlags: ['flag_c'],
    });
  });

  it('build output date used when project has no date but build output does', () => {
    setup('wrangler.json', '{ "name": "test" }');
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_date: '2026-03-29' }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-03-29',
    });
  });

  it('build output flags used when project has no flags but build output does', () => {
    setup('wrangler.json', '{ "compatibility_date": "2026-04-01" }');
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_flags: ['nodejs_als'] }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['nodejs_als'],
    });
  });

  it('uses the default when the build output fallback is missing too', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(readWranglerCompat(tmpDir, undefined, join(tmpDir, 'nonexistent'))).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
  });
});

describe('ensureWranglerCompat', () => {
  it('pins the latest known-good compatibility date in void.json when none exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(JSON.parse(readFileSync(join(tmpDir, 'void.json'), 'utf-8'))).toEqual({
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
  });

  it('pins void.json when the build output fallback is missing too', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompat(tmpDir, undefined, join(tmpDir, 'nonexistent'))).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(JSON.parse(readFileSync(join(tmpDir, 'void.json'), 'utf-8'))).toEqual({
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
  });

  it('preserves existing void.json fields when pinning compatibility_date', () => {
    setup(
      'void.json',
      JSON.stringify({
        $schema: './node_modules/void/schema.json',
        database: 'pg',
        worker: { compatibility_flags: ['nodejs_compat'] },
      }),
    );
    expect(ensureWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
    });
    expect(JSON.parse(readFileSync(join(tmpDir, 'void.json'), 'utf-8'))).toEqual({
      $schema: './node_modules/void/schema.json',
      database: 'pg',
      worker: {
        compatibility_flags: ['nodejs_compat'],
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
      },
    });
  });
});

describe('ensureWranglerCompatibilityDate', () => {
  it('creates wrangler.jsonc with compatibility_date when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created.compatibility_date).toBe('2026-02-24');
  });

  it('updates existing wrangler config compatibility_date', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.compatibility_date).toBe('2026-02-24');
  });

  it('returns false when compatibility_date already matches', () => {
    setup('wrangler.jsonc', '{ "compatibility_date": "2026-02-24" }');
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(false);
  });
});

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

describe('ensureWranglerNodejsAlsFlag', () => {
  it('creates wrangler.jsonc when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerNodejsAlsFlag(tmpDir)).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created.compatibility_flags).toEqual(['nodejs_als']);
  });

  it('adds nodejs_als compatibility flag when missing', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = ensureWranglerNodejsAlsFlag(tmpDir);
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.compatibility_flags).toEqual(['nodejs_als']);
  });

  it('does not duplicate existing nodejs_als compatibility flag', () => {
    setup('wrangler.jsonc', '{ "name": "test", "compatibility_flags": ["nodejs_als"] }');
    const result = ensureWranglerNodejsAlsFlag(tmpDir);
    expect(result).toBe(false);
  });
});

describe('syncWranglerBindings', () => {
  it('creates wrangler.jsonc when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created).toEqual({});
  });

  it('adds D1 binding when needsD1 is true', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.d1_databases).toEqual([
      { binding: 'DB', database_name: 'default', database_id: 'local' },
    ]);
  });

  it('adds KV and R2 bindings', () => {
    setup('wrangler.json', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsKV: true, needsR2: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.json'), 'utf-8'));
    expect(parsed.kv_namespaces).toEqual([{ binding: 'KV', id: 'local' }]);
    expect(parsed.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'default' }]);
  });

  it('does not add auth-specific bindings', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    syncWranglerBindings(tmpDir, { ...noBindings, needsAuth: true });
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed).toEqual({ name: 'test' });
  });

  it('uses custom binding names', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    syncWranglerBindings(
      tmpDir,
      { ...noBindings, needsD1: true, needsKV: true },
      { bindingNames: { d1: 'MY_DB', kv: 'MY_KV' } },
    );
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.d1_databases[0].binding).toBe('MY_DB');
    expect(parsed.kv_namespaces[0].binding).toBe('MY_KV');
  });

  it('does not duplicate existing bindings', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'test',
        compatibility_flags: ['nodejs_als'],
        d1_databases: [{ binding: 'DB', database_name: 'prod', database_id: 'real-id' }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(false);
  });

  it('adds sandbox durable object, container, and migration metadata', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsSandbox: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([{ name: 'SANDBOX', class_name: 'Sandbox' }]);
    expect(parsed.containers[0]).toMatchObject({
      name: 'void-sandbox',
      class_name: 'Sandbox',
    });
    expect(parsed.containers[0].image).toContain('Dockerfile');
    expect(parsed.migrations).toEqual([
      { tag: 'void-sandbox-v1', new_sqlite_classes: ['Sandbox'] },
    ]);
  });

  it('adds live durable object and SQLite migration metadata', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'VOID_LIVE', class_name: 'VoidLiveStreamDurableObject' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('does not duplicate live durable object bindings or migrations', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'VOID_LIVE', class_name: 'VoidLiveStreamDurableObject' }],
        },
        migrations: [{ tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(false);
    expect(readExistingLiveBindingConfig(tmpDir)).toEqual({
      bindingName: 'VOID_LIVE',
      className: 'VoidLiveStreamDurableObject',
    });
  });

  it('adds a non-conflicting live migration when live-v1 exists for another class', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        migrations: [{ tag: 'live-v1', new_sqlite_classes: ['OtherDurableObject'] }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.migrations).toEqual([
      { tag: 'live-v1', new_sqlite_classes: ['OtherDurableObject'] },
      { tag: 'live-v1-2', new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('uses deterministic live names when defaults collide', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'VOID_LIVE', class_name: 'UserLiveDurableObject' }],
        },
      }),
    );
    const live = resolveLiveBindingConfig(tmpDir);
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true }, { live });
    expect(result).toBe(true);
    expect(live.bindingName).toMatch(/^VOID_LIVE_[0-9a-f]{8}$/);
    expect(live.className).toBe('VoidLiveStreamDurableObject');
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'VOID_LIVE', class_name: 'UserLiveDurableObject' },
      { name: live.bindingName, class_name: live.className },
    ]);
    expect(parsed.migrations).toEqual([{ tag: 'live-v1', new_sqlite_classes: [live.className] }]);
  });

  it('does not treat arbitrary live-like prefixes as generated live names', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [
            {
              name: 'VOID_LIVE_custom',
              class_name: 'VoidLiveStreamDurableObject_custom',
            },
          ],
        },
      }),
    );

    expect(resolveLiveBindingConfig(tmpDir)).toEqual({
      bindingName: 'VOID_LIVE',
      className: 'VoidLiveStreamDurableObject',
    });
    expect(readExistingLiveBindingConfig(tmpDir)).toBeUndefined();
  });

  it('uses custom sandbox config', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    syncWranglerBindings(
      tmpDir,
      { ...noBindings, needsSandbox: true },
      {
        sandbox: {
          binding: 'CODE',
          className: 'CodeSandbox',
          containerName: 'code-sandbox',
          image: '/project/Dockerfile.sandbox',
          platformImage: 'registry.example.com/code-sandbox:latest',
          instanceType: 'lite',
          maxInstances: 2,
        },
      },
    );
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings[0]).toEqual({
      name: 'CODE',
      class_name: 'CodeSandbox',
    });
    expect(parsed.containers[0]).toMatchObject({
      name: 'code-sandbox',
      class_name: 'CodeSandbox',
      image: '/project/Dockerfile.sandbox',
      instance_type: 'lite',
      max_instances: 2,
    });
  });

  it('returns false when no bindings are needed', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(false);
  });
});

describe('writeProvisionedWranglerConfig', () => {
  const commentedFixture = `{
  // Void manages this file — comments below must survive provisioning.
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": "src/index.ts",
  /* App databases (real ids written by \`wrangler d1 create --update-config\`). */
  "d1_databases": [
    { "binding": "DB", "database_name": "app-db", "database_id": "abc-123" },
    { "binding": "ANALYTICS", "database_name": "an-db", "database_id": "def-456" }
  ]
}`;

  function readRaw(filename: string): string {
    return readFileSync(join(tmpDir, filename), 'utf-8');
  }

  function parseRaw(filename: string): Record<string, unknown> {
    return parseJsoncRaw(readRaw(filename)) as Record<string, unknown>;
  }

  it('preserves comments while filling account_id, name, compatibility_date, and migrations_dir', () => {
    setup('wrangler.jsonc', commentedFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'acc-999',
      name: 'my-app',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });

    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);
    expect(result.configPath).toBe(join(tmpDir, 'wrangler.jsonc'));

    const raw = readRaw('wrangler.jsonc');
    // Crux: comments must survive the write.
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain('/* App databases');

    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.account_id).toBe('acc-999');
    expect(parsed.name).toBe('my-app');
    expect(parsed.compatibility_date).toBe('2026-02-24');
    const d1 = parsed.d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });
    // The other D1 entry is untouched.
    expect(d1[1].migrations_dir).toBeUndefined();
  });

  it('overwrites account_id but only sets name/compatibility_date when absent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // user-owned fields
  "name": "user-chosen-name",
  "account_id": "stale-account",
  "compatibility_date": "2025-01-01"
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'fresh-account',
      name: 'should-not-clobber',
      compatibilityDate: '2026-02-24',
    });

    expect(result.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    // account_id is always corrected on re-resolve.
    expect(parsed.account_id).toBe('fresh-account');
    // name / compatibility_date are only-if-absent — user's values win.
    expect(parsed.name).toBe('user-chosen-name');
    expect(parsed.compatibility_date).toBe('2025-01-01');
    expect(readRaw('wrangler.jsonc')).toContain('// user-owned fields');
  });

  it('adds migrations_dir to the D1 entry matched by binding, leaving others untouched', () => {
    setup('wrangler.jsonc', commentedFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'ANALYTICS', dir: 'db/analytics-migrations' },
    });

    expect(result.d1MigrationsDirSkipped).toBe(false);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].migrations_dir).toBeUndefined();
    expect(d1[1]).toMatchObject({
      binding: 'ANALYTICS',
      migrations_dir: 'db/analytics-migrations',
    });
  });

  it('signals when no D1 entry matches the requested binding and leaves the file untouched', () => {
    setup('wrangler.jsonc', commentedFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'MISSING', dir: 'db/migrations' },
    });

    expect(result.d1MigrationsDirSkipped).toBe(true);
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('is idempotent — running twice yields byte-identical output with no duplicate keys/entries', () => {
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      accountId: 'acc-999',
      name: 'my-app',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');

    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);

    // No duplicated D1 entries or keys.
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(2);
    expect((afterFirst.match(/"account_id"/g) ?? []).length).toBe(1);
    expect((afterFirst.match(/"migrations_dir"/g) ?? []).length).toBe(1);
  });

  it('operates on wrangler.json when wrangler.jsonc is absent', () => {
    setup('wrangler.json', '{ "name": "json-app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-1' });
    expect(result.configPath).toBe(join(tmpDir, 'wrangler.json'));
    expect(parseRaw('wrangler.json').account_id).toBe('acc-1');
  });

  it('prefers wrangler.jsonc over wrangler.json', () => {
    setup('wrangler.jsonc', '{ "name": "jsonc-app" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json-app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-2' });
    expect(result.configPath).toBe(join(tmpDir, 'wrangler.jsonc'));
    expect(parseRaw('wrangler.jsonc').account_id).toBe('acc-2');
    // The wrangler.json is left untouched.
    expect(parseRaw('wrangler.json').account_id).toBeUndefined();
  });

  it('creates wrangler.jsonc when no config exists and a patch is provided', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'acc-new',
      name: 'brand-new',
    });
    expect(result.configPath).toBe(join(tmpDir, 'wrangler.jsonc'));
    expect(result.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.account_id).toBe('acc-new');
    expect(parsed.name).toBe('brand-new');
  });

  it('preserves the fixture indentation style (tabs) for inserted content', () => {
    setup('wrangler.jsonc', '{\n\t"name": "tabbed"\n}');
    writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-tab' });
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('\t"account_id": "acc-tab"');
    expect(parseRaw('wrangler.jsonc').account_id).toBe('acc-tab');
  });

  it('handles a leading UTF-8 BOM: parses (never fail-open), respects only-if-absent, matches D1, keeps the BOM + comments', () => {
    // Node's utf-8 read preserves the BOM; a fail-open-to-`{}` parser would see
    // name/compatibility_date as absent and clobber them, and miss the D1 entry.
    const bomFixture =
      '﻿' +
      `{
  // BOM-prefixed config — must NOT be treated as empty.
  "name": "user-name",
  "compatibility_date": "2025-06-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "abc" }
  ]
}`;
    setup('wrangler.jsonc', bomFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'acc-bom',
      name: 'should-not-clobber',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });

    expect(result.modified).toBe(true);
    // D1 matched despite the BOM (fail-open would have skipped it).
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    // BOM round-trips (wrangler-compatible) and comments survive.
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('// BOM-prefixed config');

    const parsed = parseJsoncRaw(raw.replace(/^﻿/, '')) as Record<string, unknown>;
    // Only-if-absent respected — the user's values are NOT clobbered.
    expect(parsed.name).toBe('user-name');
    expect(parsed.compatibility_date).toBe('2025-06-01');
    expect(parsed.account_id).toBe('acc-bom');
    const d1 = parsed.d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });
  });

  it('fails closed on a malformed config — throws without writing', () => {
    const malformed = '{ "name": "x" "d1_databases": [] }'; // missing comma
    setup('wrangler.jsonc', malformed);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-x', name: 'y' })).toThrow(
      /not valid JSON/,
    );
    // The file is left byte-for-byte untouched.
    expect(readRaw('wrangler.jsonc')).toBe(malformed);
  });

  it('upserts queue producers/consumers into a config with no queues — exactly one each, comments preserved', () => {
    setup('wrangler.jsonc', commentedFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        consumers: [{ queue: 'jobs', max_batch_size: 10 }],
      },
    });

    expect(result.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// Void manages this file');

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toHaveLength(1);
    expect(q.producers[0]).toEqual({ queue: 'jobs', binding: 'QUEUE_JOBS' });
    expect(q.consumers).toHaveLength(1);
    expect(q.consumers[0]).toEqual({ queue: 'jobs', max_batch_size: 10 });
  });

  it('queue upsert is idempotent — re-running yields exactly one producer + one consumer, byte-identical', () => {
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      queues: {
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        consumers: [{ queue: 'jobs', max_batch_timeout: 5 }],
      },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');

    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<unknown>;
      consumers: Array<unknown>;
    };
    expect(q.producers).toHaveLength(1);
    expect(q.consumers).toHaveLength(1);
    // No duplicated producer binding in the emitted text.
    expect((afterFirst.match(/"binding": "QUEUE_JOBS"/g) ?? []).length).toBe(1);
  });

  it('appends a new queue producer/consumer without duplicating existing ones, leaving them untouched', () => {
    setup(
      'wrangler.jsonc',
      `{
  // existing queue
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }],
    "consumers": [{ "queue": "jobs" }]
  }
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [
          { queue: 'jobs', binding: 'QUEUE_JOBS' }, // already present — must not duplicate
          { queue: 'emails', binding: 'QUEUE_EMAILS' }, // new — appended
        ],
        consumers: [{ queue: 'emails', max_retries: 3 }],
      },
    });

    expect(result.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// existing queue');

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toHaveLength(2);
    expect(q.producers.map((p) => p.binding).sort()).toEqual(['QUEUE_EMAILS', 'QUEUE_JOBS']);
    expect(q.consumers).toHaveLength(2);
    expect(q.consumers.map((c) => c.queue).sort()).toEqual(['emails', 'jobs']);
  });

  it('updating a matching queue entry preserves user fields + inline comments (no whole-object clobber), and is idempotent', () => {
    // A matching-but-differing entry must be patched property-by-property, NOT
    // replaced wholesale: replacing the array element with the narrow inferred
    // patch would drop the user's tuned fields (producer `delivery_delay`;
    // consumer `dead_letter_queue`, `max_concurrency`) AND their comments,
    // silently changing production delivery/retry/concurrency/failure-routing.
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — comments below must survive queue upserts.
  "queues": {
    "producers": [
      // job producer — delivery_delay is user-tuned and must NOT be lost
      { "queue": "jobs", "binding": "QUEUE_JOBS", "delivery_delay": 60 }
    ],
    "consumers": [
      {
        "queue": "jobs",
        "max_batch_size": 10,
        "dead_letter_queue": "jobs-dlq", // route failures here — must survive
        "max_concurrency": 3
      }
    ]
  }
}`,
    );

    const patch = {
      queues: {
        // Matches by binding; differs only because the fixture carries an extra
        // `delivery_delay` the patch omits. This is exactly the clobber case.
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        // Matches by queue; changes max_batch_size 10 -> 25 and adds max_retries,
        // while dead_letter_queue + max_concurrency must be preserved.
        consumers: [{ queue: 'jobs', max_batch_size: 25, max_retries: 5 }],
      },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // All comments — file-level, producer-level, and the inline one — survive.
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain('// job producer — delivery_delay is user-tuned');
    expect(raw).toContain('// route failures here — must survive');

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toHaveLength(1);
    // Producer: user's delivery_delay preserved; queue/binding untouched.
    expect(q.producers[0]).toEqual({ queue: 'jobs', binding: 'QUEUE_JOBS', delivery_delay: 60 });
    expect(q.consumers).toHaveLength(1);
    // Consumer: supplied fields applied; user's DLQ + concurrency preserved.
    expect(q.consumers[0]).toEqual({
      queue: 'jobs',
      max_batch_size: 25,
      max_retries: 5,
      dead_letter_queue: 'jobs-dlq',
      max_concurrency: 3,
    });

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });
});
