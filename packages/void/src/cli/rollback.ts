import { intro, outro, log, select, confirm, isCancel, cancel, spinner } from '@clack/prompts';
import { getToken } from './auth';
import { PlatformClient } from './client';
import { cliTitle, dim, ensureUtc, pc } from './output';
import { readProjectConfig } from './project';

export async function runRollbackCommand(root: string, deployId?: string): Promise<void> {
  console.log();
  intro(cliTitle('project rollback'));

  const token = getToken();
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error('No linked project. Run `void project link` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const { deployments, activeDeploymentId } = await client.listDeployments(linked.projectId);

  // Filter to retained deployments that aren't the active one
  const candidates = deployments.filter(
    (d) => d.retained && d.status === 'live' && d.id !== activeDeploymentId,
  );

  if (candidates.length === 0) {
    log.warn('No retained deployments available for rollback.');
    outro(dim('Deploy more versions to enable rollback.'));
    return;
  }

  let targetId: string;

  if (deployId) {
    const target = candidates.find((d) => d.id === deployId);
    if (!target) {
      log.error(
        `Deployment ${deployId} is not available for rollback (not retained or not found).`,
      );
      process.exit(1);
    }
    targetId = deployId;
  } else {
    const result = await select({
      message: 'Select a deployment to roll back to:',
      options: candidates.map((d) => ({
        value: d.id,
        label: `${d.id} ${dim(formatAge(d.deployed_at))}`,
        hint: d.source ? `via ${d.source}` : undefined,
      })),
    });

    if (isCancel(result)) {
      cancel('Rollback cancelled.');
      process.exit(0);
    }
    targetId = result as string;
  }

  // Compute migration diff client-side for warning
  const active = deployments.find((d) => d.id === activeDeploymentId);
  const target = candidates.find((d) => d.id === targetId)!;
  const currentMigrations: string[] = active?.applied_migrations
    ? JSON.parse(active.applied_migrations)
    : [];
  const targetMigrations: string[] = target.applied_migrations
    ? JSON.parse(target.applied_migrations)
    : [];
  const migrationDiff = currentMigrations.filter((m) => !targetMigrations.includes(m));

  if (migrationDiff.length > 0) {
    log.warn(
      `The current database has ${migrationDiff.length} migration(s) applied after this deployment:`,
    );
    for (const m of migrationDiff) {
      log.message(`  ${dim('•')} ${m}`);
    }
    log.message(
      dim(
        'Rolling back will NOT revert these migrations. The older code will run against the current schema.',
      ),
    );

    const proceed = await confirm({ message: 'Proceed with rollback?' });
    if (isCancel(proceed) || !proceed) {
      cancel('Rollback cancelled.');
      process.exit(0);
    }
  }

  const s = spinner();
  s.start('Rolling back...');

  try {
    const result = await client.rollback(linked.projectId, targetId);
    s.stop('Rollback complete.');

    if (result.ok) {
      log.success(`Rolled back to ${pc.bold(targetId)}`);
    } else {
      log.error(result.error ?? 'Rollback failed.');
      process.exit(1);
    }
  } catch (err) {
    s.stop('Rollback failed.');
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  outro(dim('Traffic is now serving the rolled-back deployment.'));
}

function formatAge(deployedAt: string | null): string {
  if (!deployedAt) {
    return '';
  }
  const diffMs = Date.now() - new Date(ensureUtc(deployedAt)).getTime();
  if (diffMs < 60_000) {
    return 'just now';
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
