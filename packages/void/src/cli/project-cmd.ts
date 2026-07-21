import type { ProjectArgs } from './project-args.ts';
import { runProjectsCommand } from './projects.ts';

export async function runProjectCommand(root: string, args: ProjectArgs): Promise<void> {
  if (args.subcommand === 'status') {
    const { runListCommand } = await import('./list.ts');
    return runListCommand(root, args.name || undefined);
  }
  if (args.subcommand === 'link') {
    const { runLink } = await import('./link.ts');
    return runLink(root, args.name || undefined);
  }
  if (args.subcommand === 'list') {
    return runProjectsCommand(root);
  }
  if (args.subcommand === 'logs') {
    const { runLogsCommand } = await import('./logs.ts');
    return runLogsCommand(
      root,
      args.filter,
      args.range,
      args.deployment || undefined,
      args.level || undefined,
    );
  }
  if (args.subcommand === 'requests') {
    const { runRequestsCommand } = await import('./requests.ts');
    return runRequestsCommand(root, args.range, args.status || undefined);
  }
  if (args.subcommand === 'rollback') {
    const { runRollbackCommand } = await import('./rollback.ts');
    return runRollbackCommand(root, args.deployId || undefined);
  }
  if (args.subcommand === 'cancel') {
    const { runCancelDeployCommand } = await import('./cancel-deploy.ts');
    return runCancelDeployCommand(root, args.deployId || undefined);
  }
  if (args.subcommand === 'delete') {
    const { runDeleteCommand } = await import('./delete.ts');
    return runDeleteCommand(root, args.name || undefined, { force: args.force });
  }
  if (args.subcommand === 'purge-cache') {
    const { runPurgeCacheCommand } = await import('./cache.ts');
    return runPurgeCacheCommand(root, args.projectSlug || undefined);
  }
}
