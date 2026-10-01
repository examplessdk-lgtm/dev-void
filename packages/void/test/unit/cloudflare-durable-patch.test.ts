import { describe, expect, it } from 'vite-plus/test';
import { finalizeDurableObjectPatch } from '../../src/cloudflare-durable-patch.ts';
import {
  assertSandboxNamespaceConfig,
  hasSandboxSqliteMigration,
  resolveSandboxConfig,
  SANDBOX_MIGRATION_TAG,
} from '../../src/sandbox/config.ts';

describe('Cloudflare durable feature patch', () => {
  const ws = { name: 'CHAT', class_name: 'Chat' };
  const sandbox = { name: 'SANDBOX', class_name: 'SandboxV1' };
  const live = { name: 'LIVE', class_name: 'Live' };
  const history = [
    { tag: 'custom-v1', new_sqlite_classes: ['History'] },
    { tag: 'custom-v2', renamed_classes: [{ from: 'History', to: 'Archived' }] },
    { tag: 'ws-v1', new_sqlite_classes: ['Chat'] },
  ];
  const additions = [
    { tag: 'sandbox-v2', new_sqlite_classes: ['SandboxV1'] },
    { tag: 'live-v1', new_sqlite_classes: ['Live'] },
  ];

  it('returns binding additions and retains the ordered authored migration prefix exactly once', () => {
    const foreign = {
      name: 'FOREIGN',
      class_name: 'Remote',
      script_name: 'another-worker',
      environment: 'production',
    };
    const original = { durable_objects: { bindings: [foreign, ws] }, migrations: history };
    const serialized = JSON.stringify(original);
    const resolved = structuredClone(original);
    const patch = {
      durable_objects: { bindings: [foreign, ws, sandbox, live, sandbox] },
      migrations: [...history, ...additions, additions[0]],
    };
    finalizeDurableObjectPatch(resolved, patch, [ws, sandbox, live]);
    expect(patch.durable_objects.bindings).toEqual([sandbox, live]);
    expect(resolved.durable_objects).toEqual(original.durable_objects);
    expect(patch.migrations).toEqual([...history, ...additions]);
    expect(resolved.migrations).toEqual([]);
    expect(JSON.stringify(original)).toBe(serialized);
  });

  it('keeps an identical repeat build from duplicating history or configured bindings', () => {
    const resolved = {
      durable_objects: { bindings: [ws, sandbox, live] },
      migrations: [...history, ...additions],
    };
    const patch = structuredClone(resolved);
    finalizeDurableObjectPatch(resolved, patch, [ws, sandbox, live]);
    expect(patch.durable_objects.bindings).toEqual([]);
    expect(patch.migrations).toEqual([...history, ...additions]);
  });

  it.each(['script_name', 'environment'])(
    'rejects silent generated local-class reuse of an external %s identity',
    (field) => {
      const resolved = { durable_objects: { bindings: [{ ...ws, [field]: 'foreign' }] } };
      expect(() => finalizeDurableObjectPatch(resolved, {}, [ws])).toThrow('configured identity');
      expect(resolved.durable_objects.bindings[0]).toHaveProperty(field, 'foreign');
    },
  );

  it('preserves optional undefined identity fields and authored development options on a local binding', () => {
    const binding = { ...ws, script_name: undefined, environment: undefined, remote: false };
    const resolved = { durable_objects: { bindings: [binding] } };
    const patch = structuredClone(resolved);
    finalizeDurableObjectPatch(resolved, patch, [ws]);
    expect(resolved.durable_objects.bindings).toEqual([binding]);
    expect(patch.durable_objects.bindings).toEqual([]);
  });

  it('refuses duplicate authored identities without silently rewriting their history', () => {
    const resolved = { durable_objects: { bindings: [ws, ws] }, migrations: history };
    expect(() => finalizeDurableObjectPatch(resolved, {}, [ws])).toThrow(
      'configured more than once',
    );
    expect(resolved.durable_objects.bindings).toEqual([ws, ws]);
    const migrations = [...history, history[0]];
    expect(() => finalizeDurableObjectPatch({ migrations }, {}, [])).toThrow(
      'configured more than once',
    );
    expect(migrations).toEqual([...history, history[0]]);
  });

  it('rejects conflicting binding fields instead of stripping the authored entry', () => {
    const resolved = { durable_objects: { bindings: [{ ...ws, class_name: 'Previous' }] } };
    expect(() =>
      finalizeDurableObjectPatch(resolved, { durable_objects: { bindings: [ws] } }, []),
    ).toThrow('conflicting configuration');
  });

  it('rejects conflicting migration payloads without clearing incoming history', () => {
    const resolved = { migrations: history };
    expect(() =>
      finalizeDurableObjectPatch(
        resolved,
        { migrations: [{ tag: 'custom-v1', new_classes: ['History'] }] },
        [],
      ),
    ).toThrow('conflicting configuration');
    expect(resolved.migrations).toBe(history);
  });

  it('rejects conflicts within cumulative pending entries', () => {
    expect(() =>
      finalizeDurableObjectPatch(
        {},
        { durable_objects: { bindings: [ws, { ...ws, script_name: 'foreign' }] } },
        [],
      ),
    ).toThrow('conflicting configuration');
    expect(() =>
      finalizeDurableObjectPatch(
        {},
        {
          migrations: [
            { tag: 'v1', new_classes: ['First'] },
            { tag: 'v1', new_classes: ['Second'] },
          ],
        },
        [],
      ),
    ).toThrow('conflicting configuration');
  });

  it('emits no configuration for an app with no durable features', () => {
    const resolved = {},
      patch = {};
    finalizeDurableObjectPatch(resolved, patch, []);
    expect(resolved).toEqual({});
    expect(patch).toEqual({});
  });
});

