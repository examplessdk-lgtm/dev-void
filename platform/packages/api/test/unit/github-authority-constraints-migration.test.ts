import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../drizzle');
const MIGRATION = '0057_github_authority_constraints';

type JournalEntry = { tag: string; idx: number; when: number };

function readJournal(): Array<JournalEntry> {
  return (
    JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<JournalEntry>;
    }
  ).entries;
}

async function applyMigration(db: PGlite, tag: string): Promise<void> {
  for (const statement of readFileSync(resolve(root, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.query(statement);
  }
}

it('removes rows without authority and then enforces GitHub authority constraints', async () => {
  const journal = readJournal();
  expect(journal.find((entry) => entry.tag === MIGRATION)?.idx).toBe(57);
  const db = new PGlite();
  try {
    for (const entry of journal.filter((candidate) => candidate.idx < 57)) {
      await applyMigration(db, entry.tag);
    }
    await db.exec(`
      INSERT INTO users (id, provider_id, login) VALUES
        ('owner', '1', 'owner'),
        ('admin', '2', 'admin'),
        ('collaborator', '3', 'collaborator'),
        ('gone', '4', 'gone');
      INSERT INTO projects (id, user_id, slug) VALUES
        ('p-owner', 'owner', 'owner'),
        ('p-admin', 'owner', 'admin'),
        ('p-deleted-authorizer', 'owner', 'deleted-authorizer'),
        ('p-no-repo', 'owner', 'no-repo'),
        ('p-collaborator', 'owner', 'collaborator');
      INSERT INTO project_members (project_id, user_id, role) VALUES
        ('p-admin', 'admin', 'admin'),
        ('p-deleted-authorizer', 'gone', 'admin'),
        ('p-collaborator', 'collaborator', 'collaborator');
      INSERT INTO github_installations (id, installation_id, user_id, account_login, account_id, account_type) VALUES
        ('ghi-user', '100', 'owner', 'owner', '1', 'User'),
        ('ghi-org-owned', '200', 'owner', 'org', '50', 'Organization');
      INSERT INTO github_connections (id, project_id, installation_id, repo_full_name, repository_id, authorized_by_user_id) VALUES
        ('c-owner', 'p-owner', '100', 'owner/a', '1', 'owner'),
        ('c-admin', 'p-admin', '200', 'org/b', '2', 'admin'),
        ('c-deleted-authorizer', 'p-deleted-authorizer', '200', 'org/c', '3', 'gone'),
        ('c-no-repo', 'p-no-repo', '100', 'owner/d', NULL, 'owner'),
        ('c-collaborator', 'p-collaborator', '200', 'org/e', '5', 'collaborator');
      DELETE FROM users WHERE id = 'gone';
      INSERT INTO builds (id, project_id, user_id, executor, status) VALUES
        ('b-owner', 'p-owner', 'owner', 'container', 'building'),
        ('b-admin', 'p-admin', 'owner', 'github_actions', 'deploying'),
        ('b-deleted-authorizer', 'p-deleted-authorizer', 'owner', 'container', 'building'),
        ('b-no-repo', 'p-no-repo', 'owner', 'github_actions', 'starting'),
        ('b-collaborator', 'p-collaborator', 'collaborator', 'container', 'queued');
    `);
    // The user delete above left this connection without an authorizer.
    expect(
      (
        await db.query(
          "select authorized_by_user_id from github_connections where id = 'c-deleted-authorizer'",
        )
      ).rows,
    ).toEqual([{ authorized_by_user_id: null }]);

    await applyMigration(db, MIGRATION);

    expect((await db.query('select id from github_connections order by id')).rows).toEqual([
      { id: 'c-admin' },
      { id: 'c-owner' },
    ]);
    const cancelled =
      'github repository authorization is no longer valid; reconnect the repository';
    expect(
      (
        await db.query(
          'select id, status, error, completed_at is not null as completed from builds order by id',
        )
      ).rows,
    ).toEqual([
      { id: 'b-admin', status: 'deploying', error: null, completed: false },
      { id: 'b-collaborator', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-deleted-authorizer', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-no-repo', status: 'cancelled', error: cancelled, completed: true },
      { id: 'b-owner', status: 'building', error: null, completed: false },
    ]);
    expect(
      (
        await db.query(
          'select installation_id, user_id from github_installations order by installation_id',
        )
      ).rows,
    ).toEqual([
      { installation_id: '100', user_id: 'owner' },
      { installation_id: '200', user_id: null },
    ]);

    await expect(
      db.query(
        "INSERT INTO github_connections (id, project_id, installation_id, repo_full_name, repository_id) VALUES ('c-new', 'p-no-repo', '100', 'owner/f', '6')",
      ),
    ).rejects.toThrow(/authorized_by_user_id.*not-null/);
    await expect(
      db.query(
        "INSERT INTO github_connections (id, project_id, installation_id, repo_full_name, authorized_by_user_id) VALUES ('c-new', 'p-no-repo', '100', 'owner/f', 'owner')",
      ),
    ).rejects.toThrow(/repository_id.*not-null/);
    await expect(db.query("DELETE FROM users WHERE id = 'admin'")).rejects.toThrow(
      /github_connections_authorized_by_user_id_users_id_fk/,
    );
  } finally {
    await db.close();
  }
}, 30_000);

// 0.23.0 and 0.24.0 only create connections with an authorizer and repository id, and
// deletes the connections a user authorized before deleting that user.
it('allows upgrading the 0.23.0 and 0.24.0 schema to the GitHub authority constraints', () => {
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = readJournal().filter((entry) => entry.idx < 57);
  expect(previous.at(-1)?.tag).toBe('0056_email_shared_recipients');
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
  expect(schemaDigest).toBe('3e3458ba1268853dc8e9a887270863557c2a4c5a5210f8615d247bf1f4bf6bcc');
  expect(
    compatibility.rollbackSafeFrom.filter((entry) => entry.schemaDigest === schemaDigest),
  ).toEqual([
    { platformVersion: '0.23.0', schemaDigest },
    { platformVersion: '0.24.0', schemaDigest },
  ]);
});
