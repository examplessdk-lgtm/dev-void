import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { emailDestinationCleanups } from '../schema.ts';
import { CloudflareApiError } from './cloudflare-api.ts';
import { deleteDestination } from './email-routing.ts';

const LEASE_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;

type ProviderAuth = Readonly<{ accountId: string; apiToken: string }>;

async function claimCleanup(db: Db, tag: string, now: Date): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(emailDestinationCleanups)
      .where(eq(emailDestinationCleanups.cf_destination_id, tag))
      .for('update');
    if (!row || row.status === 'completed') {
      return null;
    }
    const nowMs = now.getTime();
    if (
      (row.status === 'pending' && new Date(row.next_attempt_at).getTime() > nowMs) ||
      (row.status === 'deleting' &&
        row.lease_started_at !== null &&
        new Date(row.lease_started_at).getTime() > nowMs - LEASE_MS)
    ) {
      return null;
    }
    await tx
      .update(emailDestinationCleanups)
      .set({
        status: 'deleting',
        attempts: sql`${emailDestinationCleanups.attempts} + 1`,
        lease_started_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .where(eq(emailDestinationCleanups.cf_destination_id, tag));
    return row.attempts + 1;
  });
}

/** Delete one queued provider tag. The tombstone remains after success. */
export async function runEmailDestinationCleanup(
  db: Db,
  auth: ProviderAuth,
  tag: string,
  now = new Date(),
): Promise<void> {
  const attempt = await claimCleanup(db, tag, now);
  if (attempt === null) {
    return;
  }

  try {
    await deleteDestination(auth.accountId, auth.apiToken, tag);
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) {
      const retryMs = Math.min(MAX_RETRY_MS, 60_000 * 2 ** Math.min(6, attempt));
      await db
        .update(emailDestinationCleanups)
        .set({
          status: 'pending',
          lease_started_at: null,
          next_attempt_at: new Date(now.getTime() + retryMs).toISOString(),
          updated_at: now.toISOString(),
        })
        .where(
          and(
            eq(emailDestinationCleanups.cf_destination_id, tag),
            eq(emailDestinationCleanups.status, 'deleting'),
            eq(emailDestinationCleanups.attempts, attempt),
          ),
        );
      console.error(`[email] destination cleanup failed for tag=${tag}:`, error);
      return;
    }
  }

  await db
    .update(emailDestinationCleanups)
    .set({
      status: 'completed',
      lease_started_at: null,
      updated_at: now.toISOString(),
    })
    .where(
      and(
        eq(emailDestinationCleanups.cf_destination_id, tag),
        eq(emailDestinationCleanups.status, 'deleting'),
        eq(emailDestinationCleanups.attempts, attempt),
      ),
    );
}

/** Fair, bounded repair for failed calls and expired cleanup leases. */
export async function reconcileEmailDestinationCleanups(
  db: Db,
  auth: ProviderAuth,
  limit = 10,
  now = new Date(),
): Promise<void> {
  const staleLease = new Date(now.getTime() - LEASE_MS).toISOString();
  const rows = await db
    .select({ tag: emailDestinationCleanups.cf_destination_id })
    .from(emailDestinationCleanups)
    .where(
      or(
        and(
          eq(emailDestinationCleanups.status, 'pending'),
          lte(emailDestinationCleanups.next_attempt_at, now.toISOString()),
        ),
        and(
          eq(emailDestinationCleanups.status, 'deleting'),
          lte(emailDestinationCleanups.lease_started_at, staleLease),
        ),
      ),
    )
    .orderBy(
      asc(emailDestinationCleanups.next_attempt_at),
      asc(emailDestinationCleanups.updated_at),
      asc(emailDestinationCleanups.cf_destination_id),
    )
    .limit(Math.max(1, Math.min(limit, 100)));
  for (const row of rows) {
    await runEmailDestinationCleanup(db, auth, row.tag, now);
  }
}
