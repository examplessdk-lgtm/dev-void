import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_DISPATCH_NAMESPACE } from './constants.ts';
import { snapshotCronScheduler, syncCronScheduler } from './cron-scheduler-client.ts';
import { getActiveDeployment, type Db, type DbOrTx } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from './naming.ts';
import { hasProjectCapability, projectRoleForUser } from './project-access.ts';
import { requireNormalizedProject } from './project-state.ts';
import {
  buildProxyTokenBindingsPatch,
  CloudflareRateLimitError,
  createRotationCloudflareClient,
  RotationBudgetExhaustedError,
  type RotationCloudflareClient,
  type ScriptBinding,
} from './proxy-token-rotation-cloudflare.ts';
import {
  PROXY_TOKEN_ROTATION_JOB_KIND,
  proxyTokenRotationTarget,
  requestProxyTokenRotation,
  rotationLog,
  type ProxyTokenRotationReason,
} from './proxy-token-rotation-request.ts';
import { deriveProxyToken, proxyTokenStateKey, serializeProxyTokenState } from './proxy-token.ts';
import { deployments, projectCleanupJobs, projects, users } from './schema.ts';
import { isAdminSuspended } from './suspension.ts';
import type { DeployManifest, Project, ProjectRole } from './types.ts';

export {
  PROXY_TOKEN_ROTATION_JOB_KIND,
  proxyTokenRotationTarget,
  requestProxyTokenRotation,
  type ProxyTokenRotationReason,
};

/**
 * Proxy token generations per project.
 *
 * `projects.proxy_token_gen` is the highest generation the platform has issued
 * for the project (0 = the legacy token). Deploys bake the token for that
 * generation into the Worker, and the proxy sends it. A Worker deploy moves 0
 * to 1 (`issueProjectProxyToken`); after that only a rotation raises it. The
 * KV accept floor (`proxy-token:<projectId>`) never exceeds it.
 */

/** How long a rotation waits for KV copies and old Worker versions to drain. */
export const PROXY_TOKEN_ROTATION_WAIT_MS = 120_000;

/** Failed steps in a row after which project owners and admins see a warning. */
export const PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS = 4;

/** Cloudflare API calls and wall-clock time one rotation run may still spend. */
export type RotationBudget = { cfCallsRemaining: number; readonly deadline: number };

/**
 * The token a deploy bakes into its Worker: the one for the project's issued
 * generation. A project still on generation 0 moves to generation 1 here, so
 * new code never receives the legacy token. The floor stays where it is:
 * older Workers of the project keep the legacy token, which stays accepted
 * until a rotation raises the floor, and the proxy tries it after generation 1.
 */
