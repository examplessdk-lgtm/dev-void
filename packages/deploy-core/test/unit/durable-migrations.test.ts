import { describe, expect, it } from 'vite-plus/test';
import { appendSqliteClassMigration, planWebSocketMigrations } from '../../src/index.ts';

describe('Durable Object migration planning', () => {
  it('creates fresh WebSocket classes on SQLite storage', () => {
    expect(
      planWebSocketMigrations({
        nextClasses: ['ChatRoom'],
        previousClasses: [],
        previousMigrations: [],
        currentVersion: 0,
      }),
    ).toEqual({
      classes: ['ChatRoom'],
      migrations: [{ tag: 'ws-v1', newSqliteClasses: ['ChatRoom'] }],
      changed: true,
      nextVersion: 1,
    });
  });

  it('preserves legacy class history while adding SQLite classes', () => {
    expect(
      planWebSocketMigrations({
        nextClasses: ['PresenceRoom', 'LegacyRoom'],
        previousClasses: ['LegacyRoom'],
        previousMigrations: [{ tag: 'ws-v1', newClasses: ['LegacyRoom'] }],
        currentVersion: 1,
      }).migrations,
    ).toEqual([
      { tag: 'ws-v1', newClasses: ['LegacyRoom'] },
      { tag: 'ws-v2', newSqliteClasses: ['PresenceRoom'] },
    ]);
  });

  it('does not reclassify a legacy Wrangler migration', () => {
    expect(
      appendSqliteClassMigration(
        [{ tag: 'void-ws-v1', new_classes: ['LegacyRoom'] }],
        ['LegacyRoom'],
        'void-ws-v1',
      ),
    ).toEqual({
      migrations: [{ tag: 'void-ws-v1', new_classes: ['LegacyRoom'] }],
      added: false,
    });
  });

  it('grandfathers a configured class whose legacy migration history is unavailable', () => {
    expect(appendSqliteClassMigration([], ['LegacyRoom'], 'void-ws-v1', ['LegacyRoom'])).toEqual({
      migrations: [],
      added: false,
    });
  });

  it('uses an append-only tag when a migration tag is occupied', () => {
    expect(
      appendSqliteClassMigration(
        [{ tag: 'void-ws-v1', new_classes: ['LegacyRoom'] }],
        ['LegacyRoom', 'ChatRoom'],
        'void-ws-v1',
      ).migrations,
    ).toEqual([
      { tag: 'void-ws-v1', new_classes: ['LegacyRoom'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['ChatRoom'] },
    ]);
  });

  it('respects classes established by rename and transfer history', () => {
    expect(
      appendSqliteClassMigration(
        [
          { tag: 'v1', new_classes: ['LegacyRoom'] },
          { tag: 'v2', renamed_classes: [{ from: 'LegacyRoom', to: 'RenamedRoom' }] },
          {
            tag: 'v3',
            transferred_classes: [
              { from: 'ExternalRoom', from_script: 'old-worker', to: 'TransferredRoom' },
            ],
          },
        ],
        ['RenamedRoom', 'TransferredRoom'],
        'void-ws-v1',
      ),
    ).toEqual({
      migrations: [
        { tag: 'v1', new_classes: ['LegacyRoom'] },
        { tag: 'v2', renamed_classes: [{ from: 'LegacyRoom', to: 'RenamedRoom' }] },
        {
          tag: 'v3',
          transferred_classes: [
            { from: 'ExternalRoom', from_script: 'old-worker', to: 'TransferredRoom' },
          ],
        },
      ],
      added: false,
    });
  });
});
