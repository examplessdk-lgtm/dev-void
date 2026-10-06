import { and, eq, getTableColumns, lte, ne, or, sql } from 'drizzle-orm';
import { paginatedR2Delete } from './assets.ts';
import { createDb, type Db, type DbOrTx } from './db.ts';
import type { DeploymentInput, DeploymentOperation } from './deployment-operation-types.ts';
import type { ApiEnv } from './env.ts';
import { deploymentOperations, projectDeployCredentials, projects, users } from './schema.ts';
import { isAdminSuspended } from './suspension.ts';
import type { DeployEvent } from './types.ts';
export type {
  DeploymentInput,
  DeploymentOperation,
  DeploymentProgress,
} from './deployment-operation-types.ts';

// Queue invocations have a 15-minute wall-clock limit. Recovery starts after
// that invocation is gone, and never repeats its provider writes or SQL.
export const DEPLOYMENT_EXECUTION_LEASE_MS = 18 * 60 * 1000;
const MAX_PROGRESS_EVENTS = 1000;

export async function installationDeploymentAdmissionClosed(
  db: DbOrTx,
  installationId?: string,
): Promise<boolean> {
  if (!installationId) {
    return false;
  }
  // Lifecycle checkpoints UPDATE this row. The shared lock serializes new
  // admissions with maintenance/downgrade while admitted jobs keep draining.
  const result = await db.execute(sql`SELECT installation_id, lifecycle_manifest
    FROM public.__void_platform_installation WHERE singleton = true FOR SHARE`);
  const row = result.rows[0] as
    | { installation_id: string; lifecycle_manifest: { status?: string; desiredState?: string } }
    | undefined;
  return (
    !row ||
    row.installation_id !== installationId ||
    row.lifecycle_manifest.status !== 'installed' ||
    row.lifecycle_manifest.desiredState !== 'enabled'
  );
}

export async function deploymentExecutionStatus(db: Db, installationId?: string) {
  return db.transaction(async (tx) => {
    const admissionClosed = await installationDeploymentAdmissionClosed(tx, installationId);
    const result = await tx.execute(
      sql`SELECT count(*)::integer AS count FROM deployment_operations WHERE status <> 'terminal'`,
    );
    return {
      protocolVersion: 1 as const,
      installationId,
      pendingDeployments: Number(result.rows[0]?.count ?? 0),
      admissionClosed,
    };
  });
}

