import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readBindingFieldPresence } from '@void/deploy-cloudflare';
import { Minimatch } from 'minimatch';
import { dirname, join, normalize, resolve } from 'pathslash';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { type DatabaseDialect } from '../config.ts';
import { openMigrationValidationDatabase } from '../migrations/sqlite-validation.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { hasDeploySchemaDrift, getDeploySchemaDriftMessage } from './deploy-drift.ts';
import { getErrorMessage, log } from './deploy-helpers.ts';
import { CLOUDFLARE_RESOURCE_LABELS, isCleanWranglerExit } from './deploy-resources.ts';
import {
  type RequiredAuthTable,
  type TableInfoRow,
  type DeployWranglerRun,
} from './deploy-types.ts';
// Type-only: the provision module must load lazily (see `deploy-types.ts`).
import type { ProvisionDriftEntry } from './provision.ts';

/**
 * Apply the checked-in migrations to an in-memory SQLite database (`node:sqlite`, a repo
 * dependency — the same driver `auth/node.ts` uses) and assert the effective schema contains
 * every REQUIRED auth table, its columns, AND the constraints that carry correctness. It reads
 * the real POST-migration schema (a token search is defeated by comments/strings/renames/plugin
 * tables) — the identical thing wrangler will apply to remote D1 (SQLite).
 *
 * Names alone are not enough: Void ships no auth migration scaffolder, so users hand-write
 * `db/schema.ts` and run `void db generate`, where Drizzle's `.unique()` and `.references()`
 * are both opt-in. A migration set with every right NAME but no unique index on `user.email`
 * and no `session.userId` foreign key is a materially weaker schema than the one the managed
 * path builds (`applySqliteAuthMigrations`), so this gate rejects it.
 *
 * Asserted: column presence, the implicit `id`'s uniqueness (`primaryKey`), `required`
 * (NOT NULL), `unique: true`, and `references` (parent table + column — including that an
 * implicit `REFERENCES "parent"` resolves to the parent's actual PRIMARY KEY). Those
 * reference checks answer only WHICH column a foreign key names; whether SQLite will ACCEPT
 * that parent key is settled by `PRAGMA foreign_key_check` on the migrated (still empty)
 * database, which applies SQLite's own rule rather than a local re-derivation of it.
 * Deliberately NOT asserted — these would reject legitimate schemas:
 *   - column TYPE — SQLite is dynamically typed, and Drizzle's output varies by mode.
 *   - non-unique `index: true` — a performance property, not a correctness one.
 *   - the exact `onDelete` action — over-tight; the reference itself is the invariant.
 *
 * Throws naming the exact offending `table.column` and what is missing (identifiers only,
 * never values), or when a migration cannot even be applied. Exported for unit testing (the
 * `required` set is passed in, so this needs no Better Auth resolution).
 */
