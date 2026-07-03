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
  { name: 'link', description: 'Link your GitHub account to Void' },
  { name: 'join', description: "Join your organization's shared GitHub App installations" },
];

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
      executor?: 'container' | 'github_actions';
      workflowPath?: string;
    }
  | {
      subcommand: 'update';
      projectName: string;
      branch?: string;
      executor?: 'container' | 'github_actions';
      workflowPath?: string;
    };

export function parseGithubArgs(args: Array<string>): GithubArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === 'install') {
    if (rest.length > 0) {
      throw new Error(`github: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'installations') {
    if (rest.length > 0) {
      throw new Error(`github: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'link') {
    if (rest.length > 0) {
      throw new Error(`github: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'join') {
    if (rest.length > 0) {
      throw new Error(`github: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }

  if (subcommand === 'connect') {
    let projectName = '';
    let installationId: string | undefined;
    let repo: string | undefined;
    let branch: string | undefined;
    let executor: 'container' | 'github_actions' | undefined;
    let workflowPath: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--installation') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --installation requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --installation requires a value.');
        }
        installationId = value;
      } else if (arg === '--repo') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --repo requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --repo requires a value.');
        }
        repo = value;
      } else if (arg === '--branch') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --branch requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --branch requires a value.');
        }
        branch = value;
      } else if (arg === '--project') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --project requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --project requires a value.');
        }
        if (projectName) {
          throw new Error(`github: Unexpected argument '${value}'.`);
        }
        projectName = value;
      } else if (arg === '--executor') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --executor requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --executor requires a value.');
        }
        if (value !== 'container' && value !== 'github_actions') {
          throw new Error('github: invalid --executor (expected container|github_actions).');
        }
        executor = value;
      } else if (arg === '--workflow') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --workflow requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --workflow requires a value.');
        }
        workflowPath = value.trim();
      } else if (arg.startsWith('-')) {
        throw new Error(`github: Unexpected argument '${arg}'.`);
      } else if (projectName) {
        throw new Error(`github: Unexpected argument '${arg}'.`);
      } else {
        projectName = arg;
      }
    }

    return { subcommand, projectName, installationId, repo, branch, executor, workflowPath };
  }

  if (subcommand === 'update') {
    let projectName = '';
    let branch: string | undefined;
    let executor: 'container' | 'github_actions' | undefined;
    let workflowPath: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--branch') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --branch requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --branch requires a value.');
        }
        // Store the trimmed branch so the no-op check and the PATCH both use the
        // canonical name — a padded value like 'main ' would never match
        // refs/heads/main at OIDC exchange time and would cancel in-flight builds
        // for the old branch.
        branch = value.trim();
      } else if (arg === '--project') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --project requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --project requires a value.');
        }
        if (projectName) {
          throw new Error(`github: Unexpected argument '${value}'.`);
        }
        projectName = value;
      } else if (arg === '--executor') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --executor requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --executor requires a value.');
        }
        if (value !== 'container' && value !== 'github_actions') {
          throw new Error('github: invalid --executor (expected container|github_actions).');
        }
        executor = value;
      } else if (arg === '--workflow') {
        if (i + 1 >= rest.length) {
          throw new Error('github: --workflow requires a value.');
        }
        const value = rest[++i]!;
        if (value.trim() === '') {
          throw new Error('github: --workflow requires a value.');
        }
        workflowPath = value.trim();
      } else if (arg.startsWith('-')) {
        throw new Error(`github: Unexpected argument '${arg}'.`);
      } else if (projectName) {
        throw new Error(`github: Unexpected argument '${arg}'.`);
      } else {
        projectName = arg;
      }
    }

    return { subcommand, projectName, branch, executor, workflowPath };
  }

  throw new Error('github: Usage: void github <install|installations|connect|update|link|join>.');
}