export async function issueProjectProxyToken(
  db: Db,
  jwtSecret: string,
  projectId: string,
): Promise<string> {
  const [initialized] = await db
    .update(projects)
    .set({ proxy_token_gen: 1 })
    .where(and(eq(projects.id, projectId), eq(projects.proxy_token_gen, 0)))
    .returning({ gen: projects.proxy_token_gen });
  if (initialized) {
    console.info('[proxy-token] initialized', { projectId });
    return deriveProxyToken(jwtSecret, projectId, initialized.gen);
  }
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

// --- Rotation ---
//
// A rotation is one `project_cleanup_jobs` row (kind `proxy-token-rotation`)
// that moves through these phases, one short transaction per step:
//
//   requested  START: raise projects.proxy_token_gen to T. Postgres only, so
//              T is committed before anything outside sees tok(T).
//   copies     queue entries and the cron scheduler get tok(T) as fallback.
//   patch      one Worker per step: GET its bindings, PATCH tok(T) in.
//   revoke     every Worker holds tok(T): write the accept floor T.
//   settle     wait until every floor reader sees T, then finish.
//
// Every step locks the project row, then the job row, and refuses while a
// deployment is in flight (the same fence as deploys, rollback and secret
// writes). A wait is stored in the payload as `waitUntil`, taken from
// `clock_timestamp()` after the step's last outside write, so a kick of
// `next_attempt_at` never cuts it short. Until the floor rises both tokens are
// accepted, so a failed or unfinished rotation never breaks a tenant.

export type ProxyTokenRotationPhase = 'requested' | 'copies' | 'patch' | 'revoke' | 'settle';

export type ProxyTokenRotationEnv = Pick<
  ApiEnv['Bindings'],
  | 'ROUTING'
  | 'CRON_SCHEDULER'
  | 'JWT_SECRET'
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'DISPATCH_NAMESPACE'
>;

export type ProjectRotationOutcome =
  | { status: 'done'; gen: number }
  | {
      status: 'pending';
      phase: ProxyTokenRotationPhase;
      reason: 'waiting' | 'busy' | 'budget' | 'rate-limited';
      retryAfterSeconds: number;
    }
  | { status: 'failed'; phase: ProxyTokenRotationPhase; error: string; workerName?: string };

export type RotationRunSummary = {
  done: number;
  pending: number;
  failed: number;
  retryAfterSeconds: number | null;
};

const PROXY_TOKEN_BINDING = '__VOID_PROXY_TOKEN';
const CLAIM_LEASE = sql`interval '15 minutes'`;
const BUSY_RETRY_SECONDS = 120;

function isStaticProjectType(type: Project['type']): boolean {
  return type === 'static' || type === 'spa';
}

/** `expr` (a timestamptz) as an ISO-8601 UTC string with microseconds. */
function isoUtc(expr: SQL): SQL<string> {
  return sql<string>`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function waitInterval(waitMs: number): SQL {
  return sql`(${Math.max(0, Math.trunc(waitMs))}::integer * interval '1 millisecond')`;
}

const jobTarget = (projectId: string) =>
  eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId));

// --- Requests ---

/**
 * Queues every project not being deleted, with the member rule on an
 * existing job. Returns the number of jobs inserted or flagged.
 */
export async function requestBulkProxyTokenRotations(db: DbOrTx): Promise<number> {
  const reason: ProxyTokenRotationReason = 'operator-bulk';
  const result = await db.execute(sql`
    INSERT INTO ${projectCleanupJobs} (target, project_id, kind, payload, next_attempt_at)
    SELECT ${PROXY_TOKEN_ROTATION_JOB_KIND}::text || ':' || ${projects.id}, ${projects.id},
      ${PROXY_TOKEN_ROTATION_JOB_KIND}::text, jsonb_build_object('phase', 'requested', 'reason', ${reason}::text), now()
    FROM ${projects}
    WHERE ${projects.status} <> 'deleting'
    ON CONFLICT (target) DO UPDATE
      SET payload = project_cleanup_jobs.payload || '{"again":"1"}'::jsonb
      WHERE project_cleanup_jobs.payload->>'phase' <> 'requested'
    RETURNING target`);
  const count = result.rows.length;
  if (count > 0) {
    console.log(`[proxy-token-rotation] requested ${count} project(s)`);
  }
  return count;
}

/**
 * While code from a user who can no longer deploy is active, it receives every
 * new token, so a rotation protects only once that code stops running. Call in
 * the cutover transaction (project lock held) right before the active
 * deployment changes: when the code being replaced was deployed by such a user,
 * this requests one more generation. Owner suspension does not count; a
 * collaborator or admin suspended by an admin does.
 */
export async function requestRotationIfReplacingUntrustedCode(
  tx: DbOrTx,
  projectId: string,
  nextDeploymentId: string,
): Promise<boolean> {
  const [current] = await tx
    .select({
      deploymentId: projects.active_deployment_id,
      initiatedBy: deployments.initiated_by_user_id,
      authorSuspendedReason: users.suspended_reason,
    })
    .from(projects)
    .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
    .leftJoin(users, eq(users.id, deployments.initiated_by_user_id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!current?.initiatedBy || current.deploymentId === nextDeploymentId) {
    return false;
  }
  const role = await projectRoleForUser(tx, projectId, current.initiatedBy);
  if (
    role === 'owner' ||
    (role &&
      hasProjectCapability(role, 'deploy') &&
      !isAdminSuspended(current.authorSuspendedReason))
  ) {
    return false;
  }
  await requestProxyTokenRotation(tx, projectId, 'untrusted-deploy-replaced', 'member');
  return true;
}

// --- Inventory ---

type InventoryRow = Readonly<{
  deploymentId: string;
  workerName: string;
  createdAt: string;
  active: boolean;
}>;

function inventoryWhere(
  project: Pick<Project, 'id' | 'active_deployment_id'>,
  after?: Readonly<{ createdAt: string; id: string }>,
): SQL | undefined {
  return and(
    eq(deployments.project_id, project.id),
    project.active_deployment_id
      ? or(eq(deployments.retained, true), eq(deployments.id, project.active_deployment_id))
      : eq(deployments.retained, true),
    sql`${deployments.source} IS DISTINCT FROM 'rollback-lease'`,
    after
      ? sql`(${deployments.created_at}, ${deployments.id}) > (${after.createdAt}::timestamp, ${after.id})`
      : undefined,
  );
}

async function selectInventory(
  db: DbOrTx,
  project: Pick<Project, 'id' | 'slug' | 'active_deployment_id'>,
  options: Readonly<{ after?: { createdAt: string; id: string }; limit?: number }> = {},
): Promise<ReadonlyArray<InventoryRow>> {
  const query = db
    .select({ id: deployments.id, createdAt: deployments.created_at })
    .from(deployments)
    .where(inventoryWhere(project, options.after))
    .orderBy(asc(deployments.created_at), asc(deployments.id));
  const rows = options.limit === undefined ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    deploymentId: row.id,
    workerName: getProjectDeploymentWorkerName(project.slug, row.id),
    createdAt: row.createdAt,
    active: row.id === project.active_deployment_id,
  }));
}

/**
 * Every Worker that may hold the project's token: the active deployment and
 * every retained one (rollback leases excluded), oldest first. Rows of a
 * static deployment stay in; their GET finds no script.
 */
export function listProxyTokenInventory(
  db: DbOrTx,
  project: Pick<Project, 'id' | 'slug' | 'active_deployment_id'>,
): Promise<ReadonlyArray<InventoryRow>> {
  return selectInventory(db, project);
}

function parseCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  const split = cursor ? cursor.indexOf('|') : -1;
  return split > 0
    ? { createdAt: cursor!.slice(0, split), id: cursor!.slice(split + 1) }
    : undefined;
}

// --- Steps ---

type JobPayload = Readonly<Record<string, string>>;

type StepContext = {
  readonly projectId: string;
  readonly env: ProxyTokenRotationEnv;
  readonly cf: RotationCloudflareClient;
  readonly wait: SQL;
  phase: ProxyTokenRotationPhase;
  workerName?: string;
};

type StepResult =
  | { kind: 'continue' }
  | { kind: 'done'; gen: number }
  | { kind: 'waiting'; retryAfterSeconds: number }
  | { kind: 'busy' };

type LockedStep = {
  project: Project;
  payload: JobPayload;
  /** Failed attempts of this step since the last one that committed. */
  attempts: number;
};

async function issuedGeneration(db: DbOrTx, projectId: string): Promise<number> {
  const [row] = await db
    .select({ gen: projects.proxy_token_gen })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.gen ?? 0;
}

/** Locks the job row and checks its wait. Null when the job is gone. */
async function lockJob(
  tx: DbOrTx,
  projectId: string,
): Promise<{ payload: JobPayload; attempts: number; waitSeconds: number | null } | null> {
  const [job] = await tx
    .select({
      payload: projectCleanupJobs.payload,
      attempts: projectCleanupJobs.attempts,
      waitSeconds: sql<number | null>`CASE
        WHEN (${projectCleanupJobs.payload}->>'waitUntil')::timestamptz > now()
        THEN ceil(extract(epoch FROM (${projectCleanupJobs.payload}->>'waitUntil')::timestamptz - now()))::integer
        END`,
    })
    .from(projectCleanupJobs)
    .where(and(jobTarget(projectId), eq(projectCleanupJobs.kind, PROXY_TOKEN_ROTATION_JOB_KIND)))
    .for('update');
  return job
    ? { payload: job.payload, attempts: job.attempts, waitSeconds: job.waitSeconds }
    : null;
}

/** Project lock, then job lock, then the wait, then no deployment in flight. */
async function lockStep(tx: DbOrTx, ctx: StepContext): Promise<LockedStep | StepResult> {
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .for('update');
  if (!project || project.status === 'deleting') {
    await tx.delete(projectCleanupJobs).where(jobTarget(ctx.projectId));
    rotationLog('dropped', ctx.projectId, 'project deleted');
    return { kind: 'done', gen: project?.proxy_token_gen ?? 0 };
  }
  const job = await lockJob(tx, ctx.projectId);
  if (!job) {
    return { kind: 'done', gen: project.proxy_token_gen };
  }
  ctx.phase = job.payload.phase as ProxyTokenRotationPhase;
  if (job.waitSeconds !== null) {
    return { kind: 'waiting', retryAfterSeconds: job.waitSeconds };
  }
  if (await getActiveDeployment(tx, ctx.projectId)) {
    return { kind: 'busy' };
  }
  return { project, payload: job.payload, attempts: job.attempts };
}

/** Final statement of a successful step: merge `fields` into the payload. */
async function finishStep(tx: DbOrTx, projectId: string, fields: SQL): Promise<void> {
  await tx
    .update(projectCleanupJobs)
    .set({
      payload: sql`${projectCleanupJobs.payload} || ${fields}`,
      attempts: 0,
      last_error: null,
    })
    .where(jobTarget(projectId));
}

type ActiveWorker = Readonly<{ workerName: string; manifest: DeployManifest | null }>;

async function activeWorker(tx: DbOrTx, project: Project): Promise<ActiveWorker | null> {
  if (!project.active_deployment_id) {
    return null;
  }
  const [row] = await tx
    .select({ manifest: deployments.manifest })
    .from(deployments)
    .where(eq(deployments.id, project.active_deployment_id))
    .limit(1);
  let manifest: DeployManifest | null = null;
  try {
    manifest = row?.manifest ? (JSON.parse(row.manifest) as DeployManifest) : null;
  } catch {
    manifest = null;
  }
  return {
    workerName: getProjectDeploymentWorkerName(project.slug, project.active_deployment_id),
    manifest,
  };
}

/** Whether the active Worker receives queue or cron traffic through a copy of its token. */
function hasTokenCopies(project: Project, active: ActiveWorker | null): active is ActiveWorker {
  return (
    !!active &&
    !isStaticProjectType(project.type) &&
    (!!active.manifest?.schedules?.length || !!active.manifest?.queues?.length)
  );
}

/**
 * Rewrites the queue routing entries and the cron scheduler of the active
 * Worker. Built from the active manifest, never from what KV holds. A field
 * left out removes it.
 */
async function writeCopies(
  env: ProxyTokenRotationEnv,
  projectId: string,
  active: ActiveWorker,
  tokens: Readonly<{ proxyToken?: string; proxyTokenFallback?: string }>,
): Promise<void> {
  if (!tokens.proxyToken) {
    return;
  }
  const fields = {
    proxyToken: tokens.proxyToken,
    ...(tokens.proxyTokenFallback ? { proxyTokenFallback: tokens.proxyTokenFallback } : {}),
  };
  if (active.manifest?.schedules?.length) {
    const state = await snapshotCronScheduler(env, projectId);
    if (state && state.workerName === active.workerName) {
      const { proxyToken: _token, proxyTokenFallback: _fallback, ...rest } = state;
      await syncCronScheduler(env, projectId, { ...rest, ...fields });
    }
  }
  for (const queue of active.manifest?.queues ?? []) {
    await env.ROUTING.put(
      `queue:${getProjectQueueName(projectId, queue.name)}`,
      JSON.stringify({
        workerName: active.workerName,
        projectId,
        queueName: queue.name,
        ...fields,
      }),
    );
  }
}

/** The proxy token binding, `undefined` when the Worker has none. */
function tokenBinding(bindings: ReadonlyArray<ScriptBinding>): ScriptBinding | undefined {
  return bindings.find((binding) => binding.name === PROXY_TOKEN_BINDING);
}

async function start(tx: DbOrTx, ctx: StepContext, locked: LockedStep): Promise<StepResult> {
  await requireNormalizedProject(tx, locked.project);
  const gen = locked.project.proxy_token_gen + 1;
  await tx.update(projects).set({ proxy_token_gen: gen }).where(eq(projects.id, ctx.projectId));
  await tx
    .update(projectCleanupJobs)
    .set({
      payload: sql`jsonb_build_object('phase', 'copies', 'reason', ${projectCleanupJobs.payload}->>'reason', 'gen', ${String(gen)}::text, 'cursor', '')`,
      attempts: 0,
      last_error: null,
    })
    .where(jobTarget(ctx.projectId));
  rotationLog('started', ctx.projectId, `gen=${gen}`);
  return { kind: 'continue' };
}

async function copies(tx: DbOrTx, ctx: StepContext, locked: LockedStep): Promise<StepResult> {
  const active = await activeWorker(tx, locked.project);
  if (hasTokenCopies(locked.project, active)) {
    ctx.workerName = active.workerName;
    const bindings = await ctx.cf.getScriptBindings(active.workerName);
    const current = bindings ? tokenBinding(bindings) : undefined;
    if (current?.type === 'plain_text' && current.text) {
      await writeCopies(
        ctx.env,
        ctx.projectId,
        active,
        await proxyTokenCopies(ctx.env.JWT_SECRET, locked.project, current.text),
      );
    }
  }
  await finishStep(
    tx,
    ctx.projectId,
    sql`jsonb_build_object('phase', 'patch', 'waitUntil', ${isoUtc(sql`clock_timestamp() + ${ctx.wait}`)})`,
  );
  return { kind: 'continue' };
}

async function patchNext(tx: DbOrTx, ctx: StepContext, locked: LockedStep): Promise<StepResult> {
  const { project, payload } = locked;
  const [row] = await selectInventory(tx, project, {
    after: parseCursor(payload.cursor),
    limit: 1,
  });
  if (!row) {
    // Old versions of a patched Worker drain for one wait after the last PATCH.
    await finishStep(
      tx,
      ctx.projectId,
      sql`jsonb_build_object('phase', 'revoke', 'waitUntil', CASE
        WHEN ${projectCleanupJobs.payload}->>'lastPatchAt' IS NOT NULL
        THEN ${isoUtc(sql`(${projectCleanupJobs.payload}->>'lastPatchAt')::timestamptz + ${ctx.wait}`)}
        ELSE ${isoUtc(sql`clock_timestamp()`)} END)`,
    );
    return { kind: 'continue' };
  }
  ctx.workerName = row.workerName;
  const token = await deriveProxyToken(ctx.env.JWT_SECRET, ctx.projectId, project.proxy_token_gen);
  const bindings = await ctx.cf.getScriptBindings(row.workerName);
  let patched = false;
  if (bindings === null) {
    if (row.active && !isStaticProjectType(project.type)) {
      throw new Error(`active Worker ${row.workerName} not found`);
    }
  } else {
    const current = tokenBinding(bindings);
    if (current && current.type !== 'plain_text') {
      throw new Error(`Worker ${row.workerName} has a ${current.type} proxy token binding`);
    }
    if (current && current.text !== token) {
      const result =
        (await ctx.cf.patchScriptBindings(
          row.workerName,
          buildProxyTokenBindingsPatch(bindings, token),
        )) ?? (await ctx.cf.getScriptBindings(row.workerName));
      if (tokenBinding(result ?? [])?.text !== token) {
        throw new Error(`Worker ${row.workerName} did not take the new proxy token`);
      }
      patched = true;
      rotationLog(
        'patched',
        ctx.projectId,
        `worker=${row.workerName} gen=${project.proxy_token_gen}`,
      );
      if (row.active) {
        const active = await activeWorker(tx, project);
        if (hasTokenCopies(project, active)) {
          await writeCopies(ctx.env, ctx.projectId, active, {
            proxyToken: token,
            proxyTokenFallback: current.text,
          });
        }
      }
    } else if (current && locked.attempts > 0) {
      // The failed attempt before this one may have patched this Worker and
      // then lost the response or rolled back. Its old version can still
      // serve, so it drains as if patched now.
      patched = true;
    }
  }
  const cursor = `${row.createdAt}|${row.deploymentId}`;
  await finishStep(
    tx,
    ctx.projectId,
    patched
      ? sql`jsonb_build_object('cursor', ${cursor}::text, 'lastPatchAt', ${isoUtc(sql`clock_timestamp()`)})`
      : sql`jsonb_build_object('cursor', ${cursor}::text)`,
  );
  return { kind: 'continue' };
}

async function revoke(tx: DbOrTx, ctx: StepContext, locked: LockedStep): Promise<StepResult> {
  const { project, payload } = locked;
  const [later] = await selectInventory(tx, project, {
    after: parseCursor(payload.cursor),
    limit: 1,
  });
  if (later) {
    // A deploy finished after the walk passed; patch (or skip) it first.
    await finishStep(tx, ctx.projectId, sql`'{"phase":"patch"}'::jsonb`);
    return { kind: 'continue' };
  }
  const gen = project.proxy_token_gen;
  const token = await deriveProxyToken(ctx.env.JWT_SECRET, ctx.projectId, gen);
  const active = await activeWorker(tx, project);
  if (active) {
    ctx.workerName = active.workerName;
    const bindings = await ctx.cf.getScriptBindings(active.workerName);
    if (bindings === null && !isStaticProjectType(project.type)) {
      throw new Error(`active Worker ${active.workerName} not found`);
    }
    const current = bindings ? tokenBinding(bindings) : undefined;
    if (current && current.text !== token) {
      await finishStep(tx, ctx.projectId, sql`'{"phase":"patch","cursor":""}'::jsonb`);
      return { kind: 'continue' };
    }
    if (hasTokenCopies(project, active)) {
      await writeCopies(ctx.env, ctx.projectId, active, { proxyToken: token });
    }
  }
  // Written before COMMIT: KV may only run ahead, and every Worker holds T.
  await ctx.env.ROUTING.put(proxyTokenStateKey(ctx.projectId), serializeProxyTokenState({ gen }));
  await finishStep(
    tx,
    ctx.projectId,
    sql`jsonb_build_object('phase', 'settle', 'waitUntil', ${isoUtc(sql`clock_timestamp() + ${ctx.wait}`)})`,
  );
  rotationLog('revoked', ctx.projectId, `gen=${gen}`);
  return { kind: 'continue' };
}

/** Holds only the job row lock: it touches nothing outside Postgres. */
async function settle(tx: DbOrTx, ctx: StepContext): Promise<StepResult> {
  const job = await lockJob(tx, ctx.projectId);
  if (!job) {
    return { kind: 'done', gen: await issuedGeneration(tx, ctx.projectId) };
  }
  ctx.phase = job.payload.phase as ProxyTokenRotationPhase;
  if (ctx.phase !== 'settle') {
    return { kind: 'continue' };
  }
  if (job.waitSeconds !== null) {
    return { kind: 'waiting', retryAfterSeconds: job.waitSeconds };
  }
  if (job.payload.again === '1') {
    await tx
      .update(projectCleanupJobs)
      .set({
        payload: sql`jsonb_build_object('phase', 'requested', 'reason', ${projectCleanupJobs.payload}->>'reason')`,
        attempts: 0,
        last_error: null,
      })
      .where(jobTarget(ctx.projectId));
    rotationLog('rotated', ctx.projectId, `gen=${job.payload.gen} again`);
    return { kind: 'continue' };
  }
  await tx.delete(projectCleanupJobs).where(jobTarget(ctx.projectId));
  rotationLog('rotated', ctx.projectId, `gen=${job.payload.gen}`);
  return { kind: 'done', gen: Number(job.payload.gen) };
}

function runStep(db: Db, ctx: StepContext): Promise<StepResult> {
  return db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ phase: sql<string>`${projectCleanupJobs.payload}->>'phase'` })
      .from(projectCleanupJobs)
      .where(jobTarget(ctx.projectId));
    if (!peek) {
      return { kind: 'done', gen: await issuedGeneration(tx, ctx.projectId) };
    }
    ctx.phase = peek.phase as ProxyTokenRotationPhase;
    ctx.workerName = undefined;
    if (peek.phase === 'settle') {
      return settle(tx, ctx);
    }
    const locked = await lockStep(tx, ctx);
    if (!('project' in locked)) {
      return locked;
    }
    switch (locked.payload.phase as ProxyTokenRotationPhase) {
      case 'requested':
        return start(tx, ctx, locked);
      case 'copies':
        return copies(tx, ctx, locked);
      case 'patch':
        return patchNext(tx, ctx, locked);
      case 'revoke':
        return revoke(tx, ctx, locked);
      default:
        throw new Error(`unknown rotation phase ${String(locked.payload.phase)}`);
    }
  });
}

// --- Runs ---

async function setNextAttempt(db: Db, projectId: string, at: SQL): Promise<void> {
  await db.update(projectCleanupJobs).set({ next_attempt_at: at }).where(jobTarget(projectId));
}

/** Runs the due steps of a job this run has claimed. */
async function runClaimed(
  db: Db,
  env: ProxyTokenRotationEnv,
  projectId: string,
  budget: RotationBudget,
  options: Readonly<{ waitMs?: number; fetch?: typeof fetch }>,
): Promise<ProjectRotationOutcome> {
  const ctx: StepContext = {
    projectId,
    env,
    cf: createRotationCloudflareClient({
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      dispatchNamespace: env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
      budget,
      fetch: options.fetch,
    }),
    wait: waitInterval(options.waitMs ?? PROXY_TOKEN_ROTATION_WAIT_MS),
    phase: 'requested',
  };
  for (;;) {
    let result: StepResult;
    try {
      if (Date.now() >= budget.deadline) {
        throw new RotationBudgetExhaustedError();
      }
      result = await runStep(db, ctx);
    } catch (error) {
      if (error instanceof CloudflareRateLimitError) {
        await setNextAttempt(
          db,
          projectId,
          sql`now() + ${error.retryAfterSeconds}::integer * interval '1 second'`,
        );
        return {
          status: 'pending',
          phase: ctx.phase,
          reason: 'rate-limited',
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      if (error instanceof RotationBudgetExhaustedError) {
        await setNextAttempt(db, projectId, sql`now()`);
        return { status: 'pending', phase: ctx.phase, reason: 'budget', retryAfterSeconds: 0 };
      }
      const message = (error instanceof Error ? error.message : String(error))
        .replaceAll(env.CF_API_TOKEN || '\u0000', '[redacted]')
        .slice(0, 500);
      const [row] = await db
        .update(projectCleanupJobs)
        .set({
          attempts: sql`${projectCleanupJobs.attempts} + 1`,
          last_error: message,
          next_attempt_at: sql`now() + ${CLAIM_LEASE}`,
        })
        .where(jobTarget(projectId))
        .returning({ attempts: projectCleanupJobs.attempts });
      console.error(
        `[proxy-token-rotation] FAILED ${projectId} phase=${ctx.phase} attempts=${row?.attempts ?? 0} worker=${ctx.workerName ?? '-'}: ${message}`,
      );
      return {
        status: 'failed',
        phase: ctx.phase,
        error: message,
        ...(ctx.workerName ? { workerName: ctx.workerName } : {}),
      };
    }
    switch (result.kind) {
      case 'continue':
        continue;
      case 'done':
        return { status: 'done', gen: result.gen };
      case 'waiting':
        await setNextAttempt(
          db,
          projectId,
          sql`(${projectCleanupJobs.payload}->>'waitUntil')::timestamptz`,
        );
        return {
          status: 'pending',
          phase: ctx.phase,
          reason: 'waiting',
          retryAfterSeconds: result.retryAfterSeconds,
        };
      case 'busy':
        await setNextAttempt(
          db,
          projectId,
          sql`now() + ${BUSY_RETRY_SECONDS}::integer * interval '1 second'`,
        );
        return {
          status: 'pending',
          phase: ctx.phase,
          reason: 'busy',
          retryAfterSeconds: BUSY_RETRY_SECONDS,
        };
    }
  }
}

/** Takes the lease on one due job. A busy or waiting job is not a failure, so `attempts` stays. */
async function claimDueJob(db: Db, projectId?: string): Promise<string | null> {
  const result = await db.execute<{ project_id: string }>(sql`
    UPDATE ${projectCleanupJobs} SET next_attempt_at = now() + ${CLAIM_LEASE}
    WHERE target = (
      SELECT target FROM ${projectCleanupJobs}
      WHERE kind = ${PROXY_TOKEN_ROTATION_JOB_KIND} AND next_attempt_at <= now()
        ${projectId ? sql`AND target = ${proxyTokenRotationTarget(projectId)}` : sql``}
      ORDER BY next_attempt_at, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING project_id`);
  return result.rows[0]?.project_id ?? null;
}

/** Runs the due steps of one project's job. Claims it first. */
export async function advanceProxyTokenRotation(
  db: Db,
  env: ProxyTokenRotationEnv,
  projectId: string,
  budget: RotationBudget,
  options: Readonly<{ waitMs?: number; fetch?: typeof fetch }> = {},
): Promise<ProjectRotationOutcome> {
  if (await claimDueJob(db, projectId)) {
    return runClaimed(db, env, projectId, budget, options);
  }
  const [job] = await db
    .select({
      phase: sql<ProxyTokenRotationPhase>`${projectCleanupJobs.payload}->>'phase'`,
      retryAfterSeconds: sql<number>`greatest(0, ceil(extract(epoch FROM ${projectCleanupJobs.next_attempt_at}::timestamptz - now())))::integer`,
    })
    .from(projectCleanupJobs)
    .where(jobTarget(projectId));
  if (!job) {
    return { status: 'done', gen: await issuedGeneration(db, projectId) };
  }
  return {
    status: 'pending',
    phase: job.phase,
    reason: 'waiting',
    retryAfterSeconds: job.retryAfterSeconds,
  };
}

/** Advances due rotation jobs, one at a time, within a Cloudflare call and time budget. */
export async function reconcileProxyTokenRotations(
  db: Db,
  env: ProxyTokenRotationEnv,
  limits: Readonly<{
    maxCfCalls?: number;
    maxMs?: number;
    waitMs?: number;
    fetch?: typeof fetch;
  }> = {},
): Promise<RotationRunSummary> {
  const budget: RotationBudget = {
    cfCallsRemaining: limits.maxCfCalls ?? 100,
    deadline: Date.now() + (limits.maxMs ?? 25_000),
  };
  const summary: RotationRunSummary = { done: 0, pending: 0, failed: 0, retryAfterSeconds: null };
  while (budget.cfCallsRemaining > 0 && Date.now() < budget.deadline) {
    const projectId = await claimDueJob(db);
    if (!projectId) {
      break;
    }
    const outcome = await runClaimed(db, env, projectId, budget, limits);
    if (outcome.status === 'done') {
      summary.done += 1;
      continue;
    }
    if (outcome.status === 'failed') {
      summary.failed += 1;
      continue;
    }
    summary.pending += 1;
    summary.retryAfterSeconds =
      summary.retryAfterSeconds === null
        ? outcome.retryAfterSeconds
        : Math.min(summary.retryAfterSeconds, outcome.retryAfterSeconds);
    if (outcome.reason === 'rate-limited' || outcome.reason === 'budget') {
      break;
    }
  }
  return summary;
}

// --- Owner warning ---

export function proxyTokenRotationStuckWarning(projectId: string): string {
  return (
    "Replacing this project's platform credentials keeps failing. Until it finishes, older " +
    'credentials still work, including any a removed member may still hold. The platform keeps ' +
    'retrying. If this warning stays, ask your platform administrator to run ' +
    `\`void platform system rotate-proxy-tokens --plan --project ${projectId}\`.`
  );
}

/**
 * Warnings for project owners and admins when the project's rotation keeps
 * failing. Other roles and deploy tokens always get none, so they cannot tell
 * whether a rotation is stuck. Busy steps, waits and budget cut-offs do not
 * raise `attempts`, so a long queue of rotations does not warn.
 */
export async function proxyTokenRotationWarnings(
  db: DbOrTx,
  projectId: string,
  role: ProjectRole,
  deployScoped: boolean,
): Promise<ReadonlyArray<string>> {
  if (deployScoped || !hasProjectCapability(role, 'members')) {
    return [];
  }
  const [job] = await db
    .select({ attempts: projectCleanupJobs.attempts })
    .from(projectCleanupJobs)
    .where(and(jobTarget(projectId), eq(projectCleanupJobs.kind, PROXY_TOKEN_ROTATION_JOB_KIND)));
  return job && job.attempts >= PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS
    ? [proxyTokenRotationStuckWarning(projectId)]
    : [];
}
