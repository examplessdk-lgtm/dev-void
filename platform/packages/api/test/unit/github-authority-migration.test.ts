import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../drizzle');
const MIGRATION = '0052_github_connection_authority';

type JournalEntry = { tag: string; idx: number; when: number };

function readJournal(): Array<JournalEntry> {
  return (
    JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<JournalEntry>;
    }
  ).entries;
}

it('allows upgrading the 0.21.9 schema to the GitHub connection authority migration', () => {
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = readJournal().filter((entry) => entry.idx <= 51);
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
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.21.9',
    schemaDigest,
  });
});

it('keeps only GitHub connections and memberships that current authority rules accept', async () => {
  const journal = readJournal();
  const target = journal.find((entry) => entry.tag === MIGRATION);
  expect(target?.idx).toBe(52);
  const db = new PGlite();
  try {
    for (const entry of journal.filter((candidate) => candidate.idx < 52)) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    await db.exec(`
      INSERT INTO users (id, provider_id, login) VALUES
        ('owner', '1', 'owner'),
        ('other', '2', 'other'),
        ('admin', '3', 'admin');
      INSERT INTO projects (id, user_id, slug) VALUES
        ('p-personal', 'owner', 'personal'),
        ('p-personal-mismatch', 'owner', 'personal-mismatch'),
        ('p-personal-no-repo', 'owner', 'personal-no-repo'),
        ('p-org-legacy', 'owner', 'org-legacy'),
        ('p-org-authorized', 'owner', 'org-authorized'),
        ('p-personal-authorized', 'owner', 'personal-authorized'),
        ('p-org-demoted', 'owner', 'org-demoted'),
        ('p-org-non-member', 'owner', 'org-non-member');
      INSERT INTO project_members (project_id, user_id, role) VALUES
        ('p-org-authorized', 'admin', 'admin'),
        ('p-org-demoted', 'admin', 'collaborator');
      INSERT INTO github_installations (id, installation_id, user_id, account_login, account_id, account_type) VALUES
        ('ghi-user', '100', 'owner', 'owner', '1', 'User'),
        ('ghi-user-other', '101', 'other', 'other', '2', 'User'),
        ('ghi-user-unlinked', '102', NULL, 'nobody', '9', 'User'),
        ('ghi-org-owned', '200', 'owner', 'org', '50', 'Organization'),
        ('ghi-org-null', '201', NULL, 'org2', '51', 'Organization');
      INSERT INTO github_connections (id, project_id, installation_id, repo_full_name, repository_id, authorized_by_user_id) VALUES
        ('c-personal', 'p-personal', '100', 'owner/a', '1', NULL),
        ('c-personal-mismatch', 'p-personal-mismatch', '101', 'other/b', '2', NULL),
        ('c-personal-no-repo', 'p-personal-no-repo', '100', 'owner/c', NULL, NULL),
        ('c-org-legacy', 'p-org-legacy', '200', 'org/d', '4', NULL),
        ('c-org-authorized', 'p-org-authorized', '201', 'org2/e', '5', 'admin'),
        ('c-personal-authorized', 'p-personal-authorized', '100', 'owner/f', NULL, 'owner'),
        ('c-org-demoted', 'p-org-demoted', '201', 'org2/g', '7', 'admin'),
        ('c-org-non-member', 'p-org-non-member', '201', 'org2/h', '8', 'other');
      INSERT INTO github_installation_members (id, installation_id, user_id, expires_at) VALUES
        ('m-user', '100', 'other', now() + interval '1 day'),
        ('m-org', '200', 'other', now() + interval '1 day');
      INSERT INTO builds (id, project_id, user_id, executor, status, completed_at) VALUES
        ('b-removed-container', 'p-org-legacy', 'owner', 'container', 'building', NULL),
        ('b-removed-actions', 'p-personal-no-repo', 'owner', 'github_actions', 'deploying', NULL),
        ('b-removed-queued', 'p-personal-mismatch', 'owner', 'container', 'queued', NULL),
        ('b-removed-finished', 'p-org-legacy', 'owner', 'container', 'complete', '2026-01-01 00:00:00'),
        ('b-kept', 'p-org-authorized', 'admin', 'container', 'building', NULL),
        ('b-backfilled', 'p-personal', 'owner', 'github_actions', 'starting', NULL),
        ('b-demoted', 'p-org-demoted', 'admin', 'container', 'building', NULL),
        ('b-non-member', 'p-org-non-member', 'other', 'github_actions', 'deploying', NULL);
    `);

    for (const statement of readFileSync(resolve(root, `${MIGRATION}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      await db.query(statement);
    }

    expect(
      (
        await db.query(
          'select installation_id, user_id from github_installations order by installation_id',
        )
      ).rows,
    ).toEqual([
      { installation_id: '100', user_id: 'owner' },
      { installation_id: '101', user_id: 'other' },
      { installation_id: '102', user_id: null },
      { installation_id: '200', user_id: null },
      { installation_id: '201', user_id: null },
    ]);
    expect(
      (await db.query('select id, authorized_by_user_id from github_connections order by id')).rows,
    ).toEqual([
      { id: 'c-org-authorized', authorized_by_user_id: 'admin' },
      { id: 'c-personal', authorized_by_user_id: 'owner' },
    ]);
    // Builds of removed connections lose their build-bound deploy tokens.
    const cancelled =
      'github repository authorization is no longer valid; reconnect the repository';
    expect(
      (
        await db.query(
          'select id, status, error, completed_at is not null as completed from builds order by id',
        )
      ).rows,
    ).toEqual([
      { id: 'b-backfilled', status: 'starting', error: null, completed: false },
      { id: 'b-demoted', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-kept', status: 'building', error: null, completed: false },
      { id: 'b-non-member', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-removed-actions', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-removed-container', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-removed-finished', status: 'complete', error: null, completed: true },
      { id: 'b-removed-queued', status: 'cancelled', error: cancelled, completed: true },
    ]);
    expect((await db.query('select id from github_installation_members order by id')).rows).toEqual(
      [{ id: 'm-org' }],
    );
  } finally {
    await db.close();
  }
}, 30_000);