export async function assertMigrationsProduceAuthSchema(
  migrations: Array<{ name: string; sql: string }>,
  required: Array<RequiredAuthTable>,
): Promise<void> {
  const db = await openMigrationValidationDatabase(migrations);
  const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
  // SQLite resolves identifiers case-insensitively, but `sqlite_master.name` and every PRAGMA
  // echo back the casing the migration DECLARED. So `CREATE TABLE "User" ("Email" TEXT UNIQUE)`
  // is the same schema as the emitted `user.email` — lowercase SELECTs resolve against it and
  // the UNIQUE constraint enforces — and must not read as missing here. Every identifier this
  // function compares (table, column, unique index member, FK parent) is folded through this
  // one notion of equality; only the PRAGMA arguments keep the caller's original spelling,
  // since SQLite resolves those case-insensitively anyway.
  const foldIdentifier = (identifier: string): string => identifier.toLowerCase();
  const sameIdentifier = (a: string, b: string): boolean => foldIdentifier(a) === foldIdentifier(b);
  // `PRAGMA table_info`, memoized. A foreign key is validated against the PARENT table's info,
  // and the parent is not necessarily a table this loop has reached (or will ever reach), so
  // this must be able to answer for an arbitrary table at any point. SQLite resolves the PRAGMA
  // argument case-insensitively, so the cache is keyed on the FOLDED name while the query keeps
  // the caller's spelling. A table no migration created yields `[]`, not an error.
  const tableInfoCache = new Map<string, Array<TableInfoRow>>();
  const tableInfoFor = (table: string): Array<TableInfoRow> => {
    const key = foldIdentifier(table);
    const cached = tableInfoCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<TableInfoRow>;
    tableInfoCache.set(key, rows);
    return rows;
  };
  // The table's single-column PRIMARY KEY, or null when it has none or a COMPOSITE one. This is
  // the ONLY thing SQLite resolves an omitted foreign-key target column to.
  const singleColumnPrimaryKey = (table: string): string | null => {
    const primaryKey = tableInfoFor(table).filter((row) => Number(row.pk) > 0);
    return primaryKey.length === 1 && primaryKey[0] ? primaryKey[0].name : null;
  };
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => foldIdentifier(row.name)),
    );
    const problems: Array<string> = [];
    for (const req of required) {
      if (!tables.has(foldIdentifier(req.table))) {
        problems.push(`table "${req.table}" is not created by any checked-in migration`);
        continue;
      }
      const tableInfo = tableInfoFor(req.table);
      const columns = new Set(tableInfo.map((row) => foldIdentifier(row.name)));
      const missing = req.columns
        .filter((required) => !columns.has(foldIdentifier(required.column)))
        .map((required) => required.column);
      if (missing.length > 0) {
        problems.push(`table "${req.table}" is missing column(s): ${missing.join(', ')}`);
      }

      // Uniqueness — collect every column SQLite actually enforces as unique, so BOTH
      // spellings a real project produces are honored: a column-level `email TEXT UNIQUE`
      // (SQLite materializes an implicit `sqlite_autoindex_*`) and a separate
      // `CREATE UNIQUE INDEX ... ON user (email)` (what `applySqliteAuthMigrations` emits).
      // Any single-column, non-partial unique index over the column counts — the index NAME
      // is never required. A single-column PRIMARY KEY counts too, including the
      // `INTEGER PRIMARY KEY` rowid alias, which materializes no `origin = 'pk'` index row.
      const uniqueColumns = new Set<string>();
      const primaryKey = tableInfo.filter((row) => Number(row.pk) > 0);
      if (primaryKey.length === 1 && primaryKey[0]) {
        uniqueColumns.add(foldIdentifier(primaryKey[0].name));
      }
      const indexes = db.prepare(`PRAGMA index_list(${quote(req.table)})`).all() as Array<{
        name: string;
        unique: number;
        origin?: string | null;
        partial?: number;
      }>;
      for (const index of indexes) {
        // A PARTIAL unique index only constrains the rows matching its WHERE clause, so it
        // does not make the column globally unique.
        if (Number(index.unique) !== 1 || Number(index.partial ?? 0) !== 0) {
          continue;
        }
        const indexColumns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all() as Array<{
          name: string | null;
        }>;
        // A composite unique index constrains the TUPLE, not this column on its own.
        if (indexColumns.length !== 1) {
          continue;
        }
        const only = indexColumns[0]?.name;
        if (typeof only === 'string') {
          uniqueColumns.add(foldIdentifier(only));
        }
      }
      // The implicit `id` — the parent key every auth foreign key resolves against. SQLite
      // only accepts a parent key that is uniquely constrained, so a migration that creates
      // `id` as an ordinary column produces a schema whose FKs are DEAD: `CREATE TABLE`
      // succeeds, `PRAGMA foreign_key_list` still reports the constraint, and then every
      // statement touching the child table fails at prepare time with `foreign key mismatch`
      // under `foreign_keys=ON` (which D1 always enforces) — i.e. auth breaks in production
      // AFTER a green deploy. PRIMARY KEY and UNIQUE are both valid parent keys, so reuse
      // `uniqueColumns` (it already accepts the single-column PK, the `INTEGER PRIMARY KEY`
      // rowid alias, and any single-column non-partial unique index) rather than demanding
      // PRIMARY KEY specifically.
      const notIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of notIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be the PRIMARY KEY (or otherwise ` +
            `uniquely constrained) — it is the row identity the auth foreign keys point at, and ` +
            `SQLite rejects a foreign key whose parent key is not unique at runtime with ` +
            `"foreign key mismatch"`,
        );
      }

      // NOT NULL — `PRAGMA table_info.notnull` answers it directly, with ONE exception. The
      // `INTEGER PRIMARY KEY` rowid alias reports `notnull = 0`, but SQLite assigns a rowid on
      // a NULL insert, so the column can never actually hold NULL; rejecting it would false-
      // reject a common, legitimate schema.
      //
      // The declared type CANNOT decide this on its own. `INTEGER PRIMARY KEY DESC` is not a
      // rowid alias — a historical SQLite quirk — yet `PRAGMA table_info` reports it
      // identically to the real alias (`type = INTEGER`, `pk = 1`, `notnull = 0`) while a NULL
      // insert genuinely stores NULL. What separates them is that a true alias IS the rowid,
      // so SQLite materializes no primary-key index for it: `PRAGMA index_list` carries an
      // `origin = 'pk'` row for `DESC`, for `TEXT PRIMARY KEY`, for `INT`/`BIGINT PRIMARY KEY`
      // and for a composite PK, but none for `INTEGER PRIMARY KEY` / `INTEGER PRIMARY KEY ASC`.
      // That is the discriminator used here — the absence of the `origin = 'pk'` row, read off
      // the `index_list` the uniqueness check above already fetched, with no SQL text parsing.
      // Note the test is the ORIGIN, not the row count: a rowid-alias table may still carry
      // unrelated `origin = 'u'` / `origin = 'c'` index rows from a column-level UNIQUE or a
      // `CREATE INDEX`. The single-column-PK and exact-`INTEGER` conditions are kept alongside
      // it, so nothing widens beyond the one shape SQLite actually aliases to the rowid.
      const hasPrimaryKeyIndex = indexes.some(
        (index) => String(index.origin ?? '').toLowerCase() === 'pk',
      );
      const isRowidAlias = (row: TableInfoRow): boolean =>
        primaryKey.length === 1 &&
        Number(row.pk) > 0 &&
        !hasPrimaryKeyIndex &&
        String(row.type ?? '')
          .trim()
          .toUpperCase() === 'INTEGER';
      const notNullColumns = new Set(
        tableInfo
          .filter((row) => Number(row.notnull) === 1 || isRowidAlias(row))
          .map((row) => foldIdentifier(row.name)),
      );

      // The identity's own NOT NULL. SQLite permits NULL in any PRIMARY KEY column that is not
      // the rowid alias — a longstanding file-format compatibility quirk — so `id text primary
      // key` accepts rows carrying NO identity, and more than one of them, because NULLs never
      // collide under a unique constraint. Reported apart from the ordinary required columns
      // below: the constraint reads as already satisfied in the migration, so the message has
      // to name the quirk to be actionable.
      const nullableIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            required.required === true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of nullableIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be declared NOT NULL — SQLite permits ` +
            `NULL in a PRIMARY KEY column unless it is the INTEGER rowid alias, so rows could ` +
            `be inserted with no identity at all, and more than one of them (NULLs do not ` +
            `collide under a unique constraint)`,
        );
      }

      // Every other column the emitted schema marks `required`.
      const nullableRequired = req.columns
        .filter(
          (required) =>
            required.required === true &&
            required.primaryKey !== true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (nullableRequired.length > 0) {
        problems.push(
          `table "${req.table}" is missing a NOT NULL constraint on column(s): ` +
            `${nullableRequired.join(', ')} (the emitted auth schema marks them required)`,
        );
      }

      const notUnique = req.columns
        .filter(
          (required) =>
            required.unique &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (notUnique.length > 0) {
        problems.push(
          `table "${req.table}" is missing a UNIQUE constraint on column(s): ${notUnique.join(', ')} ` +
            `(no column-level UNIQUE and no single-column unique index covers them)`,
        );
      }

      // References — the emitted schema points these columns at a parent row, and without the
      // foreign key the migrations permit orphaned auth rows (e.g. a session with no user).
      // `PRAGMA foreign_key_list` returns ONE ROW PER COLUMN, not one per constraint: the rows
      // of a single constraint share an `id` and are ordered by `seq`. Grouping by `id` is what
      // makes the width of each constraint visible, and the width is load-bearing — see below.
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${quote(req.table)})`)
        .all() as Array<{
        id: number;
        table: string;
        from: string;
        to: string | null;
      }>;
      const foreignKeyConstraints = new Map<number, Array<(typeof foreignKeys)[number]>>();
      for (const fk of foreignKeys) {
        const group = foreignKeyConstraints.get(Number(fk.id));
        if (group) {
          group.push(fk);
        } else {
          foreignKeyConstraints.set(Number(fk.id), [fk]);
        }
      }
      const constraints = Array.from(foreignKeyConstraints.values());
      for (const required of req.columns) {
        const reference = required.references;
        if (!reference || !columns.has(foldIdentifier(required.column))) {
          continue;
        }
        const namesReference = (fk: (typeof foreignKeys)[number]): boolean =>
          typeof fk.from === 'string' &&
          sameIdentifier(fk.from, required.column) &&
          typeof fk.table === 'string' &&
          sameIdentifier(fk.table, reference.table);
        // ONLY a SINGLE-COLUMN foreign key satisfies an auth reference. SQLite applies
        // MATCH SIMPLE, under which a COMPOSITE foreign key is skipped ENTIRELY whenever ANY
        // of its child columns is NULL — so `FOREIGN KEY (userId, tenant) REFERENCES
        // user(id, tenant)` with a nullable `tenant` lets a session naming a nonexistent user
        // be inserted, exactly the orphan the `references` requirement exists to prevent.
        // Matching per ROW would accept that constraint through its `userId` member alone.
        // `PRAGMA foreign_key_check` cannot cover for this either: it reports orphaned DATA,
        // and the freshly-migrated database it runs against holds no rows.
        const matching = constraints.flatMap((group) =>
          group.length === 1 && group[0] && namesReference(group[0]) ? [group[0]] : [],
        );
        const composite = constraints.some(
          (group) => group.length > 1 && group.some(namesReference),
        );
        // WHICH COLUMN the foreign key points at — a question of NAMES, and the only
        // question this block answers. Whether SQLite will ACCEPT that parent key at all is
        // orthogonal and is settled below by `PRAGMA foreign_key_check`, so nothing here
        // needs to model SQLite's parent-key rules.
        //
        // `to` is NULL when the migration omitted the target column (`REFERENCES "user"`).
        // SQLite resolves an omitted target ONLY to the parent's single-column PRIMARY KEY,
        // so the shorthand names the required column only when that column IS the parent's
        // PRIMARY KEY. The answer lives only in the PARENT's own `table_info`, which is why
        // this reaches outside the table being validated. This check is load-bearing beyond
        // the pragma: a foreign key aimed at a perfectly valid parent key that is the WRONG
        // column (`REFERENCES "user"` where the parent's PRIMARY KEY is `email`, not `id`)
        // is structurally sound, so `foreign_key_check` passes it — only this comparison
        // catches it. An EXPLICIT `to` matches by name directly.
        const satisfied = matching.some((fk) => {
          if (fk.to != null) {
            return sameIdentifier(String(fk.to), reference.column);
          }
          const parentPrimaryKey = singleColumnPrimaryKey(fk.table);
          return parentPrimaryKey !== null && sameIdentifier(parentPrimaryKey, reference.column);
        });
        if (!satisfied) {
          problems.push(
            matching.length === 0 && composite
              ? `table "${req.table}" column "${required.column}" references ` +
                  `"${reference.table}"."${reference.column}" only as part of a MULTI-COLUMN ` +
                  `foreign key — SQLite skips a composite foreign key entirely when any of its ` +
                  `child columns is NULL, so a row naming a "${reference.table}" that does not ` +
                  `exist is still accepted. This reference needs its own single-column foreign ` +
                  `key on "${required.column}"`
              : matching.some((fk) => fk.to == null)
                ? `table "${req.table}" column "${required.column}" references "${reference.table}" ` +
                  `without naming a target column, but "${reference.table}"."${reference.column}" ` +
                  `is not that table's single-column PRIMARY KEY — SQLite resolves an omitted ` +
                  `target only to the parent's PRIMARY KEY (a UNIQUE constraint does not qualify, ` +
                  `nor does a composite PRIMARY KEY) and rejects this at runtime with ` +
                  `"foreign key mismatch"`
                : `table "${req.table}" column "${required.column}" is missing a foreign key ` +
                  `referencing "${reference.table}"."${reference.column}"`,
          );
        }
      }

      // AUTHORITATIVE structural gate for this table's foreign keys — ask SQLite instead of
      // re-deriving its parent-key rules here. Those rules are subtler than they look: a
      // parent key must be a PRIMARY KEY, or a UNIQUE index whose columns AND COLLATING
      // SEQUENCES match the reference, and an omitted target column resolves only to the
      // parent's PRIMARY KEY. Hand-modelling them easily lets a schema SQLite rejects pass
      // (an ordinary parent column; a UNIQUE-only parent under the implicit shorthand; a
      // unique index declared `COLLATE NOCASE` over a plainly declared column).
      // `PRAGMA foreign_key_check` applies SQLite's own rule, so a case this file has not
      // anticipated cannot pass.
      //
      // It reports a STRUCTURAL mismatch by THROWING (`foreign key mismatch - "child"
      // referencing "parent"`), not by returning rows; returned rows mean orphaned DATA,
      // which a freshly-migrated database holding no rows cannot have, but are surfaced too
      // so neither outcome is silently dropped. Scoped to this table (the CHILD side) so an
      // unrelated application table with its own broken foreign key is not this gate's
      // business. Any other error is a real fault and propagates untouched.
      //
      // Why this matters: `CREATE TABLE` accepts a dead foreign key, and `PRAGMA
      // foreign_key_list` echoes it back as if valid. Only when a statement touches the
      // child does SQLite fail at PREPARE time with `foreign key mismatch` — under
      // `foreign_keys=ON`, which D1 always enforces. Without this gate that surfaces as auth
      // breaking in production AFTER a green deploy.
      try {
        const violations = db
          .prepare(`PRAGMA foreign_key_check(${quote(req.table)})`)
          .all() as Array<{ parent?: string | null }>;
        for (const violation of violations) {
          const parent = typeof violation.parent === 'string' ? violation.parent : 'its parent';
          problems.push(
            `table "${req.table}" has rows violating its foreign key to "${parent}" ` +
              `(PRAGMA foreign_key_check)`,
          );
        }
      } catch (err) {
        const message = getErrorMessage(err);
        const mismatch = /foreign key mismatch\s*-\s*"(.+?)"\s+referencing\s+"(.+?)"/i.exec(
          message,
        );
        if (!mismatch) {
          throw err;
        }
        problems.push(
          `table "${mismatch[1]}" has a foreign key referencing "${mismatch[2]}" whose parent ` +
            `key is not a valid foreign-key target — SQLite requires the referenced column(s) ` +
            `to be a PRIMARY KEY, or a UNIQUE index that MATCHES the reference (an index ` +
            `declared with a different COLLATE does not match), and an omitted target column ` +
            `resolves only to the parent's PRIMARY KEY. The table is created, but SQLite ` +
            `rejects every statement touching it at runtime with "foreign key mismatch"`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(problems.join('; '));
    }
  } finally {
    db.close();
  }
}

