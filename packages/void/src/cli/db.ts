import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro, log } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig } from "./project";
import type { DbArgs } from "./db-args";
import { cliTitle, dim, pc } from "./output";
import { readConfig, getDatabaseDialect, type DatabaseDialect } from "../config";
import { collectMigrations } from "../migrations/collect";
import { validateMigrations } from "../migrations/validate";

const drizzleKitBin = join(fileURLToPath(import.meta.resolve("drizzle-kit")), "..", "bin.cjs");

function readEnvLocal(root: string): Record<string, string> {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function getPgUrl(root: string): string {
  const vars = readEnvLocal(root);
  const url = vars.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not found in .env.local. Add it to connect to your PostgreSQL database.",
    );
  }
  return url;
}

async function withPgClient<T>(root: string, fn: (client: any) => Promise<T>): Promise<T> {
  const url = getPgUrl(root);
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function validatePendingMigrations(
  migrations: { name: string; sql: string }[],
  appliedNames: Set<string>,
): void {
  const pending = migrations.filter((migration) => !appliedNames.has(migration.name));
  if (pending.length === 0) return;
  validateMigrations(pending);
}

export async function runDbCommand(root: string, args: DbArgs): Promise<void> {
  console.log();
  intro(cliTitle("db"));

  const dialect = getDatabaseDialect(readConfig(root));

  if (args.action === "push") {
    await runPush(root, dialect);
  } else if (args.action === "generate") {
    await runGenerate(root, dialect);
  } else if (args.action === "status") {
    await runStatus(root, dialect);
  } else if (args.action === "reset") {
    await runReset(root, dialect);
  } else if (args.action === "seed") {
    await runSeed(root, args.file, dialect);
  } else if (args.action === "execute") {
    await runExecute(root, args.command, args.file, dialect);
  } else if (args.action === "migrate") {
    await runMigrate(root, dialect);
  } else if (args.action === "studio") {
    await runStudio(root, dialect);
  } else if (args.action === "set-url") {
    await runSetUrl(root);
  } else {
    await runExport(root, args, dialect);
  }
}

async function runPush(root: string, dialect: DatabaseDialect): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { writeDrizzleConfig } = await import("../drizzle/config");

  let configPath: string;
  if (dialect === "postgresql") {
    const url = getPgUrl(root);
    configPath = writeDrizzleConfig(root, url, "postgresql");
  } else {
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { getMiniflareDatabasePath } = await import("../migrations/runner");
    const persistRoot = join(root, ".void");
    const dbPath = getMiniflareDatabasePath(persistRoot, "local");
    mkdirSync(dirname(dbPath), { recursive: true });
    configPath = writeDrizzleConfig(root, dbPath);
  }

  try {
    execSync(`node ${drizzleKitBin} push --config ${configPath}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
  outro("Done.");
}

async function runGenerate(root: string, dialect: DatabaseDialect): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { writeDrizzleConfig } = await import("../drizzle/config");

  const configPath =
    dialect === "postgresql"
      ? writeDrizzleConfig(root, "postgresql://dummy", "postgresql")
      : writeDrizzleConfig(root, ":memory:");

  try {
    execSync(`node ${drizzleKitBin} generate --config ${configPath}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
  outro("Done.");
}

async function runStatus(root: string, dialect: DatabaseDialect): Promise<void> {
  const migrationsDir = join(root, "db", "migrations");
  const { collectMigrations } = await import("../migrations/collect");
  const allMigrations = collectMigrations(migrationsDir);

  if (allMigrations.length === 0) {
    log.info("No migration files found in db/migrations/");
    outro("Done.");
    return;
  }

  let localApplied: { name: string }[];
  if (dialect === "postgresql") {
    try {
      localApplied = await withPgClient(root, async (client) => {
        try {
          const result = await client.query("SELECT name FROM _void_migrations ORDER BY name");
          return result.rows;
        } catch {
          return [];
        }
      });
    } catch {
      localApplied = [];
    }
  } else {
    const { getMiniflareDatabasePath, getAppliedMigrations } = await import("../migrations/runner");
    const persistRoot = join(root, ".void");
    const dbPath = getMiniflareDatabasePath(persistRoot, "local");
    localApplied = await getAppliedMigrations(dbPath);
  }
  const localSet = new Set(localApplied.map((m) => m.name));

  // Try to get remote status
  let remoteApplied: { name: string; applied_at: string }[] | null = null;
  const token = getToken();
  const config = readProjectConfig(root);
  if (token && config) {
    try {
      const client = new PlatformClient(token);
      const result = await client.getMigrationStatus(config.projectId);
      remoteApplied = result.applied;
    } catch {
      // graceful degradation — remote unavailable
    }
  }

  const remoteSet = remoteApplied ? new Set(remoteApplied.map((m) => m.name)) : null;

  const lines: string[] = [];
  for (const migration of allMigrations) {
    const localStatus = localSet.has(migration.name) ? pc.green("applied") : pc.yellow("pending");

    let remotePart = "";
    if (remoteSet !== null) {
      const remoteStatus = remoteSet.has(migration.name)
        ? pc.green("applied")
        : pc.yellow("pending");
      remotePart = `  remote: ${remoteStatus}`;
    }

    lines.push(`  ${migration.name}  ${dim("local:")} ${localStatus}${remotePart}`);
  }

  log.info(lines.join("\n"));

  const localPending = allMigrations.length - localSet.size;
  const parts = [`${allMigrations.length} migration(s)`];
  if (localPending > 0) {
    parts.push(`${localPending} pending locally`);
  }
  if (remoteSet !== null) {
    const remotePending = allMigrations.length - remoteSet.size;
    if (remotePending > 0) {
      parts.push(`${remotePending} pending remotely`);
    }
  }
  outro(parts.join(", "));
}

async function resetDatabase(root: string, dialect: DatabaseDialect): Promise<number> {
  if (dialect === "postgresql") {
    await withPgClient(root, async (client) => {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const row of tables.rows) {
        await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
    });
    const migrationsDir = join(root, "db", "migrations");
    const { collectMigrations } = await import("../migrations/collect");
    const migrations = collectMigrations(migrationsDir);
    if (migrations.length > 0) {
      await withPgClient(root, async (client) => {
        await client.query(
          `CREATE TABLE IF NOT EXISTS _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
        );
        for (const m of migrations) {
          await client.query("BEGIN");
          try {
            await client.query(m.sql);
            await client.query("INSERT INTO _void_migrations (name, applied_at) VALUES ($1, $2)", [
              m.name,
              new Date().toISOString(),
            ]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        }
      });
    }
    return migrations.length;
  }

  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const migrationsDir = join(root, "db", "migrations");
  const applied = await runMigrations(migrationsDir, dbPath);
  return applied.length;
}

async function runReset(root: string, dialect: DatabaseDialect): Promise<void> {
  const count = await resetDatabase(root, dialect);
  log.success(`Database reset. Applied ${count} migration(s).`);
  if (dialect !== "postgresql") {
    log.info(dim("Restart your dev server if it's running."));
  }
  outro("Done.");
}

async function runSeed(
  root: string,
  file: string | undefined,
  dialect: DatabaseDialect,
): Promise<void> {
  // Reset first (drop + re-run migrations)
  const migrationCount = await resetDatabase(root, dialect);
  log.step(`Reset database. Applied ${migrationCount} migration(s).`);

  const seedPath = file ? join(root, file) : join(root, "db", "seed.sql");
  if (!existsSync(seedPath)) {
    log.error(`Seed file not found: ${seedPath}`);
    process.exit(1);
  }

  const sql = readFileSync(seedPath, "utf-8");

  if (dialect === "postgresql") {
    await withPgClient(root, async (client) => {
      await client.query(sql);
    });
    log.success(`Seeded from ${file ?? "db/seed.sql"}.`);
    outro("Done.");
    return;
  }

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");
  const db = await openSqliteDatabase(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }

  log.success(`Seeded from ${file ?? "db/seed.sql"}.`);
  log.info(dim("Restart your dev server if it's running."));
  outro("Done.");
}

async function runExecute(
  root: string,
  command: string | undefined,
  file: string | undefined,
  dialect: DatabaseDialect,
): Promise<void> {
  if (dialect === "postgresql") {
    const sql = file ? readFileSync(join(root, file), "utf-8") : command!;
    await withPgClient(root, async (client) => {
      const result = await client.query(sql);
      if (result.rows && result.rows.length > 0) {
        printTable(result.rows);
      } else {
        log.success("Executed successfully.");
      }
    });
    outro("Done.");
    return;
  }

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  if (!existsSync(dbPath)) {
    log.error("No local database found. Run `void dev` first.");
    process.exit(1);
  }

  const sql = file ? readFileSync(join(root, file), "utf-8") : command!;

  const db = await openSqliteDatabase(dbPath);
  try {
    const trimmed = sql.trimStart();
    if (/^SELECT\b/i.test(trimmed)) {
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      if (rows.length === 0) {
        log.info("No rows returned.");
      } else {
        printTable(rows);
      }
    } else {
      db.exec(sql);
      log.success("Executed successfully.");
    }
  } finally {
    db.close();
  }
  outro("Done.");
}

function printTable(rows: Record<string, unknown>[]): void {
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) => {
    let max = col.length;
    for (const row of rows) {
      const len = String(row[col] ?? "NULL").length;
      if (len > max) max = len;
    }
    return max;
  });

  const header = cols.map((col, i) => col.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("──");
  const lines = [header, separator];
  for (const row of rows) {
    lines.push(cols.map((col, i) => String(row[col] ?? "NULL").padEnd(widths[i])).join("  "));
  }
  console.log(lines.join("\n"));
}

async function runMigrate(root: string, dialect: DatabaseDialect): Promise<void> {
  const migrationsDir = join(root, "db", "migrations");
  const rawMigrations = collectMigrations(migrationsDir);

  if (dialect === "postgresql") {
    const { applyPgMigrations } = await import("../migrations/runner-pg");
    const applied = await withPgClient(root, async (client) => {
      let existingRows: { name: string }[] = [];
      try {
        const result = await client.query("SELECT name FROM _void_migrations");
        existingRows = result.rows;
      } catch {
        existingRows = [];
      }

      try {
        validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
      } catch (err: any) {
        log.error(err.message);
        process.exit(1);
      }

      return applyPgMigrations(client, rawMigrations);
    });

    if (applied.length === 0) {
      log.info("All migrations are up to date.");
    } else {
      for (const name of applied) {
        log.step(name);
      }
      log.success(`Applied ${applied.length} migration(s).`);
    }
    outro("Done.");
    return;
  }

  const { getMiniflareDatabasePath, getAppliedMigrations, runMigrations } =
    await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  try {
    const existingRows = await getAppliedMigrations(dbPath);
    validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
  } catch (err: any) {
    log.error(err.message);
    process.exit(1);
  }

  const applied = await runMigrations(migrationsDir, dbPath);
  if (applied.length === 0) {
    log.info("All migrations are up to date.");
  } else {
    for (const name of applied) {
      log.step(name);
    }
    log.success(`Applied ${applied.length} migration(s).`);
    log.info(dim("Restart your dev server if it's running."));
  }
  outro("Done.");
}

async function runStudio(root: string, dialect: DatabaseDialect): Promise<void> {
  if (dialect === "postgresql") {
    const { execSync } = await import("node:child_process");
    const { writeDrizzleConfig } = await import("../drizzle/config");
    const url = getPgUrl(root);
    const configPath = writeDrizzleConfig(root, url, "postgresql");

    log.info("Opening Drizzle Studio...");
    try {
      execSync(`node ${drizzleKitBin} studio --config ${configPath}`, {
        cwd: root,
        stdio: "inherit",
      });
    } catch {
      process.exit(1);
    }
    return;
  }

  const { existsSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const { writeDrizzleConfig } = await import("../drizzle/config");
  const { getMiniflareDatabasePath } = await import("../migrations/runner");

  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  if (!existsSync(dbPath)) {
    log.error("No local database found. Run `void dev` first.");
    process.exit(1);
  }

  const configPath = writeDrizzleConfig(root, dbPath);

  log.info("Opening Drizzle Studio...");
  try {
    execSync(`node ${drizzleKitBin} studio --config ${configPath}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
}

async function runExport(
  root: string,
  args: { output?: string; noData?: boolean; noSchema?: boolean; table?: string },
  dialect: DatabaseDialect,
): Promise<void> {
  if (dialect === "postgresql") {
    const parts: string[] = [];
    await withPgClient(root, async (client) => {
      let tables: string[];
      if (args.table) {
        const check = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [args.table],
        );
        if (check.rows.length === 0) {
          log.error(`Table not found: ${args.table}`);
          process.exit(1);
        }
        tables = [args.table];
      } else {
        const result = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_%' ORDER BY tablename",
        );
        tables = result.rows.map((r: any) => r.tablename);
      }

      for (const table of tables) {
        if (!args.noSchema) {
          // Get CREATE TABLE statement (simplified — pg_dump would be more complete)
          const cols = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
            [table],
          );
          const colDefs = cols.rows.map((c: any) => {
            let def = `  "${c.column_name}" ${c.data_type}`;
            if (c.is_nullable === "NO") def += " NOT NULL";
            if (c.column_default) def += ` DEFAULT ${c.column_default}`;
            return def;
          });
          parts.push(`CREATE TABLE "${table}" (\n${colDefs.join(",\n")}\n);`);
        }

        if (!args.noData) {
          const rows = await client.query(`SELECT * FROM "${table}"`);
          for (const row of rows.rows) {
            const cols = Object.keys(row);
            const vals = cols.map((c) => {
              const v = row[c];
              if (v === null) return "NULL";
              if (typeof v === "number") return String(v);
              return `'${String(v).replace(/'/g, "''")}'`;
            });
            parts.push(`INSERT INTO "${table}" (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
          }
        }
        parts.push("");
      }
    });

    const output = parts.join("\n");
    if (args.output) {
      writeFileSync(join(root, args.output), output);
      log.success(`Exported to ${args.output}`);
      outro("Done.");
    } else {
      process.stdout.write(output);
    }
    return;
  }

  const { getMiniflareDatabasePath, openSqliteDatabase } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  if (!existsSync(dbPath)) {
    log.error("No local database found. Run `void dev` first.");
    process.exit(1);
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });
  try {
    let tables: string[];
    if (args.table) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(args.table);
      if (!exists) {
        log.error(`Table not found: ${args.table}`);
        process.exit(1);
      }
      tables = [args.table];
    } else {
      tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .all()
        .map((row: any) => row.name);
    }

    const parts: string[] = [];

    for (const table of tables) {
      if (!args.noSchema) {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { sql: string };
        parts.push(row.sql + ";");
      }

      if (!args.noData) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map((c) => {
            const v = row[c];
            if (v === null) return "NULL";
            if (typeof v === "number") return String(v);
            return `'${String(v).replace(/'/g, "''")}'`;
          });
          parts.push(`INSERT INTO "${table}" (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
        }
      }

      parts.push("");
    }

    const output = parts.join("\n");

    if (args.output) {
      writeFileSync(join(root, args.output), output);
      log.success(`Exported to ${args.output}`);
      outro("Done.");
    } else {
      // Print raw SQL to stdout for piping — no clack formatting
      process.stdout.write(output);
    }
  } finally {
    db.close();
  }
}

async function runSetUrl(root: string): Promise<void> {
  const { readConfig: readVoidConfig, getDatabaseDialect: getDialect } = await import("../config");
  const config = readVoidConfig(root);
  const dialect = getDialect(config);

  if (dialect !== "postgresql") {
    log.error('This command is only for PostgreSQL projects. Set "database": "pg" in void.json.');
    process.exit(1);
  }

  const token = getToken();
  if (!token) {
    log.error("No auth token found. Run `void auth login` first.");
    process.exit(1);
  }

  const projectConfig = readProjectConfig(root);
  if (!projectConfig) {
    log.error("No project linked. Run `void deploy` first or link a project.");
    process.exit(1);
  }

  const { text: promptText, isCancel: isCancelCheck } = await import("@clack/prompts");

  const connectionString = await promptText({
    message: "Enter your PostgreSQL connection string:",
    placeholder: "postgresql://user:pass@host:5432/dbname",
    validate(value = "") {
      if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
        return 'Connection string must start with "postgres://" or "postgresql://"';
      }
    },
  });

  if (isCancelCheck(connectionString)) {
    process.exit(0);
  }

  const client = new PlatformClient(token);
  await client.setDatabaseUrl(projectConfig.projectId, connectionString as string);

  log.success("Database URL updated.");
  outro("Done.");
}
