import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db.ts';
import { sandboxDrainCheckpoints } from './schema.ts';

export const SANDBOX_DRAIN_STATE_KEY = '__void/platform/sandbox-drain/v1';
const LEASE_MS = 120_000;

export type SandboxDrainPhase = 'deployments' | 'resources';
export type SandboxDrainCursor = Readonly<Record<string, string>>;
export type SandboxDrainCheckpoint = typeof sandboxDrainCheckpoints.$inferSelect;

export type SandboxDrainState = Readonly<{
  version: 1;
  generation: string;
  state: 'draining' | 'complete';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

export async function readSandboxDrainState(
  routing: Pick<KVNamespace, 'get'>,
): Promise<SandboxDrainState | null> {
  const raw = await routing.get(SANDBOX_DRAIN_STATE_KEY);
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SANDBOX_DRAIN_STATE_KEY} contains invalid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${SANDBOX_DRAIN_STATE_KEY} contains an invalid state document.`);
  }
  const state = parsed as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.generation !== 'string' ||
    (state.state !== 'draining' && state.state !== 'complete') ||
    typeof state.startedAt !== 'string' ||
    typeof state.updatedAt !== 'string' ||
    (state.completedAt !== undefined && typeof state.completedAt !== 'string')
  ) {
    throw new Error(`${SANDBOX_DRAIN_STATE_KEY} contains an invalid state document.`);
  }
  return state as SandboxDrainState;
}

export async function writeSandboxDrainMirror(
  routing: Pick<KVNamespace, 'put'>,
  checkpoint: SandboxDrainCheckpoint,
): Promise<void> {
  const state: SandboxDrainState = {
    version: 1,
    generation: checkpoint.generation,
    state: checkpoint.state,
    startedAt: checkpoint.started_at,
    updatedAt: checkpoint.updated_at,
    ...(checkpoint.completed_at ? { completedAt: checkpoint.completed_at } : {}),
  };
  await routing.put(SANDBOX_DRAIN_STATE_KEY, JSON.stringify(state));
}

export async function readSandboxDrainCheckpoint(db: Db): Promise<SandboxDrainCheckpoint | null> {
  const [row] = await db
    .select()
    .from(sandboxDrainCheckpoints)
    .where(eq(sandboxDrainCheckpoints.singleton, true));
  if (!row) {
    return null;
  }
  assertValidCheckpoint(row);
  return row;
}

function assertValidCheckpoint(row: SandboxDrainCheckpoint): void {
  if (
    (row.admission_protocol !== 0 && row.admission_protocol !== 2) ||
    !row.generation ||
    (row.state !== 'draining' && row.state !== 'complete') ||
    (row.phase !== 'deployments' && row.phase !== 'resources') ||
    !row.cursor ||
    (row.cursor.pass !== '1' && row.cursor.pass !== '2')
  ) {
    throw new Error('Sandbox drain database checkpoint is invalid.');
  }
}

export async function acquireSandboxDrainLease(
  db: Db,
): Promise<
  | { kind: 'acquired'; checkpoint: SandboxDrainCheckpoint; owner: string }
  | { kind: 'busy'; checkpoint: SandboxDrainCheckpoint }
  | { kind: 'complete'; checkpoint: SandboxDrainCheckpoint }
> {
  const owner = crypto.randomUUID();
  return db.transaction(async (tx) => {
    await tx
      .insert(sandboxDrainCheckpoints)
      .values({
        singleton: true,
        generation: crypto.randomUUID(),
        state: 'draining',
        phase: 'deployments',
        cursor: { pass: '1' },
      })
      .onConflictDoNothing();
    const [checkpoint] = await tx
      .select()
      .from(sandboxDrainCheckpoints)
      .where(eq(sandboxDrainCheckpoints.singleton, true))
      .for('update');
    if (!checkpoint) {
      throw new Error('Sandbox drain checkpoint could not be initialized.');
    }
    assertValidCheckpoint(checkpoint);
    if (checkpoint.state === 'complete') {
      return { kind: 'complete' as const, checkpoint };
    }
    if (checkpoint.lease_owner && checkpoint.lease_expires_at) {
      const [lease] = await tx
        .select({ active: sql<boolean>`${sandboxDrainCheckpoints.lease_expires_at} > now()` })
        .from(sandboxDrainCheckpoints)
        .where(eq(sandboxDrainCheckpoints.singleton, true));
      if (lease?.active) {
        return { kind: 'busy' as const, checkpoint };
      }
    }
    const [leased] = await tx
      .update(sandboxDrainCheckpoints)
      .set({
        lease_owner: owner,
        lease_expires_at: sql`now() + (${LEASE_MS} * interval '1 millisecond')`,
        updated_at: sql`now()`,
      })
      .where(eq(sandboxDrainCheckpoints.singleton, true))
      .returning();
    if (!leased) {
      throw new Error('Sandbox drain checkpoint lease could not be acquired.');
    }
    return { kind: 'acquired' as const, checkpoint: leased, owner };
  });
}

export async function checkpointSandboxDrain(
  db: Db,
  lease: { generation: string; owner: string },
  update: { phase: SandboxDrainPhase; cursor: SandboxDrainCursor },
): Promise<SandboxDrainCheckpoint> {
  const [row] = await db
    .update(sandboxDrainCheckpoints)
    .set({
      phase: update.phase,
      cursor: update.cursor,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(sandboxDrainCheckpoints.singleton, true),
        eq(sandboxDrainCheckpoints.generation, lease.generation),
        eq(sandboxDrainCheckpoints.lease_owner, lease.owner),
      ),
    )
    .returning();
  if (!row) {
    throw new Error('Sandbox drain lease was superseded; stale work was not checkpointed.');
  }
  return row;
}

export async function completeSandboxDrain(
  db: Db,
  lease: { generation: string; owner: string },
): Promise<SandboxDrainCheckpoint> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(sandboxDrainCheckpoints)
    .set({
      state: 'complete',
      completed_at: now,
      updated_at: now,
      lease_owner: null,
      lease_expires_at: null,
    })
    .where(
      and(
        eq(sandboxDrainCheckpoints.singleton, true),
        eq(sandboxDrainCheckpoints.generation, lease.generation),
        eq(sandboxDrainCheckpoints.lease_owner, lease.owner),
      ),
    )
    .returning();
  if (!row) {
    throw new Error('Sandbox drain lease was superseded; stale work cannot complete it.');
  }
  return row;
}

/** Any lifecycle document closes container creation until the beta is reintroduced. */
export async function assertSandboxContainerCreationAllowed(
  routing: Pick<KVNamespace, 'get'>,
): Promise<void> {
  if (await readSandboxDrainState(routing)) {
    throw new Error('Managed Sandbox container creation is disabled by the platform drain gate.');
  }
}
