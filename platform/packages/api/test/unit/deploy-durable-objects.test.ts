import { describe, expect, it } from 'vite-plus/test';
import {
  buildDurableObjectUploadMigrations,
  buildLiveUploadBindings,
  buildSandboxIdentityBindings,
  buildSandboxPlatformBindings,
  buildSandboxUploadBindings,
  buildSandboxUploadContainers,
  buildWebSocketUploadBindings,
  buildWebSocketUploadMigrations,
  enrichLiveManifest,
  enrichSandboxManifest,
  enrichWebSocketManifest,
  validateManifestShape,
} from '../../src/routes/deploy.ts';
import type { DeployManifest } from '../../src/types.ts';

describe('enrichWebSocketManifest', () => {
  it('reuses previous websocket migrations when class sets are unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: '/chat/:room',
            filePath: 'chat/[room].ws.ts',
            className: 'ChatRoom',
            mode: 'room',
            hasAuthGate: true,
          },
        ],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: '/chat/:room',
              filePath: 'chat/[room].ws.ts',
              className: 'ChatRoom',
              mode: 'room',
              hasAuthGate: true,
            },
          ],
          classes: ['ChatRoom', 'ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual(previousManifest.websocket?.migrations);
  });

  it('appends migration when a genuinely new class is added', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('does not emit deletedClasses when classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom', 'LegacyRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — no migration step needed (no new classes)
    expect(result.nextVersion).toBe(1);
    // Class list updated but no new migration appended
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
    ]);
  });

  it('does not emit deletedClasses when all classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest({ version: 3, bindings: {} }, previousManifest, 1);

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // No new migration — nothing for CF to do
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
    expect(result.manifest.websocket?.classes).toEqual([]);
  });

  it('does not re-emit newClasses for a class that was previously created then removed', () => {
    // Scenario: class created in v1, removed in deploy 2, re-added in deploy 3
    // The class namespace already exists in CF — must NOT appear in newClasses again
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [], // was removed in a previous deploy
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-added
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — ChatRoom already exists in CF from ws-v1
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    // No new migration step — ChatRoom is not "new"
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
  });

  it('only emits newClasses for genuinely new classes when mixed with returning classes', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'], // ChatRoom returns, PresenceRoom is new
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('falls back to previousClasses when migration history is absent (legacy projects)', () => {
    // Legacy project: classes exist in CF but no migration history was recorded
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [], // no history — predates the migration system
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // Only PresenceRoom is new — ChatRoom already exists (from previousClasses fallback)
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('re-creates a class that was previously deleted via legacy deletedClasses', () => {
    // Legacy project had a class created then deleted (old behavior).
    // The namespace was actually destroyed — must re-create it.
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [
          { tag: 'ws-v1', newClasses: ['ChatRoom'] },
          { tag: 'ws-v2', deletedClasses: ['ChatRoom'] }, // namespace was destroyed
        ],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-adding after deletion
          migrations: [],
        },
      },
      previousManifest,
      2,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(3);
    // ChatRoom must appear in newClasses because its namespace was deleted
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', deletedClasses: ['ChatRoom'] },
      { tag: 'ws-v3', newSqliteClasses: ['ChatRoom'] },
    ]);
  });

  it('uses SQLite storage for a fresh hosted WebSocket deployment', () => {
    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: { routes: [], classes: ['ChatRoom'] },
      },
      null,
      0,
    );

    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newSqliteClasses: ['ChatRoom'] },
    ]);
  });
});

