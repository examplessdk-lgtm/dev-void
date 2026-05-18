import { log } from '@clack/prompts';
import { PlatformApiError, type PlatformClient } from './client.ts';
import { pc } from './output.ts';
import { writeProjectConfig, type ProjectConfig } from './project.ts';
import { promptProjectSlug } from './prompt.ts';
import { inferDefaultSlug } from './resolve-project.ts';

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

export function isRetryableCreateError(error: PlatformApiError): boolean {
  if (error.status === 400 || error.status === 409 || error.status === 422) {
    return true;
  }
  // 403 is retryable ONLY when it's the slug-length plan rejection — other
  // 403s (e.g. account suspended from auth middleware) are not fixable by
  // choosing a different slug and would cause an infinite re-prompt loop.
  if (error.status === 403) {
    return isSlugRelatedError(error);
  }
  return false;
}

function isSlugRelatedError(error: PlatformApiError): boolean {
  const message = (error.code ?? error.body ?? '').toLowerCase();
  return message.includes('slug');
}
