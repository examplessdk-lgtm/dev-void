import { outro, log } from '@voidzero-dev/vite-plus-prompts';
import { getToken, getSiteDomain } from './auth.ts';
import { PlatformClient } from './client.ts';
import { dim, formatCount, formatUrl, pc, tablePrefix } from './output.ts';

export async function runProjectsCommand(root: string): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const projects = await client.listProjects();

  if (projects.length === 0) {
    outro('No projects found.');
    return;
  }

  const rows = projects.map((p) => ({
    slug: p.slug,
    role: p.role,
    appType: p.type ?? 'worker',
    url: p.custom_domain
      ? `https://${p.custom_domain}`
      : (p.url ?? `https://${p.slug}.${getSiteDomain(root)}`),
  }));

  const slugWidth = Math.max('slug'.length, ...rows.map((r) => r.slug.length));
  const roleWidth = Math.max('role'.length, ...rows.map((r) => r.role.length));
  const typeWidth = Math.max('type'.length, ...rows.map((r) => r.appType.length));

  const prefix = tablePrefix();
  const header = `${prefix}${dim(`${'slug'.padEnd(slugWidth)}  ${'role'.padEnd(roleWidth)}  ${'type'.padEnd(typeWidth)}  url`)}`;
  const lines = rows.map(
    (row) =>
      `${prefix}${pc.green(row.slug)}${''.padEnd(slugWidth - row.slug.length)}  ${row.role.padEnd(roleWidth)}  ${row.appType.padEnd(typeWidth)}  ${formatUrl(row.url)}`,
  );
  console.log(prefix);
  console.log(header);
  for (const line of lines) {
    console.log(line);
  }
  outro(formatCount(projects.length, 'project'));
}