/**
 * Read the REQUIRED Better Auth schema (tables + columns) from the schema the BUILD
 * actually generated — ground truth, not a facsimile. `writeAuthDatabaseFiles`
 * (plugin-routing.ts) emits `<root>/.void/better-auth-schema.ts` during the build,
 * containing an `export const migrationSchema = { ... } as const;` literal —
 * `JSON.stringify(resolveVoidAuthMigrationSchema(...), null, 2)` derived under the
 * build's real mode, so it already reflects configured table/column RENAMES + PLUGIN
 * tables. The literal's top-level object closes with `}` at column 0, so the
 * `\n} as const;` terminator uniquely bounds the JSON (inner braces are indented).
 * The `id` column is the implicit PRIMARY KEY, so it is prepended to each table's
 * columns — matching `resolveVoidAuthMigrationSchema`'s field set exactly. Each field
 * also carries its `required` (NOT NULL) and `unique` flags and its `references` target,
 * so the check below can assert the CONSTRAINTS the schema requires and not merely the
 * names. Throws a fail-closed error when the artifact is missing/malformed.
 */
function readEmittedAuthMigrationSchema(root: string): Array<RequiredAuthTable> {
  const schemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (!existsSync(schemaPath)) {
    throw new Error(
      `the build did not emit ${schemaPath}, so the generated auth schema could not be read from the build output.`,
    );
  }
  const content = readFileSync(schemaPath, 'utf-8');
  const marker = 'export const migrationSchema = ';
  const start = content.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `${schemaPath} has no migrationSchema literal — cannot verify the auth schema.`,
    );
  }
  const jsonStart = start + marker.length;
  const end = content.indexOf('\n} as const;', jsonStart);
  if (end === -1) {
    throw new Error(
      `${schemaPath} migrationSchema literal is malformed — cannot verify the auth schema.`,
    );
  }
  let migrationSchema: VoidAuthMigrationSchema;
  try {
    migrationSchema = JSON.parse(content.slice(jsonStart, end + 2)) as VoidAuthMigrationSchema;
  } catch {
    throw new Error(
      `${schemaPath} migrationSchema is not valid JSON — cannot verify the auth schema.`,
    );
  }
  return migrationSchema.tables.map((table) => ({
    table: table.name,
    columns: [
      // `id` is the implicit PRIMARY KEY — never carries `unique`/`references` of its own,
      // and is absent from `fields`, so this synthesized descriptor is the ONLY thing that
      // represents it. `primaryKey` makes the check assert it is a usable FK parent key
      // (see {@link RequiredAuthColumn.primaryKey}); `required` makes it assert the column
      // cannot be NULL, which PRIMARY KEY alone does not guarantee in SQLite.
      { column: 'id', unique: false, required: true, primaryKey: true },
      ...Object.entries(table.fields).map(([column, field]) => ({
        column,
        unique: field.unique === true,
        required: field.required === true,
        references: field.references
          ? { table: field.references.table, column: field.references.field }
          : undefined,
      })),
    ],
  }));
}

