import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db/client.ts';
import { projectCleanupJobs } from './schema.ts';

// Rotation requests, apart from the runner in `proxy-token-rotation.ts` so the
// `db/` modules can write one inside their transactions without importing
// `db.ts` back.

export const PROXY_TOKEN_ROTATION_JOB_KIND = 'proxy-token-rotation';

/** Primary key of a project's rotation row in `project_cleanup_jobs`. */
export function proxyTokenRotationTarget(projectId: string): string {
  return `${PROXY_TOKEN_ROTATION_JOB_KIND}:${projectId}`;
}

export type ProxyTokenRotationReason =
  | 'member-removed'
  | 'member-role-changed'
  | 'user-deleted'
  | 'untrusted-deploy-replaced'
  | 'operator'
  | 'operator-bulk'
  | 'legacy-init';

export function rotationLog(event: string, projectId: string, detail = ''): void {
  console.log(`[proxy-token-rotation] ${event} ${projectId}${detail ? ` ${detail}` : ''}`);
}

/**
 * Asks for a new token generation. A job that has not started yet already
 * covers the request; one past START may have handed out tok(T), so it
 * finishes and then runs once more (`again`). Operator requests also make the
 * job due now. Member requests take over the job's reason, so a queued bulk
 * job is no longer claimed last. Call inside the caller's transaction.
 */
export async function requestProxyTokenRotation(
  tx: DbOrTx,
  projectId: string,
  reason: ProxyTokenRotationReason,
  mode: 'member' | 'operator',
): Promise<void> {
  const flagAgain = sql`CASE WHEN ${projectCleanupJobs.payload}->>'phase' <> 'requested'
    THEN ${projectCleanupJobs.payload} || '{"again":"1"}'::jsonb
    ELSE ${projectCleanupJobs.payload} END`;
  const rows = await tx
    .insert(projectCleanupJobs)
    .values({
      target: proxyTokenRotationTarget(projectId),
      project_id: projectId,
      kind: PROXY_TOKEN_ROTATION_JOB_KIND,
      payload: { phase: 'requested', reason },
      next_attempt_at: sql`now()`,
    })
    .onConflictDoUpdate({
      target: projectCleanupJobs.target,
      set:
        mode === 'operator'
          ? { payload: flagAgain, next_attempt_at: sql`now()` }
          : { payload: sql`${flagAgain} || jsonb_build_object('reason', ${reason}::text)` },
    })
    .returning({ phase: sql<string>`${projectCleanupJobs.payload}->>'phase'` });
  if (rows.length > 0) {
    rotationLog('requested', projectId, `reason=${reason}`);
  }
}
