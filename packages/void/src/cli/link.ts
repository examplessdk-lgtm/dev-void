import { intro, outro, log, cancel } from '@clack/prompts';
import { getToken, getSiteDomain } from './auth.ts';
import { PlatformClient } from './client.ts';
import { promptAndCreateProject } from './create-project.ts';
import { cliTitle, pc } from './output.ts';
import { attachSelectedPlatform, readProjectConfig, writeProjectConfig } from './project.ts';
import { promptProjectSelection } from './prompt.ts';
import { resolveProjectBySlug } from './resolve-project.ts';

export async function runLink(root: string, slug?: string): Promise<void> {
  console.log();
  intro(cliTitle('project link'));

  // Check if already linked
  const existing = readProjectConfig(root);
  if (existing) {
    log.warn(`Already linked to ${pc.blue(existing.slug)}.${getSiteDomain(root)}`);
    outro('To re-link, delete .void/project.json and run again.');
    return;
  }

  // Auth
  const token = getToken(root);
  if (!token) {
    cancel('No auth token found. Run `void auth login` first.');
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
    outro(`Linked to ${pc.blue(config.slug)}.${getSiteDomain(root)}`);
    return;
  }

  // Interactive: prompt user to select or create
  const result = await promptProjectSelection(projects, 'Select a project:', root, {
    confirmExisting: true,
  });

  if (result.action === 'create') {
    const config = await promptAndCreateProject(root, client);
    outro(`Created and linked to ${pc.blue(config.slug)}.${getSiteDomain(root)}`);
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
  outro(`Linked to ${pc.blue(result.project.slug)}.${getSiteDomain(root)}`);
}
