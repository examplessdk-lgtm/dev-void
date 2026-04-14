import { intro, outro, log } from '@clack/prompts';
import { getToken, getSiteDomain } from './auth';
import { PlatformClient } from './client';
import { cliTitle, dim, pc, tablePrefix } from './output';

export async function runProjectsCommand(): Promise<void> {
  console.log();
  intro(cliTitle('project list'));

  const token = getToken();
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (projects.length === 0) {
    outro('No projects found.');
    return;
  }

  const rows = projects.map((p) => ({
    slug: p.slug,
    appType: p.type ?? 'worker',
    url: p.custom_domain ? `https://${p.custom_domain}` : `https://${p.slug}.${getSiteDomain()}`,
  }));

  const slugWidth = Math.max('slug'.length, ...rows.map((r) => r.slug.length));
  const typeWidth = Math.max('type'.length, ...rows.map((r) => r.appType.length));

  const prefix = tablePrefix();
  const header = `${prefix}${dim(`${'slug'.padEnd(slugWidth)}  ${'type'.padEnd(typeWidth)}  url`)}`;
  const lines = rows.map(
    (row) =>
      `${prefix}${pc.green(row.slug)}${''.padEnd(slugWidth - row.slug.length)}  ${row.appType.padEnd(typeWidth)}  ${row.url}`,
  );
  console.log(prefix);
  console.log(header);
  for (const line of lines) {
    console.log(line);
  }
  outro(`${projects.length} project(s)`);
}
