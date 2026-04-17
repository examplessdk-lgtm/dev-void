#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, outro, note } from '@clack/prompts';
import { getPackageDir } from './agents';
import { parseDeployArgs } from './args';
import { asciiArts } from './ascii';
import { authSubcommands, parseAuthArgs } from './auth-args';
import { dbSubcommands, parseDbArgs } from './db-args';
import { domainSubcommands, parseDomainArgs } from './domain-args';
import { envSubcommands, parseEnvArgs } from './env-args';
import { genSubcommands, parseGenArgs } from './gen-args';
import { categoryTitle, helpLine, pc, sectionTitle } from './output';
import { projectSubcommands, parseProjectArgs } from './project-args';
import { secretSubcommands, parseSecretArgs } from './secret-args';
import type { SubcommandDef, SubcommandResult } from './subcommand-prompt';

function printHelp() {
  const version = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf-8')).version;
  const art = asciiArts[Math.floor(Math.random() * asciiArts.length)];
  console.log(pc.blue(`${art}  v${version}\n`));
  note(
    [
      helpLine('void init', 'Set up void in a new or existing project'),
      helpLine('  --agents', 'Set up agent instructions, skills, and MCP config'),
      helpLine('  --tsconfig', 'Only update tsconfig.json'),
      helpLine('  --github', 'Only create GitHub Actions workflow'),
      '',
      helpLine('void deploy', 'Build and deploy to Void'),
      helpLine('  --project <name>', 'Deploy target project name'),
      helpLine('  --dir <path>', 'Deploy a static directory (skip build)'),
      helpLine('  --spa', 'Use SPA mode (default: SSG)'),
      helpLine('  --skip-build', 'Skip the build step (use existing output)'),
      '',
      categoryTitle('auth'),
      helpLine('void auth login', 'Log in with GitHub or Google'),
      helpLine('void auth logout', 'Log out and remove credentials'),
      helpLine('void auth whoami', 'Show the logged-in username'),
      helpLine('void auth token', 'Copy auth token to clipboard'),
      '',
      categoryTitle('project'),
      helpLine('void project status [name]', 'Show deployments for a project'),
      helpLine('void project link [name]', 'Link directory to a project'),
      helpLine('void project list', 'List your projects'),
      helpLine('void project logs [--filter] [--range]', 'Show runtime logs from deployed project'),
      helpLine('void project rollback [deployId]', 'Roll back to a previous deployment'),
      helpLine('void project cancel [deployId]', 'Cancel an active deployment'),
      helpLine('void project delete [name]', 'Delete a project and all its resources'),
      helpLine('void project purge-cache [--project]', 'Purge all cached pages'),
      '',
      categoryTitle('secrets'),
      helpLine('void secret list', 'List project secrets'),
      helpLine('void secret put <name> [--project]', 'Set a project secret'),
      helpLine('void secret delete <name>', 'Delete a project secret'),
      helpLine('void secret sync <file>', 'Sync secrets from a dotenv file'),
      '',
      categoryTitle('domains'),
      helpLine('void domain add <hostname>', 'Add a custom domain'),
      helpLine('void domain delete <hostname>', 'Remove a custom domain'),
      helpLine('void domain list', 'List custom domains + status'),
      helpLine('void domain status <hostname>', 'Check domain verification status'),
      '',
      categoryTitle('database'),
      helpLine('void db status', 'Show migration status (local + remote)'),
      helpLine('void db reset', 'Reset local DB and re-run migrations'),
      helpLine('void db seed [--file <path>]', 'Reset local DB, run migrations, and seed'),
      helpLine('void db execute <sql>', 'Run SQL against the local database'),
      helpLine('  --file <path>', 'Run SQL from a file instead'),
      helpLine('void db migrate', 'Apply pending migrations locally'),
      helpLine('void db studio', 'Open Drizzle Studio for the local database'),
      helpLine('void db export [--output <path>]', 'Export local database as SQL'),
      helpLine('  --no-data', 'Schema only (no INSERT statements)'),
      helpLine('  --no-schema', 'Data only (no CREATE TABLE)'),
      helpLine('  --table <name>', 'Export a single table'),
      helpLine('void db rename-migrations', 'Rename to timestamp-based format'),
      '',
      categoryTitle('env'),
      helpLine('void env check', 'Validate env.ts against .env files'),
      helpLine('  --remote', 'Also check that required keys exist as remote secrets'),
      helpLine('void env types', 'Regenerate .void/env.d.ts from env.ts'),
      '',
      categoryTitle('codegen'),
      helpLine('void gen model <name> [cols...]', 'Generate migration + CRUD routes + db types'),
      helpLine('void gen migration <name>', 'Generate an empty migration file'),
      helpLine('void gen route <path> [--methods]', 'Generate a route with handler exports'),
      helpLine('void gen middleware <name>', 'Generate a numbered middleware file'),
      helpLine('void gen ssr [--react|--vue|...]', 'Generate SSR entry + client + App component'),
      helpLine('void gen cron <name>', 'Generate a cron job file'),
      helpLine('void gen queue <name>', 'Generate a queue consumer file'),
      '',
      categoryTitle('agent'),
      helpLine('void init --agents', 'Set up agent instructions, skills, and MCP config'),
      helpLine('void mcp', 'Start MCP server (stdio, for AI agents)'),
    ].join('\n'),
    sectionTitle('Commands'),
  );

  note(
    [
      helpLine('VOID_TOKEN', 'Auth token (or use `void login`)'),
      helpLine('VOID_PROJECT', 'Deploy target project name override'),
    ].join('\n'),
    sectionTitle('Environment'),
  );

  outro('https://void.cloud');
}

