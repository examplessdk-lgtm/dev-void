import { log } from '@clack/prompts';
import { PlatformApiError, type CreateProjectResponse, type PlatformClient } from './client.ts';
import { pc, sanitizeTerminalText } from './output.ts';
import { attachSelectedPlatform, writeProjectConfig, type ProjectConfig } from './project.ts';
import { promptProjectSlug } from './prompt.ts';
import { inferDefaultSlug } from './resolve-project.ts';

/**
 * Prompts for a slug and calls `client.createProject`, re-prompting whenever
 * the server rejects with a retryable error (e.g. free-plan short-slug 403,
 * slug-already-taken 409, validation 400/422). Returns `undefined` when the
 * caller's prompt callback returns `undefined` (cancel).
 *
 * The shared retry loop keeps `promptAndCreateProject` (deploy/link paths)
 * and the AI-setup path in `index.ts` in sync.
 */
export async function createProjectWithSlugRetry(
  client: PlatformClient,
  initialDefaultSlug: string,
  promptSlug: (defaultSlug: string) => Promise<string | undefined>,
): Promise<CreateProjectResponse | undefined> {
  let defaultSlug = initialDefaultSlug;
  while (true) {
    const slug = await promptSlug(defaultSlug);
    if (slug === undefined) {
      return undefined;
    }
    try {
      log.step(`Creating project ${pc.blue(slug)}...`);
      const project = await client.createProject(slug);
      log.success(`Project created: ${pc.blue(project.slug)}`);
      reportProjectCreationWarnings(project);
      return project;
    } catch (error) {
      if (error instanceof PlatformApiError && isRetryableCreateError(error)) {
        log.error(`project: ${error.message}`);
        defaultSlug = slug;
        continue;
      }
      throw error;
    }
  }
}

export function reportProjectCreationWarnings(project: CreateProjectResponse): void {
  for (const warning of project.warnings ?? []) {
    log.warn(sanitizeTerminalText(warning));
  }
}

export async function promptAndCreateProject(
  root: string,
  client: PlatformClient,
): Promise<ProjectConfig> {
  // promptProjectSlug exits the process on Ctrl+C, so it never returns undefined.
  const project = await createProjectWithSlugRetry(
    client,
    inferDefaultSlug(root),
    async (defaultSlug) => promptProjectSlug(defaultSlug),
  );
  // createProjectWithSlugRetry only returns undefined when the prompt does,
  // which promptProjectSlug never does (it exits on cancel).
  if (!project) {
    throw new Error('Project creation cancelled.');
  }
  const config: ProjectConfig = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, attachSelectedPlatform(root, config, client.apiUrl));
  if (project.owner_email_destination) {
    // The platform registers the owner's address after it has answered, so
    // the response cannot say whether Cloudflare mailed a verification link
    // or adopted an address already verified on an earlier project. Say the
    // one thing that is true either way, and where the outcome shows up.
    const { address } = project.owner_email_destination;
    log.info(
      `Registering ${address} as a recipient for this project. Cloudflare emails it a verification link unless it is already verified — \`void email destinations\` shows the state.`,
    );
  }
  return config;
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
  // Inspect BOTH `code` (parsed error/message field) and `body` (full response
  // text). The server's current short-slug response embeds "slug" in `error`,
  // but a future generic code like "forbidden" with the slug detail only in a
  // separate message field would slip past a `code ?? body` short-circuit.
  const haystack = `${error.code ?? ''} ${error.body ?? ''}`.toLowerCase();
  return haystack.includes('slug');
}
