import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseJsoncRaw, type ParseError } from 'jsonc-parser';
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

/** Count jsonc-parser parse errors — used to assert CR-only edits stay valid. */
function parseErrors(text: string): number {
  const errs: Array<ParseError> = [];
  parseJsoncRaw(text, errs, { allowTrailingComma: true });
  return errs.length;
}

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

  it('fails closed on a queue consumer with a duplicated property — throws without writing', () => {
    // jsonc-parser resolves the duplicate `max_batch_size` to the LAST member (20,
    // what wrangler reads) but modify() edits the FIRST — so patching to 25 would
    // leave wrangler on the stale 20 while the write looks byte-idempotent. Reject.
    const dup = `{
  "queues": {
    "consumers": [
      {
        "queue": "jobs",
        "max_batch_size": 10,
        "max_batch_size": 20
      }
    ]
  }
}`;
    setup('wrangler.jsonc', dup);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { consumers: [{ queue: 'jobs', max_batch_size: 25 }] },
      }),
    ).toThrow(/duplicate key "max_batch_size"/);
    // File left byte-for-byte untouched.
    expect(readRaw('wrangler.jsonc')).toBe(dup);
  });

  it('fails closed on a top-level duplicated key (account_id twice) — throws without writing', () => {
    const dup = `{
  "account_id": "aaa",
  "account_id": "bbb"
}`;
    setup('wrangler.jsonc', dup);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'ccc' })).toThrow(
      /duplicate key "account_id"/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(dup);
  });

  it('does not fire the duplicate guard on a valid config — still upserts and stays idempotent', () => {
    // Sanity: the guard must not break the normal path. A no-duplicate config
    // upserts a queue consumer and a second run is byte-identical.
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      accountId: 'acc-ok',
      queues: { consumers: [{ queue: 'jobs', max_batch_size: 25 }] },
    };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');

    const q = parseRaw('wrangler.jsonc').queues as { consumers: Array<Record<string, unknown>> };
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 25 }]);

    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
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

  it('producer upsert keys on binding — a matching QUEUE_JOBS beside a user CUSTOM producer on the same queue is a no-op (no duplicate binding)', () => {
    // Producers are keyed by their UNIQUE `binding`, not the queue: wrangler
    // allows multiple producers per queue but rejects duplicate binding names.
    // Given a legal `{jobs,CUSTOM}` + `{jobs,QUEUE_JOBS}` pair, desiring
    // `{jobs,QUEUE_JOBS}` must leave both untouched. A by-queue upsert would
    // rewrite the FIRST match (CUSTOM → QUEUE_JOBS), minting two identical
    // QUEUE_JOBS bindings that wrangler rejects.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "CUSTOM" },
      { "queue": "jobs", "binding": "QUEUE_JOBS" }
    ]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });

    // Already present under its binding — nothing to do, byte-identical.
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'CUSTOM' },
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
    // Exactly one QUEUE_JOBS binding — no duplicate minted.
    expect((before.match(/"QUEUE_JOBS"/g) ?? []).length).toBe(1);
  });

  it('producer upsert appends QUEUE_JOBS beside a user CUSTOM producer on the same queue — never hijacks the user producer', () => {
    // A user renamed their producer binding to CUSTOM on queue "jobs". Void's
    // deterministic QUEUE_JOBS binding is absent, so it is APPENDED as its own
    // producer; the user's CUSTOM producer (and its tuned delivery_delay) is left
    // exactly as-is. Void must not rewrite a binding it does not own.
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — comments must survive queue upserts.
  "queues": {
    "producers": [
      // user's own producer — must be left untouched
      { "queue": "jobs", "binding": "CUSTOM", "delivery_delay": 60 }
    ]
  }
}`,
    );

    const patch = {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain("// user's own producer — must be left untouched");

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    // Two producers now: the user's CUSTOM (untouched) + Void's appended QUEUE_JOBS.
    expect(q.producers).toHaveLength(2);
    expect(q.producers[0]).toEqual({ queue: 'jobs', binding: 'CUSTOM', delivery_delay: 60 });
    expect(q.producers[1]).toEqual({ queue: 'jobs', binding: 'QUEUE_JOBS' });

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('fails closed when the desired producer binding is already bound to a DIFFERENT queue — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [{ "queue": "other", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/already bound to queue "other"/);

    // Fail closed — the file is untouched.
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('inserting migrations_dir keeps a trailing inline comment on the property it documented (no reassociation)', () => {
    // The D1 entry's LAST property carries a trailing inline comment. Naively
    // inserting migrations_dir via a formatting modify() reflows the region and
    // re-emits the comment at the end — silently moving `// production database`
    // onto migrations_dir. The comment must stay with database_id.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id" // production database
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    // Comment stays attached to database_id (comma before it), NOT migrations_dir.
    expect(raw).toContain('"database_id": "prod-id", // production database');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('appending a queue entry keeps a trailing inline comment on the entry it documented (no reassociation)', () => {
    // The producers array's LAST entry carries a trailing inline comment.
    // Appending a new entry must not reflow `// jobs producer` onto the appended
    // emails entry — it must stay with the jobs entry.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "QUEUE_JOBS" } // jobs producer
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // The comment stays with the jobs entry (before the appended emails entry),
    // never reassociated onto QUEUE_EMAILS.
    expect(raw).toContain('}, // jobs producer');
    expect(raw.indexOf('// jobs producer')).toBeGreaterThan(raw.indexOf('QUEUE_JOBS'));
    expect(raw.indexOf('// jobs producer')).toBeLessThan(raw.indexOf('QUEUE_EMAILS'));
    expect(raw).not.toMatch(/QUEUE_EMAILS[\s\S]*jobs producer/);

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('inserting migrations_dir keeps a trailing comment that sits AFTER a separator comma on its property', () => {
    // The last property carries a JSONC trailing comma BEFORE its inline comment
    // (`"database_id": "prod-id", // …`). A naive scan sees the comma first and
    // gives up, letting the plain formatting edit reassociate the comment onto
    // the inserted migrations_dir. The comment must stay with database_id.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id", // production database
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    // Comment stays attached to database_id, NOT migrations_dir.
    expect(raw).toContain('"database_id": "prod-id", // production database');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('inserting migrations_dir keeps a single-line block comment that sits after a separator comma', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id", /* production database */
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"database_id": "prod-id", /* production database */');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    // Idempotent.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('creating a missing queues.producers section keeps the trailing comment on the existing consumers entry', () => {
    // Only `consumers` exists (with a trailing inline comment). Adding the
    // `producers` section makes modify() append `producers` as a NEW member of
    // the `queues` object, right after `consumers`. The `// jobs consumer`
    // comment must stay on the consumers entry, not move onto producers.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": 10 }
    ] // jobs consumer
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // Comment stays with consumers (its comma comes before it), never on producers.
    expect(raw).toContain('], // jobs consumer');
    expect(raw.indexOf('// jobs consumer')).toBeGreaterThan(raw.indexOf('"consumers"'));
    expect(raw.indexOf('// jobs consumer')).toBeLessThan(raw.indexOf('"producers"'));
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 10 }]);
    expect(q.producers).toEqual([{ queue: 'emails', binding: 'QUEUE_EMAILS' }]);

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('creating a missing queues.producers section keeps a single-line block comment on the consumers entry', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": 10 }
    ] /* jobs consumer */
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('], /* jobs consumer */');
    expect(raw.indexOf('/* jobs consumer */')).toBeLessThan(raw.indexOf('"producers"'));
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);

    // Idempotent.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('KNOWN LIMITATION: jsonc-parser modify() reassociates a MULTI-LINE block comment used as a trailing comment; comment text is preserved, association is best-effort', () => {
    // A block comment that spans multiple lines cannot be safely relocated onto
    // a single line, so readTrailingComment declines it and the plain formatting
    // edit runs. jsonc-parser then re-emits the comment at the end of the
    // reflowed region — moving it onto the appended entry. We PIN this: the hard
    // guarantee is that the comment TEXT survives; exact association is
    // best-effort for this exotic placement and is not chased further.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "QUEUE_JOBS" } /* jobs
         producer spanning lines */
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // Hard guarantee: the comment text is never dropped.
    expect(raw).toContain('producer spanning lines');
    // Both producers are present and parse cleanly.
    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    // Still idempotent despite the best-effort association.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  const CR = '\r';

  it('CR-only line endings: inserting migrations_dir stays valid, keeps the trailing comment, byte-identical on re-run', () => {
    // Classic-Mac CR-only file. A `\n`-only comment scanner would swallow the CR
    // + the closing brace, writing migrations_dir OUTSIDE the object (parse error)
    // and making a second run throw. Stopping the scan at CR keeps it valid.
    const fixture =
      `{${CR}` +
      `  "d1_databases": [${CR}` +
      `    {${CR}` +
      `      "binding": "DB",${CR}` +
      `      "database_id": "prod-id" // entrypoint${CR}` +
      `    }${CR}` +
      `  ]${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    // Zero parse errors — the closing brace was NOT consumed by the comment scan.
    expect(parseErrors(raw)).toBe(0);
    // Comment text preserved and still on database_id (not moved onto migrations_dir).
    expect(raw).toContain('// entrypoint');
    expect(raw).not.toMatch(/migrations_dir[^\r\n]*entrypoint/);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    // Byte-identical second run — previously the corrupted file made this THROW.
    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('CR-only line endings: appending a queue producer stays valid, keeps the trailing comment, byte-identical on re-run', () => {
    const fixture =
      `{${CR}` +
      `  "queues": {${CR}` +
      `    "producers": [${CR}` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" } // jobs producer${CR}` +
      `    ]${CR}` +
      `  }${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// jobs producer');
    // Comment stays with the jobs entry, never reassociated onto the appended one.
    expect(raw).not.toMatch(/QUEUE_EMAILS[\s\S]*jobs producer/);
    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('CR-only line endings: creating a missing queues.producers section stays valid, keeps the consumers trailing comment', () => {
    const fixture =
      `{${CR}` +
      `  "queues": {${CR}` +
      `    "consumers": [${CR}` +
      `      { "queue": "jobs", "max_batch_size": 10 }${CR}` +
      `    ] // jobs consumer${CR}` +
      `  }${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// jobs consumer');
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);
    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 10 }]);
    expect(q.producers).toEqual([{ queue: 'emails', binding: 'QUEUE_EMAILS' }]);

    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('producer conflict is order-independent: a duplicate binding across producers fails closed in EITHER array order', () => {
    // Both entries share binding QUEUE_JOBS (already undeployable). The desired
    // {jobs,QUEUE_JOBS} must fail closed regardless of order — a first-match check
    // would falsely report convergence when {jobs,...} happens to come first.
    const forward =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [\n` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" },\n` +
      `      { "queue": "other", "binding": "QUEUE_JOBS" }\n` +
      `    ]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', forward);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/declared 2 times/);
    expect(readRaw('wrangler.jsonc')).toBe(forward);

    const reversed =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [\n` +
      `      { "queue": "other", "binding": "QUEUE_JOBS" },\n` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" }\n` +
      `    ]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', reversed);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/declared 2 times/);
    expect(readRaw('wrangler.jsonc')).toBe(reversed);
  });

  it('producer upsert is a no-op when the sole matching binding already maps to the same queue', () => {
    const fixture =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', fixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  // Global comment-text-preservation invariant (final gate before write). The
  // writer's contract is that every comment's TEXT survives a write. A
  // scalar-expected field holding a composite object/array value with a comment
  // inside is a case jsonc-parser's modify() silently drops (it replaces the
  // whole node yet reports modified:true). The final gate compares the comment
  // token multiset of the original vs the final output and throws WITHOUT
  // writing on any drop, rather than chasing each pathological path.

  it('fails closed when a composite account_id value drops an inner comment — throws without writing', () => {
    // `account_id` is scalar-expected but holds an object with a comment inside.
    // modify() replaces the whole node (deleting the comment) and reports
    // success; the final gate must catch the dropped comment and refuse to write.
    const fixture = `{
  "account_id": { "x": 1 /* keep this note */ },
  "name": "app"
}`;
    setup('wrangler.jsonc', fixture);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-999' })).toThrow(
      /"account_id" has an object\/array value; expected a string/,
    );
    // Fail closed — the file is byte-for-byte untouched.
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('fails closed when a composite migrations_dir on the matched D1 entry drops an inner comment — throws without writing', () => {
    const fixture = `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": { "dir": "old" /* keep this note */ }
    }
  ]
}`;
    setup('wrangler.jsonc', fixture);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
      }),
    ).toThrow(/"migrations_dir" has an object\/array value; expected a string/);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('fails closed when a composite consumer option (max_batch_size) drops an inner comment — throws without writing', () => {
    const fixture = `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": { "n": 1 /* keep this note */ } }
    ]
  }
}`;
    setup('wrangler.jsonc', fixture);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { consumers: [{ queue: 'jobs', max_batch_size: 25 }] },
      }),
    ).toThrow(/"max_batch_size" has an object\/array value; expected a string/);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('does NOT fire on a normal comment-rich config — upsert succeeds, every comment survives, idempotent', () => {
    // Negative control: the invariant must never fire for a valid edit. A config
    // with several comments upserts cleanly, keeps ALL comments, and a second run
    // is byte-identical (the gate does not perturb idempotence).
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      accountId: 'acc-ok',
      name: 'my-app',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
      queues: {
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        consumers: [{ queue: 'jobs', max_batch_size: 10 }],
      },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // Every original comment token is still present.
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain('/* App databases');

    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('does NOT fire on a relocation — appending after a trailing-commented sibling keeps every comment', () => {
    // Relocation MOVES a comment (same text, new position), so the comment-token
    // multiset is unchanged and the invariant passes. Appending a queue producer
    // after a sibling that carries a trailing inline comment must succeed.
    setup(
      'wrangler.jsonc',
      `{
  // file-level note
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "QUEUE_JOBS" } // jobs producer
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    // Both comments survive; the trailing one stays on the jobs entry.
    expect(raw).toContain('// file-level note');
    expect(raw).toContain('// jobs producer');
    expect(raw).toContain('}, // jobs producer');

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    // Idempotent.
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });
});
