import { readFileSync } from 'node:fs';
import { note, outro } from '@clack/prompts';
import { join } from 'pathe';
import { getPackageDir } from './agents.ts';
import { asciiArts } from './ascii.ts';
import { categoryTitle, helpLine, pc, sectionTitle } from './output.ts';

type HelpCommand = {
  command: string;
  description: string;
};

type HelpPage = {
  summary: string;
  usage: Array<string>;
  commands?: Array<HelpCommand>;
  options?: Array<HelpCommand>;
  examples?: Array<HelpCommand>;
};

type HelpNode = HelpPage & { children?: HelpTree };
type HelpTree = Record<string, HelpNode>;

const HELP_TREE: HelpTree = {
  init: {
    summary: 'Set up Void in a new or existing project.',
    usage: ['void init [options]'],
    options: [
      { command: '--agents', description: 'Set up agent instructions, skills, and MCP config' },
      { command: '--tsconfig', description: 'Only update tsconfig.json' },
      {
        command: '--github',
        description: 'Only create the GitHub Actions deploy workflow (OIDC, no stored token)',
      },
    ],
    examples: [
      { command: 'void init', description: 'Scaffold or configure the current project' },
      { command: 'void init --agents', description: 'Install agent instructions and MCP config' },
      { command: 'void init --github', description: 'Scaffold the GitHub Actions deploy workflow' },
    ],
  },
  deploy: {
    summary: 'Build and deploy the current project to Void.',
    usage: ['void deploy [options]'],
    options: [
      { command: '--project <name>', description: 'Deploy target project name' },
      { command: '--dir <path>', description: 'Deploy a static directory and skip build' },
      { command: '--spa', description: 'Use SPA mode for static deploys' },
      { command: '--skip-build', description: 'Skip the build step and use existing output' },
      {
        command: '--debug',
        description: 'Mirror the deploy log to stderr (always written to ~/.void/logs)',
      },
    ],
    examples: [
      { command: 'void deploy', description: 'Deploy the linked project' },
      { command: 'void deploy --project my-app', description: 'Deploy to a specific project' },
      { command: 'void deploy --dir dist --spa', description: 'Deploy a static SPA directory' },
    ],
  },
  auth: {
    summary: 'Log in, log out, and inspect local auth state.',
    usage: ['void auth <command>'],
    commands: [
      { command: 'login', description: 'Log in with GitHub or Google' },
      { command: 'logout', description: 'Log out and remove credentials' },
      { command: 'whoami', description: 'Show the logged-in username' },
      { command: 'token', description: 'Copy auth token to clipboard' },
    ],
    children: {
      login: basicSubcommand('Log in with GitHub or Google.', 'void auth login'),
      logout: basicSubcommand('Log out and remove credentials.', 'void auth logout'),
      whoami: basicSubcommand('Show the logged-in username.', 'void auth whoami'),
      token: basicSubcommand('Copy auth token to clipboard.', 'void auth token'),
    },
  },
  project: {
    summary: 'Manage Void projects and deployments.',
    usage: ['void project <command>'],
    commands: [
      { command: 'status [name]', description: 'Show deployments for a project' },
      { command: 'link [name]', description: 'Link this directory to a project' },
      { command: 'list', description: 'List your projects' },
      { command: 'logs', description: 'Show runtime logs from the deployed project' },
      { command: 'rollback [deployId]', description: 'Roll back to a previous deployment' },
      { command: 'cancel [deployId]', description: 'Cancel an active deployment' },
      { command: 'delete [name]', description: 'Delete a project and all its resources' },
      { command: 'purge-cache', description: 'Purge all cached pages' },
    ],
    children: {
      status: basicSubcommand(
        'Show deployments for a project.',
        'void project status [name]',
        'void project status my-app',
      ),
      link: basicSubcommand(
        'Link this directory to a Void project.',
        'void project link [name]',
        'void project link my-app',
      ),
      list: basicSubcommand('List your projects.', 'void project list'),
      logs: {
        summary: 'Show runtime logs from the deployed project.',
        usage: ['void project logs [options]'],
        options: [
          { command: '--filter <text>', description: 'Substring search over log messages' },
          {
            command: '--level <level>',
            description: 'Filter by level: error|warn|info|log|debug|all (default: all)',
          },
          { command: '--range <range>', description: 'Time range to query (default: 1h)' },
          { command: '--deployment <id>', description: 'Limit logs to one deployment' },
        ],
        examples: [
          { command: 'void project logs --range 30m', description: 'Show recent project logs' },
          {
            command: 'void project logs --level error',
            description: 'Show only error-level entries and exceptions',
          },
          {
            command: 'void project logs --filter websocket',
            description: 'Substring search over log messages',
          },
        ],
      },
      rollback: basicSubcommand(
        'Roll back to a previous deployment.',
        'void project rollback [deployId]',
      ),
      cancel: basicSubcommand('Cancel an active deployment.', 'void project cancel [deployId]'),
      delete: {
        summary: 'Delete a project and all its resources.',
        usage: ['void project delete [name] [options]'],
        options: [{ command: '--force, -f', description: 'Delete without confirmation' }],
        examples: [{ command: 'void project delete my-app', description: 'Delete a project' }],
      },
      'purge-cache': {
        summary: 'Purge all cached pages for a project.',
        usage: ['void project purge-cache [options]'],
        options: [{ command: '--project <name>', description: 'Project name override' }],
      },
    },
  },
  secret: {
    summary: 'Manage production secrets for Void projects.',
    usage: ['void secret <command>'],
    commands: [
      { command: 'list', description: 'List project secrets' },
      { command: 'put <name>', description: 'Set a project secret' },
      { command: 'delete <name>', description: 'Delete a project secret' },
      { command: 'sync <file>', description: 'Sync secrets from a dotenv file' },
    ],
    children: {
      list: withProjectOption('List project secrets.', 'void secret list [options]'),
      put: withProjectOption('Set a project secret.', 'void secret put <name> [options]'),
      delete: withProjectOption('Delete a project secret.', 'void secret delete <name> [options]'),
      sync: withProjectOption(
        'Sync secrets from a dotenv file.',
        'void secret sync <file> [options]',
      ),
    },
  },
  domain: {
    summary: 'Configure custom domains for Void projects.',
    usage: ['void domain <command>'],
    commands: [
      { command: 'add <hostname>', description: 'Add a custom domain' },
      { command: 'delete <hostname>', description: 'Remove a custom domain' },
      { command: 'list', description: 'List custom domains and status' },
      { command: 'status <hostname>', description: 'Check domain verification status' },
    ],
    children: {
      add: withProjectOption('Add a custom domain.', 'void domain add <hostname> [options]'),
      delete: withProjectOption(
        'Remove a custom domain.',
        'void domain delete <hostname> [options]',
      ),
      list: withProjectOption('List custom domains and status.', 'void domain list [options]'),
      status: {
        summary:
          'Check domain verification status. Prints a rolled-up state with a one-line diagnostic.',
        usage: ['void domain status <hostname> [options]'],
        options: [
          { command: '--project <name>', description: 'Project name override' },
          {
            command: '--verbose',
            description: 'Also print the raw multi-line status breakdown',
          },
        ],
      },
    },
  },
  github: {
    summary: 'Connect a GitHub repository for automatic deploys.',
    usage: ['void github <command>'],
    commands: [
      { command: 'install', description: 'Open the GitHub App install page in your browser' },
      { command: 'installations', description: 'List your GitHub App installations' },
      {
        command: 'connect [project]',
        description: 'Connect a repository to a project for auto-deploy',
      },
    ],
    children: {
      install: basicSubcommand(
        'Open the GitHub App install page in your browser.',
        'void github install',
      ),
      installations: basicSubcommand(
        'List your GitHub App installations.',
        'void github installations',
      ),
      connect: {
        summary: 'Connect a repository to a project for automatic deploys.',
        usage: ['void github connect [project] [options]'],
        options: [
          { command: '--installation <id>', description: 'GitHub App installation ID' },
          { command: '--repo <owner/repo>', description: 'Repository full name (owner/repo)' },
          { command: '--branch <name>', description: 'Branch to deploy from (default: main)' },
          {
            command: '--executor <type>',
            description: 'Build executor: container (default) | github_actions',
          },
        ],
        examples: [
          {
            command: 'void github connect [project]',
            description: 'Connect a repository to a project',
          },
        ],
      },
    },
  },
  db: {
    summary: 'Manage local and remote database state.',
    usage: ['void db <command>'],
    commands: [
      { command: 'push', description: 'Push schema to local D1 without migration files' },
      { command: 'generate', description: 'Generate SQL migrations from schema changes' },
      { command: 'status', description: 'Show migration status (local and remote)' },
      { command: 'reset', description: 'Reset local DB and re-run migrations' },
      { command: 'seed', description: 'Reset local DB, run migrations, and seed' },
      {
        command: 'execute <sql>',
        description: 'Run SQL against the database (--remote for deployed)',
      },
      { command: 'migrate', description: 'Apply pending migrations' },
      { command: 'studio', description: 'Open Drizzle Studio (--remote for deployed PG)' },
      { command: 'export', description: 'Export local database as SQL' },
      { command: 'set-url', description: 'Update the PostgreSQL connection string' },
      { command: 'rename-migrations', description: 'Rename migrations to timestamp format' },
    ],
    children: {
      push: basicSubcommand('Push schema to local D1 without migration files.', 'void db push'),
      generate: basicSubcommand('Generate SQL migrations from schema changes.', 'void db generate'),
      status: basicSubcommand('Show migration status for local and remote DBs.', 'void db status'),
      reset: basicSubcommand('Reset local DB and re-run migrations.', 'void db reset'),
      seed: {
        summary: 'Reset local DB, run migrations, and seed data.',
        usage: ['void db seed [options]'],
        options: [{ command: '--file <path>', description: 'Seed from a specific file' }],
      },
      execute: {
        summary:
          'Run SQL against the database (local by default; use --remote for the deployed database).',
        usage: ['void db execute <sql>', 'void db execute --file <path>'],
        options: [
          { command: '--file <path>', description: 'Run SQL from a file instead' },
          {
            command: '--remote',
            description:
              'Run against the deployed database (D1 via proxy; PostgreSQL via direct connection)',
          },
        ],
        examples: [
          { command: 'void db execute "select * from users"', description: 'Run inline SQL' },
          { command: 'void db execute --file query.sql', description: 'Run SQL from a file' },
          {
            command: 'void db execute --remote "select count(*) from users"',
            description: 'Query the deployed database',
          },
        ],
      },
      migrate: {
        summary: 'Apply pending migrations.',
        usage: ['void db migrate [options]'],
        options: [{ command: '--remote', description: 'Apply to the remote database' }],
      },
      studio: {
        summary:
          'Open Drizzle Studio against the database (local by default; use --remote for the deployed PostgreSQL database; D1 remote not yet supported).',
        usage: ['void db studio [options]'],
        options: [
          {
            command: '--remote',
            description:
              'Open Studio against the deployed PostgreSQL database (D1 remote not yet supported)',
          },
        ],
        examples: [
          { command: 'void db studio', description: 'Open Studio for the local database' },
          {
            command: 'void db studio --remote',
            description: 'Open Studio against the deployed PostgreSQL database',
          },
        ],
      },
      export: {
        summary: 'Export local database contents as SQL.',
        usage: ['void db export [options]'],
        options: [
          { command: '--output <path>', description: 'Export to a specific file path' },
          { command: '--no-data', description: 'Schema only (no INSERT statements)' },
          { command: '--no-schema', description: 'Data only (no CREATE TABLE)' },
          { command: '--table <name>', description: 'Export a single table' },
        ],
      },
      'set-url': basicSubcommand(
        'Update the PostgreSQL connection string for deployment.',
        'void db set-url',
      ),
      'rename-migrations': basicSubcommand(
        'Rename migrations to timestamp-based format.',
        'void db rename-migrations',
      ),
    },
  },
  env: {
    summary: 'Validate env.ts and generate environment artifacts.',
    usage: ['void env <command>'],
    commands: [
      { command: 'check', description: 'Validate env.ts against .env files' },
      { command: 'types', description: 'Regenerate .void/env.d.ts from env.ts' },
      { command: 'example', description: 'Generate .env.example from env.ts schema' },
    ],
    children: {
      check: {
        summary: 'Validate env.ts against .env files and optionally remote secrets.',
        usage: ['void env check [options]'],
        options: [
          { command: '--remote', description: 'Also check required keys as remote secrets' },
        ],
      },
      types: basicSubcommand('Regenerate .void/env.d.ts from env.ts.', 'void env types'),
      example: {
        summary: 'Refresh the Void-managed block in .env.example.',
        usage: ['void env example [options]'],
        options: [{ command: '--force', description: 'Suppress the appended block notice' }],
      },
    },
  },
  gen: {
    summary: 'Scaffold routes, models, background jobs, and framework entries.',
    usage: ['void gen <command>'],
    commands: [
      {
        command: 'model <name> [cols...]',
        description: 'Generate migration, CRUD routes, and DB types',
      },
      { command: 'migration <name>', description: 'Generate an empty migration file' },
      { command: 'route <path>', description: 'Generate a route with handler exports' },
      { command: 'middleware <name>', description: 'Generate a numbered middleware file' },
      { command: 'ssr', description: 'Generate SSR entry, client, and App component' },
      { command: 'cron <name>', description: 'Generate a cron job file' },
      { command: 'queue <name>', description: 'Generate a queue consumer file' },
    ],
    children: {
      model: {
        summary: 'Generate a migration, CRUD routes, and database types.',
        usage: ['void gen model <name> [columns...]'],
        examples: [
          { command: 'void gen model post title:string body:text', description: 'Create a model' },
        ],
      },
      migration: basicSubcommand('Generate an empty migration file.', 'void gen migration <name>'),
      route: {
        summary: 'Generate a route with handler exports.',
        usage: ['void gen route <path> [options]'],
        options: [
          { command: '--methods <list>', description: 'Comma-separated methods (default: get)' },
        ],
        examples: [
          { command: 'void gen route api/posts --methods get,post', description: 'Create a route' },
        ],
      },
      middleware: basicSubcommand(
        'Generate a numbered middleware file.',
        'void gen middleware <name>',
      ),
      ssr: {
        summary: 'Generate SSR entry, client, and App component.',
        usage: ['void gen ssr [options]'],
        options: [
          { command: '--react', description: 'Use React' },
          { command: '--vue', description: 'Use Vue' },
          { command: '--svelte', description: 'Use Svelte' },
          { command: '--solid', description: 'Use Solid' },
        ],
      },
      cron: basicSubcommand('Generate a cron job file.', 'void gen cron <name>'),
      queue: basicSubcommand('Generate a queue consumer file.', 'void gen queue <name>'),
    },
  },
  prepare: {
    summary: 'Generate .void artifacts without starting Vite.',
    usage: ['void prepare'],
    examples: [{ command: 'void prepare', description: 'Refresh generated project types' }],
  },
  mcp: {
    summary: 'Start the Void MCP server over stdio for AI agents.',
    usage: ['void mcp'],
  },
};

