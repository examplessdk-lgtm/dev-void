import { describe, expect, it } from 'vite-plus/test';
import { validateManifestShape, type DeployManifest } from '../../src/index.ts';

function manifestWithMigration(migration: unknown): DeployManifest {
  return {
    version: 3,
    bindings: {},
    websocket: {
      routes: [],
      classes: ['Room'],
      migrations: [migration] as NonNullable<
        NonNullable<DeployManifest['websocket']>['migrations']
      >,
    },
  };
}

describe('WebSocket deployment manifest validation', () => {
  it('accepts legacy and SQLite Durable Object migration history', () => {
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', newClasses: ['LegacyRoom'] })),
    ).toBeNull();
    expect(
      validateManifestShape(
        manifestWithMigration({
          tag: 'ws-v2',
          newSqliteClasses: ['Room'],
          deletedClasses: ['RetiredRoom'],
        }),
      ),
    ).toBeNull();
  });

  it('rejects malformed migration tags and class lists', () => {
    expect(validateManifestShape(manifestWithMigration({ tag: '' }))).toContain(
      'non-empty string tag',
    );
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', newSqliteClasses: 'Room' })),
    ).toContain('newSqliteClasses must be an array of strings');
    expect(
      validateManifestShape(manifestWithMigration({ tag: 'ws-v1', deletedClasses: [1] })),
    ).toContain('deletedClasses must be an array of strings');
  });
});
