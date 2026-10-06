import { outro, log, cancel } from '@voidzero-dev/vite-plus-prompts';
import { getToken, getSiteDomain } from './auth.ts';
import { PlatformClient } from './client.ts';
import { promptAndCreateProject } from './create-project.ts';
import { pc } from './output.ts';
import { attachSelectedPlatform, readProjectConfig, writeProjectConfig } from './project.ts';
import { promptProjectSelection } from './prompt.ts';
import { resolveProjectBySlug } from './resolve-project.ts';

function projectLabel(slug: string, root: string, url?: string): string {
  if (url) {
    return url;
  }
  const domain = getSiteDomain(root);
  return domain.endsWith('.workers.dev')
    ? `${pc.blue(slug)} (workers.dev)`
    : `${pc.blue(slug)}.${domain}`;
}

export async function runLink(root: string, slug?: string): Promise<void> {
  console.log();

  const existing = readProjectConfig(root);
  if (existing) {
    log.warn(`Already linked to ${projectLabel(existing.slug, root)}`);
    outro('To re-link, delete .void/project.json and run again.');
    return;
  }

  const token = getToken(root);
  if (!token) {
    cancel('No auth token found. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const projects = await client.listProjects();

  if (slug) {
    // Non-interactive: link by slug
    const resolved = resolveProjectBySlug(projects, slug);
    if (!resolved) {
      cancel(`project: No project found with slug '${slug}'.`);
      process.exit(1);
    }
    const config = attachSelectedPlatform(root, resolved, client.apiUrl);
    writeProjectConfig(root, config);
    outro(
      `Linked to ${projectLabel(config.slug, root, projects.find((project) => project.id === config.projectId)?.url)}`,
    );
    return;
  }

  // Interactive: prompt user to select or create
  const result = await promptProjectSelection(projects, 'Select a project:', root, {
    confirmExisting: true,
  });

  if (result.action === 'create') {
    const config = await promptAndCreateProject(root, client);
    outro(`Created and linked to ${projectLabel(config.slug, root)}`);
    return;
  }

  writeProjectConfig(
    root,
    attachSelectedPlatform(
      root,
      { projectId: result.project.id, slug: result.project.slug },
      client.apiUrl,
    ),
  );
  outro(`Linked to ${projectLabel(result.project.slug, root, result.project.url)}`);
}
