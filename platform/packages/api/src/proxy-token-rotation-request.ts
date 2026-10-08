import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from './db/client.ts';
import { projectCleanupJobs, projectMembers } from './schema.ts';

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
  | 'user-suspended'
  | 'untrusted-deploy-replaced'
  | 'operator'
  | 'operator-bulk';

export function rotationLog(event: string, projectId: string, detail = ''): void {
  console.log(`[proxy-token-rotation] ${event} ${projectId}${detail ? ` ${detail}` : ''}`);
}

// What a request does to an existing job. Both writers below share these, so
// one statement for many projects leaves the rows one request per project would.
const jobStarted = sql`${projectCleanupJobs.payload}->>'phase' <> 'requested'`;
const flagAgain = sql`CASE WHEN ${projectCleanupJobs.payload}->>'phase' <> 'requested'
    THEN ${projectCleanupJobs.payload} || '{"again":"1"}'::jsonb
    ELSE ${projectCleanupJobs.payload} END`;

/**
 * Asks for a new token generation. A job that has not started yet already
 * covers the request; one past START may have handed out tok(T), so it
 * finishes and then runs once more (`again`). Operator requests also make the
 * job due now. Call inside the caller's transaction.
 */
export async function requestProxyTokenRotation(
  tx: DbOrTx,
  projectId: string,
  reason: ProxyTokenRotationReason,
  mode: 'member' | 'operator',
): Promise<void> {
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
          : { payload: flagAgain },
      ...(mode === 'member' ? { setWhere: jobStarted } : {}),
    })
    .returning({ phase: sql<string>`${projectCleanupJobs.payload}->>'phase'` });
  if (rows.length > 0) {
    rotationLog('requested', projectId, `reason=${reason}`);
  }
}

/**
 * `requestProxyTokenRotation` in `member` mode for every project where the
 * user is a collaborator or admin, in one statement whatever the number of
 * projects. Call inside the caller's transaction.
 */
export async function requestProxyTokenRotationsForMember(
  tx: DbOrTx,
  userId: string,
  reason: ProxyTokenRotationReason,
): Promise<void> {
  const deployMember = and(
    eq(projectMembers.user_id, userId),
    inArray(projectMembers.role, ['collaborator', 'admin']),
  );
  const result = await tx.execute<{ project_id: string }>(sql`
    INSERT INTO ${projectCleanupJobs} (target, project_id, kind, payload, next_attempt_at)
    SELECT ${PROXY_TOKEN_ROTATION_JOB_KIND}::text || ':' || ${projectMembers.project_id},
      ${projectMembers.project_id}, ${PROXY_TOKEN_ROTATION_JOB_KIND}::text,
      jsonb_build_object('phase', 'requested', 'reason', ${reason}::text), now()
    FROM ${projectMembers}
    WHERE ${deployMember}
    ORDER BY ${projectMembers.project_id}
    ON CONFLICT (target) DO UPDATE SET payload = ${flagAgain} WHERE ${jobStarted}
    RETURNING project_id`);
  for (const { project_id: projectId } of result.rows) {
    rotationLog('requested', projectId, `reason=${reason}`);
  }
}
