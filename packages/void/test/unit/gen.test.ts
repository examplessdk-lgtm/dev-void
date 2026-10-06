import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSlash } from 'pathslash';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vite-plus/test';
import { runGenCommand, formatTimestamp } from '../../src/cli/gen.ts';

const mockSelect = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  select: (...args: Array<unknown>) => mockSelect(...args),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

// `vi.hoisted` is required because `vi.mock` is hoisted above imports —
// referencing a plain `let` from inside the mock factory hits a TDZ at
// module-init time.
const spawnMockState = vi.hoisted(() => ({
  // Per-test override. When non-null, the mock delegates to this handler
  // instead of the default "simulate drizzle-kit generate --custom"
  // behavior. Used by the rollback tests to simulate failures.
  handler: null as
    | ((
        command: string,
        args: Array<string>,
        options: { cwd?: string },
      ) => {
        status: number;
        stdout: string;
        stderr: string;
        error?: Error;
      })
    | null,
  calls: [] as Array<{
    command: string;
    args: Array<string>;
    options: { cwd?: string };
  }>,
}));

vi.mock('node:child_process', async () => {
  const nodeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const nodePath = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    spawnSync: (command: string, args: Array<string>, options: { cwd?: string }) => {
      spawnMockState.calls.push({ command, args, options });

      // Per-test handler wins.
      if (spawnMockState.handler !== null) {
        return spawnMockState.handler(command, args, options);
      }

      // Default behavior: simulate `drizzle-kit generate --custom --name
      // <name>` success. Detect the shape of the command and, when it
      // matches, produce the same on-disk side effects drizzle-kit
      // itself produces:
      //   - new `<timestamp>_<name>.sql` stub under db/migrations/
      //   - appended entry in `meta/_journal.json`
      //   - new `meta/<prefix>_snapshot.json` with a re-issued id chain
      if (
        Array.isArray(args) &&
        args[1] === 'generate' &&
        args.includes('--custom') &&
        typeof options?.cwd === 'string'
      ) {
        const cwd = options.cwd;
        const nameIdx = args.indexOf('--name');
        const name = nameIdx !== -1 ? args[nameIdx + 1] : 'custom';
        simulateDrizzleCustom(cwd, name, nodeFs, nodePath);
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
});

/**
 * Simulate what `drizzle-kit generate --custom --name <name>` writes to
 * disk: a new empty `.sql` stub, an updated journal entry, and a new
 * snapshot derived from the current (freshly loaded) schema.
 *
 * The test seeds the previous snapshot, so for simulation purposes we
 * read that snapshot, re-issue the id chain, and write it back — this
 * mirrors the shape of a zero-diff custom migration without actually
 * running a schema compiler.
 */
function simulateDrizzleCustom(
  cwd: string,
  name: string,
  nodeFs: typeof import('node:fs'),
  nodePath: typeof import('node:path'),
): void {
  const migrationsDir = nodePath.join(cwd, 'db', 'migrations');
  const metaDir = nodePath.join(migrationsDir, 'meta');
  if (!nodeFs.existsSync(metaDir)) {
    return;
  }

  // Derive a unique timestamp that doesn't collide with existing .sql
  // files on disk.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const makeTs = (d: Date) =>
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  let ts = makeTs(now);
  while (nodeFs.readdirSync(migrationsDir).some((f) => f.startsWith(ts + '_'))) {
    now.setSeconds(now.getSeconds() + 1);
    ts = makeTs(now);
  }
  const tag = `${ts}_${name}`;

  // Write the empty .sql stub that `--custom` emits.
  nodeFs.writeFileSync(nodePath.join(migrationsDir, `${tag}.sql`), '');

  // Append journal entry.
  const journalPath = nodePath.join(metaDir, '_journal.json');
  const journal = JSON.parse(nodeFs.readFileSync(journalPath, 'utf-8')) as {
    version: string;
    dialect: string;
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  const lastEntry = journal.entries[journal.entries.length - 1];
  const nextIdx =
    journal.entries.length > 0 ? Math.max(...journal.entries.map((e) => e.idx)) + 1 : 0;
  journal.entries.push({
    idx: nextIdx,
    version: lastEntry?.version ?? journal.version,
    when: Date.now(),
    tag,
    breakpoints: lastEntry?.breakpoints ?? true,
  });
  nodeFs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');

  // Find the prev snapshot (tag-derived) and write a new snapshot
  // with a re-issued id chain. The new snapshot is a structural clone
  // of the previous one — in real life drizzle-kit would recompile
  // `db/schema.ts`, but for mock purposes the chaining shape is all the
  // tests need.
  if (lastEntry) {
    const prevPrefix = lastEntry.tag.split('_')[0];
    const prevSnapshotPath = nodePath.join(metaDir, `${prevPrefix}_snapshot.json`);
    if (nodeFs.existsSync(prevSnapshotPath)) {
      const prevSnapshot = JSON.parse(nodeFs.readFileSync(prevSnapshotPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const nextSnapshot = {
        ...prevSnapshot,
        id: `sim-${ts}`,
        prevId: prevSnapshot.id,
      };
      const newSnapshotPath = nodePath.join(metaDir, `${ts}_snapshot.json`);
      nodeFs.writeFileSync(newSnapshotPath, JSON.stringify(nextSnapshot, null, 2));
    }
  }
}

const TMP = join(import.meta.dirname, '.tmp-gen-test');

function read(path: string): string {
  return readFileSync(join(TMP, path), 'utf-8');
}

function writePkg(deps: Record<string, string>): void {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ dependencies: deps }));
}

/**
 * Seed a minimal `db/schema.ts` so `writeDrizzleConfig()` succeeds.
 * `runMigration` writes a drizzle config via `writeDrizzleConfig`
 * before spawning drizzle-kit, and `writeDrizzleConfig` throws with
 * "No Drizzle schema found" if there's no schema on disk.
 */
function seedSchema(): void {
  const schemaPath = join(TMP, 'db', 'schema.ts');
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(
    schemaPath,
    'import { sqliteTable, text } from "drizzle-orm/sqlite-core";\nexport const t = sqliteTable("t", { a: text("a") });\n',
  );
}

beforeEach(() => {
  spawnMockState.calls = [];
  spawnMockState.handler = null;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mockSelect.mockReset();
  spawnMockState.calls = [];
  spawnMockState.handler = null;
});

// ---------------------------------------------------------------------------
// gen model
// ---------------------------------------------------------------------------

describe('gen model', () => {
  it('generates Drizzle table definition', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
      ],
    });

    const schema = read('db/schema/posts.ts');
    expect(schema).toContain('from "void/schema-d1"');
    expect(schema).toContain('import { sqliteTable');
    expect(schema).toContain('export const posts = sqliteTable("posts"');
    expect(schema).toContain('id: integer("id").primaryKey({ autoIncrement: true })');
    expect(schema).toContain('title: text("title").notNull()');
    expect(schema).toContain('body: text("body").notNull()');
    expect(schema).toContain('integer("published", { mode: "boolean" }).notNull()');
    expect(schema).toContain('createdAt:');
    expect(schema).toContain('updatedAt:');
  });

  it('maps all column types correctly in schema', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 't',
      columns: [
        { name: 'a', type: 'string', nullable: false },
        { name: 'b', type: 'text', nullable: false },
        { name: 'c', type: 'integer', nullable: false },
        { name: 'd', type: 'boolean', nullable: false },
        { name: 'e', type: 'real', nullable: false },
      ],
    });

    const schema = read('db/schema/t.ts');
    expect(schema).toContain('a: text("a").notNull()');
    expect(schema).toContain('b: text("b").notNull()');
    expect(schema).toContain('c: integer("c").notNull()');
    expect(schema).toContain('integer("d", { mode: "boolean" }).notNull()');
    expect(schema).toContain('e: real("e").notNull()');
  });

  it.each([
    {
      dialect: 'sqlite',
      database: undefined,
      required: [
        'title: text("title").notNull(),',
        'flag: integer("flag", { mode: "boolean" }).notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: integer("views"),',
        'score: real("score"),',
        'hidden: integer("hidden", { mode: "boolean" }).default(false),',
      ],
    },
    {
      dialect: 'postgresql',
      database: 'pg',
      required: [
        'title: text("title").notNull(),',
        'flag: boolean("flag").notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: integer("views"),',
        'score: doublePrecision("score"),',
        'hidden: boolean("hidden").default(false),',
      ],
    },
    {
      dialect: 'mysql',
      database: 'mysql',
      required: [
        'title: text("title").notNull(),',
        'flag: boolean("flag").notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: int("views"),',
        'score: double("score"),',
        'hidden: boolean("hidden").default(false),',
      ],
    },
  ])(
    'omits .notNull() only for nullable columns ($dialect)',
    async ({ database, required, nullable }) => {
      writePkg({ valibot: '^1.0.0' });
      if (database) {
        writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database }));
      }
      await runGenCommand(TMP, {
        subcommand: 'model',
        name: 'posts',
        columns: [
          { name: 'title', type: 'string', nullable: false },
          { name: 'flag', type: 'boolean', nullable: false },
          { name: 'bio', type: 'text', nullable: true },
          { name: 'views', type: 'integer', nullable: true },
          { name: 'score', type: 'real', nullable: true },
          { name: 'hidden', type: 'boolean', nullable: true },
        ],
      });

      const schema = read('db/schema/posts.ts');
      for (const line of [...required, ...nullable]) {
        expect(schema).toContain(`  ${line}\n`);
      }
    },
  );

  it('creates barrel export in db/schema.ts', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const barrel = read('db/schema.ts');
    expect(barrel).toContain('export * from "./schema/posts"');
  });

  it('appends to existing barrel export', async () => {
    writePkg({ valibot: '^1.0.0' });
    mkdirSync(join(TMP, 'db'), { recursive: true });
    writeFileSync(join(TMP, 'db/schema.ts'), 'export * from "./schema/users";\n');

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [],
    });

    const barrel = read('db/schema.ts');
    expect(barrel).toContain('export * from "./schema/users"');
    expect(barrel).toContain('export * from "./schema/posts"');
  });

  it('generates index route with GET and POST using Drizzle', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
      ],
    });

    const route = read('routes/api/posts/index.ts');
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain('import { defineHandler } from "void"');
    expect(route).toContain('import { db } from "void/db"');
    expect(route).toContain('import { posts } from "@schema"');
    expect(route).toContain('export const GET = defineHandler');
    expect(route).toContain('db.select().from(posts)');
    expect(route).toContain('export const POST = defineHandler.withValidator');
    expect(route).toContain('title: v.string()');
    expect(route).toContain('body: v.string()');
    expect(route).toContain('db.insert(posts).values({ title: body.title, body: body.body })');
  });

  it('generates index route without validator when no columns', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'events',
      columns: [],
    });

    const route = read('routes/api/events/index.ts');
    expect(route).not.toContain('valibot');
    expect(route).not.toContain('withValidator');
    expect(route).toContain('db.select().from(events)');
    expect(route).toContain('db.insert(events).values(body)');

    // [id] route is still generated even with no columns
    const idRoute = read('routes/api/events/[id].ts');
    expect(idRoute).toContain('params: v.object({ id: v.string() })');
    expect(idRoute).toContain('db.select().from(events)');
    expect(idRoute).toContain('eq(events.id');
  });

  it('generates [id] route with Drizzle query and 404 handling', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const route = read('routes/api/posts/[id].ts');
    expect(route).toContain('import { db, eq } from "void/db"');
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain('import { posts } from "@schema"');
    expect(route).toContain('params: v.object({ id: v.string() })');
    expect(route).toContain('db.select().from(posts).where(eq(posts.id, Number(params.id)))');
    expect(route).toContain('new Response("Not found", { status: 404 })');
  });

  it('uses correct valibot types for each column type', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 't',
      columns: [
        { name: 'a', type: 'string', nullable: false },
        { name: 'b', type: 'integer', nullable: false },
        { name: 'c', type: 'boolean', nullable: false },
        { name: 'd', type: 'real', nullable: false },
        { name: 'e', type: 'blob', nullable: false },
        { name: 'f', type: 'text', nullable: true },
      ],
    });

    const route = read('routes/api/t/index.ts');
    expect(route).toContain('a: v.string()');
    expect(route).toContain('b: v.number()');
    expect(route).toContain('c: v.boolean()');
    expect(route).toContain('d: v.number()');
    expect(route).toContain('e: v.instance(Blob)');
    expect(route).toContain('f: v.optional(v.string())');
  });

  it('sets up project tsconfig with @schema paths', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const tsconfig = JSON.parse(read('.void/tsconfig.json'));
    expect(tsconfig.compilerOptions.paths['@schema']).toBeDefined();
    expect(tsconfig.compilerOptions.paths['@schema/*']).toEqual(['../db/schema/*']);
  });

  it('skips existing files without overwriting', async () => {
    writePkg({ valibot: '^1.0.0' });
    const routePath = join(TMP, 'routes/api/posts/index.ts');
    mkdirSync(join(TMP, 'routes/api/posts'), { recursive: true });
    writeFileSync(routePath, 'existing content');

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [],
    });

    expect(readFileSync(routePath, 'utf-8')).toBe('existing content');
  });

  it('generates zod routes when zod is in package.json', async () => {
    writePkg({ zod: '^3.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'count', type: 'integer', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
        { name: 'data', type: 'blob', nullable: false },
        { name: 'bio', type: 'text', nullable: true },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { z } from "zod"');
    expect(index).toContain('title: z.string()');
    expect(index).toContain('count: z.number()');
    expect(index).toContain('published: z.boolean()');
    expect(index).toContain('data: z.instanceof(Blob)');
    expect(index).toContain('bio: z.string().optional()');
    expect(index).toContain('defineHandler.withValidator');
    expect(index).toContain('z.object(');
    expect(index).not.toContain('valibot');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).toContain('import { z } from "zod"');
    expect(idRoute).toContain('z.object({ id: z.string() })');
    expect(idRoute).not.toContain('valibot');
  });

  it('generates arktype routes when arktype is in package.json', async () => {
    writePkg({ arktype: '^2.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'count', type: 'integer', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
        { name: 'data', type: 'blob', nullable: false },
        { name: 'bio', type: 'text', nullable: true },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { type } from "arktype"');
    expect(index).toContain('title: "string"');
    expect(index).toContain('count: "number"');
    expect(index).toContain('published: "boolean"');
    expect(index).toContain('data: "instanceof Blob"');
    expect(index).toContain('bio: "string | undefined"');
    expect(index).toContain('defineHandler.withValidator');
    expect(index).not.toContain('valibot');
    expect(index).not.toContain('zod');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).toContain('import { type } from "arktype"');
    expect(idRoute).toContain('type({ id: "string" })');
  });

  it('generates routes without validation when none selected', async () => {
    mockSelect.mockResolvedValueOnce('none');
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).not.toContain('valibot');
    expect(index).not.toContain('zod');
    expect(index).not.toContain('arktype');
    expect(index).not.toContain('withValidator');
    expect(index).toContain('c.req.json()');
    expect(index).toContain('db.insert(posts).values(');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).not.toContain('valibot');
    expect(idRoute).not.toContain('withValidator');
    expect(idRoute).toContain('c.req.param("id")');
    expect(idRoute).toContain('db.select().from(posts)');
    expect(idRoute).toContain('eq(posts.id');
    expect(idRoute).toContain('Number(id)');
  });

  it('prompts when no validator found in package.json', async () => {
    writePkg({ react: '^19.0.0' });
    mockSelect.mockResolvedValueOnce('zod');
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    expect(mockSelect).toHaveBeenCalledOnce();
    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { z } from "zod"');
  });

  it('exits when user cancels validator prompt', async () => {
    mockSelect.mockResolvedValueOnce(Symbol.for('cancel'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(
        runGenCommand(TMP, {
          subcommand: 'model',
          name: 'posts',
          columns: [],
        }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('produces YYYYMMDDHHMMSS from a UTC date', () => {
    const date = new Date(Date.UTC(2026, 3, 10, 16, 15, 0)); // April 10, 2026 16:15:00 UTC
    expect(formatTimestamp(date)).toBe('20260410161500');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(Date.UTC(2025, 0, 5, 3, 7, 9)); // Jan 5, 2025 03:07:09 UTC
    expect(formatTimestamp(date)).toBe('20250105030709');
  });

  it('uses UTC regardless of local timezone', () => {
    const date = new Date(Date.UTC(2026, 11, 31, 23, 59, 59)); // Dec 31, 2026 23:59:59 UTC
    expect(formatTimestamp(date)).toBe('20261231235959');
  });
});

// ---------------------------------------------------------------------------
// gen migration
// ---------------------------------------------------------------------------

// Helper: seed a playground-style "placeholder" journal with `entries: []`.
// This shape ships in the kitchen-sink playground and is treated as NOT
// drizzle-managed — bare-legacy behavior applies and `gen migration` writes
// a plain .sql file without touching the journal. A journal with at least
// one entry is treated as drizzle-managed and the command refuses.
function seedPlaceholderJournal(dialect: 'sqlite' | 'postgresql' = 'sqlite'): void {
  const migrationsDir = join(TMP, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
  writeFileSync(
    join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect, entries: [] }, null, 2) + '\n',
  );
}

function spyExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
}

describe('gen migration', () => {
  it('generates timestamp-prefixed migration file (bare-legacy)', async () => {
    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_avatar_to_users' });

    const files = readdirSync(join(TMP, 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_add_avatar_to_users\.sql$/);

    const sql = readFileSync(join(TMP, 'db', 'migrations', files[0]), 'utf-8');
    expect(sql).toBe('-- add_avatar_to_users\n');
  });

  it('generates unique timestamps for subsequent migrations (bare-legacy)', async () => {
    mkdirSync(join(TMP, 'db', 'migrations'), { recursive: true });
    // Use a timestamp far in the past so the generated one always sorts after it
    writeFileSync(join(TMP, 'db/migrations/20200101000000_something.sql'), '');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'another' });

    const files = readdirSync(join(TMP, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('20200101000000_something.sql');
    expect(files[1]).toMatch(/^\d{14}_another\.sql$/);
  });

  it('avoids same-second timestamp collisions (bare-legacy)', async () => {
    mkdirSync(join(TMP, 'db', 'migrations'), { recursive: true });
    // Pre-create a file with the current UTC timestamp to force a collision
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const currentTs =
      String(now.getUTCFullYear()) +
      pad(now.getUTCMonth() + 1) +
      pad(now.getUTCDate()) +
      pad(now.getUTCHours()) +
      pad(now.getUTCMinutes()) +
      pad(now.getUTCSeconds());
    writeFileSync(join(TMP, `db/migrations/${currentTs}_existing.sql`), '');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'new_one' });

    const files = readdirSync(join(TMP, 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    // The new file must have a different (later) timestamp than the existing one
    const newFile = files.find((f) => f.includes('new_one'));
    expect(newFile).toBeDefined();
    expect(newFile).not.toContain(currentTs);
  });

  it('ignores seed.sql (bare-legacy)', async () => {
    mkdirSync(join(TMP, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(TMP, 'db/migrations/seed.sql'), '');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'first' });

    const files = readdirSync(join(TMP, 'db', 'migrations')).filter(
      (f) => f.endsWith('.sql') && f !== 'seed.sql',
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_first\.sql$/);
  });

  it('bare-legacy: does not synthesize a journal when none exists (no prior files)', async () => {
    // Empty project with no schema, no drizzle metadata, no .sql files.
    // `gen migration` must write the new .sql file without fabricating a
    // `_journal.json` — fabricating one without matching snapshot files
    // would corrupt the snapshot chain the moment the user adopts
    // drizzle-kit (it would diff against an empty baseline and regenerate
    // every existing table).
    const migrationsDir = join(TMP, 'db', 'migrations');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'initial' });

    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_initial\.sql$/);

    // No journal was created — bare-legacy stays bare-legacy.
    expect(existsSync(join(migrationsDir, 'meta', '_journal.json'))).toBe(false);
    // No snapshot files either.
    expect(existsSync(join(migrationsDir, 'meta'))).toBe(false);
  });

  it('bare-legacy: leaves existing .sql files alone and skips the journal write', async () => {
    // Project with hand-written .sql files and NO drizzle metadata at all.
    // `gen migration` must write the new .sql file and leave the on-disk
    // state otherwise untouched — no synthesized journal, no snapshots.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, '0001_create_users.sql'), '-- users\n');
    writeFileSync(join(migrationsDir, '0002_add_email.sql'), '-- email\n');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_avatar' });

    // The two pre-existing files are still on disk and the new one was
    // added alongside them.
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(3);
    expect(files[0]).toBe('0001_create_users.sql');
    expect(files[1]).toBe('0002_add_email.sql');
    expect(files[2]).toMatch(/^\d{14}_add_avatar\.sql$/);

    // No journal or snapshot files were created.
    expect(existsSync(join(migrationsDir, 'meta', '_journal.json'))).toBe(false);
    expect(existsSync(join(migrationsDir, 'meta'))).toBe(false);

    // assertJournalCoherence tolerates a missing journal and stays quiet.
    const { collectMigrations } = await import('../../src/migrations/collect.ts');
    const { assertJournalCoherence } = await import('../../src/migrations/validate.ts');
    expect(() =>
      assertJournalCoherence(migrationsDir, collectMigrations(migrationsDir)),
    ).not.toThrow();
  });

  it('bare-legacy: writes a .sql file even when void.json says postgresql', async () => {
    // Bare-legacy with a postgresql project config. The dialect is
    // irrelevant — no journal is written either way.
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, '0001_existing.sql'), '-- existing\n');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'initial_pg' });

    // New migration file was written.
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('0001_existing.sql');
    expect(files[1]).toMatch(/^\d{14}_initial_pg\.sql$/);

    // No journal was written.
    expect(existsSync(join(migrationsDir, 'meta', '_journal.json'))).toBe(false);
  });

  it('allows migration on a journal with empty entries (playground placeholder)', async () => {
    // The kitchen-sink playground ships a `meta/_journal.json` with
    // `entries: []` as a placeholder. A journal with zero entries is NOT
    // treated as drizzle-managed — `gen migration` still runs in its
    // bare-legacy mode and writes a plain .sql file without touching the
    // journal. This preserves existing playground ergonomics.
    seedPlaceholderJournal();

    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_table' });

    const migrationsDir = join(TMP, 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_add_table\.sql$/);

    // The placeholder journal is untouched — still has `entries: []`.
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8'));
    expect(journal.entries).toEqual([]);
    expect(journal.version).toBe('7');
    expect(journal.dialect).toBe('sqlite');
  });

  it('running assertJournalCoherence after gen migration does not throw (bare-legacy)', async () => {
    const { collectMigrations } = await import('../../src/migrations/collect.ts');
    const { assertJournalCoherence } = await import('../../src/migrations/validate.ts');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'coherent' });

    const migrationsDir = join(TMP, 'db', 'migrations');
    expect(() =>
      assertJournalCoherence(migrationsDir, collectMigrations(migrationsDir)),
    ).not.toThrow();
  });

  it('refuses to scaffold when _journal.json is missing but meta/*_snapshot.json is present', async () => {
    // `_journal.json` deleted in isolation (e.g. bad merge / manual
    // cleanup) while `meta/*_snapshot.json` lingers on disk is the exact
    // "partial drizzle-kit state" `assertJournalCoherence` rejects across
    // the rest of the CLI. Writing a new .sql file here would leave a
    // project every later `void db status`/`migrate`/`deploy` rejects.
    // `gen migration` must refuse up front,
    // BEFORE writing any .sql file, with the same partial-state error the
    // rest of the CLI emits.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const snapshotPath = join(migrationsDir, 'meta', '0000_silent_the_anarchist_snapshot.json');
    const snapshotBytes = Buffer.from(JSON.stringify({ id: 'snap-0000', prevId: null }));
    writeFileSync(snapshotPath, snapshotBytes);

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'add_column' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // No .sql file was written — the refusal happens before any file write.
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);

    // The snapshot is still on disk, untouched.
    expect(existsSync(snapshotPath)).toBe(true);
    expect(readFileSync(snapshotPath).equals(snapshotBytes)).toBe(true);

    // The error message points at the partial state AND the snapshot path,
    // so the user knows exactly what to restore or delete.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('partial drizzle-kit state');
    expect(errorMessages).toContain('db/migrations/meta/0000_silent_the_anarchist_snapshot.json');
  });

  it('refuses on an empty-entries journal when meta/*_snapshot.json is present', async () => {
    // A journal with `entries: []` is only "bare-legacy placeholder" when
    // there are NO accompanying drizzle artifacts. When a
    // `meta/<tag>_snapshot.json` is also on disk, the project is in the
    // same partial drizzle-kit shape `assertJournalCoherence` treats as
    // drizzle-managed; a new .sql file here would be rejected by every
    // later `void db status`/`migrate`/`deploy`.
    // Refuse BEFORE writing any .sql file so there's nothing to roll back.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal =
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }, null, 2) + '\n';
    writeFileSync(journalPath, initialJournal);
    const snapshotPath = join(migrationsDir, 'meta', '0000_silent_the_anarchist_snapshot.json');
    const snapshotBytes = Buffer.from(JSON.stringify({ id: 'snap-0000', prevId: null }));
    writeFileSync(snapshotPath, snapshotBytes);

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'add_column' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // No new .sql file was written — nothing on disk.
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);

    // The placeholder journal and snapshot were left untouched.
    expect(readFileSync(journalPath, 'utf-8')).toBe(initialJournal);
    expect(readFileSync(snapshotPath).equals(snapshotBytes)).toBe(true);

    // The error message still points the user at the drizzle-kit workflow.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('drizzle-kit');
    expect(errorMessages).toContain('void db generate');
  });

  it('delegates a data migration to drizzle-kit generate --custom on a journal-backed project', async () => {
    // Journal-backed integration: when `_journal.json` has entries and a
    // matching snapshot is on disk, `void gen migration` shells out to
    // `drizzle-kit generate --custom --name <name>`. Drizzle-kit is the
    // source of truth for the `.sql` stub, the journal entry, AND the
    // new snapshot — the earlier in-process path cloned the previous
    // snapshot, which left the new journal entry pointing at a stale
    // schema state and caused the next `void db generate` to re-emit
    // schema changes the custom migration had already applied. This
    // test asserts the delegation shape: the spawned command is
    // `drizzle-kit generate --custom --name <name>` against the
    // project root.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    const initialSnapshotPath = join(migrationsDir, 'meta', '20200101000000_snapshot.json');
    const initialSnapshot = {
      version: '6',
      dialect: 'sqlite',
      id: 'c6fe9cdc-1e14-40e0-a9c6-c27361e93e98',
      prevId: '00000000-0000-0000-0000-000000000000',
      tables: { users: { name: 'users' } },
      enums: {},
      _meta: { schemas: {}, tables: {}, columns: {} },
    };
    writeFileSync(initialSnapshotPath, JSON.stringify(initialSnapshot, null, 2));

    await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' });

    // The spawned command was `drizzle-kit generate --custom --name
    // backfill_users`, invoked with the project root as cwd.
    const generateCall = spawnMockState.calls.find(
      (c) => Array.isArray(c.args) && c.args[1] === 'generate',
    );
    expect(generateCall).toBeDefined();
    expect(generateCall!.args).toContain('--custom');
    expect(generateCall!.args).toContain('--name');
    expect(generateCall!.args[generateCall!.args.indexOf('--name') + 1]).toBe('backfill_users');
    expect(generateCall!.args).toContain('--config');
    expect(generateCall!.options.cwd).toBe(TMP);

    // After the spawn mock's default handler ran, a second .sql file is on
    // disk alongside the seeded one.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toHaveLength(2);
    expect(sqlFiles[0]).toBe('20200101000000_initial.sql');
    expect(sqlFiles[1]).toMatch(/^\d{14}_backfill_users\.sql$/);

    // Journal grew by exactly one entry.
    const updatedJournal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    expect(updatedJournal.entries).toHaveLength(2);
    expect(updatedJournal.entries[0]).toEqual(initialJournal.entries[0]);
    expect(updatedJournal.entries[1].tag).toMatch(/_backfill_users$/);

    // A second snapshot file exists. Its content shape is drizzle-kit's
    // responsibility — we only care that the delegation fired and wrote
    // one.
    const snapshotFiles = readdirSync(join(migrationsDir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshotFiles).toHaveLength(2);
  });

  it('refuses when the journal dialect disagrees with the void.json dialect', async () => {
    // Once a journal exists on disk, its `dialect` field is
    // authoritative. Drizzle-kit chains every snapshot in `meta/` off
    // that dialect, so if a user flips `void.json`'s `database` field
    // to `pg` without dropping `db/migrations/`, running `void gen
    // migration` would append a postgresql snapshot to a sqlite
    // chain — corrupting the project. The correct behavior is to
    // refuse loudly BEFORE spawning drizzle-kit.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    writeFileSync(
      join(migrationsDir, 'meta', '20200101000000_snapshot.json'),
      JSON.stringify(
        {
          version: '6',
          dialect: 'sqlite',
          id: 'c6fe9cdc-1e14-40e0-a9c6-c27361e93e98',
          prevId: '00000000-0000-0000-0000-000000000000',
          tables: { users: { name: 'users' } },
        },
        null,
        2,
      ),
    );
    // Flip the project config to postgresql, contradicting the journal.
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // Refusal must surface BOTH dialects by name so the user knows
    // which side to reconcile.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('sqlite');
    expect(errorMessages).toContain('postgresql');
    expect(errorMessages).toContain('_journal.json');

    // Drizzle-kit must NOT have been spawned — refusal happens before
    // the spawn, so no new files land on disk.
    const generateCall = spawnMockState.calls.find(
      (c) => Array.isArray(c.args) && c.args[1] === 'generate',
    );
    expect(generateCall).toBeUndefined();

    // No new .sql file was written — the refusal fires before the
    // spawn.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['20200101000000_initial.sql']);

    // Journal bytes are untouched — the refusal path never writes it.
    const afterJournal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    expect(afterJournal).toEqual(initialJournal);
  });

  it('proceeds when the journal dialect matches the void.json dialect (postgresql)', async () => {
    // Positive case: when both sides agree on postgresql, `runMigration`
    // passes the journal-derived dialect through to `writeDrizzleConfig`
    // and the spawn proceeds normally.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'postgresql',
      entries: [
        {
          idx: 0,
          version: '7',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    writeFileSync(
      join(migrationsDir, 'meta', '20200101000000_snapshot.json'),
      JSON.stringify(
        {
          version: '7',
          dialect: 'postgresql',
          id: '11111111-1111-1111-1111-111111111111',
          prevId: '00000000-0000-0000-0000-000000000000',
          tables: { users: { name: 'users' } },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' });

    // Delegation fired — drizzle-kit was spawned with `--custom`.
    const generateCall = spawnMockState.calls.find(
      (c) => Array.isArray(c.args) && c.args[1] === 'generate',
    );
    expect(generateCall).toBeDefined();
    expect(generateCall!.args).toContain('--custom');
    expect(generateCall!.args).toContain('--name');
  });

  it('refuses when the journal dialect is unsupported', async () => {
    // A hand-edited or merge-corrupted journal with e.g. `mariadb`,
    // `pg`, or an empty string must not be silently
    // coerced to sqlite. The refusal happens BEFORE the dialect
    // cross-check against `void.json`, so the user sees a clear
    // "unsupported dialect" error regardless of what `void.json`
    // currently says.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'mariadb',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    writeFileSync(
      join(migrationsDir, 'meta', '20200101000000_snapshot.json'),
      JSON.stringify(
        {
          version: '6',
          dialect: 'mariadb',
          id: '33333333-3333-3333-3333-333333333333',
          prevId: '00000000-0000-0000-0000-000000000000',
          tables: { users: { name: 'users' } },
        },
        null,
        2,
      ),
    );
    // `void.json` dialect is irrelevant — the whitelist fires first.
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({}));

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // The refusal must call out "unsupported dialect" and name the
    // offending value so the user knows which field to reconcile.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('unsupported dialect');
    expect(errorMessages).toContain('mariadb');
    expect(errorMessages).toContain('_journal.json');

    // Drizzle-kit must NOT have been spawned — whitelist fires before
    // the spawn.
    const generateCall = spawnMockState.calls.find(
      (c) => Array.isArray(c.args) && c.args[1] === 'generate',
    );
    expect(generateCall).toBeUndefined();

    // Journal bytes are untouched — the refusal path never writes it.
    const afterJournal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    expect(afterJournal).toEqual(initialJournal);
  });

  it('preflight checks the journal-tag-derived snapshot, leaving stale lex-higher snapshots untouched', async () => {
    // The preflight must locate the previous snapshot via
    // `lastEntry.tag`'s prefix (not by directory-sorting `meta/` and
    // picking the last one). A stale lex-higher snapshot file — e.g.
    // left behind by a bad merge or manual cleanup — must not confuse
    // the preflight: the tag-derived snapshot path exists, so the
    // command proceeds to spawn drizzle-kit. Drizzle-kit is the source
    // of truth for the new snapshot's content; this test only confirms
    // that the preflight path bound to the correct filename and the
    // stale snapshot was left alone.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20260412171331_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20260412171331_initial.sql'), '-- initial\n');

    // The correct snapshot (matches `lastEntry.tag`'s prefix).
    const correctSnapshotPath = join(migrationsDir, 'meta', '20260412171331_snapshot.json');
    const correctSnapshot = {
      version: '6',
      dialect: 'sqlite',
      id: '11111111-1111-1111-1111-111111111111',
      prevId: '00000000-0000-0000-0000-000000000000',
      tables: { correct_table: { name: 'correct_table' } },
    };
    writeFileSync(correctSnapshotPath, JSON.stringify(correctSnapshot, null, 2));

    // A stale lex-higher snapshot from a bad merge (distinct content).
    const staleSnapshotPath = join(migrationsDir, 'meta', '29991231235959_stale_snapshot.json');
    const staleSnapshot = {
      version: '6',
      dialect: 'sqlite',
      id: '22222222-2222-2222-2222-222222222222',
      prevId: '00000000-0000-0000-0000-000000000000',
      tables: { stale_table: { name: 'stale_table' } },
    };
    writeFileSync(staleSnapshotPath, JSON.stringify(staleSnapshot, null, 2));

    await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

    // The delegation fired — drizzle-kit was spawned with --custom.
    const generateCall = spawnMockState.calls.find(
      (c) => Array.isArray(c.args) && c.args[1] === 'generate',
    );
    expect(generateCall).toBeDefined();
    expect(generateCall!.args).toContain('--custom');

    // The stale snapshot is left untouched on disk.
    expect(JSON.parse(readFileSync(staleSnapshotPath, 'utf-8'))).toEqual(staleSnapshot);
    // The correct snapshot is also untouched.
    expect(JSON.parse(readFileSync(correctSnapshotPath, 'utf-8'))).toEqual(correctSnapshot);
  });

  it('refuses when the journal tag has no matching snapshot (even if unrelated snapshots exist)', async () => {
    // The directory-listing approach would happily copy any lex-last
    // snapshot forward, masking a broken repo state where the snapshot
    // matching `lastEntry.tag` has been lost. Deriving from the tag
    // surfaces that immediately as a refusal with a clear recovery path
    // ("restore the snapshot or regenerate with `void db generate`").
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20260412171331_initial',
          breakpoints: true,
        },
      ],
    };
    writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
    writeFileSync(join(migrationsDir, '20260412171331_initial.sql'), '-- initial\n');
    // An unrelated snapshot file that does NOT match the journal tag.
    const unrelatedPath = join(migrationsDir, 'meta', '99999999_other_snapshot.json');
    writeFileSync(
      unrelatedPath,
      JSON.stringify({ version: '6', dialect: 'sqlite', tables: {}, id: 'other' }, null, 2) + '\n',
    );

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // The error message must surface the missing snapshot under its
    // tag-derived name, not a directory-listing heuristic.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('20260412171331_initial');
    expect(errorMessages).toContain('20260412171331_snapshot.json');
    expect(errorMessages).toContain('missing under meta/');

    // No new .sql file should have been written — refusal happens before
    // any writes.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['20260412171331_initial.sql']);

    // The unrelated snapshot is left untouched.
    expect(existsSync(unrelatedPath)).toBe(true);
  });

  it('fails and refuses to write when _journal.json has a non-array entries field', async () => {
    // Seed a journal that parses as JSON but whose `entries` is a non-array
    // object (e.g. after a bad merge). This is distinct from the bare-legacy
    // "no journal on disk" path — here the journal exists but is structurally
    // invalid, so runMigration must fail loudly rather than silently fall
    // through to bare-legacy and leave the user with a malformed journal
    // plus a new .sql file on disk (which the next `void db status`/
    // `migrate`/`deploy` would choke on).
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const invalidBytes = Buffer.from(
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: {} }, null, 2) + '\n',
    );
    writeFileSync(journalPath, invalidBytes);

    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'bad_shape' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // No .sql file was written — the refusal happens before any file
    // writes.
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);

    // The invalid journal bytes are preserved byte-for-byte.
    const afterBytes = readFileSync(journalPath);
    expect(afterBytes.equals(invalidBytes)).toBe(true);
  });

  it('fails and refuses to write when _journal.json is malformed JSON', async () => {
    // `readJournal` throws on malformed JSON. Surface that as a refusal
    // before writing any new .sql file — same treatment as the non-array
    // `entries` shape.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const malformedBytes = Buffer.from('{');
    writeFileSync(journalPath, malformedBytes);

    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'broken' }),
      ).rejects.toThrow();
    } finally {
      exitSpy.mockRestore();
    }

    // No .sql file should remain on disk.
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);

    // The malformed journal bytes are preserved verbatim — not overwritten.
    const afterBytes = readFileSync(journalPath);
    expect(afterBytes.equals(malformedBytes)).toBe(true);
  });

  it('surfaces partial-drizzle state before bundled-mode guard when migrations.js is present but _journal.json is missing', async () => {
    // When `migrations.js` survives a bad merge but `_journal.json` is
    // missing, telling the user to "delete migrations.js" would strip the
    // last drizzle artifact and leave orphan SQL files in bare-legacy mode.
    // The coherence check must run BEFORE the bundled guard so the user
    // gets the partial-state error (restore the journal OR delete every
    // drizzle artifact) instead of the misleading bundled advice.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    // No `_journal.json` on disk, but the bundled `migrations.js` is still
    // there. Combined, this is the partial-state shape `assertJournalCoherence`
    // refuses with the "partial drizzle-kit state" message.
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const errorMock = log.error as ReturnType<typeof vi.fn>;
    errorMock.mockClear();
    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'should_refuse' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // No new .sql file was written.
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);
    // The bundle is left untouched.
    expect(existsSync(join(migrationsDir, 'migrations.js'))).toBe(true);

    // The error message is the partial-state one, NOT the bundled-mode
    // "delete migrations.js" advice. The user should be steered toward
    // restoring the journal (or deleting all drizzle artifacts together),
    // not toward stripping the bundle in isolation.
    const errorMessages = errorMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('partial drizzle-kit state');
    expect(errorMessages).toContain('db/migrations/migrations.js');
    expect(errorMessages).not.toContain('Either run `drizzle-kit generate`');
  });

  it('refuses to scaffold a migration when db/migrations/migrations.js exists (bundled mode)', async () => {
    // Drizzle-kit's bundled migration format (Expo / `bundle: true`) hard-
    // codes one `import m000N` line per journal entry in `migrations.js`.
    // Appending a journal entry without rewriting the bundle would throw
    // `Missing migration: <tag>` at runtime. `gen migration` must refuse
    // BEFORE writing any .sql file, so there's nothing to roll back.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal =
      JSON.stringify(
        {
          version: '7',
          dialect: 'sqlite',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1_700_000_000_000,
              tag: '20200101000000_existing',
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ) + '\n';
    writeFileSync(journalPath, initialJournal);
    writeFileSync(join(migrationsDir, '20200101000000_existing.sql'), '-- existing\n');
    // A stub `migrations.js` is enough to trigger the refusal — `gen
    // migration` only checks for existence, it doesn't parse the file.
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    const exitSpy = spyExit();
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'should_refuse' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // No new .sql file was written. Only the pre-existing migration remains.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['20200101000000_existing.sql']);

    // The journal was left untouched — byte-for-byte.
    expect(readFileSync(journalPath, 'utf-8')).toBe(initialJournal);
  });

  it('does not clone the previous snapshot in-process (drizzle-kit is the source of truth)', async () => {
    // Cloning `meta/<prevPrefix>_snapshot.json` in-process would leave
    // the new journal entry pointing at a stale schema state: if the user
    // had edited `db/schema.ts` to match their hand-written DDL, the next
    // `void db generate` would diff against the stale clone and re-emit
    // the same change. The whole write goes through
    // `drizzle-kit generate --custom --name <name>`, which recompiles
    // the current schema into a fresh snapshot.
    //
    // To pin the behavior, this test:
    //   - Seeds a previous snapshot with a `CANARY` shape.
    //   - Replaces the spawn mock with a handler that writes a NEW
    //     snapshot file with content drizzle-kit would have emitted
    //     from the current schema (i.e. totally different from the
    //     canary).
    //   - Asserts the new snapshot content is drizzle-kit's output,
    //     NOT a clone of the canary.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    writeFileSync(
      journalPath,
      JSON.stringify(
        {
          version: '7',
          dialect: 'sqlite',
          entries: [
            {
              idx: 0,
              version: '6',
              when: 1_700_000_000_000,
              tag: '20200101000000_initial',
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    const canarySnapshotPath = join(migrationsDir, 'meta', '20200101000000_snapshot.json');
    const canarySnapshot = {
      version: '6',
      dialect: 'sqlite',
      id: 'canary-id',
      prevId: null,
      tables: { CANARY_STALE_TABLE: { name: 'CANARY_STALE_TABLE' } },
    };
    writeFileSync(canarySnapshotPath, JSON.stringify(canarySnapshot, null, 2));

    // Replace the spawn mock with one that simulates drizzle-kit
    // compiling the CURRENT schema (post-user-edit) into a fresh
    // snapshot. Its tables shape must NOT match the canary — that's
    // the whole point of delegation.
    spawnMockState.handler = (_command, args, options) => {
      if (
        Array.isArray(args) &&
        args[1] === 'generate' &&
        args.includes('--custom') &&
        typeof options?.cwd === 'string'
      ) {
        // Write a new journal entry, new .sql stub, and a snapshot
        // that reflects "fresh compilation" of the current schema.
        const ts = '20260413120000';
        writeFileSync(join(options.cwd, 'db', 'migrations', `${ts}_fresh.sql`), '');
        const updatedJournal = {
          version: '7',
          dialect: 'sqlite',
          entries: [
            {
              idx: 0,
              version: '6',
              when: 1_700_000_000_000,
              tag: '20200101000000_initial',
              breakpoints: true,
            },
            { idx: 1, version: '6', when: Date.now(), tag: `${ts}_fresh`, breakpoints: true },
          ],
        };
        writeFileSync(
          join(options.cwd, 'db', 'migrations', 'meta', '_journal.json'),
          JSON.stringify(updatedJournal, null, 2) + '\n',
        );
        writeFileSync(
          join(options.cwd, 'db', 'migrations', 'meta', `${ts}_snapshot.json`),
          JSON.stringify(
            {
              version: '6',
              dialect: 'sqlite',
              id: 'drizzle-fresh-id',
              prevId: 'canary-id',
              // CRITICAL: drizzle-kit's fresh compilation includes
              // tables that reflect the current schema, NOT the stale
              // canary shape.
              tables: { fresh_from_current_schema: { name: 'fresh_from_current_schema' } },
            },
            null,
            2,
          ),
        );
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    await runGenCommand(TMP, { subcommand: 'migration', name: 'fresh' });

    // The newly-written snapshot came from drizzle-kit's fresh
    // compilation, NOT from an in-process clone of the canary. If the
    // bug ever comes back, the tables shape would match the canary
    // (`CANARY_STALE_TABLE`) instead of the fresh shape
    // (`fresh_from_current_schema`).
    const newSnapshotFiles = readdirSync(join(migrationsDir, 'meta')).filter(
      (f) => f.endsWith('_snapshot.json') && f !== '20200101000000_snapshot.json',
    );
    expect(newSnapshotFiles).toHaveLength(1);
    const newSnapshot = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', newSnapshotFiles[0]), 'utf-8'),
    );
    expect(newSnapshot.tables).toEqual({
      fresh_from_current_schema: { name: 'fresh_from_current_schema' },
    });
    expect(newSnapshot.tables).not.toHaveProperty('CANARY_STALE_TABLE');
  });

  it('rolls back any partial artifacts when drizzle-kit fails mid-run', async () => {
    // Rollback guarantee: if the spawned `drizzle-kit generate --custom`
    // exits non-zero after having already emitted SOME artifacts
    // (partial .sql or snapshot on disk, journal overwritten), the
    // rollback must byte-restore the journal and unlink any new files
    // drizzle-kit left behind. Without this, `assertJournalCoherence`
    // would gate every subsequent `void db` call until the user
    // manually cleaned up.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    const initialJournalBytes = JSON.stringify(initialJournal, null, 2) + '\n';
    writeFileSync(journalPath, initialJournalBytes);
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    const initialSnapshotPath = join(migrationsDir, 'meta', '20200101000000_snapshot.json');
    const initialSnapshotBytes = JSON.stringify(
      {
        version: '6',
        dialect: 'sqlite',
        id: '11111111-1111-1111-1111-111111111111',
        prevId: '00000000-0000-0000-0000-000000000000',
        tables: {},
      },
      null,
      2,
    );
    writeFileSync(initialSnapshotPath, initialSnapshotBytes);

    // Arm the spawn mock: write a partial .sql file and an overwritten
    // journal, then exit non-zero to simulate a crashed drizzle-kit
    // invocation. The rollback must undo both.
    spawnMockState.handler = (_command, _args, options) => {
      if (typeof options?.cwd === 'string') {
        writeFileSync(join(options.cwd, 'db', 'migrations', '99999999_partial.sql'), '');
        writeFileSync(
          join(options.cwd, 'db', 'migrations', 'meta', '_journal.json'),
          '{"corrupted": true}',
        );
      }
      return { status: 1, stdout: '', stderr: 'simulated drizzle-kit failure' };
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // The partial .sql file drizzle-kit emitted was rolled back — only
    // the seeded migration remains.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['20200101000000_initial.sql']);

    // The seeded snapshot is still intact.
    const snapshotFiles = readdirSync(join(migrationsDir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshotFiles).toEqual(['20200101000000_snapshot.json']);

    // The journal bytes were restored.
    expect(readFileSync(journalPath, 'utf-8')).toBe(initialJournalBytes);
    expect(readFileSync(initialSnapshotPath, 'utf-8')).toBe(initialSnapshotBytes);
  });

  it('does not delete an unrelated .sql file on rollback', async () => {
    // Rollback must only unlink files this call actually created.
    // Unrelated migration files on disk from a previous run must
    // survive a rollback after a drizzle-kit failure.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    const initialJournalBytes = JSON.stringify(initialJournal, null, 2) + '\n';
    writeFileSync(journalPath, initialJournalBytes);
    const initialSqlPath = join(migrationsDir, '20200101000000_initial.sql');
    const initialSqlBytes = '-- initial\n';
    writeFileSync(initialSqlPath, initialSqlBytes);
    const initialSnapshotPath = join(migrationsDir, 'meta', '20200101000000_snapshot.json');
    const initialSnapshotBytes = JSON.stringify(
      {
        version: '6',
        dialect: 'sqlite',
        id: '11111111-1111-1111-1111-111111111111',
        prevId: '00000000-0000-0000-0000-000000000000',
        tables: {},
      },
      null,
      2,
    );
    writeFileSync(initialSnapshotPath, initialSnapshotBytes);

    // Arm the spawn mock: fail without writing anything.
    spawnMockState.handler = () => ({
      status: 1,
      stdout: '',
      stderr: 'simulated drizzle-kit failure',
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // The unrelated .sql file seeded before the call is untouched.
    expect(existsSync(initialSqlPath)).toBe(true);
    expect(readFileSync(initialSqlPath, 'utf-8')).toBe(initialSqlBytes);
    // The original journal and previous snapshot are also untouched.
    expect(readFileSync(journalPath, 'utf-8')).toBe(initialJournalBytes);
    expect(readFileSync(initialSnapshotPath, 'utf-8')).toBe(initialSnapshotBytes);
  });

  it('byte-restores _journal.json when drizzle-kit corrupts it mid-write', async () => {
    // Drizzle-kit normally writes `_journal.json` atomically, but a
    // crashed invocation could leave a partial / garbage payload on
    // disk — and every subsequent `void db` command would then crash
    // in `readJournal` / `assertJournalCoherence`. The rollback must
    // byte-restore the pre-run snapshot so the project stays usable.
    seedSchema();
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const initialJournal = {
      version: '7',
      dialect: 'sqlite',
      entries: [
        {
          idx: 0,
          version: '6',
          when: 1_700_000_000_000,
          tag: '20200101000000_initial',
          breakpoints: true,
        },
      ],
    };
    const initialJournalBytes = JSON.stringify(initialJournal, null, 2) + '\n';
    writeFileSync(journalPath, initialJournalBytes);
    const expectedBuffer = readFileSync(journalPath);
    writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
    const initialSnapshotPath = join(migrationsDir, 'meta', '20200101000000_snapshot.json');
    const initialSnapshot = {
      version: '6',
      dialect: 'sqlite',
      id: '11111111-1111-1111-1111-111111111111',
      prevId: '00000000-0000-0000-0000-000000000000',
      tables: {},
    };
    writeFileSync(initialSnapshotPath, JSON.stringify(initialSnapshot, null, 2));

    // Arm the mock: corrupt the journal with garbage, then fail.
    spawnMockState.handler = (_command, _args, options) => {
      if (typeof options?.cwd === 'string') {
        writeFileSync(join(options.cwd, 'db', 'migrations', 'meta', '_journal.json'), '{invalid');
      }
      return { status: 1, stdout: '', stderr: 'simulated drizzle-kit corruption' };
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(
        runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' }),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
    }

    // The corrupted bytes were replaced with the original snapshot —
    // byte-identical to what was on disk before the run.
    const afterBuffer = readFileSync(journalPath);
    expect(afterBuffer.equals(expectedBuffer)).toBe(true);

    // No orphan .sql or snapshot artifacts.
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(['20200101000000_initial.sql']);
    const snapshotFiles = readdirSync(join(migrationsDir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshotFiles).toEqual(['20200101000000_snapshot.json']);
  });

  // Yarn Berry PnP guard — under PnP, `node_modules` does not
  // exist and dependencies resolve through `.pnp.cjs`. `runMigration`
  // must inject the PnP loaders into the spawned child's NODE_OPTIONS
  // so `drizzle-kit generate --custom` can resolve user imports like
  // `void/schema-d1` from `db/schema.ts`. These tests pin that shape.
  describe('Yarn PnP NODE_OPTIONS injection', () => {
    // Seed a minimal journal-backed project so `runMigration` reaches
    // the spawn call instead of bailing early.
    function seedJournalBackedProject(): void {
      seedSchema();
      const migrationsDir = join(TMP, 'db', 'migrations');
      mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
      const journalPath = join(migrationsDir, 'meta', '_journal.json');
      const initialJournal = {
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1_700_000_000_000,
            tag: '20200101000000_initial',
            breakpoints: true,
          },
        ],
      };
      writeFileSync(journalPath, JSON.stringify(initialJournal, null, 2) + '\n');
      writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
      writeFileSync(
        join(migrationsDir, 'meta', '20200101000000_snapshot.json'),
        JSON.stringify(
          {
            version: '6',
            dialect: 'sqlite',
            id: '11111111-1111-1111-1111-111111111111',
            prevId: '00000000-0000-0000-0000-000000000000',
            tables: {},
          },
          null,
          2,
        ),
      );
    }

    // Normalize NODE_OPTIONS across each test so pre-existing values
    // from the ambient vitest environment don't leak into assertions.
    // Saved once per test and restored in afterEach.
    let savedNodeOptions: string | undefined;
    beforeEach(() => {
      savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;
    });
    afterEach(() => {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    });

    it('injects --require .pnp.cjs into NODE_OPTIONS when .pnp.cjs exists', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = spawnMockState.calls.find(
        (c) => Array.isArray(c.args) && c.args[1] === 'generate',
      );
      expect(generateCall).toBeDefined();
      const env = (generateCall!.options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      expect(env!.NODE_OPTIONS).toContain('--require');
      // Path is JSON.stringify-quoted so spaces in the project path are
      // handled by Node's NODE_OPTIONS parser.
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      // Without a `.pnp.loader.mjs` on disk, no loader flag is injected.
      expect(env!.NODE_OPTIONS).not.toContain('--experimental-loader');
    });

    it('also injects --experimental-loader file URL when .pnp.loader.mjs exists', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      const pnpLoaderPath = join(TMP, '.pnp.loader.mjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');
      writeFileSync(pnpLoaderPath, '// fake pnp loader\n');

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = spawnMockState.calls.find(
        (c) => Array.isArray(c.args) && c.args[1] === 'generate',
      );
      expect(generateCall).toBeDefined();
      const env = (generateCall!.options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      expect(env!.NODE_OPTIONS).toContain('--require');
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      expect(env!.NODE_OPTIONS).toContain('--experimental-loader');
      // The loader flag must be a file:// URL (Node requires a URL here,
      // not a plain path). `pathToFileURL` produces the documented form.
      expect(env!.NODE_OPTIONS).toContain(pathToFileURL(pnpLoaderPath).href);
    });

    it('leaves NODE_OPTIONS untouched when no PnP markers exist', async () => {
      seedJournalBackedProject();
      // No `.pnp.cjs` or `.pnp.loader.mjs` on disk — non-PnP project.

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = spawnMockState.calls.find(
        (c) => Array.isArray(c.args) && c.args[1] === 'generate',
      );
      expect(generateCall).toBeDefined();
      const env = (generateCall!.options as { env?: NodeJS.ProcessEnv }).env;
      // The child env is a clone of process.env (from the spread), so
      // NODE_OPTIONS should match whatever the parent had — which the
      // beforeEach normalized to `undefined`.
      expect(env?.NODE_OPTIONS).toBeUndefined();
    });

    it('preserves pre-existing NODE_OPTIONS when injecting the PnP --require flag', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');
      // Simulate a user-set NODE_OPTIONS (e.g. extra heap for heavy
      // projects). The PnP flag must come first so `--require .pnp.cjs`
      // runs before anything the user registered.
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = spawnMockState.calls.find(
        (c) => Array.isArray(c.args) && c.args[1] === 'generate',
      );
      expect(generateCall).toBeDefined();
      const env = (generateCall!.options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      // Injected PnP flag comes first so `--require` runs before any
      // user-registered requires/loaders.
      expect(env!.NODE_OPTIONS!.startsWith('--require ')).toBe(true);
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      // And the pre-existing user value is still there.
      expect(env!.NODE_OPTIONS).toContain('--max-old-space-size=4096');
    });

    it('walks ancestors to find `.pnp.cjs` (workspace-root PnP, project is a subpackage)', async () => {
      // Yarn PnP monorepos keep `.pnp.cjs` at the workspace
      // root, not in each subpackage. The helper walks ancestors so
      // this common shape works. Set up a nested "subpackage" under
      // TMP and place `.pnp.cjs` one directory up from the project
      // root to simulate the workspace layout.
      const subProject = join(TMP, 'packages', 'app');
      const workspaceRoot = join(TMP, 'packages');
      mkdirSync(subProject, { recursive: true });
      // Schema + journal must live inside the project that we hand to
      // runGenCommand, not the workspace root.
      const schemaPath = join(subProject, 'db', 'schema.ts');
      mkdirSync(dirname(schemaPath), { recursive: true });
      writeFileSync(
        schemaPath,
        'import { sqliteTable, text } from "drizzle-orm/sqlite-core";\nexport const t = sqliteTable("t", { a: text("a") });\n',
      );
      const migrationsDir = join(subProject, 'db', 'migrations');
      mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
      writeFileSync(
        join(migrationsDir, 'meta', '_journal.json'),
        JSON.stringify(
          {
            version: '7',
            dialect: 'sqlite',
            entries: [
              {
                idx: 0,
                version: '6',
                when: 1_700_000_000_000,
                tag: '20200101000000_initial',
                breakpoints: true,
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(join(migrationsDir, '20200101000000_initial.sql'), '-- initial\n');
      writeFileSync(
        join(migrationsDir, 'meta', '20200101000000_snapshot.json'),
        JSON.stringify(
          {
            version: '6',
            dialect: 'sqlite',
            id: '11111111-1111-1111-1111-111111111111',
            prevId: '00000000-0000-0000-0000-000000000000',
            tables: {},
          },
          null,
          2,
        ),
      );
      // `.pnp.cjs` is at the workspace root (the PARENT of the
      // project) — NOT inside the project itself.
      const pnpCjsPath = join(workspaceRoot, '.pnp.cjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim at workspace root\n');

      await runGenCommand(subProject, { subcommand: 'migration', name: 'backfill' });

      const generateCall = spawnMockState.calls.find(
        (c) => Array.isArray(c.args) && c.args[1] === 'generate',
      );
      expect(generateCall).toBeDefined();
      const env = (generateCall!.options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      expect(env!.NODE_OPTIONS).toContain('--require');
      // The helper must have found the ancestor `.pnp.cjs`, not
      // anything inside the project directory.
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
    });
  });
});

// ---------------------------------------------------------------------------
// gen route
// ---------------------------------------------------------------------------

describe('gen route', () => {
  it('generates route with default GET handler', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/health',
      methods: ['get'],
    });

    const content = read('routes/api/health.ts');
    expect(content).toContain('import { defineHandler } from "void"');
    expect(content).toContain('export const GET = defineHandler');
    expect(content).toContain('"GET api/health"');
    expect(content).not.toContain('export const POST');
  });

  it('generates route with multiple methods and no extras', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/users',
      methods: ['get', 'post', 'delete'],
    });

    const content = read('routes/api/users.ts');
    expect(content).toContain('export const GET = defineHandler');
    expect(content).toContain('export const POST = defineHandler');
    expect(content).toContain('export const DELETE = defineHandler');
    expect(content).toContain('"GET api/users"');
    expect(content).toContain('"POST api/users"');
    expect(content).toContain('"DELETE api/users"');
    // Should not contain methods that weren't requested
    expect(content).not.toContain('export const PUT');
    expect(content).not.toContain('export const PATCH');
  });

  it('generates PUT and PATCH methods', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/items',
      methods: ['put', 'patch'],
    });

    const content = read('routes/api/items.ts');
    expect(content).toContain('export const PUT = defineHandler');
    expect(content).toContain('export const PATCH = defineHandler');
    expect(content).not.toContain('export const GET');
  });

  it('creates nested directory structure', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/v2/users/profile',
      methods: ['get'],
    });

    expect(existsSync(join(TMP, 'routes/api/v2/users/profile.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gen middleware
// ---------------------------------------------------------------------------

describe('gen middleware', () => {
  it('generates numbered middleware file', async () => {
    await runGenCommand(TMP, { subcommand: 'middleware', name: 'auth' });

    const content = read('middleware/01.auth.ts');
    expect(content).toContain('import { defineMiddleware } from "void"');
    expect(content).toContain('export default defineMiddleware');
    expect(content).toContain('await next()');
    expect(content).toContain('implement auth middleware');
  });

  it('auto-numbers after existing middleware with correct content', async () => {
    mkdirSync(join(TMP, 'middleware'), { recursive: true });
    writeFileSync(join(TMP, 'middleware/01.logger.ts'), '');
    writeFileSync(join(TMP, 'middleware/02.cors.ts'), '');

    await runGenCommand(TMP, { subcommand: 'middleware', name: 'auth' });

    expect(existsSync(join(TMP, 'middleware/03.auth.ts'))).toBe(true);
    const content = read('middleware/03.auth.ts');
    expect(content).toContain('defineMiddleware');
    expect(content).toContain('await next()');
    expect(content).toContain('implement auth middleware');
  });
});

// ---------------------------------------------------------------------------
// gen ssr
// ---------------------------------------------------------------------------

describe('gen ssr', () => {
  it('generates React SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'react' });

    const ssr = read('src/main.ssr.tsx');
    expect(ssr).toContain('import { renderToString } from "react-dom/server"');
    expect(ssr).toContain('import { defineRender } from "void"');
    expect(ssr).toContain('export default defineRender');

    const client = read('src/main.client.tsx');
    expect(client).toContain('import { hydrateRoot } from "react-dom/client"');

    const app = read('src/App.tsx');
    expect(app).toContain('import { useState } from "react"');
    expect(app).toContain('export default function App');
  });

  it('generates Vue SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'vue' });

    const ssr = read('src/main.ssr.ts');
    expect(ssr).toContain('import { createSSRApp } from "vue"');
    expect(ssr).toContain('import { renderToString } from "vue/server-renderer"');

    const client = read('src/main.client.ts');
    expect(client).toContain('import { createSSRApp } from "vue"');
    expect(client).toContain('app.mount("#app")');

    const app = read('src/App.vue');
    expect(app).toContain('<script setup lang');
    expect(app).toContain('<template>');
  });

  it('generates Svelte SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'svelte' });

    const ssr = read('src/main.ssr.ts');
    expect(ssr).toContain('import { render } from "svelte/server"');

    const client = read('src/main.client.ts');
    expect(client).toContain('import { hydrate } from "svelte"');

    const app = read('src/App.svelte');
    expect(app).toContain('$state(0)');
  });

  it('generates Solid SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'solid' });

    const ssr = read('src/main.ssr.tsx');
    expect(ssr).toContain('import { renderToString } from "solid-js/web"');

    const client = read('src/main.client.tsx');
    expect(client).toContain('import { hydrate } from "solid-js/web"');

    const app = read('src/App.tsx');
    expect(app).toContain('import { createSignal } from "solid-js"');
    expect(app).toContain('count()');
  });

  it('auto-detects React from package.json', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    await runGenCommand(TMP, { subcommand: 'ssr', framework: undefined });

    expect(existsSync(join(TMP, 'src/main.ssr.tsx'))).toBe(true);
    expect(read('src/main.ssr.tsx')).toContain('react-dom/server');
  });

  it('auto-detects Vue from package.json devDependencies', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ devDependencies: { vue: '^3.0.0' } }),
    );

    await runGenCommand(TMP, { subcommand: 'ssr', framework: undefined });

    expect(read('src/main.ssr.ts')).toContain('vue/server-renderer');
  });

  it('does not overwrite existing SSR files', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src/App.tsx'), '// my custom App');

    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'react' });

    expect(readFileSync(join(TMP, 'src/App.tsx'), 'utf-8')).toBe('// my custom App');
    // main.ssr.tsx and main.client.tsx are still created since they didn't exist
    expect(existsSync(join(TMP, 'src/main.ssr.tsx'))).toBe(true);
    expect(existsSync(join(TMP, 'src/main.client.tsx'))).toBe(true);
  });

  it('exits when no package.json and no framework flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(runGenCommand(TMP, { subcommand: 'ssr', framework: undefined })).rejects.toThrow(
        'process.exit',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('exits when package.json has no supported framework', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ dependencies: { angular: '^17.0.0' } }),
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    try {
      await expect(runGenCommand(TMP, { subcommand: 'ssr', framework: undefined })).rejects.toThrow(
        'process.exit',
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// gen cron
// ---------------------------------------------------------------------------

describe('gen cron', () => {
  it('generates cron job file with defineScheduled', async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: 'cron', name: 'hourly-sync' });

    const content = read('crons/hourly-sync.ts');
    expect(content).toContain('import { defineScheduled } from "void"');
    expect(content).toContain('export const cron = "* * * * *"');
    expect(content).toContain('export default defineScheduled(');
    expect(content).toContain('// TODO: implement hourly-sync');
  });

  it('does not overwrite existing file', async () => {
    mkdirSync(join(TMP, 'crons'), { recursive: true });
    writeFileSync(join(TMP, 'crons/sync.ts'), '// existing');

    await runGenCommand(TMP, { subcommand: 'cron', name: 'sync' });

    expect(read('crons/sync.ts')).toBe('// existing');
  });
});