export async function getDeploymentOperation(db: DbOrTx, id: string) {
  const [operation] = await db
    .select({
      ...getTableColumns(deploymentOperations),
      // The stored lease is a timestamp without time zone. Resolve it in the
      // SQL session's zone so observers receive an unambiguous UTC instant.
      lease_expires_at: sql<string | null>`to_char(
        ${deploymentOperations.lease_expires_at} AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(deploymentOperations)
    .where(eq(deploymentOperations.id, id));
  return operation ?? null;
}

export async function findDeploymentOperation(
  db: DbOrTx,
  projectId: string,
  actorId: string,
  key: string,
) {
  const [operation] = await db
    .select()
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.project_id, projectId),
        eq(deploymentOperations.actor_id, actorId),
        eq(deploymentOperations.idempotency_key, key),
      ),
    );
  return operation ?? null;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function prepareDeploymentInput(
  r2: R2Bucket,
  projectId: string,
  body: Record<string, unknown>,
  files: Array<{ name: string; content: Blob }>,
  credentialId?: string,
) {
  const prefix = `deployment-inputs/${projectId}/${crypto.randomUUID()}/`;
  const input: DeploymentInput = {
    body: { ...body },
    modules: [],
    ...(credentialId ? { credentialId } : {}),
  };
  delete input.body.workerFiles;
  try {
    for (let index = 0; index < files.length; index++) {
      const { name, content } = files[index]!;
      const bytes = await content.arrayBuffer();
      const digest = await sha256Hex(bytes);
      const key = `${prefix}${index}`;
      await r2.put(key, bytes);
      input.modules.push({ name, key, digest, type: content.type });
    }
    const identity = JSON.stringify({
      body: input.body,
      modules: input.modules.map(({ name, digest, type }) => ({ name, digest, type })),
    });
    const digest = await sha256Hex(new TextEncoder().encode(identity));
    // A marker lets the orphan sweep recognize complete and partial staging.
    await r2.put(`${prefix}receipt`, JSON.stringify({ createdAt: Date.now() }));
    return { input, prefix, digest };
  } catch (error) {
    await paginatedR2Delete(r2, prefix).catch(() => {});
    throw error;
  }
}

export async function assertDeploymentExecutionAuthority(
  db: DbOrTx,
  operation: DeploymentOperation,
): Promise<void> {
  const [actor] = await db
    .select({ reason: users.suspended_reason })
    .from(users)
    .where(eq(users.id, operation.actor_id))
    .limit(1);
  if (!actor || isAdminSuspended(actor.reason)) {
    throw new Error('Deployment actor is no longer active');
  }
  if (!operation.payload.credentialId) {
    return;
  }
  const [credential] = await db
    .select({ id: projectDeployCredentials.id })
    .from(projectDeployCredentials)
    .innerJoin(projects, eq(projects.id, projectDeployCredentials.project_id))
    .where(
      and(
        eq(projectDeployCredentials.id, operation.payload.credentialId),
        eq(projectDeployCredentials.project_id, operation.project_id),
        eq(projectDeployCredentials.issued_by, operation.actor_id),
        eq(projects.user_id, operation.actor_id),
        sql`${projectDeployCredentials.revoked_at} IS NULL`,
        sql`${projectDeployCredentials.expires_at} > now()`,
      ),
    )
    .limit(1);
  if (!credential) {
    throw new Error('Deployment actor or credential is no longer active');
  }
}

export async function appendDeploymentEvent(
  db: DbOrTx,
  id: string,
  ownerId: string,
  event: DeployEvent,
): Promise<void> {
  if (event.event === 'heartbeat') {
    return;
  }
  const terminal = event.event === 'done' || event.event === 'error';
  // Heartbeats and excessive intermediate events are omitted. The terminal
  // result always gets a sequence and is committed with the terminal state.
  await db.execute(sql`UPDATE deployment_operations SET
    events = events || jsonb_build_array(jsonb_build_object('seq', last_seq + 1, 'event', ${JSON.stringify(event)}::jsonb)),
    last_seq = last_seq + 1,
    status = CASE WHEN ${terminal} THEN 'terminal' ELSE status END
    WHERE id = ${id} AND owner_id = ${ownerId} AND status <> 'terminal'
      AND (${terminal} OR last_seq < ${MAX_PROGRESS_EVENTS})`);
}

export function deploymentEventPage(operation: DeploymentOperation, since: number) {
  const events = operation.events.filter((item) => item.seq > since).slice(0, 100);
  const lastSeq = events.at(-1)?.seq ?? Math.min(since, operation.last_seq);
  return {
    deploymentId: operation.id,
    events,
    lastSeq,
    terminal: operation.status === 'terminal' && lastSeq >= operation.last_seq,
    ...(operation.status !== 'terminal' && {
      heartbeat: {
        event: 'heartbeat' as const,
        deploymentId: operation.id,
        step:
          operation.status === 'recovering'
            ? 'recovery'
            : (operation.events.at(-1)?.event.event ?? 'queued'),
        status: operation.status,
        ...(operation.lease_expires_at && {
          recoveryAt: new Date(operation.lease_expires_at).toISOString(),
        }),
      },
    }),
  };
}

export function deploymentReceiptResponse(db: Db, id: string): Response {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const poll = async () => {
        if (stopped) {
          return;
        }
        try {
          const operation = await getDeploymentOperation(db, id);
          if (stopped) {
            return;
          }
          if (!operation) {
            throw new Error('Deployment receipt no longer exists');
          }
          const page = deploymentEventPage(operation, cursor);
          for (const item of page.events) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ ...item.event, seq: item.seq })}\n`),
            );
          }
          cursor = page.lastSeq;
          if (page.terminal) {
            stopped = true;
            controller.close();
            return;
          }
          if (!page.events.length) {
            controller.enqueue(encoder.encode(`${JSON.stringify(page.heartbeat)}\n`));
          }
          timer = setTimeout(() => {
            void poll();
          }, 1000);
        } catch (error) {
          stopped = true;
          controller.error(error);
        }
      };
      await poll();
    },
    cancel() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'x-void-deployment-id': id },
  });
}

export async function dispatchDeploymentOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  id: string,
): Promise<void> {
  if (!env.DEPLOYMENTS_QUEUE) {
    throw new Error('Deployment Queue is unavailable');
  }
  // Stamp before send: a lost send acknowledgement is harmless; the outbox
  // sends again and the execution claim rejects duplicate deliveries.
  await db
    .update(deploymentOperations)
    .set({ next_dispatch_at: sql`now() + interval '2 minutes'` })
    .where(and(eq(deploymentOperations.id, id), ne(deploymentOperations.status, 'terminal')));
  await env.DEPLOYMENTS_QUEUE.send({ deploymentId: id });
}

/** Queued, or abandoned by a runner whose lease has expired. */
function claimableOperation() {
  return or(
    eq(deploymentOperations.status, 'queued'),
    and(
      ne(deploymentOperations.status, 'terminal'),
      lte(deploymentOperations.lease_expires_at, sql`now()`),
    ),
  );
}

