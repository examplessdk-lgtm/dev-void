#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '@clack/prompts';
import { getPackageDir } from './agents';
import { parseDeployArgs } from './args';
import { authSubcommands, parseAuthArgs } from './auth-args';
import { dbSubcommands, parseDbArgs } from './db-args';
import { domainSubcommands, parseDomainArgs } from './domain-args';
import { envSubcommands, parseEnvArgs } from './env-args';
import { genSubcommands, parseGenArgs } from './gen-args';
import { getHelpPath, printGlobalHelp, printHelpPage, printVoidHeader } from './help';
import { parsePrepareArgs } from './prepare-args';
import { projectSubcommands, parseProjectArgs } from './project-args';
import { secretSubcommands, parseSecretArgs } from './secret-args';
import type { SubcommandDef, SubcommandResult } from './subcommand-prompt';

function buildArgs(result: SubcommandResult, trailingArgs: Array<string>): Array<string> {
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
  subcommands: Array<SubcommandDef>,
  parse: (args: Array<string>) => T,
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
const helpPath = getHelpPath(args);

if (helpPath) {
  if (helpPath.length === 0) {
    printGlobalHelp();
  } else {
    try {
      printHelpPage(helpPath);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
} else if (command === 'deploy') {
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
} else if (command === 'prepare') {
  const root = process.cwd();
  let prepareArgs;
  try {
    prepareArgs = parsePrepareArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import('./prepare').then(({ runPrepareCommand }) => {
    runPrepareCommand(root, prepareArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
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
  log.error(`cli: Unknown command '${command}'. Run \`void --help\` for usage.`);
  process.exit(1);
} else if (!command && process.stdin.isTTY) {
  // Interactive top-level prompt
  const topLevelCommands: Array<SubcommandDef> = [
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
    {
      name: 'env',
      hint: 'check | types | example',
      description: 'Validate env.ts, generate types, or scaffold .env.example',
    },
    {
      name: 'gen',
      hint: 'model | migration | route | middleware | ssr | cron | queue',
      description: 'Scaffold routes, models, and more',
    },
    {
      name: 'prepare',
      description: 'Generate .void artifacts without starting Vite',
    },
    { name: 'mcp', description: 'Start MCP server (for AI agents)' },
    { name: 'help', description: 'Show help message' },
  ];

  (async () => {
    printVoidHeader();

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
      case 'prepare': {
        const { runPrepareCommand } = await import('./prepare');
        await runPrepareCommand(root, parsePrepareArgs([]));
        return;
      }
      case 'help':
        printGlobalHelp();
        return;
    }
  })().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  printGlobalHelp();
}