function basicSubcommand(summary: string, usage: string, example?: string): HelpPage {
  return {
    summary,
    usage: [usage],
    examples: example ? [{ command: example, description: summary }] : undefined,
  };
}

function withProjectOption(summary: string, usage: string): HelpPage {
  return {
    summary,
    usage: [usage],
    options: [{ command: '--project <name>', description: 'Project name override' }],
  };
}

export function printGlobalHelp(): void {
  printVoidHeader();

  note(
    [
      globalCommandLine(['init'], 'void init'),
      ...globalOptionLines(['init']),
      '',
      globalCommandLine(['deploy'], 'void deploy'),
      ...globalOptionLines(['deploy']),
      '',
      ...globalCommandGroup('auth'),
      '',
      ...globalCommandGroup('project'),
      '',
      categoryTitle('secrets'),
      ...globalCommandLines('secret'),
      '',
      ...globalCommandGroup('domain'),
      '',
      ...globalCommandGroup('github'),
      '',
      categoryTitle('database'),
      ...globalCommandLines('db', {
        execute: 'execute <sql>',
        export: 'export [--output <path>]',
        seed: 'seed [--file <path>]',
      }),
      ...globalOptionLines(['db', 'execute']),
      ...globalOptionLines(['db', 'export']),
      '',
      ...globalCommandGroup('env'),
      ...globalOptionLines(['env', 'check']),
      ...globalOptionLines(['env', 'example']),
      '',
      categoryTitle('codegen'),
      globalCommandLine(['prepare'], 'void prepare'),
      ...globalCommandLines('gen', { route: 'route <path> [--methods]' }),
      '',
      categoryTitle('agent'),
      helpLine('void init --agents', requiredOption(['init'], '--agents').description),
      globalCommandLine(['mcp'], 'void mcp'),
      '',
      categoryTitle('help'),
      helpLine('void help <command>', 'Show command-specific help'),
      helpLine('void <command> --help', 'Show command-specific help'),
    ].join('\n'),
    sectionTitle('Commands'),
  );

  note(
    [
      helpLine('VOID_TOKEN', 'Auth token (or use `void auth login`)'),
      helpLine('VOID_PROJECT', 'Deploy target project name override'),
    ].join('\n'),
    sectionTitle('Environment'),
  );

  outro('https://void.cloud');
}