function buildArgs(result: SubcommandResult, trailingArgs: string[]): string[] {
  const out = [result.subcommand];
  if (result.arg) {
    out.push(result.arg);
  }
  if (result.extraArgs) {
    out.push(...result.extraArgs);
  }
  if (result.flags) {
    for (const [flag, value] of Object.entries(result.flags)) {
      out.push(flag);
      if (typeof value === 'string') {
        out.push(value);
      }
    }
  }
  for (const a of trailingArgs) {
    if (a.startsWith('-')) {
      out.push(a);
    }
  }
  return out;
}

async function runSubcommandGroup<T>(
  command: string,
  subcommands: SubcommandDef[],
  parse: (args: string[]) => T,
  run: (root: string, parsed: T) => Promise<void>,
) {
  const root = process.cwd();
  const sub = args[1];
  try {
    if ((!sub || sub.startsWith('-')) && process.stdin.isTTY) {
      const { promptSubcommand } = await import('./subcommand-prompt');
      const result = await promptSubcommand(command, subcommands);
      if (!result) {
        process.exit(0);
      }
      const parsed = parse(buildArgs(result, args.slice(1)));
      await run(root, parsed);
    } else {
      const parsed = parse(args.slice(1));
      await run(root, parsed);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const command = args[0];

if (command === 'deploy') {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import('./deploy').then(({ runDeploy }) => {
    runDeploy(root, {
      projectSlug: deployArgs.projectSlug,
      dir: deployArgs.dir,
      spa: deployArgs.spa,
      skipBuild: deployArgs.skipBuild,
    }).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === 'auth') {
  runSubcommandGroup('auth', authSubcommands, parseAuthArgs, (root, parsed) =>
    import('./auth-cmd').then(({ runAuthCommand }) => runAuthCommand(root, parsed)),
  );
} else if (command === 'project') {
  runSubcommandGroup('project', projectSubcommands, parseProjectArgs, (root, parsed) =>
    import('./project-cmd').then(({ runProjectCommand }) => runProjectCommand(root, parsed)),
  );
} else if (command === 'secret') {
  runSubcommandGroup('secret', secretSubcommands, parseSecretArgs, (root, parsed) =>
    import('./secret').then(({ runSecretCommand }) => runSecretCommand(root, parsed)),
  );
} else if (command === 'domain') {
  runSubcommandGroup('domain', domainSubcommands, parseDomainArgs, (root, parsed) =>
    import('./domain').then(({ runDomainCommand }) => runDomainCommand(root, parsed)),
  );
} else if (command === 'db') {
  runSubcommandGroup('db', dbSubcommands, parseDbArgs, (root, parsed) =>
    import('./db').then(({ runDbCommand }) => runDbCommand(root, parsed)),
  );
} else if (command === 'env') {
  runSubcommandGroup('env', envSubcommands, parseEnvArgs, (root, parsed) =>
    import('./env').then(({ runEnvCommand }) => runEnvCommand(root, parsed)),
  );
} else if (command === 'gen') {
  runSubcommandGroup('gen', genSubcommands, parseGenArgs, (root, parsed) =>
    import('./gen').then(({ runGenCommand }) => runGenCommand(root, parsed)),
  );
} else if (command === 'init') {
  const root = process.cwd();
  import('./init').then(({ runInitCommand, parseInitArgs }) => {
    let initArgs;
    try {
      initArgs = parseInitArgs(args.slice(1));
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    runInitCommand(root, initArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === 'mcp') {
  import('./mcp').then(({ runMcp }) => {
    runMcp();
  });
} else if (command === '-v' || command === '--version') {
  const version = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf-8')).version;
  console.log(version);
} else if (command && command !== 'help' && command !== '--help' && command !== '-h') {
  log.error(`Unknown command: ${command}. Run \`void --help\` for usage.`);
  process.exit(1);
} else if (!command && process.stdin.isTTY) {
  // Interactive top-level prompt
  const topLevelCommands: SubcommandDef[] = [
    { name: 'init', description: 'Set up void in a new or existing project' },
    { name: 'deploy', description: 'Build and deploy to Void' },
    {
      name: 'auth',
      hint: 'login | logout | whoami | token',
      description: 'Login, logout, and token management',
    },
    {
      name: 'project',
      hint: 'status | link | list | logs | rollback | delete | purge-cache',
      description: 'Manage projects and deployments',
    },
    { name: 'secret', hint: 'list | put | delete | sync', description: 'Manage project secrets' },
    {
      name: 'domain',
      hint: 'add | delete | list | status',
      description: 'Configure custom domains',
    },
    {
      name: 'db',
      hint: 'status | reset | seed | execute | migrate | studio | export | rename-migrations',
      description: 'Database migrations and management',
    },
    { name: 'env', hint: 'check | types', description: 'Validate and generate env.ts types' },
    {
      name: 'gen',
      hint: 'model | migration | route | middleware | ssr | cron | queue',
      description: 'Scaffold routes, models, and more',
    },
    { name: 'mcp', description: 'Start MCP server (for AI agents)' },
    { name: 'help', description: 'Show help message' },
  ];

  (async () => {
    const version = JSON.parse(
      readFileSync(join(getPackageDir(), 'package.json'), 'utf-8'),
    ).version;
    const art = asciiArts[Math.floor(Math.random() * asciiArts.length)];
    console.log(pc.blue(`${art}  v${version}\n`));

    const { promptSubcommand } = await import('./subcommand-prompt');
    const result = await promptSubcommand('', topLevelCommands);
    if (!result) {
      process.exit(0);
    }

    const cmd = result.subcommand;
    const root = process.cwd();

    switch (cmd) {
      case 'init': {
        const { runInitCommand, parseInitArgs } = await import('./init');
        await runInitCommand(root, parseInitArgs([]));
        return;
      }
      case 'deploy': {
        const { runDeploy } = await import('./deploy');
        await runDeploy(root);
        return;
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp');
        runMcp();
        return;
      }
      case 'auth':
        return runSubcommandGroup('auth', authSubcommands, parseAuthArgs, (r, p) =>
          import('./auth-cmd').then(({ runAuthCommand }) => runAuthCommand(r, p)),
        );
      case 'project':
        return runSubcommandGroup('project', projectSubcommands, parseProjectArgs, (r, p) =>
          import('./project-cmd').then(({ runProjectCommand }) => runProjectCommand(r, p)),
        );
      case 'secret':
        return runSubcommandGroup('secret', secretSubcommands, parseSecretArgs, (r, p) =>
          import('./secret').then(({ runSecretCommand }) => runSecretCommand(r, p)),
        );
      case 'domain':
        return runSubcommandGroup('domain', domainSubcommands, parseDomainArgs, (r, p) =>
          import('./domain').then(({ runDomainCommand }) => runDomainCommand(r, p)),
        );
      case 'db':
        return runSubcommandGroup('db', dbSubcommands, parseDbArgs, (r, p) =>
          import('./db').then(({ runDbCommand }) => runDbCommand(r, p)),
        );
      case 'env':
        return runSubcommandGroup('env', envSubcommands, parseEnvArgs, (r, p) =>
          import('./env').then(({ runEnvCommand }) => runEnvCommand(r, p)),
        );
      case 'gen':
        return runSubcommandGroup('gen', genSubcommands, parseGenArgs, (r, p) =>
          import('./gen').then(({ runGenCommand }) => runGenCommand(r, p)),
        );
      case 'help':
        printHelp();
        return;
    }
  })().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  printHelp();
}
