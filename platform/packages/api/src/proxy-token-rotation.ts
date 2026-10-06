import { eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { deriveProxyToken } from './proxy-token.ts';
import { projects } from './schema.ts';
import type { Project } from './types.ts';

/**
 * Proxy token generations per project.
 *
 * `projects.proxy_token_gen` is the highest generation the platform has issued
 * for the project (0 = the legacy token). Deploys bake the token for that
 * generation into the Worker, and the proxy sends it. Only a rotation raises
 * it; the KV accept floor (`proxy-token:<projectId>`) never exceeds it.
 */

export const PROXY_TOKEN_ROTATION_JOB_KIND = 'proxy-token-rotation';
/** How long a rotation waits for KV copies and old Worker versions to drain. */
export const PROXY_TOKEN_ROTATION_WAIT_MS = 120_000;

/** Primary key of a project's rotation row in `project_cleanup_jobs`. */
export function proxyTokenRotationTarget(projectId: string): string {
  return `${PROXY_TOKEN_ROTATION_JOB_KIND}:${projectId}`;
}

/** The token for the project's issued generation. Generation 0 is the legacy token. */
export async function issueProjectProxyToken(
  db: Db,
  jwtSecret: string,
  projectId: string,
): Promise<string> {
  const [row] = await db
    .select({ gen: projects.proxy_token_gen })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) {
    throw new Error(`project ${projectId} not found`);
  }
  return deriveProxyToken(jwtSecret, projectId, row.gen);
}

/**
 * Token fields for the queue routing entries and the cron scheduler when they
 * point at an existing Worker. A Worker that has not yet received the issued
 * generation still holds its own token; the issued one rides along as the
 * fallback so the relay keeps working once that Worker is updated.
 */
export async function proxyTokenCopies(
  jwtSecret: string,
  project: Pick<Project, 'id' | 'proxy_token_gen'>,
  workerToken: string | undefined,
): Promise<Readonly<{ proxyToken?: string; proxyTokenFallback?: string }>> {
  if (workerToken === undefined) {
    return {};
  }
  if (project.proxy_token_gen < 1) {
    return { proxyToken: workerToken };
  }
  const issued = await deriveProxyToken(jwtSecret, project.id, project.proxy_token_gen);
  return workerToken === issued
    ? { proxyToken: workerToken }
    : { proxyToken: workerToken, proxyTokenFallback: issued };
}
