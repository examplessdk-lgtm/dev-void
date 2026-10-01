import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

it('normalizes worker project modes without changing deployment pointers and retains rollback to 0.22.0', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx < 54);
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.22.0',
    schemaDigest: platformDatabaseSchemaDigest(
      compatibility.lineage,
      previous.map((entry) => ({
        index: entry.idx,
        tag: entry.tag,
        timestampMillis: entry.when,
        sha256: createHash('sha256')
          .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
          .digest('hex'),
      })),
    ),
  });
  const db = new PGlite();
  try {
    for (const entry of previous) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    await db.exec("INSERT INTO users (id, login) VALUES ('migration-user', 'migration-user')");
    await db.exec(
      "INSERT INTO projects (id, user_id, slug, mode, active_deployment_id) VALUES ('worker-project', 'migration-user', 'worker-project', 'worker', 'serving-older'), ('static-project', 'migration-user', 'static-project', 'static', NULL)",
    );
    await db.exec(readFileSync(resolve(root, '0054_project_mode.sql'), 'utf8'));
    await db.exec(
      "INSERT INTO projects (id, user_id, slug) VALUES ('new-project', 'migration-user', 'new-project')",
    );
    expect(
      (await db.query('SELECT id, mode, active_deployment_id FROM projects ORDER BY id')).rows,
    ).toEqual([
      { id: 'new-project', mode: 'void', active_deployment_id: null },
      { id: 'static-project', mode: 'static', active_deployment_id: null },
      { id: 'worker-project', mode: 'void', active_deployment_id: 'serving-older' },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);

// 0.10.14 and 0.20.1 can write GitHub connections without an authorizer and
// delete users without removing the connections they authorized.
it('requires 0.10.14 and 0.20.1 to upgrade through a release that enforces GitHub authority', () => {
  const compatibility = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../drizzle/compatibility.json'), 'utf8'),
  ) as { rollbackSafeFrom: Array<{ platformVersion: string }> };
  const versions = compatibility.rollbackSafeFrom.map((entry) => entry.platformVersion);
  expect(versions).not.toContain('0.10.14');
  expect(versions).not.toContain('0.20.1');
});

it('allows rollback to the 0.20.3 schema after adding invitation delivery status', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 48);
  expect(previous.at(-1)?.tag).toBe('0048_project_teams');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('089431e230970d03afa429c102613598e88371155cb693c076002c5d632bb0b6');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.20.3',
    schemaDigest,
  });
});

it('allows rollback to the 0.20.3 schema after adding direct member grants', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 49);
  expect(previous.at(-1)?.tag).toBe('0049_invitation_delivery_status');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('408364e61c4b7d83def4030a1c11e8b9b07fc21dd3bffe6529e1b7d3759979b6');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.20.3',
    schemaDigest,
  });
});

it('allows upgrading the 0.21.2 schema after adding project cleanup jobs', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 50);
  expect(previous.at(-1)?.tag).toBe('0050_project_member_direct_grants');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('9a9ae6677b795debd4ffaa20a05f533727063c7a21366310a2fe4b17bd918edd');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.21.2',
    schemaDigest,
  });
});

it('allows upgrading the 0.21.3 through 0.21.9 schema after adding project Zero Trust', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 51);
  expect(previous.at(-1)?.tag).toBe('0051_icy_psylocke');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('ac70deb5847c71ece9938edd27e5dbc50ce41e16771926c78e757850baf15bfa');
  for (const platformVersion of [
    '0.21.3',
    '0.21.4',
    '0.21.5',
    '0.21.6',
    '0.21.7',
    '0.21.8',
    '0.21.9',
  ]) {
    expect(compatibility.rollbackSafeFrom).toContainEqual({ platformVersion, schemaDigest });
  }
});