export function printVoidHeader(): void {
  const version = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf-8')).version;
  const art = asciiArts[Math.floor(Math.random() * asciiArts.length)];
  console.log(pc.blue(`${art}  v${version}\n`));
}

export function getHelpPath(args: Array<string>): Array<string> | null {
  if (args.length === 0) {
    return null;
  }

  const command = args[0];
  if (command === 'help') {
    return args.slice(1);
  }
  if (command === '--help' || command === '-h') {
    return [];
  }
  if (args[1] === 'help') {
    return [command, ...args.slice(2)];
  }

  const helpIndex = args.findIndex((arg) => arg === '--help' || arg === '-h');
  if (helpIndex === -1) {
    return null;
  }

  return getKnownHelpPrefix(args.slice(0, helpIndex));
}

export function hasHelpPage(path: Array<string>): boolean {
  return findHelpPage(path) !== null;
}

export function printHelpPage(path: Array<string>): void {
  const page = findHelpPage(path);
  if (!page) {
    throw new Error(`Unknown help topic: ${formatHelpPath(path)}`);
  }

  const lines = [
    page.summary,
    '',
    categoryTitle('Usage'),
    ...page.usage.map((usage) => `  ${usage}`),
  ];

  appendHelpSection(lines, 'Commands', page.commands);
  appendHelpSection(lines, 'Options', page.options);
  appendHelpSection(lines, 'Examples', page.examples);

  if (page.commands) {
    lines.push('', `Run \`void help ${path.join(' ')} <command>\` for command-specific help.`);
  }

  note(lines.join('\n'), sectionTitle(`void ${path.join(' ')}`));
}