/**
 * Default {@link CloudflareDeployDeps.validateAuthMigrations} seam: read the auth
 * schema the BUILD generated ({@link readEmittedAuthMigrationSchema}) and assert the
 * checked-in migrations produce it (applied to in-memory SQLite). Runs POST-build,
 * against ground truth — no auth-config subprocess, no mode/envDir divergence.
 * Throws on any missing table/column (or an unapplyable migration); the caller
 * renders `.message` + fails closed.
 */
export async function validateAuthMigrationSchema(
  root: string,
  migrations: Array<{ name: string; sql: string }>,
): Promise<void> {
  const required = readEmittedAuthMigrationSchema(root);
  await assertMigrationsProduceAuthSchema(migrations, required);
}

/** Format the drift / CI-gate guidance naming each un-provisioned resource. */
export function formatCloudflareDriftMessage(
  missing: Array<ProvisionDriftEntry>,
  reasons: Map<string, string>,
  header: string,
  footer: string,
): string {
  const lines = missing.map((entry) => {
    const reason = reasons.get(entry.binding);
    const label = CLOUDFLARE_RESOURCE_LABELS[entry.kind];
    return `  • ${entry.binding} (${label})${reason ? ` — ${reason}` : ''}`;
  });
  return [header, ...lines, '', footer].join('\n');
}

