import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

it('adds the email ledger without changing tables used by the previous runtime', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const emailIndex = journal.entries.findIndex((entry) => entry.tag === '0047_email_gateway');
  expect(journal.entries[emailIndex]?.idx).toBe(47);
  const previous = journal.entries.slice(0, emailIndex);
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8'));
  // The schema used by the 0.20.1 runtime.
  expect(
    platformDatabaseSchemaDigest(
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
  ).toBe('6de871d9524b082bba675d0d653ade45f95206895a962fea2b9be4b85d486313');
  const db = new PGlite();
  try {
    for (const entry of previous) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    const tables = (
      await db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      )
    ).rows.map((row) => row.tablename);
    const catalog = async () => ({
      columns: (
        await db.query(
          "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = any($1::text[]) order by table_name, ordinal_position",
          [tables],
        )
      ).rows,
      indexes: (
        await db.query(
          "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any($1::text[]) order by tablename, indexname",
          [tables],
        )
      ).rows,
      constraints: (
        await db.query(
          "select conrelid::regclass::text as relation, conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])) order by relation, conname",
          [tables],
        )
      ).rows,
    });
    const before = await catalog();
    await db.exec(readFileSync(resolve(root, '0047_email_gateway.sql'), 'utf8'));
    expect(await catalog()).toEqual(before);
    expect((await db.query("select to_regclass('email_actions') as actions")).rows).toEqual([
      { actions: 'email_actions' },
    ]);
  } finally {
    await db.close();
  }
}, 15_000);
