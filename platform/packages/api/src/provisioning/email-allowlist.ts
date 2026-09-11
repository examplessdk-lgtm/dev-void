/**
 * KV mirror of per-project verified email destinations.
 *
 * The proxy worker (`packages/proxy/src/email.ts`) reads
 * `email-allowlist:<projectId>` from `ROUTING` KV on every send to enforce
 * per-project allowlists at the binding layer. Postgres
 * (`email_destinations`) is the source of truth; KV is a denormalized
 * read-cache. Every destinations CRUD calls this helper.
 *
 * On empty (no verified destinations), the key is deleted rather than set
 * to `[]` — the proxy's read treats missing/empty identically and the
 * delete saves a KV slot.
 */

import { getVerifiedEmailDestinationsByProjectId, type Db } from '../db.ts';

/**
 * Rewrite `email-allowlist:<projectId>` from the verified rows in Postgres.
 *
 * `excludeDestinationId` drops one row from the write. A revoke has to
 * TIGHTEN the mirror before it deletes the row (the row is what a retry
 * re-derives the mirror from), and at that point
 * `getVerifiedEmailDestinationsByProjectId` still returns the row being
 * revoked — without the exclusion the sync would write the revoked address
 * straight back.
 */
export async function syncProjectAllowlistKv(
  db: Db,
  kv: KVNamespace,
  projectId: string,
  options?: { excludeDestinationId?: string },
): Promise<void> {
  const rows = await getVerifiedEmailDestinationsByProjectId(db, projectId);
  const excludeId = options?.excludeDestinationId;
  const addresses = rows.filter((r) => r.id !== excludeId).map((r) => r.address.toLowerCase());
  const key = `email-allowlist:${projectId}`;
  if (addresses.length === 0) {
    await kv.delete(key);
    return;
  }
  await kv.put(key, JSON.stringify(addresses));
}

/**
 * Best-effort wrapper that swallows errors. Use from sites where a KV
 * blip mustn't fail the user-facing operation (e.g. CRUD endpoints
 * already returned 201 to the user). Logs failures so a sweep job can
 * pick up stragglers.
 */
export async function syncProjectAllowlistKvBestEffort(
  db: Db,
  kv: KVNamespace,
  projectId: string,
): Promise<void> {
  try {
    await syncProjectAllowlistKv(db, kv, projectId);
  } catch (err) {
    console.error(`[email-allowlist] KV sync failed for project=${projectId}:`, err);
  }
}