/**
 * Run the SAME migration validations the MANAGED deploy runs before applying
 * migrations to remote D1 — schema drift (drizzle-kit), journal coherence, and
 * destructive-op-without-pragma — reusing the managed building blocks
 * ({@link hasDeploySchemaDrift} / {@link getDeploySchemaDriftMessage} /
 * `assertJournalCoherence` / `validateMigrations`). Unlike the managed
 * `assertDeploySchemaDriftFree` (which calls `process.exit` itself), this THROWS on
 * any failure so the Cloudflare orchestrator routes the exit through its injectable
 * seam. This is the default of the {@link CloudflareDeployDeps.assertMigrationsDeployable}
 * seam; tests inject a stub to avoid spawning drizzle-kit.
 */
export function assertRemoteMigrationsDeployable(
  root: string,
  dialect: DatabaseDialect,
  migrationsDir: string,
  migrations: Array<{ name: string; sql: string }>,
): void {
  if (hasDeploySchemaDrift(root, dialect)) {
    throw new Error(getDeploySchemaDriftMessage(root));
  }
  assertJournalCoherence(migrationsDir, migrations);
  if (migrations.length > 0) {
    validateMigrations(migrations);
  }
}

/**
 * wrangler 4.131's own migration-file order comparator, reproduced EXACTLY
 * (`compareMigrationPaths` / `compareSegments` / `leadingMigrationNumber`,
 * `wrangler-dist/cli.js` `src/d1/migrations/helpers.ts`): segment-by-segment, comparing each
 * segment's LEADING NUMERIC PREFIX (`parseInt(segment.split('_')[0], 10)`) numerically first,
 * so `2_x.sql` sorts BEFORE `10_x.sql` (lexicographic would invert them). A finite number
 * sorts before a non-numeric segment; equal/both-NaN falls back to lexicographic. This is the
 * exact order `d1 migrations apply` walks (`listFilesRelative(...).sort(compareMigrationPaths)`
 * → `getMigrationNames`), so ordering the gated set the same way tells us what remote D1 will
 * receive, in what order.
 */
