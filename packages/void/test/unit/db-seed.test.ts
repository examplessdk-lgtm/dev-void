import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMiniflareDatabasePath } from '../../src/migrations/runner';

const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
};

vi.mock('@clack/prompts', () => ({
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  log: {
    error: (...args: unknown[]) => mockLog.error(...args),
    info: (...args: unknown[]) => mockLog.info(...args),
    step: (...args: unknown[]) => mockLog.step(...args),
    success: (...args: unknown[]) => mockLog.success(...args),
  },
}));

const roots: string[] = [];

function createProjectRoot(options: {
  seedFile: { name: string; content: string };
  extraSeedFile?: { name: string; content: string };
  schema?: string;
}): string {
  const root = mkdtempSync(join(import.meta.dirname, '.tmp-db-seed-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
  writeFileSync(
    join(migrationsDir, '0000_messages.sql'),
    `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL
);
`,
  );
  // Keep the journal coherent with the migration file above.
  writeFileSync(
    join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: 'sqlite',
        entries: [
          { idx: 0, version: '7', when: 1730000000000, tag: '0000_messages', breakpoints: true },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(root, 'db', options.seedFile.name), options.seedFile.content);
  if (options.extraSeedFile) {
    writeFileSync(join(root, 'db', options.extraSeedFile.name), options.extraSeedFile.content);
  }
  if (options.schema) {
    writeFileSync(join(root, 'db', 'schema.ts'), options.schema);
  }
  roots.push(root);
  return root;
}

async function readMessages(root: string): Promise<{ id: number; text: string }[]> {
  const dbPath = getMiniflareDatabasePath(join(root, '.void'), 'local');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, text FROM messages ORDER BY id').all() as {
      id: number;
      text: string;
    }[];
  } finally {
    db.close();
  }
}

describe('void db seed', () => {
  let runDbCommand: typeof import('../../src/cli/db').runDbCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds from db/seed.sql by default', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.sql',
        content: "INSERT INTO messages (text) VALUES ('hello from sql');\n",
      },
    });

    await runDbCommand(root, { action: 'seed' });

    expect(await readMessages(root)).toEqual([{ id: 1, text: 'hello from sql' }]);
    expect(mockLog.success).toHaveBeenCalledWith('Seeded from db/seed.sql.');
  });

  it('seeds from db/seed.ts by default and passes the schema context', async () => {
    const root = createProjectRoot({
      schema: `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
`,
      seedFile: {
        name: 'seed.ts',
        content: `export default async function seed({ db, schema }) {
  await db.insert(schema.messages).values([
    { text: "alpha" },
    { text: "beta" },
  ]);
}
`,
      },
    });

    await runDbCommand(root, { action: 'seed' });

    expect(await readMessages(root)).toEqual([
      { id: 1, text: 'alpha' },
      { id: 2, text: 'beta' },
    ]);
    expect(mockLog.success).toHaveBeenCalledWith('Seeded from db/seed.ts.');
  });

  it('fails when multiple default seed files exist', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.sql',
        content: "INSERT INTO messages (text) VALUES ('hello from sql');\n",
      },
      extraSeedFile: {
        name: 'seed.ts',
        content: 'export default async function seed() {}\n',
      },
    });

    await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow('process.exit:1');
    expect(mockLog.error).toHaveBeenCalledWith(
      'Multiple default seed files found: db/seed.ts, db/seed.sql. Use --file <path> to choose one.',
    );
  });
});