describe('buildWebSocketUploadMigrations', () => {
  it('returns Cloudflare upload metadata with new_tag and steps', () => {
    expect(
      buildWebSocketUploadMigrations([
        { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
        { tag: 'ws-v2', newClasses: ['PresenceRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['ChatRoom', 'LegacyRoom'] }, { new_classes: ['PresenceRoom'] }],
    });
  });

  it('strips deleted_classes from legacy migration data', () => {
    // Old migration data may still contain deletedClasses from before the fix.
    // buildWebSocketUploadMigrations should not pass them to Cloudflare.
    expect(
      buildWebSocketUploadMigrations([
        { tag: 'ws-v1', newClasses: ['ChatRoom'] },
        { tag: 'ws-v2', deletedClasses: ['ChatRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['ChatRoom'] }, {}],
    });
  });

  it('returns undefined when there are no websocket migrations', () => {
    expect(buildWebSocketUploadMigrations([])).toBeUndefined();
    expect(buildWebSocketUploadMigrations(undefined)).toBeUndefined();
  });

  it('serializes SQLite WebSocket migrations without changing legacy steps', () => {
    expect(
      buildWebSocketUploadMigrations([
        { tag: 'ws-v1', newClasses: ['LegacyRoom'] },
        { tag: 'ws-v2', newSqliteClasses: ['ChatRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['LegacyRoom'] }, { new_sqlite_classes: ['ChatRoom'] }],
    });
  });
});

describe('buildWebSocketUploadBindings', () => {
  it('serializes durable object namespaces from websocket routes', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [
          {
            pattern: '/ws/chat/:room',
            filePath: 'routes/ws/chat/[room].ws.ts',
            className: 'WsChatRoomWs',
            bindingName: 'CHAT_ROOM',
            mode: 'room',
            hasAuthGate: false,
          },
          {
            pattern: '/ws/presence',
            filePath: 'routes/ws/presence.ws.ts',
            className: 'WsPresenceWs',
            mode: 'socket',
            hasAuthGate: false,
          },
        ],
        classes: ['WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'CHAT_ROOM',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });

  it('falls back to class names when route metadata is unavailable', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [],
        classes: ['WsPresenceWs', 'WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'WsChatRoomWs',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });
});

describe('enrichSandboxManifest', () => {
  it('adds a SQLite Durable Object migration for the sandbox class', () => {
    const result = enrichSandboxManifest(
      {
        version: 3,
        bindings: {},
        sandbox: {
          bindingName: 'SANDBOX',
          className: 'Sandbox',
          containerName: 'void-sandbox',
          image: 'docker.io/cloudflare/sandbox:0.8.11',
        },
      },
      null,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.sandbox?.migrations).toEqual([
      { tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] },
    ]);
  });

  it('reuses previous sandbox migrations when the class is unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      sandbox: {
        bindingName: 'SANDBOX',
        className: 'Sandbox',
        containerName: 'void-sandbox',
        image: 'docker.io/cloudflare/sandbox:0.8.11',
        migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] }],
      },
    };

    const result = enrichSandboxManifest(
      {
        version: 3,
        bindings: {},
        sandbox: {
          bindingName: 'SANDBOX',
          className: 'Sandbox',
          containerName: 'void-sandbox',
          image: 'docker.io/cloudflare/sandbox:0.8.12',
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.sandbox?.migrations).toEqual(previousManifest.sandbox?.migrations);
  });
});

describe('enrichLiveManifest', () => {
  it('adds a SQLite Durable Object migration for the live stream class', () => {
    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject'],
        },
      },
      null,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live?.migrations).toEqual([
      { tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('reuses previous live migrations when the class is unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      live: {
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
        migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      },
    };

    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject', 'VoidLiveStreamDurableObject'],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live?.classes).toEqual(['VoidLiveStreamDurableObject']);
    expect(result.manifest.live?.migrations).toEqual(previousManifest.live?.migrations);
  });

  it('does not preserve previous live metadata when the current manifest omits live', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      live: {
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
        migrations: [{ tag: 'live-v1', newSqliteClasses: ['VoidLiveStreamDurableObject'] }],
      },
    };

    const result = enrichLiveManifest({ version: 3, bindings: {} }, previousManifest, 1);

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.live).toBeUndefined();
  });

  it('uses the shared Durable Object migration version sequence', () => {
    const result = enrichLiveManifest(
      {
        version: 3,
        bindings: {},
        live: {
          bindingName: 'VOID_LIVE',
          className: 'VoidLiveStreamDurableObject',
          storage: 'sqlite',
          classes: ['VoidLiveStreamDurableObject'],
        },
      },
      null,
      3,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(4);
    expect(result.manifest.live?.migrations).toEqual([
      { tag: 'live-v4', newSqliteClasses: ['VoidLiveStreamDurableObject'] },
    ]);
  });
});

describe('buildSandboxUploadMetadata', () => {
  const sandbox = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('serializes sandbox Durable Object bindings and container metadata', () => {
    expect(buildSandboxUploadBindings(sandbox)).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'SANDBOX',
        class_name: 'Sandbox',
      },
    ]);
    expect(buildSandboxUploadContainers(sandbox)).toEqual([{ class_name: 'Sandbox' }]);
  });

  it('combines websocket and sandbox migrations for Worker upload metadata', () => {
    expect(
      buildDurableObjectUploadMigrations(
        [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
        [{ tag: 'sandbox-v2', newSqliteClasses: ['Sandbox'] }],
      ),
    ).toEqual({
      new_tag: 'sandbox-v2',
      steps: [{ new_classes: ['ChatRoom'] }, { new_sqlite_classes: ['Sandbox'] }],
    });
  });

  it('combines live SQLite Durable Object migrations for Worker upload metadata', () => {
    expect(
      buildDurableObjectUploadMigrations([{ tag: 'ws-v1', newClasses: ['ChatRoom'] }], undefined, [
        { tag: 'live-v2', newSqliteClasses: ['VoidLiveStreamDurableObject'] },
      ]),
    ).toEqual({
      new_tag: 'live-v2',
      steps: [
        { new_classes: ['ChatRoom'] },
        { new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
      ],
    });
  });

  it('serializes live Durable Object binding metadata', () => {
    expect(
      buildLiveUploadBindings({
        bindingName: 'VOID_LIVE',
        className: 'VoidLiveStreamDurableObject',
        storage: 'sqlite',
        classes: ['VoidLiveStreamDurableObject'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'VOID_LIVE',
        class_name: 'VoidLiveStreamDurableObject',
      },
    ]);
  });

  it('preserves chronological migration tag order across websocket and sandbox migrations', () => {
    expect(
      buildDurableObjectUploadMigrations(
        [
          { tag: 'ws-v1', newClasses: ['ChatRoom'] },
          { tag: 'ws-v3', newClasses: ['PresenceRoom'] },
        ],
        [{ tag: 'sandbox-v2', newSqliteClasses: ['Sandbox'] }],
      ),
    ).toEqual({
      new_tag: 'ws-v3',
      steps: [
        { new_classes: ['ChatRoom'] },
        { new_sqlite_classes: ['Sandbox'] },
        { new_classes: ['PresenceRoom'] },
      ],
    });
  });
});

describe('buildSandboxPlatformBindings', () => {
  const sandbox: NonNullable<DeployManifest['sandbox']> = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('returns the queue producer binding when sandbox is present', () => {
    expect(
      buildSandboxPlatformBindings({ USAGE_EVENTS_QUEUE_NAME: 'void-usage-events' }, sandbox),
    ).toEqual([{ type: 'queue', name: 'USAGE_EVENTS_QUEUE', queue_name: 'void-usage-events' }]);
  });

  it('returns an empty list when sandbox is absent (no sandbox = no platform bindings)', () => {
    expect(
      buildSandboxPlatformBindings({ USAGE_EVENTS_QUEUE_NAME: 'void-usage-events' }, undefined),
    ).toEqual([]);
  });

  it('falls back to production defaults when env vars are unset', () => {
    expect(buildSandboxPlatformBindings({}, sandbox)).toEqual([
      { type: 'queue', name: 'USAGE_EVENTS_QUEUE', queue_name: 'void-usage-events' },
    ]);
  });

  it('honors staging overrides when env vars carry the staging names', () => {
    expect(
      buildSandboxPlatformBindings(
        { USAGE_EVENTS_QUEUE_NAME: 'void-usage-events-staging' },
        sandbox,
      ),
    ).toEqual([
      { type: 'queue', name: 'USAGE_EVENTS_QUEUE', queue_name: 'void-usage-events-staging' },
    ]);
  });
});

describe('buildSandboxIdentityBindings', () => {
  const sandbox: NonNullable<DeployManifest['sandbox']> = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('returns the __VOID_USER_ID plain-text binding the framework runtime reads', () => {
    expect(buildSandboxIdentityBindings(sandbox, { userId: 'user_1' })).toEqual([
      { type: 'plain_text', name: '__VOID_USER_ID', text: 'user_1' },
    ]);
  });

  it('does NOT emit __VOID_PROJECT_SLUG — provisionBindings is its sole producer', () => {
    // `void/email` needs the slug on every worker, not just sandbox ones, so
    // it moved to `provisionBindings`. Emitting it here too would upload the
    // same binding name twice in one `metadata.bindings` array.
    // `api-sandbox.test.ts` pins that sandbox workers still receive it.
    expect(
      buildSandboxIdentityBindings(sandbox, { userId: 'user_1' }).some(
        (b) => b.name === '__VOID_PROJECT_SLUG',
      ),
    ).toBe(false);
  });

  it('returns an empty list when sandbox is absent', () => {
    expect(buildSandboxIdentityBindings(undefined, { userId: 'user_1' })).toEqual([]);
  });
});

describe('validateManifestShape sandbox + static/spa rejection', () => {
  const sandbox = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: 'void-sandbox',
    image: 'docker.io/cloudflare/sandbox:0.8.11',
  };

  it('rejects manifest.sandbox when type is "static"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'static',
        sandbox,
      }),
    ).toBe('sandbox is not supported for static/spa deployments');
  });

  it('rejects manifest.sandbox when type is "spa"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'spa',
        sandbox,
      }),
    ).toBe('sandbox is not supported for static/spa deployments');
  });

  it('accepts manifest.sandbox when type is "void"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'void',
        sandbox,
      }),
    ).toBeNull();
  });

  it('accepts manifest.sandbox when type is omitted (defaults to void/framework)', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        sandbox,
      }),
    ).toBeNull();
  });

  it('accepts manifest.sandbox when type is "framework"', () => {
    expect(
      validateManifestShape({
        version: 3,
        bindings: {},
        type: 'framework',
        sandbox,
      }),
    ).toBeNull();
  });
});