function leadingWranglerMigrationNumber(relativePath: string): number {
  const firstSegment = relativePath.split('/')[0] ?? '';
  return parseInt(firstSegment.split('_')[0] ?? '', 10);
}

function compareWranglerMigrationSegments(a: string, b: string): number {
  const aNum = leadingWranglerMigrationNumber(a);
  const bNum = leadingWranglerMigrationNumber(b);
  if (aNum !== bNum) {
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    if (Number.isFinite(aNum)) {
      return -1;
    }
    if (Number.isFinite(bNum)) {
      return 1;
    }
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function compareWranglerMigrationPaths(a: string, b: string): number {
  const aSegments = a.split('/');
  const bSegments = b.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareWranglerMigrationSegments(aSegments[i] as string, bSegments[i] as string);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return aSegments.length - bSegments.length;
}

export function resolveWranglerMigrationPattern(
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
): { ok: true; pattern: string } | { ok: false; reason: string } {
  const field = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_pattern');
  const migrationsDir = normalize(migrationsDirRaw.replace(/\\/g, '/')).replace(/\/$/, '');
  if (!field.present) {
    return { ok: true, pattern: '*.sql' };
  }
  const directoryField = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_dir',
  );
  if (!directoryField.present) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern for D1 binding ${binding} requires an explicit ` +
        'migrations_dir in the same binding.',
    };
  }
  if (typeof field.value !== 'string' || field.value.length === 0) {
    return {
      ok: false,
      reason: `deploy: migrations_pattern for D1 binding ${binding} must be a non-empty string.`,
    };
  }
  const normalized = normalize(field.value.replace(/\\/g, '/')).replace(/\/$/, '');
  const prefix = migrationsDir === '.' ? '' : `${migrationsDir}/`;
  if (prefix && !normalized.startsWith(prefix)) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern ${JSON.stringify(field.value)} must start with ` +
        `${JSON.stringify(`${migrationsDir}/`)} to match migrations_dir ${JSON.stringify(migrationsDirRaw)}.`,
    };
  }
  const pattern = prefix ? normalized.slice(prefix.length) : normalized;
  try {
    new Minimatch(pattern, { dot: false });
  } catch (error) {
    return {
      ok: false,
      reason: `deploy: invalid migrations_pattern ${JSON.stringify(field.value)} — ${getErrorMessage(error)}`,
    };
  }
  return { ok: true, pattern };
}

