import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const dbSubcommands: Array<SubcommandDef> = [
  { name: 'push', description: 'Push schema to the development database (no migration files)' },
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
      'Open Drizzle Studio against the database (use --remote for the deployed PostgreSQL or MySQL database)',
    flags: [{ name: '--remote', description: 'Open Studio against the deployed database' }],
  },
  { name: 'set-url', description: 'Update the external database URL for deployment' },
  {
    name: 'connect',
    arg: '[connection-string]',
    description: 'Connect or provision an external database',
    flags: [
      { name: '--provider', arg: '<name-or-module>', description: 'Provision with an adapter' },
      { name: '--name', arg: '<name>', description: 'Provider project/database name' },
      { name: '--region', arg: '<region>', description: 'Provider region identifier' },
      { name: '--local-only', description: 'Do not sync a linked Void project' },
    ],
  },
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
  | { action: 'reset'; yes?: boolean }
  | { action: 'seed'; file?: string; yes?: boolean }
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
  | {
      action: 'connect';
      url?: string;
      provider?: string;
      name?: string;
      region?: string;
      localOnly?: boolean;
    }
  | { action: 'rename-migrations' };

// Positional arguments each action accepts after its name.
const MAX_POSITIONALS: Record<DbArgs['action'], number> = {
  push: 0,
  generate: 0,
  status: 0,
  reset: 0,
  seed: 0,
  execute: 1,
  migrate: 0,
  studio: 0,
  'set-url': 0,
  connect: 1,
  'rename-migrations': 0,
  export: 0,
};

// Flags each action reads. Every other flag stops the command, so `reset --remote` cannot
// quietly act on the local database.
const ACTION_FLAGS: Record<DbArgs['action'], Array<string>> = {
  push: [],
  generate: [],
  status: [],
  reset: ['yes'],
  seed: ['file', 'yes'],
  execute: ['file', 'remote'],
  migrate: ['remote'],
  studio: ['remote'],
  'set-url': [],
  connect: ['provider', 'name', 'region', 'local-only'],
  'rename-migrations': [],
  export: ['output', 'no-data', 'no-schema', 'table'],
};

function isDbAction(value: string | undefined): value is DbArgs['action'] {
  return value !== undefined && Object.hasOwn(MAX_POSITIONALS, value);
}

export function parseDbArgs(args: Array<string>): DbArgs {
  const { values, positionals } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      output: { type: 'string' },
      'no-data': { type: 'boolean' },
      'no-schema': { type: 'boolean' },
      table: { type: 'string' },
      remote: { type: 'boolean' },
      provider: { type: 'string' },
      name: { type: 'string' },
      region: { type: 'string' },
      'local-only': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  const [action, ...rest] = positionals;
  if (!isDbAction(action)) {
    throw new Error(
      'db: Usage: void db <push|generate|status|reset|seed|execute|migrate|studio|export|connect|set-url|rename-migrations>.',
    );
  }
  if (action === 'export' && values.remote) {
    throw new Error(
      'db: `void db export` reads only the local database; --remote is not supported.',
    );
  }
  const unsupported = Object.keys(values).find((flag) => !ACTION_FLAGS[action].includes(flag));
  if (unsupported) {
    throw new Error(`db: \`void db ${action}\` does not support --${unsupported}.`);
  }
  const maxPositionals = MAX_POSITIONALS[action];
  if (rest.length > maxPositionals) {
    throw new Error(`db: Unexpected argument '${rest[maxPositionals]}'.`);
  }

  switch (action) {
    case 'reset':
      return { action, yes: values.yes };
    case 'seed':
      return { action, file: values.file, yes: values.yes };
    case 'execute': {
      const [command] = rest;
      if (!command && !values.file) {
        throw new Error('db: Usage: void db execute <sql> or void db execute --file <path>.');
      }
      if (command && values.file) {
        throw new Error('db: Provide either SQL inline or --file, not both.');
      }
      return { action, command, file: values.file, remote: values.remote };
    }
    case 'migrate':
    case 'studio':
      return { action, remote: values.remote };
    case 'connect': {
      const [url] = rest;
      if (url && values.provider) {
        throw new Error('db: Provide either a connection string or --provider, not both.');
      }
      return {
        action,
        url,
        provider: values.provider,
        name: values.name,
        region: values.region,
        localOnly: values['local-only'],
      };
    }
    case 'export':
      return {
        action,
        output: values.output,
        noData: values['no-data'],
        noSchema: values['no-schema'],
        table: values.table,
      };
    default:
      return { action };
  }
}
