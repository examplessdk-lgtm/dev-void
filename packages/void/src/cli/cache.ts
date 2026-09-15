import { intro, outro, log } from '@clack/prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { cliTitle, createSpinner, dim } from './output.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

export async function runPurgeCacheCommand(root: string, projectSlug?: string): Promise<void> {
  console.log();
  intro(cliTitle('project purge-cache'));

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const requestedSlug = getRequestedProjectSlug({ projectSlug });
  let projectId: string;
  let client: PlatformClient;
  if (requestedSlug) {
    client = new PlatformClient(token, { root });
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, requestedSlug);
    if (!config) {
      log.error(`project: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = config.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error('No linked project. Run `void project link` first.');
      process.exit(1);
    }
    projectId = linked.projectId;
    client = new PlatformClient(token, { root });
  }

  const s = createSpinner();
  s.start('Purging cache...');

  try {
    const result = await client.purgeCache(projectId);
    s.stop('Cache purged.');
    log.success(`Purged ${result.purged} cached page(s).`);
  } catch (err) {
    s.stop('Cache purge failed.');
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  outro(dim('Edge cache will clear within seconds.'));
}
