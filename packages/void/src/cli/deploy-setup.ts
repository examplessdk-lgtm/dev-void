import { cancel, confirm, isCancel, log } from '@clack/prompts';
import { getToken, isStagingMode } from './auth';
import { PlatformClient } from './client';
import { promptAndCreateProject } from './create-project';
import { promptForLoginToken } from './login';
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from './project';
import { promptProjectSelection } from './prompt';

async function ensureToken(root: string): Promise<string> {
  const existing = getToken(root);
  if (existing) {
    return existing;
  }

  const token = await promptForLoginToken(root);
  log.success(isStagingMode(root) ? 'Staging token saved.' : 'Token saved.');
  return token;
}

export async function maybeSetupDeployProject(root: string): Promise<ProjectConfig | null> {
  const existing = readProjectConfig(root);
  if (existing) {
    log.info(`Project already linked: ${existing.slug}`);
    return existing;
  }

  const existingToken = getToken(root);
  const shouldSetup = await confirm({
    message: existingToken
      ? 'Link your Void project now?'
      : 'Set up your Void project now? (log in + link project)',
  });
  if (isCancel(shouldSetup)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  if (!shouldSetup) {
    return null;
  }

  const token = existingToken ?? (await ensureToken(root));
  const client = new PlatformClient(token, { root });
  const projects = await client.listProjects();

  if (projects.length === 0) {
    return promptAndCreateProject(root, client);
  }

  const result = await promptProjectSelection(projects, 'Select a project to link:', root);
  if (result.action === 'select') {
    const config = { projectId: result.project.id, slug: result.project.slug };
    writeProjectConfig(root, config);
    log.success(`Linked project: ${config.slug}`);
    return config;
  }

  return promptAndCreateProject(root, client);
}