function appendHelpSection(
  lines: Array<string>,
  title: string,
  entries: Array<HelpCommand> | undefined,
): void {
  if (!entries || entries.length === 0) {
    return;
  }

  lines.push('', categoryTitle(title));
  for (const entry of entries) {
    lines.push(helpLine(entry.command, entry.description));
  }
}

function globalCommandGroup(group: keyof typeof HELP_TREE): Array<string> {
  return [categoryTitle(group), ...globalCommandLines(group)];
}

function globalCommandLines(
  group: keyof typeof HELP_TREE,
  commandOverrides?: Record<string, string>,
): Array<string> {
  const page = requiredPage([group]);
  return (page.commands ?? []).map((command) =>
    helpLine(
      `void ${group} ${commandOverrides?.[command.command.split(' ')[0]] ?? command.command}`,
      command.description,
    ),
  );
}

function globalCommandLine(path: Array<string>, command: string): string {
  return helpLine(command, formatGlobalDescription(requiredPage(path).summary));
}

function globalOptionLines(path: Array<string>): Array<string> {
  const page = requiredPage(path);
  return (page.options ?? []).map((option) => helpLine(`  ${option.command}`, option.description));
}

function requiredOption(path: Array<string>, command: string): HelpCommand {
  const option = requiredPage(path).options?.find((entry) => entry.command === command);
  if (!option) {
    throw new Error(`Missing help option: ${formatHelpPath(path)} ${command}`);
  }
  return option;
}

