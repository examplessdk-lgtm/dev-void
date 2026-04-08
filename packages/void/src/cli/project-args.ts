import type { SubcommandDef } from './subcommand-prompt';

export const projectSubcommands: SubcommandDef[] = [
  { name: 'status', arg: '[name]', description: 'Show deployments (omit name for linked project)' },
  { name: 'link', arg: '[name]', description: 'Link directory to a project' },
  { name: 'list', description: 'List your projects' },
  { name: 'logs', description: 'Show runtime logs from the deployed project' },
  { name: 'rollback', arg: '[deployId]', description: 'Roll back to a previous deployment' },
  {
    name: 'delete',
    arg: '[name]',
    description: 'Delete a project (omit name to delete linked project)',
  },
  { name: 'purge-cache', description: 'Purge all cached pages' },
];

export type ProjectArgs =
  | { subcommand: 'status'; name: string }
  | { subcommand: 'link'; name: string }
  | { subcommand: 'list' }
  | { subcommand: 'logs'; filter: string; range: string; deployment: string }
  | { subcommand: 'rollback'; deployId: string }
  | { subcommand: 'delete'; name: string; force: boolean }
  | { subcommand: 'purge-cache' };

export function parseProjectArgs(args: string[]): ProjectArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === 'status') {
    const [name, extra] = rest;
    if (extra) {
      throw new Error(`Error: Unexpected argument: ${extra}`);
    }
    return { subcommand, name: name ?? '' };
  }

  if (subcommand === 'link') {
    const [name, extra] = rest;
    if (extra) {
      throw new Error(`Error: Unexpected argument: ${extra}`);
    }
    return { subcommand, name: name ?? '' };
  }

  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { subcommand };
  }

  if (subcommand === 'logs') {
    let filter = '';
    let range = '1h';
    let deployment = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--filter' && rest[i + 1]) {
        filter = rest[++i];
      } else if (rest[i] === '--range' && rest[i + 1]) {
        range = rest[++i];
      } else if (rest[i] === '--deployment' && rest[i + 1]) {
        deployment = rest[++i];
      } else {
        throw new Error(`Error: Unexpected argument: ${rest[i]}`);
      }
    }
    return { subcommand, filter, range, deployment };
  }

  if (subcommand === 'rollback') {
    const [deployId, extra] = rest;
    if (extra) {
      throw new Error(`Error: Unexpected argument: ${extra}`);
    }
    return { subcommand, deployId: deployId ?? '' };
  }

  if (subcommand === 'delete') {
    let name = '';
    let force = false;
    for (const arg of rest) {
      if (arg === '--force' || arg === '-f') {
        force = true;
      } else if (arg.startsWith('-')) {
        throw new Error(`Error: Unknown flag: ${arg}`);
      } else if (name) {
        throw new Error(`Error: Unexpected argument: ${arg}`);
      } else {
        name = arg;
      }
    }
    return { subcommand, name, force };
  }

  if (subcommand === 'purge-cache') {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { subcommand };
  }

  throw new Error('Error: Usage: void project <status|link|list|logs|rollback|delete|purge-cache>');
}
