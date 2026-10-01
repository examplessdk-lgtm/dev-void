import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw, type ParseError } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  acknowledgeWranglerManagedQueueRemovals,
  bindingEntriesForField,
  bindingNamesForField,
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  LATEST_KNOWN_COMPAT_DATE,
  readExistingLiveBindingConfig,
  readProvisionedBindingEntry,
  readWranglerCompat,
  readWranglerManagedQueueCleanupCandidates,
  readWranglerWebSocketTombstones,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
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

  it('does NOT add a send_email binding even when needsEmail is true', () => {
    // Outbound email goes through __VOID_PROXY/email/send (the proxy
    // worker holds the platform-level send_email binding). User workers
    // never get one, so wrangler sync intentionally skips emission.
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsEmail: true });
    expect(result).toBe(false);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.send_email).toBeUndefined();
  });

  it('leaves a user-defined send_email block alone (does not strip it)', () => {
    // If a user manually added one, that's harmless dead config they
    // should remove — but the framework never rewrites it.
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'test',
        send_email: [{ name: 'CUSTOM_EMAIL', destination_address: 'me@x.dev' }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsEmail: true });
    expect(result).toBe(false);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.send_email).toEqual([{ name: 'CUSTOM_EMAIL', destination_address: 'me@x.dev' }]);
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

  it('adds WebSocket classes as SQLite Durable Objects', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerWebSockets(tmpDir, [
      {
        pattern: '/chat/:room',
        methods: ['GET'],
        params: ['room'],
        catchAll: false,
        env: null,
        filePath: 'chat/[room].ws.ts',
        className: 'WsChatRoomWs',
        bindingName: 'WS_CHAT_ROOM_WS',
        mode: 'room',
        hasAuthGate: false,
      },
    ]);

    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'WS_CHAT_ROOM_WS', class_name: 'WsChatRoomWs' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['WsChatRoomWs'] },
    ]);
  });

  it('preserves a legacy WebSocket class and appends new classes as SQLite', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'LEGACY', class_name: 'LegacyRoom' }],
        },
        migrations: [{ tag: 'void-ws-v1', new_classes: ['LegacyRoom'] }],
      }),
    );
    const route = (className: string, bindingName: string) => ({
      pattern: `/${bindingName}`,
      methods: ['GET'],
      params: [],
      catchAll: false,
      env: null,
      filePath: `${bindingName}.ws.ts`,
      className,
      bindingName,
      mode: 'room' as const,
      hasAuthGate: false,
    });

    syncWranglerWebSockets(tmpDir, [route('LegacyRoom', 'LEGACY'), route('ChatRoom', 'CHAT')]);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_classes: ['LegacyRoom'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['ChatRoom'] },
    ]);
  });

  it('retains stale generated WebSocket bindings and reports tombstone exports', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [
            { name: 'OLD_CHAT', class_name: 'OldChatWs' },
            { name: 'CART', class_name: 'ShoppingCartDurableObject' },
          ],
        },
        migrations: [
          { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
          { tag: 'durable-shopping-cart-v1', new_sqlite_classes: ['ShoppingCartDurableObject'] },
        ],
      }),
    );

    expect(syncWranglerWebSockets(tmpDir, [])).toBe(false);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'OLD_CHAT', class_name: 'OldChatWs' },
      { name: 'CART', class_name: 'ShoppingCartDurableObject' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
      { tag: 'durable-shopping-cart-v1', new_sqlite_classes: ['ShoppingCartDurableObject'] },
    ]);
    expect(readWranglerWebSocketTombstones(tmpDir, [])).toEqual(['OldChatWs']);
  });

  it('replaces a renamed generated WebSocket binding', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: { bindings: [{ name: 'OLD_CHAT', class_name: 'OldChatWs' }] },
        migrations: [{ tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] }],
      }),
    );

    syncWranglerWebSockets(tmpDir, [
      {
        pattern: '/chat',
        methods: ['GET'],
        params: [],
        catchAll: false,
        env: null,
        filePath: 'chat.ws.ts',
        className: 'ChatWs',
        bindingName: 'CHAT',
        mode: 'room',
        hasAuthGate: false,
      },
    ]);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'OLD_CHAT', class_name: 'OldChatWs' },
      { name: 'CHAT', class_name: 'ChatWs' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['ChatWs'] },
    ]);
    expect(
      readWranglerWebSocketTombstones(tmpDir, [
        {
          pattern: '/chat',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ws.ts',
          className: 'ChatWs',
          bindingName: 'CHAT',
          mode: 'room',
          hasAuthGate: false,
        },
      ]),
    ).toEqual(['OldChatWs']);
  });

  it('adds sandbox durable object, container, and migration metadata', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsSandbox: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([{ name: 'SANDBOX', class_name: 'SandboxV1' }]);
    expect(parsed.containers[0]).toMatchObject({
      name: 'void-sandbox-v1',
      class_name: 'SandboxV1',
    });
    expect(parsed.containers[0].images.default.dockerfile).toMatch(/sandbox\.Dockerfile$/);
    expect(parsed.containers[0].scheduling_policy).toBe('durable_object');
    expect(parsed.migrations).toEqual([
      { tag: 'void-sandbox-v2', new_sqlite_classes: ['SandboxV1'] },
    ]);
  });

  it('refuses to reuse a legacy Sandbox namespace before changing the deployment config', () => {
    const original = JSON.stringify({
      name: 'legacy',
      durable_objects: { bindings: [{ name: 'SANDBOX', class_name: 'Sandbox' }] },
      containers: [
        {
          name: 'void-sandbox',
          class_name: 'Sandbox',
          image: 'docker.io/cloudflare/sandbox:0.12.10',
        },
      ],
      migrations: [{ tag: 'void-sandbox-v1', new_sqlite_classes: ['Sandbox'] }],
    });
    setup('wrangler.jsonc', original);
    expect(() => syncWranglerBindings(tmpDir, { ...noBindings, needsSandbox: true })).toThrow(
      'new Durable Object namespace',
    );
    expect(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf8')).toBe(original);
  });

  it('preserves custom Sandbox SQLite rename history even when the reserved tag belongs to another class', () => {
    const migrations = [
      { tag: 'custom-v1', new_sqlite_classes: ['OriginalSandbox'] },
      { tag: 'custom-v2', renamed_classes: [{ from: 'OriginalSandbox', to: 'SandboxV1' }] },
      { tag: 'void-sandbox-v2', new_sqlite_classes: ['Unrelated'] },
    ];
    setup('wrangler.jsonc', JSON.stringify({ name: 'custom', migrations }));
    expect(syncWranglerBindings(tmpDir, { ...noBindings, needsSandbox: true })).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf8'));
    expect(parsed.migrations).toEqual(migrations);
    expect(parsed.durable_objects.bindings).toEqual([{ name: 'SANDBOX', class_name: 'SandboxV1' }]);
  });

  it.each([
    { tag: 'void-sandbox-v2', new_sqlite_classes: ['Unrelated'] },
    { tag: 'legacy', new_classes: ['SandboxV1'] },
    {
      tag: 'transfer',
      transferred_classes: [{ from_script: 'foreign', from: 'Original', to: 'SandboxV1' }],
    },
  ])(
    'refuses an incompatible Sandbox migration before writing any generated config',
    (migration) => {
      const original = JSON.stringify({ name: 'incompatible', migrations: [migration] });
      setup('wrangler.jsonc', original);
      expect(() => syncWranglerBindings(tmpDir, { ...noBindings, needsSandbox: true })).toThrow(
        /another class|needs SQLite storage/,
      );
      expect(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf8')).toBe(original);
    },
  );

  it('appends typed Durable Object migrations when new files sort earlier', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const zeta = {
      filePath: join(tmpDir, 'durable-objects', 'zeta.ts'),
      bindingName: 'ZETA',
      className: 'ZetaDurableObject',
      migrationTag: 'void-durable-zeta-v1',
    };
    const alpha = {
      filePath: join(tmpDir, 'durable-objects', 'alpha.ts'),
      bindingName: 'ALPHA',
      className: 'AlphaDurableObject',
      migrationTag: 'void-durable-alpha-v1',
    };

    expect(syncWranglerDurableObjects(tmpDir, [zeta])).toBe(true);
    expect(syncWranglerDurableObjects(tmpDir, [alpha, zeta])).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));

    expect(parsed.migrations).toEqual([
      { tag: 'void-durable-zeta-v1', new_sqlite_classes: ['ZetaDurableObject'] },
      { tag: 'void-durable-alpha-v1', new_sqlite_classes: ['AlphaDurableObject'] },
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
          platformImage:
            'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          instanceType: 'lite',
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
      scheduling_policy: 'durable_object',
      images: { default: { dockerfile: '/project/Dockerfile.sandbox' } },
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

  it('preserves comments and appends stable WebSocket migration history', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Keep the worker identity comment.
  "name": "chat-app",
  "vars": {
    // Keep unrelated bindings untouched.
    "FEATURE": "on"
  }
}`,
    );
    const route = (className: string) => ({
      bindingName: className.toUpperCase(),
      className,
      filePath: `${className}.ws.ts`,
    });

    const first = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs')],
    });
    expect(first.modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');
    expect(afterFirst).toContain('// Keep the worker identity comment.');
    expect(afterFirst).toContain('// Keep unrelated bindings untouched.');

    const unchanged = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs')],
    });
    expect(unchanged.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);

    const second = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs'), route('NotificationsWs')],
    });
    expect(second.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.vars).toEqual({ FEATURE: 'on' });
    expect((parsed.durable_objects as { bindings: unknown }).bindings).toEqual([
      { name: 'CHATWS', class_name: 'ChatWs' },
      { name: 'NOTIFICATIONSWS', class_name: 'NotificationsWs' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['ChatWs'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['NotificationsWs'] },
    ]);
    expect(readRaw('wrangler.jsonc')).toContain('// Keep unrelated bindings untouched.');
  });

  it('keeps an existing legacy WebSocket namespace authoritative', () => {
    const config = `{
  "durable_objects": {
    "bindings": [{ "name": "CHAT", "class_name": "ChatWs" }]
  },
  // This class is already deployed with legacy KV storage.
  "migrations": [{ "tag": "void-ws-v1", "new_classes": ["ChatWs"] }]
}`;
    setup('wrangler.jsonc', config);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [{ bindingName: 'CHAT', className: 'ChatWs', filePath: 'chat.ws.ts' }],
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(config);
  });

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
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));

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

  it('adds compatibility flags without removing existing flags or comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  "compatibility_flags": [
    "nodejs_compat" // user-selected runtime mode
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als', 'nodejs_compat'],
    });

    expect(result.modified).toBe(true);
    expect(parseRaw('wrangler.jsonc').compatibility_flags).toEqual(['nodejs_compat', 'nodejs_als']);
    expect(readRaw('wrangler.jsonc')).toContain('// user-selected runtime mode');
  });

  it('creates compatibility_flags idempotently when the field is absent', () => {
    setup('wrangler.jsonc', '{\n  "name": "my-worker"\n}');

    const first = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als'],
    });
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als'],
    });

    expect(first.modified).toBe(true);
    expect(second.modified).toBe(false);
    expect(parseRaw('wrangler.jsonc').compatibility_flags).toEqual(['nodejs_als']);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
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
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.json')));
    expect(parseRaw('wrangler.json').account_id).toBe('acc-1');
  });

  it('prefers wrangler.jsonc over wrangler.json', () => {
    setup('wrangler.jsonc', '{ "name": "jsonc-app" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json-app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-2' });
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));
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
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));
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

  it('never infers queue ownership from a conventional QUEUE_* binding name', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "binding": "QUEUE_OLD", "queue": "old" },
      { "binding": "CUSTOM", "queue": "custom" }
    ],
    "consumers": [
      { "queue": "old", "max_batch_size": 5 },
      { "queue": "custom", "max_batch_size": 10 }
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });

    expect(result.modified).toBe(false);
    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [
        { binding: 'QUEUE_OLD', queue: 'old' },
        { binding: 'CUSTOM', queue: 'custom' },
      ],
      consumers: [
        { queue: 'old', max_batch_size: 5 },
        { queue: 'custom', max_batch_size: 10 },
      ],
    });
  });

  it('prunes only queue entries that Void explicitly recorded as managed', () => {
    setup('wrangler.jsonc', '{}');
    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_OLD', queue: 'old' }],
        consumers: [{ queue: 'old', max_batch_size: 5 }],
        reconcileVoidOwned: true,
      },
    });
    expect(readRaw('wrangler.jsonc')).toContain('// void:managed-queues:v1:');

    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });

    expect(parseRaw('wrangler.jsonc').queues).toEqual({ producers: [], consumers: [] });
    const configPath = join(tmpDir, 'wrangler.jsonc');
    expect(readRaw('wrangler.jsonc')).toContain('// void:managed-queues:v1:');
    expect(readWranglerManagedQueueCleanupCandidates(configPath)).toEqual(['old']);

    acknowledgeWranglerManagedQueueRemovals(configPath, ['old']);
    expect(readWranglerManagedQueueCleanupCandidates(configPath)).toEqual([]);
    expect(readRaw('wrangler.jsonc')).not.toContain('// void:managed-queues:v1:');
  });

  it('reconciles a renamed framework queue without retaining the old binding', () => {
    setup('wrangler.jsonc', '{}');
    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_OLD', queue: 'old' }],
        consumers: [{ queue: 'old' }],
        reconcileVoidOwned: true,
      },
    });

    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_NEW', queue: 'new' }],
        consumers: [{ queue: 'new' }],
        reconcileVoidOwned: true,
      },
    });

    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [{ binding: 'QUEUE_NEW', queue: 'new' }],
      consumers: [{ queue: 'new' }],
    });
    expect(readWranglerManagedQueueCleanupCandidates(join(tmpDir, 'wrangler.jsonc'))).toEqual([
      'new',
      'old',
    ]);
  });

  it('cancels a pending consumer removal when the queue is reintroduced before deploy', () => {
    setup('wrangler.jsonc', '{}');
    const queues = {
      producers: [{ binding: 'QUEUE_JOBS', queue: 'jobs' }],
      consumers: [{ queue: 'jobs' }],
      reconcileVoidOwned: true,
    };
    writeProvisionedWranglerConfig(tmpDir, { queues });
    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });
    writeProvisionedWranglerConfig(tmpDir, { queues });

    expect(readWranglerManagedQueueCleanupCandidates(join(tmpDir, 'wrangler.jsonc'))).toEqual([
      'jobs',
    ]);
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

  it('fails closed when the desired producer binding collides with a D1 binding name (worker-wide uniqueness) — throws without writing', () => {
    // wrangler requires every binding NAME to be unique across the ENTIRE worker,
    // not just within queues.producers. QUEUE_JOBS is already a D1 binding, so
    // appending a producer with that binding would emit a cross-type duplicate
    // wrangler 4.x rejects at deploy. Fail closed instead.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "QUEUE_JOBS", "database_name": "app", "database_id": "id" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a D1 Database binding/);

    // Fail closed — the file is byte-unchanged.
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with a KV binding name — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "kv_namespaces": [{ "binding": "QUEUE_JOBS", "id": "abc" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a KV Namespace binding/);

    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with a var name — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "vars": { "QUEUE_JOBS": "some-value" }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by an? Environment Variable binding/);

    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with a secrets.required name — throws without writing', () => {
    // wrangler folds `secrets.required` into its worker-wide uniqueness set under
    // the label "Secret" (validateBindingsHaveUniqueNames). QUEUE_JOBS is declared
    // there, so appending a producer with that binding would emit a cross-type
    // duplicate wrangler rejects at deploy. Fail closed instead.
    setup(
      'wrangler.jsonc',
      `{
  "secrets": { "required": ["QUEUE_JOBS"] }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a Secret binding/);

    // Fail closed — the file is byte-unchanged.
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with an unsafe_hello_world binding — throws without writing', () => {
    // `unsafe_hello_world` is a `[{ binding }]` array in wrangler's
    // friendlyBindingNames set. QUEUE_JOBS is already such a binding, so the
    // append would make the config undeployable — fail closed.
    setup(
      'wrangler.jsonc',
      `{
  "unsafe_hello_world": [{ "binding": "QUEUE_JOBS", "enable_timer": false }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a Hello World binding/);

    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with a ratelimits[].name — throws without writing', () => {
    // ratelimit bindings key their NAME on `.name`, not `.binding`, so wrangler's
    // own getBindingNames overlooks them — but validateRateLimitBinding requires
    // `.name`, making it the binding name enforced at deploy. Collect it as a safe
    // superset and fail closed on the collision.
    setup(
      'wrangler.jsonc',
      `{
  "ratelimits": [{ "name": "QUEUE_JOBS", "namespace_id": "1", "simple": { "limit": 100, "period": 60 } }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a Rate Limit binding/);

    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when the desired producer binding collides with a send_email[].name — throws without writing', () => {
    // send_email is the other `.name`-keyed binding array (like ratelimits). A
    // producer binding must never silently collide with a send_email binding.
    setup(
      'wrangler.jsonc',
      `{
  "send_email": [{ "name": "QUEUE_JOBS", "destination_address": "ops@example.com" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a Send Email binding/);

    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('negative control: top-level name, d1 database_name, and consumer queue equal to the producer binding are NOT binding names — append succeeds', () => {
    // None of these fields is a binding NAME: the worker `name`, a D1
    // `database_name`, and a queues.consumers[].queue can all legally equal
    // QUEUE_JOBS without colliding with the QUEUE_JOBS producer binding. The guard
    // must only inspect the binding-bearing fields wrangler enumerates, so this
    // append proceeds.
    setup(
      'wrangler.jsonc',
      `{
  "name": "QUEUE_JOBS",
  "d1_databases": [{ "binding": "DB", "database_name": "QUEUE_JOBS", "database_id": "id" }],
  "queues": {
    "consumers": [{ "queue": "QUEUE_JOBS", "max_batch_size": 10 }]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(true);

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    // The producer was appended; the consumer keyed on the same queue string is
    // untouched (not a binding-name collision).
    expect(q.producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
    expect(q.consumers).toEqual([{ queue: 'QUEUE_JOBS', max_batch_size: 10 }]);
  });

  it('negative control: a producer binding that collides with nothing appends normally', () => {
    // A DB binding named DB does NOT collide with the QUEUE_JOBS producer binding,
    // so the append proceeds — the worker-wide guard is precise, not paranoid.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "id" }],
  "kv_namespaces": [{ "binding": "KV", "id": "abc" }]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(true);

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
  });

  it('worker-wide guard does not fire on the idempotent same-queue producer path (no false collision)', () => {
    // QUEUE_JOBS already exists as a producer for the SAME queue. The worker-wide
    // collision guard now runs for EVERY producer upsert, but the collector
    // deliberately OMITS `queues`, so a producer never self-collides — with no OTHER
    // binding owning QUEUE_JOBS the upsert stays an idempotent no-op.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when an ARRAY-shaped `queues` (present) would hide a producer/D1 binding collision on adopt — throws without writing', () => {
    // wrangler 4.131 REQUIRES `queues` to be an OBJECT `{ producers, consumers }`.
    // A PRESENT array-shaped `queues` makes the old `isRecord(queues)` guard in
    // `addQueueProducerOwners` return early, so a producer-like `{ binding: "DB" }`
    // is NOT collected — and a D1 adopt of binding `DB` would then slip through the
    // cross-type uniqueness check. The shared `assertObjectContainer` validator now
    // fails closed on the malformed outer shape instead of hiding the collision.
    setup(
      'wrangler.jsonc',
      `{
  "queues": [{ "binding": "DB", "queue": "jobs" }],
  "d1_databases": []
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'db-id' },
      }),
    ).toThrow(/"queues" must be an object/);

    // Fail closed — the file is byte-unchanged (collision NOT hidden).
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when a WRONG-SHAPE `secrets` (present, non-object) would hide a secret binding collision on producer upsert — throws without writing', () => {
    // wrangler requires `secrets` to be an OBJECT `{ required: string[] }`. A
    // present-but-array `secrets` was silently skipped by the old `isRecord(secrets)`
    // guard in `collectWorkerBindingNames`, so a producer could collide with a real
    // secret binding name unnoticed. `assertObjectContainer` now fails closed.
    setup(
      'wrangler.jsonc',
      `{
  "secrets": ["QUEUE_JOBS"]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"secrets" must be an object/);

    // Fail closed — the file is byte-unchanged.
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed when an ARRAY-shaped `queues` (present) is seen on the producer UPSERT path — throws without writing (no bypass)', () => {
    // The producer-upsert path (`upsertQueueEntries`) is ALSO routed through
    // `assertObjectContainer`, so an array-shaped `queues` throws there too — proving
    // no path can bypass the outer-shape validator.
    setup(
      'wrangler.jsonc',
      `{
  "queues": [{ "binding": "DB", "queue": "jobs" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"queues" must be an object/);

    // Fail closed — the file is byte-unchanged.
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('ABSENT `queues` and `secrets` containers are a NO-OP — a D1 adopt with neither present succeeds normally', () => {
    // Regression guard: `assertObjectContainer(undefined, …)` returns undefined (a
    // no-op, NOT an error). A config with NO `queues` and NO `secrets` adopts a D1
    // binding normally.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "" }]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-id' },
    });
    expect(result.modified).toBe(true);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', database_id: 'real-id' });
  });

  it('fails closed on an explicit DIFFERENT migrations_dir — names both paths, throws without writing', () => {
    // A reused D1 configured with its own
    // migrations directory must NEVER be silently rewritten to Void's default —
    // that would strand the user's migration files. Fail closed, naming both.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": "drizzle",
      "migrations_pattern": "drizzle/*/migration.sql"
    }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(
      /already sets "migrations_dir": "drizzle".*"\.\/db\/migrations".*Refusing to overwrite an explicit different migrations directory/s,
    );

    // Fail closed — the file is byte-unchanged (dir + pattern untouched).
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('an explicit legacy migrations_dir on a reused D1 is never overwritten', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "id", "migrations_dir": "./legacy-migrations" }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(/"\.\/legacy-migrations".*"\.\/db\/migrations"/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('normalized-EQUIVALENT migrations_dir spellings are kept untouched (byte-identical file)', () => {
    // `db/migrations` vs `./db/migrations` vs `db/migrations/` all normalize equal
    // (wrangler's normalizeRelativePath rule) — the user's spelling survives.
    for (const existing of ['db/migrations', './db/migrations', 'db/migrations/']) {
      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "id", "migrations_dir": ${JSON.stringify(existing)} }
  ]
}`,
      );
      const before = readRaw('wrangler.jsonc');
      const result = writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      });
      expect(result.modified).toBe(false);
      expect(result.d1MigrationsDirSkipped).toBe(false);
      expect(readRaw('wrangler.jsonc')).toBe(before);
    }
  });

  it('fill-if-absent still validates a companion migrations_pattern — throws without writing', () => {
    // The entry has a pattern but NO migrations_dir; filling Void's default dir would
    // invalidate the pattern (wrangler requires it to start with `${migrations_dir}/`).
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_pattern": "drizzle/*/migration.sql"
    }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(/"migrations_pattern": "drizzle\/\*\/migration\.sql", which is not under/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('a DEFINED non-string migrations_pattern fails closed BEFORE any fill/keep branch — byte-identical file', () => {
    // Pre-fix the pattern compatibility check ran only for `typeof === "string"`, so an
    // object/array/number/null pattern was silently IGNORED, migrations_dir was
    // committed, provisioning reported success — and wrangler's own d1 migrations
    // commands later rejected the config we just accepted.
    const badPatterns: Array<[label: string, json: string]> = [
      ['object', '{ "glob": "*.sql" }'],
      ['array', '["*.sql"]'],
      ['number', '42'],
      ['null', 'null'],
    ];
    for (const [label, json] of badPatterns) {
      // Once WITHOUT migrations_dir (the fill branch)...
      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_pattern": ${json}
    }
  ]
}`,
      );
      let before = readRaw('wrangler.jsonc');
      expect(
        () =>
          writeProvisionedWranglerConfig(tmpDir, {
            d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
          }),
        `pattern kind: ${label} (fill branch)`,
      ).toThrow(/non-string "migrations_pattern"/);
      expect(readRaw('wrangler.jsonc'), `pattern kind: ${label} (fill branch)`).toBe(before);

      // ...and once WITH an equivalent migrations_dir (the keep-equivalent branch):
      // the non-string pattern must be rejected before EVERY branch, not only fill.
      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": "./db/migrations",
      "migrations_pattern": ${json}
    }
  ]
}`,
      );
      before = readRaw('wrangler.jsonc');
      expect(
        () =>
          writeProvisionedWranglerConfig(tmpDir, {
            d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
          }),
        `pattern kind: ${label} (keep-equivalent branch)`,
      ).toThrow(/non-string "migrations_pattern"/);
      expect(readRaw('wrangler.jsonc'), `pattern kind: ${label} (keep-equivalent branch)`).toBe(
        before,
      );
    }
  });

  it('migrations_dir upsert proceeds when there is no migrations_pattern (unchanged behavior, idempotent)', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "id" }
  ]
}`,
    );

    const patch = { d1MigrationsDir: { binding: 'DB', dir: 'drizzle' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'drizzle' });

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('migrations_dir upsert is a no-op when a compatible migrations_pattern already matches the requested dir', () => {
    // The existing pattern is under the requested dir, so setting the (already
    // equal) migrations_dir is a byte-idempotent no-op that leaves the pattern
    // untouched.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": "db/migrations",
      "migrations_pattern": "db/migrations/0001_init.sql"
    }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(false);
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

  it('fails closed on a composite (non-string) migrations_dir on the matched D1 entry — throws without writing', () => {
    // The provisioner rejects the malformed value BEFORE any edit (previously the comment-drop
    // gate caught it after the fact) — the file is never touched either way.
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
    ).toThrow(/non-string "migrations_dir" value; expected a string/);
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

  // Adopt fields — write the REAL id/name of an already-existing resource into
  // the binding's entry (the CREATE path can't, since `wrangler <res> create
  // --update-config` errors on a name collision). Upsert-existing + upsert-new +
  // idempotent-rerun + comment-preserved, for each of d1/kv/r2/hyperdrive.

  it('d1 adopt: overwrites a placeholder database_id/database_name in place, keeps comments, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — comments must survive adoption.
  "d1_databases": [
    { "binding": "DB", "database_name": "default", "database_id": "local" }
  ]
}`,
    );

    const patch = {
      d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: 'real-uuid-123' },
    };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// Void manages this file');

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    // No duplicate entry — the placeholder was updated in place.
    expect(d1).toHaveLength(1);
    expect(d1[0]).toEqual({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: 'real-uuid-123',
    });

    // Idempotent — a second run is byte-identical.
    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('d1 adopt: creates the d1_databases entry when the binding is absent', () => {
    setup('wrangler.jsonc', '{ "name": "app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: 'real-uuid-123' },
    });
    expect(result.modified).toBe(true);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(1);
    expect(d1[0]).toEqual({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: 'real-uuid-123',
    });
  });

  it('d1 adopt composes with d1MigrationsDir on the same binding (the real adopt path)', () => {
    // The adopt path passes both: capture the real id AND set migrations_dir. Even
    // when the D1 entry is absent, adopt creates it and migrations_dir lands on it.
    setup('wrangler.jsonc', '{ "name": "app" }');
    const patch = {
      d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: 'real-uuid-123' },
      d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
    };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    expect(first.d1MigrationsDirSkipped).toBe(false);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(1);
    expect(d1[0]).toMatchObject({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: 'real-uuid-123',
      migrations_dir: './db/migrations',
    });

    // Idempotent.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('kv adopt: overwrites a placeholder id in place, keeps comments, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // comment must survive
  "kv_namespaces": [
    { "binding": "ISR_CACHE", "id": "local" }
  ]
}`,
    );
    const patch = { kv: { binding: 'ISR_CACHE', id: 'realkvid456' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// comment must survive');

    const kv = parseRaw('wrangler.jsonc').kv_namespaces as Array<Record<string, unknown>>;
    expect(kv).toHaveLength(1);
    expect(kv[0]).toEqual({ binding: 'ISR_CACHE', id: 'realkvid456' });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('kv adopt: creates the kv_namespaces entry when the binding is absent', () => {
    setup('wrangler.jsonc', '{ "name": "app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      kv: { binding: 'KV', id: 'realkvid456' },
    });
    expect(result.modified).toBe(true);
    const kv = parseRaw('wrangler.jsonc').kv_namespaces as Array<Record<string, unknown>>;
    expect(kv).toEqual([{ binding: 'KV', id: 'realkvid456' }]);
  });

  it('r2 adopt: overwrites a placeholder bucket_name in place, keeps comments, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // comment must survive
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "default" }
  ]
}`,
    );
    const patch = { r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// comment must survive');

    const r2 = parseRaw('wrangler.jsonc').r2_buckets as Array<Record<string, unknown>>;
    expect(r2).toEqual([{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('r2 adopt: creates the r2_buckets entry when the binding is absent', () => {
    setup('wrangler.jsonc', '{ "name": "app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' },
    });
    expect(result.modified).toBe(true);
    const r2 = parseRaw('wrangler.jsonc').r2_buckets as Array<Record<string, unknown>>;
    expect(r2).toEqual([{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }]);
  });

  it('hyperdrive adopt: overwrites the id in place, keeps comments, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // comment must survive
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "local" }
  ]
}`,
    );
    const patch = { hyperdrive: { binding: 'HYPERDRIVE', id: 'realhyperid789' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// comment must survive');

    const hd = parseRaw('wrangler.jsonc').hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: 'realhyperid789' }]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('hyperdrive adopt: creates the hyperdrive entry when the binding is absent', () => {
    setup('wrangler.jsonc', '{ "name": "app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      hyperdrive: { binding: 'HYPERDRIVE', id: 'realhyperid789' },
    });
    expect(result.modified).toBe(true);
    const hd = parseRaw('wrangler.jsonc').hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: 'realhyperid789' }]);
  });

  // Adopt-field invariants — the append path must uphold the SAME worker-wide
  // binding-uniqueness rules the queue-producer guard enforces, and the update
  // path must fail closed on an ambiguous duplicate binding in the target array.

  it('adopt fails closed when the binding is already used by a DIFFERENT resource type (worker-wide collision) — no write', () => {
    // A KV is already bound `DB`; adopting a D1 as `DB` would emit a cross-type
    // duplicate binding name wrangler rejects at deploy. Fail closed.
    setup('wrangler.jsonc', '{ "kv_namespaces": [{ "binding": "DB", "id": "abc" }] }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when the binding collides with a var name — no write', () => {
    setup('wrangler.jsonc', '{ "vars": { "STORAGE": "x" } }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        r2: { binding: 'STORAGE', bucketName: 'uploads' },
      }),
    ).toThrow(
      /cannot adopt "STORAGE" into "r2_buckets".*already used by an? Environment Variable/s,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when the target array already declares the binding twice (ambiguous) — no write', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "a", "database_id": "id-a" },
    { "binding": "DB", "database_name": "b", "database_id": "id-b" }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('negative control: adopt appends normally when the binding collides with nothing, and is idempotent', () => {
    // A D1 binding `DB` and a KV binding `KV` do NOT collide with adopting an R2
    // as `STORAGE` — the worker-wide guard is precise, not paranoid.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "id" }],
  "kv_namespaces": [{ "binding": "KV", "id": "abc" }]
}`,
    );
    const patch = { r2: { binding: 'STORAGE', bucketName: 'uploads' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const r2 = parseRaw('wrangler.jsonc').r2_buckets as Array<Record<string, unknown>>;
    expect(r2).toEqual([{ binding: 'STORAGE', bucket_name: 'uploads' }]);

    // Idempotent — a second run writes nothing and is byte-identical.
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('honors an explicit configPath option (writes the pinned file, not discovery)', () => {
    // The provisioner pins the exact file so read-first + wrangler -c + this write
    // never diverge. With both files present, discovery would prefer .jsonc; the
    // explicit option must win and write .json.
    setup('wrangler.jsonc', '{ "name": "jsonc" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json" }');
    const jsonPath = join(tmpDir, 'wrangler.json');
    const result = writeProvisionedWranglerConfig(
      tmpDir,
      { accountId: 'acc-pinned' },
      { configPath: jsonPath },
    );
    expect(result.configPath).toBe(jsonPath);
    expect((parseRaw('wrangler.json') as Record<string, unknown>).account_id).toBe('acc-pinned');
    // The .jsonc (which discovery would have preferred) is untouched.
    expect((parseRaw('wrangler.jsonc') as Record<string, unknown>).account_id).toBeUndefined();
  });

  // Adopt collision guards must be built from the CURRENT text, cover MATCHED
  // (existing-target) entries, include queues.producers, and reject duplicate D1
  // migration targets — not just the append/initial-parse cases.

  it('adopt fails closed when the binding collides with an existing queue PRODUCER binding — no write', () => {
    // An existing queue producer already binds `DB`; adopting a D1 as `DB` would
    // emit a cross-type duplicate binding name wrangler rejects at deploy. The base
    // collector omits producers, so the adopt guard must layer them back in.
    setup(
      'wrangler.jsonc',
      `{
  "queues": { "producers": [{ "queue": "jobs", "binding": "DB" }] }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a Queue binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when TWO adopts in one patch request the same binding (current-text rebuild, not stale map)', () => {
    // A single patch adopting the same binding into two arrays would, with a map
    // built once from the INITIAL parse, append both. The guard rebuilds from the
    // current text before each adopt, so the second sees the first and fails closed.
    setup('wrangler.jsonc', '{ "name": "app" }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DUP', databaseName: 'app', databaseId: 'real-uuid' },
        kv: { binding: 'DUP', id: 'real-kv-id' },
      }),
    ).toThrow(/cannot adopt "DUP" into "kv_namespaces".*already used by a D1 Database binding/s);
    // Fail closed — nothing written (the d1 append is discarded because the whole
    // write only commits past the final gate).
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed on a MATCHED existing-target entry whose binding also collides cross-type — no write', () => {
    // The target D1 entry already exists (matched, not appended) AND a KV binds the
    // same name — an undeployable cross-type duplicate. The MATCHED/update path must
    // fail closed too, not just the append path.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "local" }],
  "kv_namespaces": [{ "binding": "DB", "id": "abc" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when a collected field has a malformed member masking a real binding — no write', () => {
    // kv_namespaces holds a null member AND a valid { binding: 'DB' }. The collector
    // must NOT silently drop the null and lose the 'DB' binding — adopting a D1 as
    // 'DB' would then emit an undeployable cross-type duplicate. Reject the whole
    // config (fail closed) instead of committing the conflicting binding.
    setup(
      'wrangler.jsonc',
      JSON.stringify({ kv_namespaces: [null, { binding: 'DB', id: 'kv-id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('producer append fails closed on a mixed-malformed binding field rather than silently dropping', () => {
    // A namespace field with a null member alongside a valid binding must reject the
    // whole config when the worker-wide uniqueness collector reads it — never a
    // partial read that could hide a collision.
    setup(
      'wrangler.jsonc',
      JSON.stringify({ d1_databases: [null, { binding: 'DB', database_id: 'id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('collector fails closed on a malformed binding-list member — no write', () => {
    // The `{ bindings: [...] }` shape (durable_objects/unsafe) is equally strict: a
    // malformed member throws rather than falling through to a partial read.
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: { bindings: [null, { name: 'DO', class_name: 'C' }] },
      }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "name"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list with ALL members malformed ({bindings:[null]}) throws — no plain-map fall-through', () => {
    // The sibling gap left open: when NO member is a record, the old
    // `some(isRecord)` guard fell through and read the field as a plain map (a bogus
    // binding named "bindings"), hiding the malformed binding entirely. Field-aware
    // strict validation throws even when every member is malformed.
    setup('wrangler.jsonc', JSON.stringify({ durable_objects: { bindings: [null] } }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "name"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton binding with a non-string binding (ai:{binding:123}) throws — not a silent empty set', () => {
    // wrangler's getBindingNames returns `[value.binding]` for a singleton with NO type
    // check, so a non-string slips in as a bogus name and a malformed one contributes
    // nothing. Field-aware strict validation rejects the whole config.
    setup('wrangler.jsonc', JSON.stringify({ ai: { binding: 123 } }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"ai" has a malformed "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('malformed secrets.required member throws — never a silent skip', () => {
    setup('wrangler.jsonc', JSON.stringify({ secrets: { required: ['API_KEY', null] } }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"secrets\.required" contains a malformed entry at index 1/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('malformed queues.producers member throws on the adopt path — never a silent skip', () => {
    // The adopt guard layers existing producers into its owner map
    // (addQueueProducerOwners); a null producer must reject the whole config rather
    // than be dropped (which could hide a real producer-binding collision).
    setup(
      'wrangler.jsonc',
      JSON.stringify({ queues: { producers: [null, { queue: 'q', binding: 'QUEUE_X' }] } }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/"queues\.producers" contains a malformed entry at index 0/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt TARGET array with a mixed valid+malformed member throws — not a silent skip', () => {
    // Adopting into kv_namespaces whose array holds a null beside a valid { binding:'KV' }.
    // The owner collector EXCLUDES the target field, so the malformed member is caught
    // only by the strict target-field validation the adopt path now runs before mutating.
    setup(
      'wrangler.jsonc',
      JSON.stringify({ kv_namespaces: [null, { binding: 'KV', id: 'kv-id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        kv: { binding: 'KV', id: 'real-id' },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('migrations_dir fails closed when the D1 binding is declared more than once (no findIndex-first)', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "a", "database_id": "id-a" },
    { "binding": "DB", "database_name": "b", "database_id": "id-b" }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('producer upsert fails closed when the EXISTING queues.producers list has a null member', () => {
    // The producer-upsert path previously cloned queues.producers and silently skipped
    // non-record members, committing a new producer beside a corrupt list. It now routes
    // the existing list through the SAME strict validator the adopt guard uses.
    setup('wrangler.jsonc', JSON.stringify({ queues: { producers: [null] } }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"queues\.producers" contains a malformed entry at index 0/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('collector fails closed on a malformed stream/media/websearch singleton binding', () => {
    // These singleton `{ binding }` fields were OMITTED from the strict set, so a
    // present-but-non-string binding silently contributed nothing (wrangler quirk).
    for (const field of ['stream', 'media', 'websearch']) {
      setup('wrangler.jsonc', JSON.stringify({ [field]: { binding: 123 } }));
      const before = readRaw('wrangler.jsonc');
      expect(() =>
        writeProvisionedWranglerConfig(tmpDir, {
          queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
        }),
      ).toThrow(new RegExp(`"${field}" has a malformed "binding"`));
      expect(readRaw('wrangler.jsonc')).toBe(before);
    }
  });

  it('collector fails closed on a wrong-shaped binding-list field (durable_objects as array)', () => {
    // durable_objects must be `{ bindings: [...] }`; an array is the wrong outer shape
    // and must throw rather than fall back to generic key collection (under-collection
    // could hide a real binding collision).
    setup('wrangler.jsonc', JSON.stringify({ durable_objects: [{ name: 'DO', class_name: 'C' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"durable_objects" must be an object with a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('collector fails closed on a wrong-shaped name-keyed field (send_email as object)', () => {
    // send_email must be an array of `{ name }`; a non-array is the wrong outer shape and
    // must throw rather than be re-read as a key-map.
    setup('wrangler.jsonc', JSON.stringify({ send_email: { EMAIL: {} } }));
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"send_email" must be an array of binding entries/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('negative control: valid stream/media/websearch singletons + unsafe-with-only-metadata do NOT throw', () => {
    // A well-formed singleton contributes its binding name; `unsafe` with only metadata
    // (no bindings) contributes nothing — neither should trip the strict collector.
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        stream: { binding: 'STREAM' },
        media: { binding: 'MEDIA' },
        websearch: { binding: 'SEARCH' },
        unsafe: { metadata: { foo: 'bar' } },
      }),
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    const producers = (parsed.queues as Record<string, unknown>).producers as Array<
      Record<string, unknown>
    >;
    expect(producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
  });
});

describe('writeProvisionedWranglerConfig — email (Mode B): sendEmail / addresses / vars', () => {
  const readRaw = (f: string): string => readFileSync(join(tmpDir, f), 'utf-8');
  const parseRaw = (f: string): Record<string, unknown> =>
    parseJsoncRaw(readRaw(f), undefined, { allowTrailingComma: true }) as Record<string, unknown>;

  // Comments everywhere a jsonc edit could disturb them, and trailing commas at
  // every level — the shape a hand-edited wrangler.jsonc really has.
  const emailFixture = `{
  // Void manages this file — every comment below must survive.
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
  /* Email Sending binding, hand-declared with a destination restriction. */
  "send_email": [
    { "name": "SEND_EMAIL", "destination_address": "ops@acme.com" }, // restricted
  ],
  "addresses": [
    "support@mail.acme.com", // routed here
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`;

  it('sendEmail: creates the send_email array with exactly one { name } entry when absent, keeping comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  // header
  "name": "acme-support", // worker name
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// header');
    expect(raw).toContain('// worker name');
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([{ name: 'SEND_EMAIL' }]);
  });

  it('sendEmail: never duplicates a matching entry and leaves its user-owned fields alone (byte-identical)', () => {
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([
      { name: 'SEND_EMAIL', destination_address: 'ops@acme.com' },
    ]);
  });

  it('sendEmail: appends beside a differently-named entry without touching it, and is idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  "send_email": [
    { "name": "NOTIFY", "destination_address": "ops@acme.com" }, // theirs
  ],
}`,
    );
    const patch = { sendEmail: { name: 'SEND_EMAIL' } };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// theirs');
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([
      { name: 'NOTIFY', destination_address: 'ops@acme.com' },
      { name: 'SEND_EMAIL' },
    ]);
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('sendEmail: fails closed when the name is already held by another binding type — no write', () => {
    setup('wrangler.jsonc', `{ "kv_namespaces": [{ "binding": "SEND_EMAIL", "id": "abc" }] }`);
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } }),
    ).toThrow(
      /cannot adopt "SEND_EMAIL" into "send_email".*already used by a KV Namespace binding/s,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('sendEmail: fails closed when send_email already declares the name twice — no write', () => {
    setup(
      'wrangler.jsonc',
      `{ "send_email": [{ "name": "SEND_EMAIL" }, { "name": "SEND_EMAIL" }] }`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } }),
    ).toThrow(/binding "SEND_EMAIL" is declared 2 times in "send_email"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: sets the whole array (creating it), keeping every comment and trailing commas', () => {
    setup(
      'wrangler.jsonc',
      `{
  // header
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      addresses: ['support@mail.acme.com', '*@acme.com'],
    });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// header');
    expect(raw).toContain('// worker name');
    expect(raw).toContain('// user var');
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.addresses).toEqual(['support@mail.acme.com', '*@acme.com']);
    expect(parsed.vars).toEqual({ APP_ENV: 'production' });
  });

  it('addresses: replaces an existing array outright (Void owns it) and is byte-identical on re-run', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
  "addresses": ["old@mail.acme.com", "gone@mail.acme.com"],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const patch = { addresses: ['support@mail.acme.com'] };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// worker name');
    expect(raw).toContain('// cache');
    expect(parseRaw('wrangler.jsonc').addresses).toEqual(['support@mail.acme.com']);
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('addresses: an equal array is a no-op even when it carries comments inside', () => {
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      addresses: ['support@mail.acme.com'],
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: a DIFFERENT array cannot be written over comments nested inside the old one — throws without writing', () => {
    // Void owns the array, but the writer never drops a comment: the generic
    // comment gate refuses instead of silently discarding `// routed here`.
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { addresses: ['sales@mail.acme.com'] }),
    ).toThrow(/would drop a comment \(\/\/ routed here\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: null deletes the key, keeps the previous sibling’s trailing comment and the blank line is gone', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
  "addresses": ["support@mail.acme.com"],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toBe(`{
  "name": "acme-support", // worker name
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`);
    expect(parseRaw('wrangler.jsonc')).not.toHaveProperty('addresses');
    // Deleting an absent key is a no-op.
    expect(writeProvisionedWranglerConfig(tmpDir, { addresses: null }).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('addresses: null on the LAST member of a strict .json file removes the preceding comma (no trailing comma left)', () => {
    setup(
      'wrangler.json',
      `{
  "name": "acme-support",
  "addresses": ["support@mail.acme.com"]
}`,
    );
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.json');
    expect(raw).toBe(`{
  "name": "acme-support"
}`);
    expect(JSON.parse(raw)).toEqual({ name: 'acme-support' });
  });

  it('addresses: null keeps the removed member’s own trailing comment and a full-line comment above it', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support",
  // inbound mail
  "addresses": ["support@mail.acme.com"], // managed by void
  "vars": { "A": "1" },
}`,
    );
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// inbound mail');
    expect(raw).toContain('// managed by void');
    expect(parseRaw('wrangler.jsonc')).toEqual({ name: 'acme-support', vars: { A: '1' } });
  });

  it('addresses: null with CR-only line endings stays valid and keeps the trailing comment', () => {
    const crOnly = `{\r  "name": "acme-support", // worker name\r  "addresses": ["support@mail.acme.com"],\r  "vars": { "A": "1" },\r}`;
    setup('wrangler.jsonc', crOnly);
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// worker name');
    expect(raw).not.toContain('\n');
    expect(parseRaw('wrangler.jsonc')).toEqual({ name: 'acme-support', vars: { A: '1' } });
  });

  it('vars: creates the vars object when absent, keeping the trailing comment on the last member', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' },
    });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"name": "acme-support", // worker name');
    expect(parseRaw('wrangler.jsonc').vars).toEqual({ __VOID_EMAIL_FROM: 'support@mail.acme.com' });
  });

  it('vars: upserts only the named keys — a changed value is overwritten, siblings and their comments stay, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  "vars": {
    "APP_ENV": "production", // user var
    "__VOID_EMAIL_FROM": "old@mail.acme.com",
  },
}`,
    );
    const patch = { vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' } };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// user var');
    expect(parseRaw('wrangler.jsonc').vars).toEqual({
      APP_ENV: 'production',
      __VOID_EMAIL_FROM: 'support@mail.acme.com',
    });
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('vars: fails closed when the key is already another binding’s name, or when vars is not an object — no write', () => {
    setup(
      'wrangler.jsonc',
      `{ "kv_namespaces": [{ "binding": "__VOID_EMAIL_FROM", "id": "abc" }] }`,
    );
    let before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { vars: { __VOID_EMAIL_FROM: 'x@y' } }),
    ).toThrow(/cannot write var "__VOID_EMAIL_FROM".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);

    setup('wrangler.jsonc', `{ "vars": ["not", "an", "object"] }`);
    before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { vars: { __VOID_EMAIL_FROM: 'x@y' } }),
    ).toThrow(/"vars" must be an object mapping names to values/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('the full Mode B patch composes: send_email + addresses + vars in one write, every comment survives, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — every comment below must survive.
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const patch = {
      sendEmail: { name: 'SEND_EMAIL' },
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' },
    };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    for (const comment of [
      '// Void manages this file',
      '// worker name',
      '// user var',
      '// cache',
    ]) {
      expect(raw).toContain(comment);
    }
    expect(parseRaw('wrangler.jsonc')).toEqual({
      name: 'acme-support',
      vars: { APP_ENV: 'production', __VOID_EMAIL_FROM: 'support@mail.acme.com' },
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
    });
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);

    // A later preflight finding routing off withdraws `addresses` only.
    expect(writeProvisionedWranglerConfig(tmpDir, { addresses: null }).modified).toBe(true);
    const withdrawn = readRaw('wrangler.jsonc');
    for (const comment of [
      '// Void manages this file',
      '// worker name',
      '// user var',
      '// cache',
    ]) {
      expect(withdrawn).toContain(comment);
    }
    expect(parseRaw('wrangler.jsonc')).toEqual({
      name: 'acme-support',
      vars: { APP_ENV: 'production', __VOID_EMAIL_FROM: 'support@mail.acme.com' },
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
      send_email: [{ name: 'SEND_EMAIL' }],
    });
  });
});

describe('writeProvisionedWranglerConfig — producer collision on EVERY upsert', () => {
  const readRaw = (f: string): string => readFileSync(join(tmpDir, f), 'utf-8');
  const parseRaw = (f: string): Record<string, unknown> =>
    parseJsoncRaw(readRaw(f)) as Record<string, unknown>;

  it('fails closed on the IDEMPOTENT same-queue producer path when the binding cross-type collides — throws (not a silent modified:false)', () => {
    // A D1 named QUEUE_JOBS PLUS an existing producer QUEUE_JOBS for the SAME queue: the
    // config is already undeployable (cross-type binding-name collision wrangler
    // rejects). The old code took the `index >= 0` path and returned `modified:false`,
    // silently accepting it. The worker-wide collision check now runs for EVERY producer
    // upsert (matched/idempotent AND append), so the idempotent path fails closed too.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "QUEUE_JOBS", "database_name": "app", "database_id": "id" }],
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by a D1 Database binding/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on the idempotent path when a matched producer binding collides with a var name', () => {
    setup(
      'wrangler.jsonc',
      `{
  "vars": { "QUEUE_JOBS": "some-value" },
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/"QUEUE_JOBS" is already used by an? Environment Variable binding/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on the idempotent path when a MALFORMED other binding field would mask a collision', () => {
    // A null kv_namespaces member alongside the idempotent producer: the collector now
    // runs on the idempotent path too, so a partially-readable binding set fails closed
    // rather than silently accepting the config with modified:false.
    setup(
      'wrangler.jsonc',
      `{
  "kv_namespaces": [null, { "binding": "KV", "id": "abc" }],
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('negative control: idempotent same-queue producer with NO cross-type collision stays a no-op (modified:false)', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
    // The producer is untouched.
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });
});

describe('worker-wide binding collector — schema-metadata field shapes', () => {
  const readRaw = (f: string): string => readFileSync(join(tmpDir, f), 'utf-8');
  const parseRaw = (f: string): Record<string, unknown> =>
    parseJsoncRaw(readRaw(f)) as Record<string, unknown>;

  // Every case drives the collector through a queue-producer append of QUEUE_JOBS.
  const appendProducer = () =>
    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });

  it('key-map: a `vars` value that LOOKS like a binding list is collected as KEYS (not misread) — no false collision', () => {
    // A var literally named "bindings" holding an array-of-records VALUE. The old
    // content-guessing read the nested `.name` ("QUEUE_JOBS") and falsely flagged a
    // collision. Key-map handling collects the KEY ("bindings"), so the append proceeds.
    setup('wrangler.jsonc', JSON.stringify({ vars: { bindings: [{ name: 'QUEUE_JOBS' }] } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });

  it('key-map: a `vars` key named "binding" reports the KEY, not its VALUE — no false collision', () => {
    // A var named "binding" whose VALUE is "QUEUE_JOBS". The old singleton misread
    // returned the VALUE ("QUEUE_JOBS") → false collision. Key-map collects the KEY
    // ("binding"), so the QUEUE_JOBS producer appends cleanly.
    setup('wrangler.jsonc', JSON.stringify({ vars: { binding: 'QUEUE_JOBS' } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('key-map: a real KEY collision (a var named QUEUE_JOBS) still fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: { QUEUE_JOBS: { bindings: [] } } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /"QUEUE_JOBS" is already used by an? Environment Variable binding/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('key-map: a wrong-shaped `vars` (array, not object) fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: [{ QUEUE_JOBS: 'x' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"vars" must be an object mapping names to values/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a required singleton (ai) with NO binding fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ ai: {} }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"ai" requires a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a required singleton (browser) present with only OTHER keys fails closed (not mis-collected)', () => {
    // The old fall-through read `{ remote: true }` via generic key collection, inventing
    // a bogus "remote" binding name. The required-binding rule fails closed instead.
    setup('wrangler.jsonc', JSON.stringify({ browser: { remote: true } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"browser" requires a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a wrong-shaped required singleton (ai as array) fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ ai: [{ binding: 'AI' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"ai" must be an object with a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: the OPTIONAL `assets` binding with only a directory contributes nothing (no throw, no bogus name)', () => {
    // The old fall-through mis-collected "directory" as a binding name. assets is
    // binding-optional, so it now contributes nothing and the producer appends.
    setup('wrangler.jsonc', JSON.stringify({ assets: { directory: './public' } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('binding-list: durable_objects missing the REQUIRED `bindings` array fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ durable_objects: {} }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"durable_objects" requires a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: logfwdr missing the REQUIRED `bindings` array fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ logfwdr: { schema: 'x' } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"logfwdr" requires a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: a durable_objects member missing its `name` identity fails closed', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ durable_objects: { bindings: [{ class_name: 'C' }] } }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: `unsafe.bindings` is OPTIONAL — metadata-only unsafe contributes nothing (no throw)', () => {
    setup('wrangler.jsonc', JSON.stringify({ unsafe: { metadata: { foo: 'bar' } } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('no false rejection: a VALID full config across every shape is collected correctly and the producer appends', () => {
    // A rich, well-formed config exercising key-map / singleton / binding-list /
    // namespace-array / name-keyed shapes — none of which names QUEUE_JOBS — must NOT
    // be rejected. (A real cross-type collision would still fail closed; see above.)
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        vars: { API_URL: 'https://x', bindings: [{ name: 'DECOY' }] },
        wasm_modules: { WASM_MOD: './m.wasm' },
        d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'id' }],
        kv_namespaces: [{ binding: 'KV', id: 'abc' }],
        ai: { binding: 'AI' },
        version_metadata: { binding: 'VERSION' },
        assets: { directory: './public' },
        durable_objects: { bindings: [{ name: 'DO', class_name: 'C' }] },
        unsafe: { metadata: { note: 'x' } },
        send_email: [{ name: 'EMAIL' }],
        ratelimits: [{ name: 'LIMIT', namespace_id: '1001', simple: { limit: 100, period: 60 } }],
        secrets: { required: ['SECRET_KEY'] },
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });
});

describe('name-keyed collector — send_email/ratelimits identity is `.name` only', () => {
  const readRaw = (f: string): string => readFileSync(join(tmpDir, f), 'utf-8');
  const parseRaw = (f: string): Record<string, unknown> =>
    parseJsoncRaw(readRaw(f)) as Record<string, unknown>;
  const appendProducer = () =>
    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });

  it('a send_email entry carrying an optional `.binding` does NOT collide with a DIFFERENT resource using that string', () => {
    // wrangler 4.131 keys send_email on `.name` ONLY (config-schema.json has no `.binding`
    // property; upload keys by `output[name]`). A mixed array `[{name,binding},{name}]` must
    // therefore leave the `.binding` string ("QUEUE_JOBS") FREE for a queue producer — the old
    // union of `.binding` invented a false "Send Email" collision and blocked the append.
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        send_email: [
          { name: 'EMAIL_A', binding: 'QUEUE_JOBS', destination_address: 'ops@example.com' },
          { name: 'EMAIL_B' },
        ],
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });

  it('a ratelimits entry carrying an optional `.binding` does NOT collide with a producer using that string', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        ratelimits: [
          {
            name: 'LIMIT_A',
            binding: 'QUEUE_JOBS',
            namespace_id: '1',
            simple: { limit: 100, period: 60 },
          },
        ],
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('a REAL same-`name` send_email collision is STILL caught (producer binding equals a send_email name)', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        send_email: [{ name: 'QUEUE_JOBS', destination_address: 'ops@example.com' }],
      }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"QUEUE_JOBS" is already used by a Send Email binding/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('a name-keyed member missing its `.name` identity STILL fails closed (fail-closed preserved)', () => {
    setup('wrangler.jsonc', JSON.stringify({ send_email: [{ binding: 'ONLY_BINDING' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });
});

describe('readProvisionedBindingEntry (strict canonical binding reader)', () => {
  const P = '/tmp/wrangler.jsonc';

  it('returns the single matching entry when the binding is unique across the worker', () => {
    const config = {
      d1_databases: [
        { binding: 'DB', database_id: 'id-a', database_name: 'app-db' },
        { binding: 'OTHER', database_id: 'id-b' },
      ],
      kv_namespaces: [{ binding: 'CACHE', id: 'kv-1' }],
    };
    expect(readProvisionedBindingEntry(config, 'd1_databases', 'DB', P)).toEqual({
      binding: 'DB',
      database_id: 'id-a',
      database_name: 'app-db',
    });
  });

  it('returns undefined when the binding is absent', () => {
    expect(
      readProvisionedBindingEntry({ d1_databases: [] }, 'd1_databases', 'DB', P),
    ).toBeUndefined();
    expect(readProvisionedBindingEntry({}, 'd1_databases', 'DB', P)).toBeUndefined();
  });

  it('fails closed on a DUPLICATE binding in the target field', () => {
    const config = {
      kv_namespaces: [
        { binding: 'CACHE', id: 'a' },
        { binding: 'CACHE', id: 'b' },
      ],
    };
    expect(() => readProvisionedBindingEntry(config, 'kv_namespaces', 'CACHE', P)).toThrow(
      /binding "CACHE" is declared 2 times in "kv_namespaces"/,
    );
  });

  it('fails closed on a CROSS-TYPE collision with another binding field', () => {
    const config = {
      d1_databases: [{ binding: 'DB', database_id: 'id-a' }],
      vars: { DB: 'oops' },
    };
    expect(() => readProvisionedBindingEntry(config, 'd1_databases', 'DB', P)).toThrow(
      /binding "DB" in "d1_databases" is also used by a Environment Variable binding/,
    );
  });

  it('fails closed on a CROSS-TYPE collision with a queue producer', () => {
    const config = {
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'b' }],
      queues: { producers: [{ binding: 'STORAGE', queue: 'jobs' }] },
    };
    expect(() => readProvisionedBindingEntry(config, 'r2_buckets', 'STORAGE', P)).toThrow(
      /binding "STORAGE" in "r2_buckets" is also used by a Queue binding/,
    );
  });

  it('fails closed on a malformed target field (wrong outer shape)', () => {
    expect(() =>
      readProvisionedBindingEntry({ d1_databases: { binding: 'DB' } }, 'd1_databases', 'DB', P),
    ).toThrow(/must be an array of binding entries/);
  });
});

// ---------------------------------------------------------------------------
// bindingEntriesForField mirrors bindingNamesForField's shape switch but returns
// each binding's NAME + its full config ENTRY object, so the deploy pass-through
// check can pin a binding's TARGET (service/namespace/type), not just its name.
// The two readers MUST agree on names for every shape, and both fail closed on a
// malformed member.
// ---------------------------------------------------------------------------

describe('bindingEntriesForField — entry reader parity with bindingNamesForField', () => {
  // One representative value per REACHABLE shape (key-map is excluded from the assert-set and
  // its entry reader throws by design — see the dedicated case below).
  const REPRESENTATIVE: Array<{ field: string; value: unknown }> = [
    // namespace-array
    {
      field: 'services',
      value: [
        { binding: 'MY_SVC', service: 'my-other-worker' },
        { binding: 'OTHER', service: 'w2', entrypoint: 'Fetcher' },
      ],
    },
    // name-keyed-array
    { field: 'send_email', value: [{ name: 'EMAIL', destination_address: 'to@example.com' }] },
    // singleton
    { field: 'browser', value: { binding: 'BROWSER', remote: true } },
    // binding-list
    { field: 'unsafe', value: { bindings: [{ name: 'X', type: 'secret_text' }] } },
    // whole-object (not a binding — pinned whole by the deploy verifier)
    { field: 'addresses', value: ['support@mail.acme.com', '*@acme.com'] },
  ];

  it('yields the SAME names as bindingNamesForField for a representative value of each shape', () => {
    for (const { field, value } of REPRESENTATIVE) {
      expect(bindingEntriesForField(field, value).map((e) => e.name)).toEqual(
        bindingNamesForField(field, value),
      );
    }
  });

  it('carries each binding’s full config entry object (so a retargeted binding is visible)', () => {
    const entries = bindingEntriesForField('services', [
      { binding: 'MY_SVC', service: 'my-other-worker' },
    ]);
    expect(entries).toEqual([
      { name: 'MY_SVC', entry: { binding: 'MY_SVC', service: 'my-other-worker' } },
    ]);
  });

  it('reads the singleton value itself as the entry, and an empty array as no entries', () => {
    expect(bindingEntriesForField('browser', { binding: 'BROWSER' })).toEqual([
      { name: 'BROWSER', entry: { binding: 'BROWSER' } },
    ]);
    // Empty-array assert fields (the normalizer default) → no entries → the deploy loop never runs.
    expect(bindingEntriesForField('services', [])).toEqual([]);
    // logfwdr is always emitted as { bindings: [] } → no entries.
    expect(bindingEntriesForField('logfwdr', { bindings: [] })).toEqual([]);
  });

  it('fails closed on a malformed member for each shape (mirrors the name reader)', () => {
    // namespace-array member missing `.binding`
    expect(() => bindingEntriesForField('services', [{ service: 'w' }])).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "binding"\)/,
    );
    // name-keyed-array member missing `.name`
    expect(() => bindingEntriesForField('send_email', [{ destination_address: 'x' }])).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
    // singleton (required) with no `.binding`
    expect(() => bindingEntriesForField('browser', { remote: true })).toThrow(
      /"browser" requires a "binding"/,
    );
    // binding-list member missing `.name`
    expect(() => bindingEntriesForField('unsafe', { bindings: [{ type: 'secret_text' }] })).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
  });

  it('addresses is a whole-object field: no binding names, no entries, never misread as a namespace-array', () => {
    // `addresses` is `string[]` (wrangler ≥ 4.113 Email Routing rules). The default
    // namespace-array reader would throw on its string members; the registry names it
    // whole-object so neither reader sees a binding in it — the deploy verifier pins the
    // value WHOLE instead (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS).
    const value = ['support@mail.acme.com', '*@acme.com'];
    expect(bindingNamesForField('addresses', value)).toEqual([]);
    expect(bindingEntriesForField('addresses', value)).toEqual([]);
    expect(bindingNamesForField('addresses', undefined)).toEqual([]);
  });

  it('fails closed when a key-map field is routed here (unreachable — asserts fail-closed)', () => {
    // All key-map fields (vars/wasm_modules/…) are EXCLUDED from the assert-set, so this reader is
    // never called with one. If a future misclassification did, it must throw rather than silently
    // return no entries.
    expect(() => bindingEntriesForField('vars', { A: '1' })).toThrow(
      /"vars" must be an object mapping names to values/,
    );
  });
});