function requiredPage(path: Array<string>): HelpPage {
  const page = findHelpPage(path);
  if (!page) {
    throw new Error(`Missing help page: ${formatHelpPath(path)}`);
  }
  return page;
}

function formatGlobalDescription(summary: string): string {
  return summary.replace(/\.$/, '');
}

function findHelpPage(path: Array<string>): HelpPage | null {
  let tree: HelpTree | undefined = HELP_TREE;
  let page: HelpPage | null = null;

  for (const part of path) {
    const node: HelpNode | undefined = tree?.[part];
    if (!node) {
      return null;
    }
    page = node;
    tree = node.children;
  }

  return page;
}

function getKnownHelpPrefix(args: Array<string>): Array<string> {
  let tree: HelpTree | undefined = HELP_TREE;
  const path: Array<string> = [];

  for (const arg of args) {
    if (arg.startsWith('-')) {
      break;
    }
    const node: HelpNode | undefined = tree?.[arg];
    if (!node) {
      if (path.length === 0) {
        return [arg];
      }
      if (tree) {
        return [...path, arg];
      }
      break;
    }
    path.push(arg);
    tree = node.children;
  }

  return path;
}

function formatHelpPath(path: Array<string>): string {
  return path.length === 0 ? 'help' : path.join(' ');
}
