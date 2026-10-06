import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const genSubcommands: Array<SubcommandDef> = [
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
      columns: Array<{ name: string; type: string; nullable: boolean }>;
    }
  | { subcommand: 'migration'; name: string }
  | { subcommand: 'route'; path: string; methods: Array<string> }
  | { subcommand: 'middleware'; name: string }
  | { subcommand: 'ssr'; framework?: 'react' | 'vue' | 'svelte' | 'solid' }
  | { subcommand: 'cron'; name: string }
  | { subcommand: 'queue'; name: string };

const COLUMN_TYPES = new Set(['string', 'text', 'datetime', 'integer', 'boolean', 'real', 'blob']);

const VALID_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

// *_HYPHENS variant also allows hyphens (cron/queue/middleware).
const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const NAME_WITH_HYPHENS_RE = /^[a-z_][a-z0-9_-]*$/;

function parseModelArgs(args: Array<string>): GenArgs {
  const [name, ...rest] = args;
  if (!name) {
    throw new Error('gen: Usage: void gen model <name> [columns...].');
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      'gen: Model name must be lowercase alphanumeric with underscores and no leading digits.',
    );
  }

  const columns: Array<{ name: string; type: string; nullable: boolean }> = [];
  for (const col of rest) {
    const match = col.match(/^([a-z_][a-z0-9_]*):([a-z]+)(\?)?$/);
    if (!match) {
      throw new Error(`gen: Invalid column format '${col}'. Use name:type or name:type?.`);
    }
    const [, colName, colType, nullable] = match;
    if (!COLUMN_TYPES.has(colType)) {
      throw new Error(
        `gen: Unknown column type '${colType}'. Use one of: ${[...COLUMN_TYPES].join(', ')}.`,
      );
    }
    columns.push({ name: colName, type: colType, nullable: !!nullable });
  }

  return { subcommand: 'model', name, columns };
}

function parseMigrationArgs(args: Array<string>): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error('gen: Usage: void gen migration <name>.');
  }
  if (extra) {
    throw new Error(`gen: Unexpected argument '${extra}'.`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      'gen: Migration name must be lowercase alphanumeric with underscores and no leading digits.',
    );
  }
  return { subcommand: 'migration', name };
}

function parseRouteArgs(args: Array<string>): GenArgs {
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
    throw new Error('gen: Usage: void gen route <path> [--methods get,post,...].');
  }
  if (extra) {
    throw new Error(`gen: Unexpected argument '${extra}'.`);
  }

  let methods = ['get'];
  if (typeof parsed.values.methods === 'string') {
    methods = parsed.values.methods.split(',').map((m) => m.trim().toLowerCase());
    for (const m of methods) {
      if (!VALID_METHODS.has(m)) {
        throw new Error(
          `gen: Unknown HTTP method '${m}'. Use one of: ${[...VALID_METHODS].join(', ')}.`,
        );
      }
    }
  }

  // Strip leading slashes
  const cleanPath = routePath.replace(/^\/+/, '');
  return { subcommand: 'route', path: cleanPath, methods };
}

/** Shared parser for the single-name generators whose names may contain hyphens. */
function parseHyphenatedNameArgs(
  args: Array<string>,
  subcommand: 'middleware' | 'cron' | 'queue',
  label: string,
): GenArgs {
  const [name, extra] = args;
  if (!name) {
    throw new Error(`gen: Usage: void gen ${subcommand} <name>.`);
  }
  if (extra) {
    throw new Error(`gen: Unexpected argument '${extra}'.`);
  }
  if (!NAME_WITH_HYPHENS_RE.test(name)) {
    throw new Error(
      `gen: ${label} name must be lowercase alphanumeric with underscores or hyphens and no leading digits.`,
    );
  }
  return { subcommand, name };
}

function parseSsrArgs(args: Array<string>): GenArgs {
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
    throw new Error(`gen: Unexpected argument '${parsed.positionals[0]}'.`);
  }

  const frameworks = (['react', 'vue', 'svelte', 'solid'] as const).filter((f) => parsed.values[f]);
  if (frameworks.length > 1) {
    throw new Error('gen: Specify only one framework flag.');
  }

  return { subcommand: 'ssr', framework: frameworks[0] };
}

export function parseGenArgs(args: Array<string>): GenArgs {
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
    return parseHyphenatedNameArgs(rest, 'middleware', 'Middleware');
  }
  if (subcommand === 'ssr') {
    return parseSsrArgs(rest);
  }
  if (subcommand === 'cron') {
    return parseHyphenatedNameArgs(rest, 'cron', 'Cron');
  }
  if (subcommand === 'queue') {
    return parseHyphenatedNameArgs(rest, 'queue', 'Queue');
  }

  throw new Error('gen: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>.');
}
