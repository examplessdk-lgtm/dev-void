import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt';

export const genSubcommands: SubcommandDef[] = [
  {
    name: 'model',
    arg: '<name>',
    description: 'Generate migration + CRUD routes + db types',
    followUp: { type: 'repeat-input', placeholder: 'name:type or name:type?' },
  },
  { name: 'migration', arg: '<name>', description: 'Generate an empty migration file' },
  {
    name: 'route',
    arg: '<path>',
    description: 'Generate a route with handler exports',
    followUp: {
      type: 'multi-select',
      flag: '--methods',
      options: [
        { value: 'get', label: 'GET', selected: true },
        { value: 'post', label: 'POST' },
        { value: 'put', label: 'PUT' },
        { value: 'patch', label: 'PATCH' },
        { value: 'delete', label: 'DELETE' },
      ],
    },
  },
  { name: 'middleware', arg: '<name>', description: 'Generate a numbered middleware file' },
  {
    name: 'ssr',
    description: 'Generate SSR entry + client + App component',
    flags: [
      { name: '--react', description: 'Use React' },
      { name: '--vue', description: 'Use Vue' },
      { name: '--svelte', description: 'Use Svelte' },
      { name: '--solid', description: 'Use Solid' },
    ],
  },
  { name: 'cron', arg: '<name>', description: 'Generate a cron job file' },
  { name: 'queue', arg: '<name>', description: 'Generate a queue consumer file' },
];

export type GenArgs =
  | {
      subcommand: 'model';
      name: string;
      columns: { name: string; type: string; nullable: boolean }[];
    }
  | { subcommand: 'migration'; name: string }
  | { subcommand: 'route'; path: string; methods: string[] }
  | { subcommand: 'middleware'; name: string }
  | { subcommand: 'ssr'; framework?: 'react' | 'vue' | 'svelte' | 'solid' }
  | { subcommand: 'cron'; name: string }
  | { subcommand: 'queue'; name: string };

const COLUMN_TYPES = new Set(['string', 'text', 'datetime', 'integer', 'boolean', 'real', 'blob']);

const VALID_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function parseModelArgs(args: string[]): GenArgs {
  const [name, ...rest] = args;
  if (!name) {
    throw new Error('Error: Usage: void gen model <name> [columns...]');
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(
      'Error: Model name must be lowercase alphanumeric + underscores, no leading digits.',
    );
  }

  const columns: { name: string; type: string; nullable: boolean }[] = [];
  for (const col of rest) {
    const match = col.match(/^([a-z_][a-z0-9_]*):([a-z]+)(\?)?$/);
    if (!match) {
      throw new Error(`Error: Invalid column format: ${col} (expected name:type or name:type?)`);
    }
    const [, colName, colType, nullable] = match;
    if (!COLUMN_TYPES.has(colType)) {
      throw new Error(
        `Error: Unknown column type: ${colType} (expected: ${[...COLUMN_TYPES].join(', ')})`,
      );
    }
    columns.push({ name: colName, type: colType, nullable: !!nullable });
  }

  return { subcommand: 'model', name, columns };
}

function parseMigrationArgs(args: string[]): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error('Error: Usage: void gen migration <name>');
  }
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(
      'Error: Migration name must be lowercase alphanumeric + underscores, no leading digits.',
    );
  }
  return { subcommand: 'migration', name };
}

function parseRouteArgs(args: string[]): GenArgs {
  const parsed = parseArgs({
    args,
    options: {
      methods: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const [routePath, extra] = parsed.positionals;
  if (!routePath) {
    throw new Error('Error: Usage: void gen route <path> [--methods get,post,...]');
  }
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }

  let methods = ['get'];
  if (typeof parsed.values.methods === 'string') {
    methods = parsed.values.methods.split(',').map((m) => m.trim().toLowerCase());
    for (const m of methods) {
      if (!VALID_METHODS.has(m)) {
        throw new Error(
          `Error: Unknown HTTP method: ${m} (expected: ${[...VALID_METHODS].join(', ')})`,
        );
      }
    }
  }

  // Strip leading slashes
  const cleanPath = routePath.replace(/^\/+/, '');
  return { subcommand: 'route', path: cleanPath, methods };
}

function parseMiddlewareArgs(args: string[]): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error('Error: Usage: void gen middleware <name>');
  }
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }
  return { subcommand: 'middleware', name };
}

function parseSsrArgs(args: string[]): GenArgs {
  const parsed = parseArgs({
    args,
    options: {
      react: { type: 'boolean' },
      vue: { type: 'boolean' },
      svelte: { type: 'boolean' },
      solid: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (parsed.positionals.length > 0) {
    throw new Error(`Error: Unexpected argument: ${parsed.positionals[0]}`);
  }

  const frameworks = (['react', 'vue', 'svelte', 'solid'] as const).filter((f) => parsed.values[f]);
  if (frameworks.length > 1) {
    throw new Error('Error: Only one framework flag can be specified.');
  }

  return { subcommand: 'ssr', framework: frameworks[0] };
}

function parseCronArgs(args: string[]): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error('Error: Usage: void gen cron <name>');
  }
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      'Error: Cron name must be lowercase alphanumeric + underscores/hyphens, no leading digits.',
    );
  }
  return { subcommand: 'cron', name };
}

function parseQueueArgs(args: string[]): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error('Error: Usage: void gen queue <name>');
  }
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      'Error: Queue name must be lowercase alphanumeric + underscores/hyphens, no leading digits.',
    );
  }
  return { subcommand: 'queue', name };
}

export function parseGenArgs(args: string[]): GenArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === 'model') {
    return parseModelArgs(rest);
  }
  if (subcommand === 'migration') {
    return parseMigrationArgs(rest);
  }
  if (subcommand === 'route') {
    return parseRouteArgs(rest);
  }
  if (subcommand === 'middleware') {
    return parseMiddlewareArgs(rest);
  }
  if (subcommand === 'ssr') {
    return parseSsrArgs(rest);
  }
  if (subcommand === 'cron') {
    return parseCronArgs(rest);
  }
  if (subcommand === 'queue') {
    return parseQueueArgs(rest);
  }

  throw new Error('Error: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>');
}