function listWranglerMigrationFiles(directory: string, pattern: string): Array<string> {
  const matcher = new Minimatch(pattern, { dot: false });
  const files: Array<string> = [];
  const visit = (absolute: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(absolute, entry.name), relativePath);
      } else if (entry.isFile() && matcher.match(relativePath)) {
        files.push(relativePath);
      }
    }
  };
  visit(directory, '');
  return files.sort(compareWranglerMigrationPaths);
}

/**
 * Assert the migration files wrangler 4.131 will APPLY — in the ORDER it applies them — equal
 * the gated source set. wrangler resolves its OWN files from the D1 entry's `migrations_dir`
 * (relative to the config-file dir) with either the default `<dir>/*.sql` pattern or the
 * configured `migrations_pattern`, tracks each by its relative `.sql` name, and applies them
 * sorted by its numeric-prefix comparator ({@link compareWranglerMigrationPaths}) — the exact
 * sequence `d1 migrations apply` runs against REMOTE D1. This backend VALIDATES the set
 * `collectMigrations` reads (flat dir, `seed.sql` excluded, sorted lexicographically). Two
 * things must hold: (1) SET equality by name AND content — a stray/extra file (e.g. `seed.sql`,
 * which `collectMigrations` skips but wrangler's `*.sql` matches), a differing dir, or a
 * divergent content would otherwise be applied UNVALIDATED; and (2) ORDER parity — the numeric
 * order wrangler applies must equal Void's gated order position-for-position, so the local
 * runner + deploy gates validate the exact order remote D1 receives (an unpadded prefix like
 * `2_` vs `10_` sorts differently lexicographically-vs-numerically and diverges — reject).
 * Custom patterns are accepted only when their exact result matches that gated set. Exported for
 * unit testing.
 */
export async function checkWranglerMigrationApplySet(
  configPath: string,
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
  gated: Array<{ name: string; sql: string }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const absDir = resolve(dirname(configPath), migrationsDirRaw);
  if (!existsSync(absDir)) {
    return {
      ok: false,
      reason:
        `deploy: configured migrations_dir ${JSON.stringify(migrationsDirRaw)} resolves to ` +
        `${absDir}, which does not exist — wrangler would have nothing to apply (or error). ` +
        `Align "migrations_dir" with your db/migrations, then rerun.`,
    };
  }
  const resolvedPattern = resolveWranglerMigrationPattern(config, binding, migrationsDirRaw);
  if (!resolvedPattern.ok) {
    return resolvedPattern;
  }
  const wranglerNames = listWranglerMigrationFiles(absDir, resolvedPattern.pattern);
  const wranglerContent = new Map(
    wranglerNames.map((name) => [name, readFileSync(join(absDir, name), 'utf-8')]),
  );
  const gatedNames = gated.map((m) => m.name.replace(/\\/g, '/'));
  const gatedContent = new Map(gatedNames.map((name, i) => [name, gated[i]!.sql]));

  // 1) SET equality by name + content.
  const wranglerSet = new Set(wranglerNames);
  const extra = wranglerNames.filter((k) => !gatedContent.has(k));
  const missing = gatedNames.filter((k) => !wranglerSet.has(k)).sort();
  const changed = wranglerNames.filter(
    (k) => gatedContent.has(k) && gatedContent.get(k) !== wranglerContent.get(k),
  );
  if (extra.length > 0 || missing.length > 0 || changed.length > 0) {
    const lines = [
      `deploy: the migrations wrangler would apply to remote D1 do not match Void's validated set (${absDir}).`,
    ];
    if (extra.length > 0) {
      lines.push(`  • wrangler would ALSO apply (not validated by Void): ${extra.join(', ')}`);
    }
    if (missing.length > 0) {
      lines.push(`  • validated by Void but NOT in wrangler's set: ${missing.join(', ')}`);
    }
    if (changed.length > 0) {
      lines.push(`  • content differs between Void's copy and wrangler's: ${changed.join(', ')}`);
    }
    lines.push(
      'Only Void-managed db/migrations/*.sql may be applied. Remove stray .sql (e.g. seed.sql) ' +
        'from migrations_dir, then rerun.',
    );
    return { ok: false, reason: lines.join('\n') };
  }

  // 2) ORDER parity — wrangler's numeric apply order must equal Void's gated (collectMigrations)
  // order position-for-position, so the order remote D1 receives is the order Void validated.
  const orderDiffers =
    gatedNames.length !== wranglerNames.length ||
    gatedNames.some((name, i) => name !== wranglerNames[i]);
  if (orderDiffers) {
    return {
      ok: false,
      reason: [
        `deploy: wrangler would apply your migrations in a DIFFERENT order than Void validated (${absDir}).`,
        `  • wrangler (numeric-prefix) order: ${wranglerNames.join(', ')}`,
        `  • Void's validated order:          ${gatedNames.join(', ')}`,
        "This happens when a migration's numeric prefix is not zero-padded (e.g. `2_` vs `10_`),",
        'so it sorts differently for wrangler (numeric) than for Void (lexicographic) — remote D1',
        'would receive them out of the validated order. Zero-pad the prefixes (0001_, 0002_, …),',
        'e.g. with `void db rename-migrations`, then rerun.',
      ].join('\n'),
    };
  }

  return { ok: true };
}

