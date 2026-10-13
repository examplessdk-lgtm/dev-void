import type { SubcommandDef } from './subcommand-prompt.ts';

export const githubSubcommands: Array<SubcommandDef> = [
  { name: 'install', description: 'Open the GitHub App install page in your browser' },
  { name: 'installations', description: 'List your GitHub App installations' },
  {
    name: 'connect',
    arg: '[project]',
    description: 'Connect a repository to a project for auto-deploy',
  },
  {
    name: 'update',
    arg: '[project]',
    description: "Update an existing connection's branch, build executor, or deploy workflow",
  },
  {
    name: 'status',
    arg: '[project]',
    description: "Show a project's GitHub connection (repo, branch, executor, workflow)",
  },
  {
    name: 'disconnect',
    arg: '[project]',
    description: 'Disconnect a project from its GitHub repository',
  },
  { name: 'link', description: 'Link your GitHub account to Void' },
  { name: 'join', description: "Join your organization's shared GitHub App installations" },
];

type Executor = 'container' | 'github_actions';

export type GithubArgs =
  | { subcommand: 'install' }
  | { subcommand: 'installations' }
  | { subcommand: 'link' }
  | { subcommand: 'join' }
  | {
      subcommand: 'connect';
      projectName: string;
      installationId?: string;
      repo?: string;
      branch?: string;
      executor?: Executor;
      workflowPath?: string;
    }
  | {
      subcommand: 'update';
      projectName: string;
      branch?: string;
      executor?: Executor;
      workflowPath?: string;
    }
  | {
      subcommand: 'status';
      projectName: string;
    }
  | {
      subcommand: 'disconnect';
      projectName: string;
      yes?: boolean;
    };

function parseExecutor(value: string): Executor {
  if (value !== 'container' && value !== 'github_actions') {
    throw new Error('github: invalid --executor (expected container|github_actions).');
  }
  return value;
}

/**
 * Parses `[project] [flags]`, where `--project <name>` is an alias for the
 * positional. Value flags require a non-blank value and receive it untrimmed.
 */
function parseProjectArgs(
  rest: Array<string>,
  valueFlags: Record<string, (value: string) => void>,
  booleanFlags: Record<string, () => void> = {},
): string {
  let projectName = '';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (Object.hasOwn(booleanFlags, arg)) {
      booleanFlags[arg]();
      continue;
    }
    if (arg !== '--project' && !Object.hasOwn(valueFlags, arg)) {
      if (arg.startsWith('-') || projectName) {
        throw new Error(`github: Unexpected argument '${arg}'.`);
      }
      projectName = arg;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.trim() === '') {
      throw new Error(`github: ${arg} requires a value.`);
    }
    if (arg !== '--project') {
      valueFlags[arg](value);
    } else if (projectName) {
      throw new Error(`github: Unexpected argument '${value}'.`);
    } else {
      projectName = value;
    }
  }
  return projectName;
}

export function parseGithubArgs(args: Array<string>): GithubArgs {
  const [subcommand, ...rest] = args;

  if (
    subcommand === 'install' ||
    subcommand === 'installations' ||
    subcommand === 'link' ||
    subcommand === 'join'
  ) {
    if (rest.length > 0) {
      throw new Error(`github: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'connect') {
    const parsed: Extract<GithubArgs, { subcommand: 'connect' }> = { subcommand, projectName: '' };
    parsed.projectName = parseProjectArgs(rest, {
      '--installation': (value) => {
        parsed.installationId = value;
      },
      '--repo': (value) => {
        parsed.repo = value;
      },
      '--branch': (value) => {
        parsed.branch = value;
      },
      '--executor': (value) => {
        parsed.executor = parseExecutor(value);
      },
      '--workflow': (value) => {
        parsed.workflowPath = value.trim();
      },
    });
    return parsed;
  }

  if (subcommand === 'update') {
    const parsed: Extract<GithubArgs, { subcommand: 'update' }> = { subcommand, projectName: '' };
    parsed.projectName = parseProjectArgs(rest, {
      // Trimmed so the no-op check and the PATCH both use the canonical branch name.
      '--branch': (value) => {
        parsed.branch = value.trim();
      },
      '--executor': (value) => {
        parsed.executor = parseExecutor(value);
      },
      '--workflow': (value) => {
        parsed.workflowPath = value.trim();
      },
    });
    return parsed;
  }

  if (subcommand === 'status') {
    return { subcommand, projectName: parseProjectArgs(rest, {}) };
  }

  if (subcommand === 'disconnect') {
    let yes = false;
    const confirm = () => {
      yes = true;
    };
    const projectName = parseProjectArgs(rest, {}, { '--yes': confirm, '-y': confirm });
    return { subcommand, projectName, yes };
  }

  throw new Error(
    'github: Usage: void github <install|installations|connect|update|status|disconnect|link|join>.',
  );
}
