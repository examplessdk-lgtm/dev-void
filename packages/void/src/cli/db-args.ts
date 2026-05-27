import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const dbSubcommands: Array<SubcommandDef> = [
  { name: 'push', description: 'Push schema to local D1 (no migration files)' },
  { name: 'generate', description: 'Generate SQL migrations from schema changes' },
  { name: 'status', description: 'Show migration status (local + remote)' },
  { name: 'reset', description: 'Reset local DB and re-run migrations' },
  {
    name: 'seed',
    description: 'Reset local DB, run migrations, and seed',
    flags: [{ name: '--file', arg: '<path>', description: 'Seed from a specific file' }],
  },
  {
    name: 'execute',
    arg: '<sql>',
    description: 'Run SQL against the database (use --remote for the deployed database)',
    flags: [{ name: '--remote', description: 'Run against the deployed database' }],
  },
  {
    name: 'migrate',
    description: 'Apply pending migrations',
    flags: [{ name: '--remote', description: 'Apply to the remote database' }],
  },
  {
    name: 'studio',
    description:
      'Open Drizzle Studio against the database (use --remote for the deployed PostgreSQL database)',
    flags: [{ name: '--remote', description: 'Open Studio against the deployed database' }],
  },
  { name: 'set-url', description: 'Update the PostgreSQL connection string for deployment' },
  { name: 'rename-migrations', description: 'Rename migrations to timestamp-based format' },
  {
    name: 'export',
    description: 'Export local database as SQL',
    flags: [
      { name: '--output', arg: '<path>', description: 'Export to a specific file path' },
      { name: '--no-data', description: 'Schema only (no INSERT statements)' },
      { name: '--no-schema', description: 'Data only (no CREATE TABLE)' },
      { name: '--table', arg: '<name>', description: 'Export a single table' },
    ],
  },
];

export type DbArgs =
  | { action: 'push' }
  | { action: 'generate' }
  | { action: 'status' }
  | { action: 'reset' }
  | { action: 'seed'; file?: string }
  | { action: 'execute'; command?: string; file?: string; remote?: boolean }
  | { action: 'migrate'; remote?: boolean }
  | { action: 'studio'; remote?: boolean }
  | {
      action: 'export';
      output?: string;
      noData?: boolean;
      noSchema?: boolean;
      table?: string;
    }
  | { action: 'set-url' }
  | { action: 'rename-migrations' };

export function parseDbArgs(args: Array<string>): DbArgs {
  const parsed = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      output: { type: 'string' },
      'no-data': { type: 'boolean' },
      'no-schema': { type: 'boolean' },
      table: { type: 'string' },
      remote: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  const [action, ...rest] = parsed.positionals;

  if (action === 'push') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'generate') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'status') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'reset') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'seed') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    const file = typeof parsed.values.file === 'string' ? parsed.values.file : undefined;
    return { action, file };
  }

  if (action === 'execute') {
    const command = rest[0];
    if (rest.length > 1) {
      throw new Error(`db: Unexpected argument '${rest[1]}'.`);
    }
    const file = typeof parsed.values.file === 'string' ? parsed.values.file : undefined;
    if (!command && !file) {
      throw new Error('db: Usage: void db execute <sql> or void db execute --file <path>.');
    }
    if (command && file) {
      throw new Error('db: Provide either SQL inline or --file, not both.');
    }
    const remote = parsed.values.remote === true ? true : undefined;
    return { action, command, file, remote };
  }

  if (action === 'migrate') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    const remote = parsed.values.remote === true ? true : undefined;
    return { action, remote };
  }

  if (action === 'studio') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    const remote = parsed.values.remote === true ? true : undefined;
    return { action, remote };
  }

  if (action === 'set-url') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'rename-migrations') {
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    return { action };
  }

  if (action === 'export') {
    if (parsed.values.remote === true) {
      throw new Error('`void db export --remote` is not yet supported. Local export only for now.');
    }
    if (rest.length > 0) {
      throw new Error(`db: Unexpected argument '${rest[0]}'.`);
    }
    const output = typeof parsed.values.output === 'string' ? parsed.values.output : undefined;
    const noData = parsed.values['no-data'] === true ? true : undefined;
    const noSchema = parsed.values['no-schema'] === true ? true : undefined;
    const table = typeof parsed.values.table === 'string' ? parsed.values.table : undefined;
    return { action, output, noData, noSchema, table };
  }

  throw new Error(
    'db: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|set-url|rename-migrations>.',
  );
}