/** Apply remote D1 changes and prove no migrations remain pending. */
export async function applyAndVerifyRemoteD1Migrations(
  d1MigrateToken: string | undefined,
  configPath: string,
  runWrangler: DeployWranglerRun,
  assertUploaderStillPinned: () => boolean,
): Promise<boolean> {
  // 10. Apply pending migrations to remote D1 — AFTER all local + ground-truth gates pass, so a
  // failed gate never mutates remote D1. Uses the token resolved + validated at step 8d, and the
  // pinned root config (`-c`), which targets the account already verified by provision/drift.
  if (d1MigrateToken) {
    log.step('Applying D1 migrations...');
    // The local migration gates above ran project code (drizzle-kit loaded db/schema.ts), which
    // could have overwritten the hashed uploader bundle after the last check. Re-verify against the
    // pre-build baseline immediately before this credentialed, remote-mutating apply.
    if (!assertUploaderStillPinned()) {
      return false;
    }
    const migrate = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.apply', database: d1MigrateToken, configPath },
        { capture: false },
      ),
    );
    if (!isCleanWranglerExit(migrate)) {
      log.error(
        `deploy: remote D1 migrations failed for "${d1MigrateToken}" (exit ${String(migrate.status)}). ` +
          'Fix the migration and rerun. Note: D1 always enforces foreign_keys=ON — a Drizzle ' +
          'table-rebuild using PRAGMA foreign_keys=OFF must use PRAGMA defer_foreign_keys instead.',
      );
      return false;
    }

    // Read the structured pending set after apply; a clean apply exit alone does not prove
    // the schema is current. Recheck integrity before this separate credentialed read.
    if (!assertUploaderStillPinned()) {
      return false;
    }
    const migrateList = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.list', database: d1MigrateToken, configPath },
        { capture: true },
      ),
    );
    if (!isCleanWranglerExit(migrateList)) {
      log.error(
        `deploy: could not verify the remote migration state for "${d1MigrateToken}" ` +
          `(\`d1 migrations list\` exit ${String(migrateList.status)}). Refusing to deploy against ` +
          'an unverified schema — rerun once wrangler can reach your account.',
      );
      return false;
    }
    const migrationState = migrateList.data as { pending?: unknown } | undefined;
    if (Array.isArray(migrationState?.pending) && migrationState.pending.length > 0) {
      log.error(
        [
          `deploy: remote D1 still has UNAPPLIED migrations for "${d1MigrateToken}" after apply.`,
          'The schema is not current for this deployment. Fix or apply the pending migrations, then retry.',
        ].join('\n'),
      );
      return false;
    }
    if (
      !Array.isArray(migrationState?.pending) ||
      !migrationState.pending.every((name) => typeof name === 'string')
    ) {
      log.error(
        [
          `deploy: could not confirm the remote migration state for "${d1MigrateToken}".`,
          'Cloudflare returned an invalid pending migration set. Refusing to deploy against an unverified schema.',
          'Retry once the database migration state can be read.',
        ].join('\n'),
      );
      return false;
    }
  }

  return true;
}