async function deleteDeploymentInputs(
  env: ApiEnv['Bindings'],
  db: Db,
  operation: Readonly<{ id: string; input_prefix: string }>,
): Promise<void> {
  await paginatedR2Delete(env.STATIC_ASSETS_R2, operation.input_prefix);
  await db
    .update(deploymentOperations)
    .set({ inputs_deleted: true, payload: { body: {}, modules: [] } })
    .where(eq(deploymentOperations.id, operation.id));
}

export async function dispatchPendingDeployments(env: ApiEnv['Bindings'], db: Db): Promise<void> {
  if (!env.DEPLOYMENTS_QUEUE) {
    return;
  }
  const pending = await db
    .select({ id: deploymentOperations.id })
    .from(deploymentOperations)
    .where(and(lte(deploymentOperations.next_dispatch_at, sql`now()`), claimableOperation()))
    .limit(20);
  for (const operation of pending) {
    await dispatchDeploymentOperation(env, db, operation.id);
  }
  const completed = await db
    .select()
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.status, 'terminal'),
        eq(deploymentOperations.inputs_deleted, false),
      ),
    )
    .limit(20);
  for (const operation of completed) {
    await deleteDeploymentInputs(env, db, operation);
  }
  // Stage-before-admission avoids holding a project transaction across R2
  // uploads. A killed request can leave partial input; walk one bounded page
  // per tick and delete only old prefixes with no acknowledged receipt.
  const sweepKey = 'deployment-input-sweep:v1';
  const cursor = await env.ROUTING.get(sweepKey);
  const page = await env.STATIC_ASSETS_R2.list({
    prefix: 'deployment-inputs/',
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const checked = new Map<string, boolean>();
  for (const object of page.objects) {
    if (object.uploaded.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
      continue;
    }
    const prefix = object.key.slice(0, object.key.lastIndexOf('/') + 1);
    let protectedInput = checked.get(prefix);
    if (protectedInput === undefined) {
      const [operation] = await db
        .select({ id: deploymentOperations.id })
        .from(deploymentOperations)
        .where(eq(deploymentOperations.input_prefix, prefix))
        .limit(1);
      protectedInput = operation !== undefined;
      checked.set(prefix, protectedInput);
    }
    if (!protectedInput) {
      await env.STATIC_ASSETS_R2.delete(object.key);
    }
  }
  if (page.truncated) {
    await env.ROUTING.put(sweepKey, page.cursor);
  } else {
    await env.ROUTING.delete(sweepKey);
  }
}

export async function processDeploymentBatch(
  batch: MessageBatch<unknown>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  for (const message of batch.messages) {
    const body = message.body as { deploymentId?: unknown } | null;
    if (!body || typeof body.deploymentId !== 'string') {
      message.ack();
      continue;
    }
    const id = body.deploymentId;
    const ownerId = crypto.randomUUID();
    const [operation] = await db
      .update(deploymentOperations)
      .set({
        owner_id: ownerId,
        lease_expires_at: sql`now() + (${DEPLOYMENT_EXECUTION_LEASE_MS} * interval '1 millisecond')`,
        status: sql`CASE WHEN status = 'queued' THEN 'running' ELSE 'recovering' END`,
      })
      .where(and(eq(deploymentOperations.id, id), claimableOperation()))
      .returning();
    if (!operation) {
      message.ack();
      continue;
    }
    try {
      if (operation.status === 'recovering') {
        const { settleExpiredDeployment } = await import('./deployment-recovery.ts');
        const result = await settleExpiredDeployment(env, db, id);
        if (!result.terminal || !result.event) {
          await db
            .update(deploymentOperations)
            .set({ lease_expires_at: sql`now() + interval '1 minute'` })
            .where(
              and(eq(deploymentOperations.id, id), eq(deploymentOperations.owner_id, ownerId)),
            );
          message.retry({ delaySeconds: 60 });
          continue;
        }
        await appendDeploymentEvent(
          db,
          id,
          ownerId,
          result.event.event === 'done'
            ? { ...result.event, workers: operation.payload.modules.length }
            : result.event,
        );
      } else {
        const { executeQueuedDeployment } = await import('./routes/deploy.ts');
        await executeQueuedDeployment(env, db, operation);
      }
      const latest = await getDeploymentOperation(db, id);
      if (latest?.status !== 'terminal') {
        message.retry({ delaySeconds: 60 });
        continue;
      }
      await deleteDeploymentInputs(env, db, operation);
      message.ack();
    } catch (error) {
      console.error('[deployment-execution] execution/reconciliation interrupted', {
        deploymentId: id,
        error,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}
