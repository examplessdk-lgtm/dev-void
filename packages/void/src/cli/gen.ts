import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { outro, log, select, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import { join, dirname, relative } from 'pathslash';
import { ensureProjectTsconfig } from '../codegen/project-tsconfig.ts';
import { readConfig, getDatabaseDialect } from '../config.ts';
import { writeDrizzleConfig } from '../drizzle/config.ts';
import { collectMigrations, readJournal } from '../migrations/collect.ts';
import { assertJournalCoherence, listDrizzleArtifacts } from '../migrations/validate.ts';
import { readProjectPaths } from '../project-paths.ts';
import type { GenArgs } from './gen-args.ts';
import { buildDrizzleKitSpawnEnv } from './yarn-pnp.ts';

const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');

export async function runGenCommand(root: string, args: GenArgs): Promise<void> {
  console.log();

  if (args.subcommand === 'model') {
    await runModel(root, args.name, args.columns);
  } else if (args.subcommand === 'migration') {
    runMigration(root, args.name);
  } else if (args.subcommand === 'route') {
    runRoute(root, args.path, args.methods);
  } else if (args.subcommand === 'middleware') {
    runMiddleware(root, args.name);
  } else if (args.subcommand === 'cron') {
    runCron(root, args.name);
  } else if (args.subcommand === 'queue') {
    runQueue(root, args.name);
  } else {
    runSsr(root, args.framework);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeIfNotExists(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    log.warn(`Skipped (already exists): ${filePath}`);
    return false;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  log.success(`Created ${filePath}`);
  return true;
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

function getMigrationTimestamp(migrationsDir: string): string {
  const now = new Date();
  let ts = formatTimestamp(now);
  // If a file with this timestamp already exists, increment seconds until unique
  while (readdirSync(migrationsDir).some((f) => f.startsWith(ts + '_'))) {
    now.setSeconds(now.getSeconds() + 1);
    ts = formatTimestamp(now);
  }
  return ts;
}

function getNextMiddlewareNumber(middlewareDir: string): string {
  if (!existsSync(middlewareDir)) {
    return '01';
  }
  const files = readdirSync(middlewareDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)\./);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return String(max + 1).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Column type mapping
// ---------------------------------------------------------------------------

type ColumnSpec = {
  name: string;
  type: string;
  nullable: boolean;
};

function drizzleColumnDef(col: ColumnSpec): string {
  const { name, type } = col;
  const notNull = col.nullable ? '' : '.notNull()';
  switch (type) {
    case 'string':
    case 'text':
      return `  ${name}: text("${name}")${notNull},`;
    case 'integer':
      return `  ${name}: integer("${name}")${notNull},`;
    case 'boolean':
      return `  ${name}: integer("${name}", { mode: "boolean" })${notNull}.default(false),`;
    case 'real':
      return `  ${name}: real("${name}")${notNull},`;
    default:
      return `  ${name}: text("${name}"),`;
  }
}

function drizzleImportsForColumns(columns: Array<ColumnSpec>): Array<string> {
  const types = new Set<string>(['text', 'integer']);
  for (const col of columns) {
    switch (col.type) {
      case 'string':
      case 'text':
        types.add('text');
        break;
      case 'integer':
        types.add('integer');
        break;
      case 'boolean':
        types.add('integer');
        break;
      case 'real':
        types.add('real');
        break;
      default:
        types.add('text');
    }
  }
  return [...types].sort();
}

function drizzleColumnDefPg(col: ColumnSpec): string {
  const { name, type } = col;
  const notNull = col.nullable ? '' : '.notNull()';
  switch (type) {
    case 'string':
    case 'text':
      return `  ${name}: text("${name}")${notNull},`;
    case 'integer':
      return `  ${name}: integer("${name}")${notNull},`;
    case 'boolean':
      return `  ${name}: boolean("${name}")${notNull}.default(false),`;
    case 'real':
      return `  ${name}: doublePrecision("${name}")${notNull},`;
    default:
      return `  ${name}: text("${name}"),`;
  }
}

function drizzleImportsForColumnsPg(columns: Array<ColumnSpec>): Array<string> {
  const types = new Set<string>(['text', 'serial', 'timestamp']);
  for (const col of columns) {
    switch (col.type) {
      case 'string':
      case 'text':
        types.add('text');
        break;
      case 'integer':
        types.add('integer');
        break;
      case 'boolean':
        types.add('boolean');
        break;
      case 'real':
        types.add('doublePrecision');
        break;
      default:
        types.add('text');
    }
  }
  return [...types].sort();
}

function drizzleColumnDefMySql(col: ColumnSpec): string {
  const { name, type } = col;
  const notNull = col.nullable ? '' : '.notNull()';
  switch (type) {
    case 'string':
    case 'text':
      return `  ${name}: text("${name}")${notNull},`;
    case 'integer':
      return `  ${name}: int("${name}")${notNull},`;
    case 'boolean':
      return `  ${name}: boolean("${name}")${notNull}.default(false),`;
    case 'real':
      return `  ${name}: double("${name}")${notNull},`;
    default:
      return `  ${name}: text("${name}"),`;
  }
}

function drizzleImportsForColumnsMySql(columns: Array<ColumnSpec>): Array<string> {
  const types = new Set<string>(['int', 'text', 'timestamp']);
  for (const col of columns) {
    switch (col.type) {
      case 'integer':
        types.add('int');
        break;
      case 'boolean':
        types.add('boolean');
        break;
      case 'real':
        types.add('double');
        break;
      default:
        types.add('text');
    }
  }
  return [...types].sort();
}

// ---------------------------------------------------------------------------
// Validator detection + templates
// ---------------------------------------------------------------------------

type Validator = 'valibot' | 'zod' | 'arktype' | 'none';

export function detectValidator(root: string): Validator | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ('valibot' in allDeps) {
    return 'valibot';
  }
  if ('zod' in allDeps) {
    return 'zod';
  }
  if ('arktype' in allDeps) {
    return 'arktype';
  }
  return null;
}

async function resolveValidator(root: string): Promise<Validator> {
  const detected = detectValidator(root);
  if (detected) {
    log.info(`Detected validator: ${detected}`);
    return detected;
  }

  const choice = await select({
    message: 'No validation library detected. Which would you like to use?',
    options: [
      { value: 'valibot', label: 'Valibot' },
      { value: 'zod', label: 'Zod' },
      { value: 'arktype', label: 'ArkType' },
      { value: 'none', label: 'No validation' },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Cancelled.');
    process.exit(0);
  }

  if (choice !== 'none') {
    log.warn(`Remember to install ${choice}: npm install ${choice}`);
  }

  return choice as Validator;
}

function validatorTypeFor(validator: Validator, col: ColumnSpec): string {
  if (validator === 'valibot') {
    return valibotType(col);
  }
  if (validator === 'zod') {
    return zodType(col);
  }
  // arktype handled separately via string syntax
  return arktypeType(col);
}

function valibotType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case 'string':
    case 'text':
    case 'datetime':
      base = 'v.string()';
      break;
    case 'integer':
    case 'real':
      base = 'v.number()';
      break;
    case 'boolean':
      base = 'v.boolean()';
      break;
    case 'blob':
      base = 'v.instance(Blob)';
      break;
    default:
      base = 'v.string()';
  }
  return col.nullable ? `v.optional(${base})` : base;
}

function zodType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case 'string':
    case 'text':
    case 'datetime':
      base = 'z.string()';
      break;
    case 'integer':
    case 'real':
      base = 'z.number()';
      break;
    case 'boolean':
      base = 'z.boolean()';
      break;
    case 'blob':
      base = 'z.instanceof(Blob)';
      break;
    default:
      base = 'z.string()';
  }
  return col.nullable ? `${base}.optional()` : base;
}

function arktypeType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case 'string':
    case 'text':
    case 'datetime':
      base = 'string';
      break;
    case 'integer':
    case 'real':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'blob':
      base = 'instanceof Blob';
      break;
    default:
      base = 'string';
  }
  return col.nullable ? `${base} | undefined` : base;
}

