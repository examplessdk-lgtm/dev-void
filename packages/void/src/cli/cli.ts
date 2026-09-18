#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { log } from '@clack/prompts';
import { join } from 'pathslash';
import { getPackageDir } from './agents.ts';
import { parseDeployArgs } from './args.ts';
import { authSubcommands, parseAuthArgs } from './auth-args.ts';
import { buildSubcommands, parseBuildArgs } from './build-args.ts';
import { cloudflareSubcommands, parseCloudflareArgs } from './cloudflare-args.ts';
import { formatCloudflareUserMessage } from './cloudflare-user-output.ts';
import { parseConnectArgs } from './connect-args.ts';
import { dbSubcommands, parseDbArgs } from './db-args.ts';
import { domainSubcommands, parseDomainArgs } from './domain-args.ts';
import { emailSubcommands, parseEmailArgs } from './email-args.ts';
import { envSubcommands, parseEnvArgs } from './env-args.ts';
import { genSubcommands, parseGenArgs } from './gen-args.ts';
import { githubSubcommands, parseGithubArgs } from './github-args.ts';
import { getHelpPath, printGlobalHelp, printHelpPage, printVoidHeader } from './help.ts';
import { OperatorClientError } from './operator-client.ts';
import { parsePlatformArgs, platformSubcommands } from './platform-args.ts';
import { parsePrepareArgs } from './prepare-args.ts';
import { projectSubcommands, parseProjectArgs } from './project-args.ts';
import { secretSubcommands, parseSecretArgs } from './secret-args.ts';
import type { SubcommandDef, SubcommandResult } from './subcommand-prompt.ts';

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
  const hasNamedSubcommand = args
    .slice(1)
    .some((arg) => subcommands.some(({ name }) => name === arg));
  try {
    if ((!sub || (sub.startsWith('-') && !hasNamedSubcommand)) && process.stdin.isTTY) {
      const { promptSubcommand } = await import('./subcommand-prompt.ts');
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
    if (command === 'platform' && args.includes('--json')) {
      console.error(
        JSON.stringify(
          err instanceof OperatorClientError
            ? err.toJSON()
            : {
                error: 'invalid_command',
                message: err instanceof Error ? err.message : String(err),
              },
        ),
      );
      process.exit(1);
    }
    const message = formatCloudflareUserMessage(err instanceof Error ? err.message : String(err));
    if (command === 'platform') {
      console.error(
        err instanceof OperatorClientError && err.details !== undefined
          ? `${message}\nPartial result:\n${JSON.stringify(err.details, null, 2)}`
          : message,
      );
    } else {
      log.error(message);
    }
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
      log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }
} else if (command === 'deploy') {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  import('./deploy.ts').then(({ runDeploy }) => {
    runDeploy(root, {
      projectSlug: deployArgs.projectSlug,
      dir: deployArgs.dir,
      spa: deployArgs.spa,
      skipBuild: deployArgs.skipBuild,
      debug: deployArgs.debug,
      platform: deployArgs.platform,
      backend: deployArgs.backend,
      provision: deployArgs.provision,
      requireEmail: deployArgs.requireEmail,
    }).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
  });
} else if (command === 'connect') {
  (async () => {
    const parsed = parseConnectArgs(args.slice(1));
    const { runConnectCommand } = await import('./connect.ts');
    await runConnectCommand(process.cwd(), parsed);
  })().catch((err) => {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
} else if (command === 'auth') {
  runSubcommandGroup('auth', authSubcommands, parseAuthArgs, (root, parsed) =>
    import('./auth-cmd.ts').then(({ runAuthCommand }) => runAuthCommand(root, parsed)),
  );
} else if (command === 'platform') {
  runSubcommandGroup('platform', platformSubcommands, parsePlatformArgs, (root, parsed) =>
    import('./platform-cmd.ts').then(({ runPlatformCommand }) => runPlatformCommand(root, parsed)),
  );
} else if (command === 'cloudflare') {
  runSubcommandGroup('cloudflare', cloudflareSubcommands, parseCloudflareArgs, (root, parsed) =>
    import('./cloudflare-cmd.ts').then(({ runCloudflareCommand }) =>
      runCloudflareCommand(root, parsed),
    ),
  );
} else if (command === 'project') {
  runSubcommandGroup('project', projectSubcommands, parseProjectArgs, (root, parsed) =>
    import('./project-cmd.ts').then(({ runProjectCommand }) => runProjectCommand(root, parsed)),
  );
} else if (command === 'secret') {
  runSubcommandGroup('secret', secretSubcommands, parseSecretArgs, (root, parsed) =>
    import('./secret.ts').then(({ runSecretCommand }) => runSecretCommand(root, parsed)),
  );
} else if (command === 'domain') {
  runSubcommandGroup('domain', domainSubcommands, parseDomainArgs, (root, parsed) =>
    import('./domain.ts').then(({ runDomainCommand }) => runDomainCommand(root, parsed)),
  );
} else if (command === 'email') {
  runSubcommandGroup('email', emailSubcommands, parseEmailArgs, (root, parsed) =>
    import('./email.ts').then(({ runEmailCommand }) => runEmailCommand(root, parsed)),
  );
} else if (command === 'db') {
  runSubcommandGroup('db', dbSubcommands, parseDbArgs, (root, parsed) =>
    import('./db.ts').then(({ runDbCommand }) => runDbCommand(root, parsed)),
  );
} else if (command === 'env') {
  runSubcommandGroup('env', envSubcommands, parseEnvArgs, (root, parsed) =>
    import('./env.ts').then(({ runEnvCommand }) => runEnvCommand(root, parsed)),
  );
} else if (command === 'gen') {
  runSubcommandGroup('gen', genSubcommands, parseGenArgs, (root, parsed) =>
    import('./gen.ts').then(({ runGenCommand }) => runGenCommand(root, parsed)),
  );
} else if (command === 'github') {
  runSubcommandGroup('github', githubSubcommands, parseGithubArgs, (root, parsed) =>
    import('./github-cmd.ts').then(({ runGithubCommand }) => runGithubCommand(root, parsed)),
  );
} else if (command === 'build') {
  runSubcommandGroup('build', buildSubcommands, parseBuildArgs, (root, parsed) =>
    import('./build-cmd.ts').then(({ runBuildCommand }) => runBuildCommand(root, parsed)),
  );
} else if (command === 'prepare') {
  const root = process.cwd();
  let prepareArgs;
  try {
    prepareArgs = parsePrepareArgs(args.slice(1));
  } catch (err) {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  import('./prepare.ts').then(({ runPrepareCommand }) => {
    runPrepareCommand(root, prepareArgs).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
  });
} else if (command === 'init') {
  const root = process.cwd();
  import('./init.ts').then(({ runInitCommand, parseInitArgs }) => {
    let initArgs;
    try {
      initArgs = parseInitArgs(args.slice(1));
    } catch (err) {
      log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    runInitCommand(root, initArgs).catch((err) => {
      log.error(formatCloudflareUserMessage(err.message ?? String(err)));
      process.exit(1);
    });
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
    {
      name: 'init',
      hint: '--agents | --tsconfig | --github | --git | --no-git',
      description: 'Set up void in a new or existing project',
    },
    { name: 'connect', description: 'Connect to Cloudflare or a Void platform' },
    { name: 'deploy', description: 'Build and deploy, or link an existing Cloudflare Worker' },
    {
      name: 'auth',
      hint: 'login | logout | whoami | token',
      description: 'Login, logout, and token management',
    },
    {
      name: 'platform',
      hint: 'auth | user | project | deployment | signup | email | system | install',
      description: 'Install platforms and administer users, projects, access, and operations',
    },
    {
      name: 'cloudflare',
      hint: 'login | status | logout',
      description: 'Manage Cloudflare sign-in and inspect the deployment account',
    },
    {
      name: 'project',
      hint: 'status | link | list | logs | requests | rollback | cancel | delete | purge-cache',
      description: 'Manage projects and deployments',
    },
    { name: 'secret', hint: 'list | put | delete | sync', description: 'Manage project secrets' },
    {
      name: 'domain',
      hint: 'add | delete | list | status',
      description: 'Configure custom domains',
    },
    {
      name: 'email',
      hint: 'usage | logs | destinations | allow | disallow | domain | status | setup',
      description: 'Inspect email activity and manage verified recipients',
    },
    {
      name: 'github',
      hint: 'install | installations | connect | update | status | disconnect | link | join',
      description: 'Connect a GitHub repository for automatic deploys',
    },
    {
      name: 'build',
      hint: 'logs',
      description: 'Inspect remote builds',
    },
    {
      name: 'db',
      hint: 'connect | status | reset | seed | execute | migrate | studio | export',
      description: 'Database migrations and management',
    },
    {
      name: 'env',
      hint: 'check | types',
      description: 'Validate env.ts or generate types',
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
    { name: 'help', description: 'Show help message' },
  ];

  (async () => {
    printVoidHeader();

    const { promptSubcommand } = await import('./subcommand-prompt.ts');
    const result = await promptSubcommand('', topLevelCommands);
    if (!result) {
      process.exit(0);
    }

    const cmd = result.subcommand;
    const root = process.cwd();

    switch (cmd) {
      case 'connect': {
        const { runConnectCommand } = await import('./connect.ts');
        await runConnectCommand(root, parseConnectArgs([]));
        return;
      }
      case 'init': {
        const { runInitCommand, parseInitArgs } = await import('./init.ts');
        await runInitCommand(root, parseInitArgs([]));
        return;
      }
      case 'deploy': {
        const { runDeploy } = await import('./deploy.ts');
        await runDeploy(root);
        return;
      }
      case 'auth':
        return runSubcommandGroup('auth', authSubcommands, parseAuthArgs, (r, p) =>
          import('./auth-cmd.ts').then(({ runAuthCommand }) => runAuthCommand(r, p)),
        );
      case 'platform':
        return runSubcommandGroup('platform', platformSubcommands, parsePlatformArgs, (r, p) =>
          import('./platform-cmd.ts').then(({ runPlatformCommand }) => runPlatformCommand(r, p)),
        );
      case 'cloudflare':
        return runSubcommandGroup(
          'cloudflare',
          cloudflareSubcommands,
          parseCloudflareArgs,
          (r, p) =>
            import('./cloudflare-cmd.ts').then(({ runCloudflareCommand }) =>
              runCloudflareCommand(r, p),
            ),
        );
      case 'project':
        return runSubcommandGroup('project', projectSubcommands, parseProjectArgs, (r, p) =>
          import('./project-cmd.ts').then(({ runProjectCommand }) => runProjectCommand(r, p)),
        );
      case 'secret':
        return runSubcommandGroup('secret', secretSubcommands, parseSecretArgs, (r, p) =>
          import('./secret.ts').then(({ runSecretCommand }) => runSecretCommand(r, p)),
        );
      case 'domain':
        return runSubcommandGroup('domain', domainSubcommands, parseDomainArgs, (r, p) =>
          import('./domain.ts').then(({ runDomainCommand }) => runDomainCommand(r, p)),
        );
      case 'github':
        return runSubcommandGroup('github', githubSubcommands, parseGithubArgs, (r, p) =>
          import('./github-cmd.ts').then(({ runGithubCommand }) => runGithubCommand(r, p)),
        );
      case 'build':
        return runSubcommandGroup('build', buildSubcommands, parseBuildArgs, (r, p) =>
          import('./build-cmd.ts').then(({ runBuildCommand }) => runBuildCommand(r, p)),
        );
      case 'email':
        return runSubcommandGroup('email', emailSubcommands, parseEmailArgs, (r, p) =>
          import('./email.ts').then(({ runEmailCommand }) => runEmailCommand(r, p)),
        );
      case 'db':
        return runSubcommandGroup('db', dbSubcommands, parseDbArgs, (r, p) =>
          import('./db.ts').then(({ runDbCommand }) => runDbCommand(r, p)),
        );
      case 'env':
        return runSubcommandGroup('env', envSubcommands, parseEnvArgs, (r, p) =>
          import('./env.ts').then(({ runEnvCommand }) => runEnvCommand(r, p)),
        );
      case 'gen':
        return runSubcommandGroup('gen', genSubcommands, parseGenArgs, (r, p) =>
          import('./gen.ts').then(({ runGenCommand }) => runGenCommand(r, p)),
        );
      case 'prepare': {
        const { runPrepareCommand } = await import('./prepare.ts');
        await runPrepareCommand(root, parsePrepareArgs([]));
        return;
      }
      case 'help':
        printGlobalHelp();
        return;
    }
  })().catch((err) => {
    log.error(formatCloudflareUserMessage(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
} else {
  printGlobalHelp();
}