describe('Sandbox migration storage identity', () => {
  const sandbox = resolveSandboxConfig({ sandbox: true });
  const occupied = { tag: SANDBOX_MIGRATION_TAG, new_sqlite_classes: ['Unrelated'] };
  it('rejects an occupied reserved tag only when the required final SQLite class is missing', () => {
    expect(() => assertSandboxNamespaceConfig({ migrations: [occupied] }, sandbox)).toThrow(
      'already configured for another class',
    );
    expect(() =>
      assertSandboxNamespaceConfig(
        { migrations: [{ tag: 'custom', new_sqlite_classes: ['SandboxV1'] }, occupied] },
        sandbox,
      ),
    ).not.toThrow();
  });
  it('preserves a custom renamed SQLite class with an independently occupied reserved tag', () => {
    const history = [
      { tag: 'custom-v1', new_sqlite_classes: ['OriginalSandbox'] },
      { tag: 'custom-v2', renamed_classes: [{ from: 'OriginalSandbox', to: 'SandboxV1' }] },
      occupied,
    ];
    expect(hasSandboxSqliteMigration(history, 'SandboxV1')).toBe(true);
    expect(() => assertSandboxNamespaceConfig({ migrations: history }, sandbox)).not.toThrow();
  });
  it('distinguishes legacy storage and classes renamed away or deleted', () => {
    expect(hasSandboxSqliteMigration([{ new_classes: ['SandboxV1'] }], 'SandboxV1')).toBe(false);
    expect(
      hasSandboxSqliteMigration(
        [
          { new_sqlite_classes: ['SandboxV1'] },
          { renamed_classes: [{ from: 'SandboxV1', to: 'Archived' }] },
        ],
        'SandboxV1',
      ),
    ).toBe(false);
    expect(
      hasSandboxSqliteMigration(
        [{ new_sqlite_classes: ['SandboxV1'] }, { deleted_classes: ['SandboxV1'] }],
        'SandboxV1',
      ),
    ).toBe(false);
    expect(() =>
      assertSandboxNamespaceConfig(
        { migrations: [{ tag: 'custom', new_classes: ['SandboxV1'] }, occupied] },
        sandbox,
      ),
    ).toThrow('needs SQLite storage');
  });
  it.each([
    [{ tag: 'legacy', new_classes: ['SandboxV1'] }],
    [
      {
        tag: 'transfer',
        transferred_classes: [{ from_script: 'foreign', from: 'Original', to: 'SandboxV1' }],
      },
    ],
    [{ tag: 'rename', renamed_classes: [{ from: 'Unknown', to: 'SandboxV1' }] }],
  ])(
    'rejects an existing non-SQLite or unknown storage namespace before appending a duplicate class',
    (migrations) => {
      expect(() => assertSandboxNamespaceConfig({ migrations: [migrations] }, sandbox)).toThrow(
        'needs SQLite storage',
      );
    },
  );
  it('rejects external SDK namespace reuse while retaining unrelated external bindings', () => {
    expect(() =>
      assertSandboxNamespaceConfig(
        {
          durable_objects: {
            bindings: [{ name: 'SANDBOX', class_name: 'SandboxV1', script_name: 'foreign' }],
          },
        },
        sandbox,
      ),
    ).toThrow('local');
    expect(() =>
      assertSandboxNamespaceConfig(
        {
          durable_objects: {
            bindings: [{ name: 'OTHER', class_name: 'Foreign', script_name: 'foreign' }],
          },
        },
        sandbox,
      ),
    ).not.toThrow();
  });
});