function getImportLine(validator: Validator): string | null {
  switch (validator) {
    case 'valibot':
      return 'import * as v from "valibot";';
    case 'zod':
      return 'import { z } from "zod";';
    case 'arktype':
      return 'import { type } from "arktype";';
    case 'none':
      return null;
  }
}

function getBodySchema(validator: Validator, columns: Array<ColumnSpec>): string {
  if (validator === 'arktype') {
    const fields = columns.map((c) => `    ${c.name}: "${arktypeType(c)}",`).join('\n');
    return `type({\n${fields}\n  })`;
  }
  const fields = columns.map((c) => `    ${c.name}: ${validatorTypeFor(validator, c)},`).join('\n');
  const prefix = validator === 'valibot' ? 'v' : 'z';
  return `${prefix}.object({\n${fields}\n  })`;
}

function getParamsSchema(validator: Validator): string {
  switch (validator) {
    case 'valibot':
      return 'v.object({ id: v.string() })';
    case 'zod':
      return 'z.object({ id: z.string() })';
    case 'arktype':
      return 'type({ id: "string" })';
    case 'none':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Route templates
// ---------------------------------------------------------------------------

function generateIndexRoute(
  name: string,
  columns: Array<ColumnSpec>,
  validator: Validator,
): string {
  const importLine = getImportLine(validator);
  const imports = [
    importLine,
    'import { defineHandler } from "void";',
    'import { db } from "void/db";',
    `import { ${name} } from "@schema";`,
  ]
    .filter(Boolean)
    .join('\n');

  const insertFields = columns.map((c) => `${c.name}: body.${c.name}`).join(', ');

  if (columns.length === 0 || validator === 'none') {
    const values = columns.length > 0 ? `{ ${insertFields} }` : 'body';
    return `import { defineHandler } from "void";
import { db } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await db.insert(${name}).values(${values});
  return { created: true };
});
`;
  }

  const bodySchema = getBodySchema(validator, columns);
  return `${imports}

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler.withValidator({
  body: ${bodySchema},
})(async (c, { body }) => {
  await db.insert(${name}).values({ ${insertFields} });
  return { created: true };
});
`;
}

function generateIdRoute(name: string, validator: Validator): string {
  if (validator === 'none') {
    return `import { defineHandler } from "void";
import { db, eq } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
  }

  const importLine = getImportLine(validator)!;
  const paramsSchema = getParamsSchema(validator);

  return `${importLine}
import { defineHandler } from "void";
import { db, eq } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler.withValidator({
  params: ${paramsSchema},
})(async (c, { params }) => {
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(params.id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runModel(root: string, name: string, columns: Array<ColumnSpec>): Promise<void> {
  const validator = await resolveValidator(root);

  const dialect = getDatabaseDialect(readConfig(root));
  const paths = readProjectPaths(root);

  const schemaDir = paths.schemaDir;
  const barrelPath = paths.schemaFile;
  const modelPath = join(schemaDir, `${name}.ts`);

  // 1. Generate Drizzle table definition
  let content: string;
  if (dialect === 'postgresql') {
    const colDefs = columns.map((col) => drizzleColumnDefPg(col));
    const columnImports = drizzleImportsForColumnsPg(columns);
    const allCols = [
      `  id: serial("id").primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
    ];

    content = [
      `import { pgTable, ${columnImports.join(', ')} } from "void/schema-pg";`,
      '',
      `export const ${name} = pgTable("${name}", {`,
      ...allCols,
      '});',
      '',
    ].join('\n');
  } else if (dialect === 'mysql') {
    const colDefs = columns.map((col) => drizzleColumnDefMySql(col));
    const columnImports = drizzleImportsForColumnsMySql(columns);
    const allCols = [
      `  id: int("id").autoincrement().primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
    ];

    content = [
      `import { mysqlTable, ${columnImports.join(', ')} } from "void/schema-mysql";`,
      '',
      `export const ${name} = mysqlTable("${name}", {`,
      ...allCols,
      '});',
      '',
    ].join('\n');
  } else {
    const colDefs = columns.map((col) => drizzleColumnDef(col));
    const columnImports = drizzleImportsForColumns(columns);
    const allCols = [
      `  id: integer("id").primaryKey({ autoIncrement: true }),`,
      ...colDefs,
      '  createdAt: text("created_at").notNull().default(sql`(datetime(\'now\'))`),',
      '  updatedAt: text("updated_at").notNull().default(sql`(datetime(\'now\'))`),',
    ];

    content = [
      `import { sqliteTable, ${columnImports.join(', ')} } from "void/schema-d1";`,
      `import { sql } from "void/db";`,
      '',
      `export const ${name} = sqliteTable("${name}", {`,
      ...allCols,
      '});',
      '',
    ].join('\n');
  }

  // Write the model file
  mkdirSync(schemaDir, { recursive: true });
  writeIfNotExists(modelPath, content);

  // 2. Update or create barrel export
  const exportLine = `export * from "./schema/${name}";`;
  if (existsSync(barrelPath)) {
    const existing = readFileSync(barrelPath, 'utf-8');
    if (!existing.includes(exportLine)) {
      writeFileSync(barrelPath, existing.trimEnd() + '\n' + exportLine + '\n');
    }
  } else {
    writeFileSync(barrelPath, exportLine + '\n');
  }

  // 3. Regenerate .void/tsconfig.json and db.d.ts
  ensureProjectTsconfig(root, undefined, true, true, { paths });

  log.success(`Created ${relative(root, modelPath)}`);
  log.success(`Updated ${relative(root, barrelPath)}`);

  // 4. Routes: routes/api/<name>/index.ts
  const routeIndexPath = join(paths.routesDir, 'api', name, 'index.ts');
  writeIfNotExists(routeIndexPath, generateIndexRoute(name, columns, validator));

  // 5. Route: routes/api/<name>/[id].ts
  const routeIdPath = join(paths.routesDir, 'api', name, '[id].ts');
  writeIfNotExists(routeIdPath, generateIdRoute(name, validator));

  outro('Model scaffolding complete. Run `void db push` to apply.');
}

function runMigration(root: string, name: string): void {
  const migrationsDir = readProjectPaths(root).migrationsDir;
  mkdirSync(migrationsDir, { recursive: true });

  // Drift / partial-state gate. Run the same check the rest of the db
  // commands (`void db status`, `migrate`, `reset`, `deploy`) use as their
  // preflight, BEFORE any other guard and BEFORE writing any file. This is
  // the first line of defense and it subsumes several footguns in one pass:
  //   - `_journal.json` missing but `meta/*_snapshot.json` or `migrations.js`
  //     still on disk (partial drizzle-kit state — a botched merge / manual
  //     cleanup that would otherwise let us write a new .sql file the rest
  //     of the CLI immediately rejects).
  //   - Journal entries that don't line up with the `.sql` files on disk
  //     (orphan file / missing file drift).
  // Must run BEFORE the bundled-mode guard below: when `migrations.js`
  // survived a bad merge but `_journal.json` is missing, the bundled guard
  // would otherwise advise "delete migrations.js" and leave the project in
  // a bare-legacy + orphan-SQL state on the next run. Surfacing the partial
  // state here points the user at the correct recovery (restore the journal
  // OR delete all drizzle artifacts) before we look at the bundle at all.
  // Collect BEFORE the new scaffold so the check sees only pre-existing
  // state. Bare-legacy (no journal, no artifacts) and the playground
  // placeholder shape (`entries: []`, no artifacts) are silent-passes in
  // `assertJournalCoherence`, which is exactly the behavior `gen migration`
  // wants here.
  const currentMigrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, currentMigrations);
  } catch (err: unknown) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Refuse to scaffold migrations into a project that uses drizzle-kit's
  // bundled migration format (`drizzle-kit generate --bundle`, used by
  // Expo/`durable-sqlite`). Bundled mode emits a `migrations.js` file
  // alongside `_journal.json` that hard-codes one `import m0000 from
  // './<tag>.sql'` line per journal entry plus an `{ journal, migrations:
  // { m0000, m0001, ... } }` export. Drizzle's runtime bundled migrator
  // iterates `journal.entries` and looks up `migrations[\`m${idx}\`]` by
  // padded idx. If we append a new journal entry without also adding a
  // matching `m000N` export to `migrations.js`, the next migration run
  // blows up at runtime with `Missing migration: <tag>`.
  //
  // Rewriting `migrations.js` from here would lock us to drizzle-kit's
  // exact emit format (import path, padding, trailing comma) and break
  // silently whenever drizzle-kit bumps that format. Shelling out to
  // `drizzle-kit generate` doesn't help either — it runs a schema diff, not
  // a bundle-rebuild from existing SQL. Refusing with a helpful error is
  // the only honest option: it turns a silent runtime failure into a
  // deterministic CLI error with a clear recovery path. Fail fast, before
  // any file write or journal mutation, so there's nothing to roll back.
  // By the time we get here, `assertJournalCoherence` has already cleared
  // the partial-state shape (journal missing + bundle on disk), so this
  // guard only fires on a coherent drizzle state with the bundle present.
  const bundlePath = join(migrationsDir, 'migrations.js');
  if (existsSync(bundlePath)) {
    log.error(
      "Your project uses Drizzle's bundled migration format (db/migrations/migrations.js).\n" +
        '`void gen migration` cannot add custom hand-written migrations to a bundled project\n' +
        'because the bundle must be regenerated by drizzle-kit.\n\n' +
        'Either run `drizzle-kit generate` to regenerate the bundle, or migrate away from\n' +
        'bundled mode by deleting db/migrations/migrations.js and re-running `void db generate`.',
    );
    process.exit(1);
  }

  // Integrate with a drizzle-managed project by delegating to
  // `drizzle-kit generate --custom --name <name>`. Drizzle-kit is the
  // source of truth for both `_journal.json` and `meta/<prefix>_snapshot.
  // json`, and running it here guarantees three things we cannot produce
  // in-process without re-implementing a schema compiler:
  //
  //   1. A fresh `<timestamp>_<name>.sql` stub under `db/migrations/`
  //      (drizzle-kit writes an empty `.sql` for `--custom`).
  //   2. An updated `_journal.json` with a new entry appended (new idx,
  //      new timestamp, inherited version/breakpoints).
  //   3. A new `meta/<prefix>_snapshot.json` that is a snapshot of the
  //      **current** `db/schema.ts`, NOT a clone of the previous
  //      snapshot.
  //
  // Bullet 3 is the whole reason we delegate. Cloning the previous
  // snapshot in-process would leave the new journal entry pointing at a
  // stale schema state: if the user had changed `db/schema.ts` before
  // running `void gen migration` to hand-write the matching DDL, the next
  // `void db generate` / `drizzle-kit generate` would diff the current
  // schema against the stale snapshot and re-emit the same DDL the custom
  // migration had already applied. drizzle-kit's own `generate --custom`
  // path uses its schema-compilation pipeline, so the emitted snapshot
  // always matches what drizzle-kit would produce on the next invocation.
  //
  // We still verify up front that the snapshot matching the last journal
  // entry is on disk. Without it drizzle-kit would fail with its own
  // (less actionable) error; the preflight gives the user a cleaner
  // message and keeps the refusal consistent with the other `void db`
  // commands.
  //
  // By the time we get here, `assertJournalCoherence` has already
  // rejected the partial-state shape (missing journal + leftover
  // snapshots), drift between journal tags and `.sql` files on disk, AND
  // a structurally invalid `entries` shape (non-array). The bundled-mode
  // guard above has already refused the `migrations.js` case. This block
  // handles two remaining drizzle shapes:
  //   - Journal with entries (the normal case): delegate to drizzle-kit.
  //   - Empty-entries journal + stale snapshot files: a weird state that
  //     should have been caught earlier. Refuse defensively — we have no
  //     snapshot tied to an entry we can chain from.
  // A journal with `entries: []` AND no accompanying artifacts is the
  // kitchen-sink playground placeholder and falls through to the bare-
  // legacy write path below.
  const existingJournal = readJournal(migrationsDir);
  if (existingJournal !== undefined && existingJournal.entries.length > 0) {
    const lastEntry = existingJournal.entries[existingJournal.entries.length - 1];
    const metaDir = join(migrationsDir, 'meta');
    // Derive the previous snapshot filename from `lastEntry.tag`, not from
    // a directory listing. Drizzle-kit's snapshot files are named
    // `<prefix>_snapshot.json`, where `<prefix>` matches the journal tag's
    // prefix under either the `timestamp` or `index` drizzle-kit naming
    // conventions — both are the portion before the first underscore. A
    // directory-sort-then-last-entry approach would pick up stale snapshots
    // left behind by a merge or manual cleanup (e.g. a lex-higher rogue
    // file lurking under `meta/`) and diff the next `void db generate`
    // against the wrong baseline, re-emitting already-applied schema
    // changes. Using the journal tag binds us to the snapshot drizzle-kit
    // actually wrote alongside that entry — the only safe baseline.
    const lastSnapshotPrefix = lastEntry.tag.split('_')[0];
    const prevSnapshotPath = join(metaDir, `${lastSnapshotPrefix}_snapshot.json`);
    if (!existsSync(prevSnapshotPath)) {
      log.error(
        `db/migrations/meta/_journal.json's last entry is \`${lastEntry.tag}\` but the matching snapshot \`${lastSnapshotPrefix}_snapshot.json\` is missing under meta/.`,
      );
      log.error(
        'Restore the snapshot from version control, or regenerate migrations with `void db generate` before running `void gen migration`.',
      );
      process.exit(1);
    }

    // Snapshot `_journal.json` bytes up front so a mid-spawn failure can
    // byte-restore the file. Drizzle-kit is atomic on success but a
    // partial write on a crashed invocation would otherwise brick the
    // project — every subsequent `void db` command then crashes in
    // `readJournal` / `assertJournalCoherence`.
    const journalPath = join(metaDir, '_journal.json');
    const originalJournalBytes: Buffer | null = existsSync(journalPath)
      ? readFileSync(journalPath)
      : null;
    const snapshotsBefore = new Set(
      readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json')),
    );
    const sqlFilesBefore = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')));

    // The journal is authoritative once it exists. `existingJournal.
    // dialect` is the dialect drizzle-kit committed to when the first migration
    // was generated; every subsequent snapshot under `meta/` is chained off
    // that same dialect. Reading the dialect from `void.config.ts` and passing it
    // to `drizzle-kit generate --custom` risks writing a new snapshot in the
    // WRONG dialect if the user edited `void.config.ts`'s `database` field without
    // dropping the existing migrations. The next `void db generate` would then
    // diff against an incompatible chain and corrupt the project.
    //
    // Cross-check that the two agree. If they disagree, refuse — the only
    // correct recovery is an explicit one (revert void.config.ts, or drop
    // db/migrations/ and regenerate).
    //
    // Whitelist the dialects Void supports instead of collapsing anything unknown
    // to sqlite. A hand-edited or merge-corrupted journal with e.g.
    // `mysql`, `pg`, or an empty dialect would otherwise silently be
    // treated as sqlite, producing either a sqlite snapshot on top of
    // a non-sqlite chain or a confusing "void.config.ts is configured for
    // X but journal says sqlite" cross-check message. Refuse loudly
    // instead so the user restores the journal (or drops db/migrations/)
    // on their terms.
    let journalDialect: 'sqlite' | 'postgresql' | 'mysql';
    if (existingJournal.dialect === 'sqlite') {
      journalDialect = 'sqlite';
    } else if (existingJournal.dialect === 'postgresql') {
      journalDialect = 'postgresql';
    } else if (existingJournal.dialect === 'mysql') {
      journalDialect = 'mysql';
    } else {
      log.error(
        `db/migrations/meta/_journal.json has an unsupported dialect: \`${existingJournal.dialect}\`.`,
      );
      log.error(
        'void supports `sqlite`, `postgresql`, and `mysql` only. Restore the journal from version control, or drop db/migrations/ and regenerate from scratch.',
      );
      process.exit(1);
    }
    const configDialect = getDatabaseDialect(readConfig(root));
    if (configDialect !== journalDialect) {
      log.error(
        `db/migrations/meta/_journal.json was generated for ${journalDialect}, but void.config.ts is configured for ${configDialect}.`,
      );
      log.error(
        `Generating a new custom migration now would append a snapshot in the wrong dialect. Revert void.config.ts's \`database\` field to ${journalDialect}, or drop db/migrations/ and regenerate from scratch.`,
      );
      process.exit(1);
    }
    const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
    const additionalSchemas = existsSync(authSchemaPath) ? [authSchemaPath] : undefined;
    const configPath = writeDrizzleConfig(
      root,
      journalDialect === 'postgresql'
        ? 'postgresql://dummy'
        : journalDialect === 'mysql'
          ? 'mysql://dummy'
          : ':memory:',
      journalDialect,
      { additionalSchemas },
    );

    // Under Yarn Berry PnP, there is no `node_modules` tree —
    // dependencies live inside ZIP archives (`.yarn/cache/*.zip`) and are
    // resolved through `.pnp.cjs`, which patches `fs` +
    // `Module._resolveFilename` to handle the virtual paths. Plain `node
    // drizzle-kit` cannot load that resolver, so drizzle-kit fails to
    // resolve `void/schema-d1` from the user's `db/schema.ts`. The
    // shared helper walks ancestors for the PnP markers and returns a
    // child env with `NODE_OPTIONS` pre-populated with the right
    // `--require` / `--experimental-loader` flags. Non-PnP projects get
    // a plain clone of `process.env`.
    const childEnv = buildDrizzleKitSpawnEnv(root);

    const result = spawnSync(
      process.execPath,
      [drizzleKitBin, 'generate', '--config', configPath, '--custom', '--name', name],
      {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf-8',
        shell: process.platform === 'win32',
        env: childEnv,
      },
    );

    if (result.error || result.status !== 0) {
      // Rollback: byte-restore the journal and unlink any new files
      // drizzle-kit may have written before it failed. Best-effort — if
      // restore itself fails, surface the original error anyway because
      // that's the actionable one.
      if (originalJournalBytes !== null) {
        try {
          writeFileSync(journalPath, originalJournalBytes);
        } catch {
          // Swallow: surfacing the original failure is more useful.
        }
      }
      if (existsSync(metaDir)) {
        for (const f of readdirSync(metaDir)) {
          if (f.endsWith('_snapshot.json') && !snapshotsBefore.has(f)) {
            try {
              unlinkSync(join(metaDir, f));
            } catch {
              // Swallow.
            }
          }
        }
      }
      for (const f of readdirSync(migrationsDir)) {
        if (f.endsWith('.sql') && !sqlFilesBefore.has(f)) {
          try {
            unlinkSync(join(migrationsDir, f));
          } catch {
            // Swallow.
          }
        }
      }
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      log.error(
        [
          `Failed to run \`drizzle-kit generate --custom --name ${name}\`.`,
          ...(detail ? [detail] : []),
          '',
          'This is usually a schema-compilation error. Fix any TypeScript errors in db/schema.ts and try again.',
        ].join('\n'),
      );
      process.exit(1);
    }

    // Locate the newly-created .sql file (there should be exactly one
    // added) so we can tell the user where their custom migration lives.
    const newSqlFile = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .find((f) => !sqlFilesBefore.has(f));
    if (newSqlFile) {
      log.success(`Created db/migrations/${newSqlFile}`);
    }

    outro('Migration created and journal updated.');
    return;
  }

  // Defensive guard: empty journal accompanied by stale drizzle artifacts
  // is a weird partial shape. `assertJournalCoherence` should have caught
  // this earlier (an empty-entries journal plus leftover `meta/*_snapshot.
  // json` is the same partial-state flavor it rejects elsewhere), but
  // surface a clear refusal here so we never fall through to bare-legacy
  // and strand a new .sql file in a project that cannot integrate it.
  if (existingJournal !== undefined && existingJournal.entries.length === 0) {
    const drizzleArtifacts = listDrizzleArtifacts(migrationsDir);
    if (drizzleArtifacts.length > 0) {
      log.error(
        'db/migrations/meta/_journal.json has empty entries but stale drizzle-kit snapshots are on disk.',
      );
      log.error(
        'Restore the journal entries from version control (or run `void db generate`), or delete the stale drizzle artifacts and rerun.',
      );
      process.exit(1);
    }
  }

  const timestamp = getMigrationTimestamp(migrationsDir);
  const tag = `${timestamp}_${name}`;
  const filePath = join(migrationsDir, `${tag}.sql`);

  writeIfNotExists(filePath, `-- ${name}\n`);

  outro('Migration created.');
}

function runRoute(root: string, routePath: string, methods: Array<string>): void {
  const filePath = join(readProjectPaths(root).routesDir, routePath + '.ts');
  const exports = methods
    .map((m) => {
      const upper = m.toUpperCase();
      return `export const ${upper} = defineHandler(async () => {
  return { message: "${upper} ${routePath}" };
});`;
    })
    .join('\n\n');

  const content = `import { defineHandler } from "void";

${exports}
`;
  writeIfNotExists(filePath, content);

  outro('Route created.');
}

function runMiddleware(root: string, name: string): void {
  const middlewareDir = readProjectPaths(root).middlewareDir;
  mkdirSync(middlewareDir, { recursive: true });

  const num = getNextMiddlewareNumber(middlewareDir);
  const filePath = join(middlewareDir, `${num}.${name}.ts`);
  const content = `import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  // TODO: implement ${name} middleware
  await next();
});
`;
  writeIfNotExists(filePath, content);

  outro('Middleware created.');
}

function runCron(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).cronsDir, name + '.ts');
  const content = `import { defineScheduled } from "void";

export const cron = "* * * * *";

export default defineScheduled(async (controller, env) => {
  // TODO: implement ${name}
});
`;
  writeIfNotExists(filePath, content);

  outro('Cron job created.');
}

function runQueue(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).queuesDir, name + '.ts');
  const content = `import { defineQueue } from "void";

type Message = {};

// export const maxBatchSize = 10;
// export const maxBatchTimeout = 5;

export default defineQueue<Message>(async (batch, env) => {
  for (const message of batch.messages) {
    // TODO: process message
  }
});
`;
  writeIfNotExists(filePath, content);

  outro('Queue consumer created.');
}

function runSsr(root: string, framework?: 'react' | 'vue' | 'svelte' | 'solid'): void {
  if (!framework) {
    framework = detectFramework(root);
  }

  if (framework === 'react') {
    writeReactSsr(root);
  } else if (framework === 'vue') {
    writeVueSsr(root);
  } else if (framework === 'svelte') {
    writeSvelteSsr(root);
  } else {
    writeSolidSsr(root);
  }

  outro('SSR scaffolding complete.');
}

function detectFramework(root: string): 'react' | 'vue' | 'svelte' | 'solid' {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    log.error(
      'No package.json found. Use --react, --vue, --svelte, or --solid to specify a framework.',
    );
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ('react' in allDeps) {
    return 'react';
  }
  if ('vue' in allDeps) {
    return 'vue';
  }
  if ('svelte' in allDeps) {
    return 'svelte';
  }
  if ('solid-js' in allDeps) {
    return 'solid';
  }

  log.error(
    'Could not detect framework from package.json. Use --react, --vue, --svelte, or --solid.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SSR templates
// ---------------------------------------------------------------------------

function writeReactSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.tsx'),
    `import { renderToString } from "react-dom/server";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(<App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="root">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.tsx'),
    `import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root")!, <App />);
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.tsx'),
    `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
`,
  );
}

function writeVueSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.ts'),
    `import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { defineRender } from "void";
import App from "./App.vue";

export default defineRender(async (c, assetTags) => {
  const app = createSSRApp(App);
  const appHtml = await renderToString(app);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.ts'),
    `import { createSSRApp } from "vue";
import App from "./App.vue";

const app = createSSRApp(App);
app.mount("#app");
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.vue'),
    `<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main>
    <h1>Hello Void</h1>
    <button type="button" @click="count++">Count: {{ count }}</button>
  </main>
</template>
`,
  );
}

function writeSvelteSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.ts'),
    `import { render } from "svelte/server";
import { defineRender } from "void";
import App from "./App.svelte";

export default defineRender(async (c, assetTags) => {
  const { html: appHtml } = render(App);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.ts'),
    `import { hydrate } from "svelte";
import App from "./App.svelte";

hydrate(App, { target: document.getElementById("app")! });
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.svelte'),
    `<script>
  let count = $state(0);
</script>

<main>
  <h1>Hello Void</h1>
  <button type="button" onclick={() => count++}>Count: {count}</button>
</main>
`,
  );
}

function writeSolidSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.tsx'),
    `import { renderToString } from "solid-js/web";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(() => <App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.tsx'),
    `import { hydrate } from "solid-js/web";
import App from "./App";

hydrate(() => <App />, document.getElementById("app")!);
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.tsx'),
    `import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
`,
  );
}
