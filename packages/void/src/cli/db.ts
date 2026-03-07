import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { intro, outro, log } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig } from "./project";
import type { DbArgs } from "./db-args";
import { cliTitle, dim, pc } from "./output";

const drizzleKitBin = join(fileURLToPath(import.meta.resolve("drizzle-kit")), "..", "bin.cjs");

export async function runDbCommand(root: string, args: DbArgs): Promise<void> {
  console.log();
  intro(cliTitle("db"));

  if (args.action === "push") {
    await runPush(root);
  } else if (args.action === "generate") {
    await runGenerate(root);
  } else if (args.action === "status") {
    await runStatus(root);
  } else if (args.action === "reset") {
    await runReset(root);
  } else if (args.action === "seed") {
    await runSeed(root, args.file);
  } else if (args.action === "execute") {
    await runExecute(root, args.command, args.file);
  } else if (args.action === "migrate") {
    await runMigrate(root);
  } else if (args.action === "studio") {
    await runStudio(root);
  } else {
    await runExport(root, args);
  }
}

async function runPush(root: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { writeDrizzleConfig } = await import("../drizzle/config");
  const { getMiniflareDatabasePath } = await import("../migrations/runner");

  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  mkdirSync(dirname(dbPath), { recursive: true });

  const configPath = writeDrizzleConfig(root, dbPath);

  try {
    execSync(`node ${drizzleKitBin} push --config ${configPath}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
  outro("");
}

async function runGenerate(root: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { writeDrizzleConfig } = await import("../drizzle/config");

  // dbPath doesn't matter for generate (no DB connection needed),
  // but drizzle-kit config requires it. Use a dummy path.
  const configPath = writeDrizzleConfig(root, ":memory:");

  try {
    execSync(`node ${drizzleKitBin} generate --config ${configPath}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    process.exit(1);
  }
  outro("");
}

async function runStatus(root: string): Promise<void> {
  const migrationsDir = join(root, "db", "migrations");
  const { collectMigrations } = await import("../migrations/collect");
  const allMigrations = collectMigrations(migrationsDir);

  if (allMigrations.length === 0) {
    log.info("No migration files found in db/migrations/");
    outro("");
    return;
  }

  const { getMiniflareDatabasePath, getAppliedMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");
  const localApplied = await getAppliedMigrations(dbPath);
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

async function runReset(root: string): Promise<void> {
  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  // Delete database files
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const migrationsDir = join(root, "db", "migrations");
  const applied = await runMigrations(migrationsDir, dbPath);
  log.success(`Database reset. Applied ${applied.length} migration(s).`);
  log.info(dim("Restart your dev server if it's running."));
  outro("");
}

async function runSeed(root: string, file?: string): Promise<void> {
  // Reset first
  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const migrationsDir = join(root, "db", "migrations");
  const applied = await runMigrations(migrationsDir, dbPath);
  log.step(`Applied ${applied.length} migration(s).`);

  // Run seed
  const seedPath = file ? join(root, file) : join(root, "db", "seed.sql");
  if (!existsSync(seedPath)) {
    log.error(`Seed file not found: ${seedPath}`);
    process.exit(1);
  }

  const sql = readFileSync(seedPath, "utf-8");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }

  log.success(`Seeded from ${file ?? "db/seed.sql"}.`);
  log.info(dim("Restart your dev server if it's running."));
  outro("");
}

async function runExecute(root: string, command?: string, file?: string): Promise<void> {
  const { getMiniflareDatabasePath } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  if (!existsSync(dbPath)) {
    log.error("No local database found. Run `void dev` first.");
    process.exit(1);
  }

  const sql = file ? readFileSync(join(root, file), "utf-8") : command!;

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath);
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
  outro("");
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

async function runMigrate(root: string): Promise<void> {
  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");
  const migrationsDir = join(root, "db", "migrations");

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
  outro("");
}

async function runStudio(root: string): Promise<void> {
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
): Promise<void> {
  const { getMiniflareDatabasePath } = await import("../migrations/runner");
  const persistRoot = join(root, ".void");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  if (!existsSync(dbPath)) {
    log.error("No local database found. Run `void dev` first.");
    process.exit(1);
  }

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath, { readonly: true });
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
      outro("");
    } else {
      // Print raw SQL to stdout for piping — no clack formatting
      process.stdout.write(output);
    }
  } finally {
    db.close();
  }
}