// ---------------------------------------------------------------------------
// gen queue
// ---------------------------------------------------------------------------

describe('gen queue', () => {
  it('generates queue consumer file with defineQueue', async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: 'queue', name: 'emails' });

    const content = read('queues/emails.ts');
    expect(content).toContain('import { defineQueue } from "void"');
    expect(content).toContain('type Message = {};');
    expect(content).toContain('// export const maxBatchSize = 10;');
    expect(content).toContain('// export const maxBatchTimeout = 5;');
    expect(content).toContain('export default defineQueue<Message>(');
    expect(content).toContain('batch.messages');
  });

  it('does not overwrite existing file', async () => {
    mkdirSync(join(TMP, 'queues'), { recursive: true });
    writeFileSync(join(TMP, 'queues/emails.ts'), '// existing');

    await runGenCommand(TMP, { subcommand: 'queue', name: 'emails' });

    expect(read('queues/emails.ts')).toBe('// existing');
  });
});

// ---------------------------------------------------------------------------
// gen model (postgresql)
// ---------------------------------------------------------------------------

describe('gen model (postgresql)', () => {
  it('generates pgTable definition', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'views', type: 'integer', nullable: false },
      ],
    });

    const schema = read('db/schema/posts.ts');
    expect(schema).toContain('pgTable');
    expect(schema).toContain('serial("id").primaryKey()');
    expect(schema).toContain('timestamp("created_at").notNull().defaultNow()');
    expect(schema).toContain('text("title").notNull()');
    expect(schema).toContain('integer("views").notNull()');
    // Should NOT contain SQLite-specific things
    expect(schema).not.toContain('sqliteTable');
    expect(schema).not.toContain('import { sql }');
  });

  it('generates boolean and real as pg types', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'items',
      columns: [
        { name: 'active', type: 'boolean', nullable: false },
        { name: 'price', type: 'real', nullable: false },
      ],
    });

    const schema = read('db/schema/items.ts');
    expect(schema).toContain('boolean("active")');
    expect(schema).toContain('doublePrecision("price")');
  });

  it('generates routes with correct imports for pg model', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const route = read('routes/api/posts/index.ts');
    expect(route).toContain('import { defineHandler } from "void"');
    expect(route).toContain('import { db } from "void/db"');
    expect(route).toContain('import { posts } from "@schema"');
  });

  it('creates barrel export for pg model', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const barrel = read('db/schema.ts');
    expect(barrel).toContain('export * from "./schema/posts"');
  });
});

describe('gen model (mysql)', () => {
  it('generates mysqlTable definitions with native MySQL columns', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'mysql' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'products',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'active', type: 'boolean', nullable: false },
        { name: 'price', type: 'real', nullable: false },
      ],
    });

    const schema = read('db/schema/products.ts');
    expect(schema).toContain('mysqlTable');
    expect(schema).toContain('from "void/schema-mysql"');
    expect(schema).toContain('int("id").autoincrement().primaryKey()');
    expect(schema).toContain('boolean("active")');
    expect(schema).toContain('double("price")');
    expect(schema).not.toContain('sqliteTable');
  });
});
