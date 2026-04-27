import { log } from '@clack/prompts';
import { PlatformApiError, type PlatformClient } from './client';
import { pc } from './output';
import { writeProjectConfig, type ProjectConfig } from './project';
import { promptProjectSlug } from './prompt';
import { inferDefaultSlug } from './resolve-project';

export async function promptAndCreateProject(
  root: string,
  client: PlatformClient,
): Promise<ProjectConfig> {
  let defaultSlug = inferDefaultSlug(root);
  while (true) {
    // promptProjectSlug exits the process on Ctrl+C, so no cancel check needed here
    const slug = await promptProjectSlug(defaultSlug);
    try {
      log.step(`Creating project ${pc.blue(slug)}...`);
      const project = await client.createProject(slug);
      const config: ProjectConfig = { projectId: project.id, slug: project.slug };
      writeProjectConfig(root, config);
      log.success(`Project created: ${pc.blue(config.slug)}`);
      return config;
    } catch (error) {
      if (error instanceof PlatformApiError && isRetryableCreateError(error)) {
        const reason = error.code || error.body || `HTTP ${error.status}`;
        log.error(`project: Could not create project '${slug}': ${reason}.`);
        defaultSlug = slug;
        continue;
      }
      throw error;
    }
  }
}

function isRetryableCreateError(error: PlatformApiError): boolean {
  return error.status === 400 || error.status === 409 || error.status === 422;
}
