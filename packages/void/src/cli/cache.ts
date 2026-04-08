import { intro, outro, log, spinner } from '@clack/prompts';
import { getToken } from './auth';
import { PlatformClient } from './client';
import { cliTitle, dim } from './output';
import { readProjectConfig } from './project';

export async function runPurgeCacheCommand(root: string): Promise<void> {
  console.log();
  intro(cliTitle('project purge-cache'));

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
  const s = spinner();
  s.start('Purging cache...');

  try {
    const result = await client.purgeCache(linked.projectId);
    s.stop('Cache purged.');
    log.success(`Purged ${result.purged} cached page(s).`);
  } catch (err) {
    s.stop('Cache purge failed.');
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  outro(dim('Edge cache will clear within seconds.'));
}
