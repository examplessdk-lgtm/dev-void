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
 * The one place this key is spelled. The writer below and the drift check at
 * the bottom of the file share it, so a rename cannot leave the reader
 * comparing a key the writer no longer writes.
 */
function allowlistKey(projectId: string): string {
  return `email-allowlist:${projectId}`;
}

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
  const key = allowlistKey(projectId);
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

/**
 * Does `email-allowlist:<projectId>` differ from what
 * {@link syncProjectAllowlistKv} would write right now?
 *
 * Every write to this mirror is best-effort:
 * `syncProjectAllowlistKvBestEffort` swallows a KV failure that happens
 * AFTER Postgres already committed `verified`, and NOTHING else re-derives
 * the key — the confirm route early-returns on an already-verified row, the
 * hourly `scheduled()` backfill touches only `email-slug:`, and no deploy
 * hook calls the sync. A single lost write therefore strands the project
 * silently: the proxy reads a missing key as deny-all, so the owner sees
 * `verified` in `void email destinations` while every send comes back as an
 * unverified destination. This is what lets the destinations listing repair
 * it — read, compare, write only on a difference.
 *
 * The comparison is order- and duplicate-insensitive. The proxy loads the
 * value into a `Set`, so a row-order change is not drift and must not make
 * every listing write. A value that is PRESENT but unusable (not JSON, not
 * an array of strings) IS drift: rewriting it is the only thing that clears
 * it. A MISSING key is not — the writer deletes the key to say "no verified
 * destinations".
 *
 * A KV READ failure reports "no difference". The caller's next step on a
 * difference is a write, and answering "differs" on a blip would turn a
 * read-only listing into a write storm for the length of a KV incident.
 */
export async function projectAllowlistKvDiffers(
  db: Db,
  kv: KVNamespace,
  projectId: string,
): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await kv.get(allowlistKey(projectId));
  } catch (err) {
    console.error(`[email-allowlist] KV read failed for project=${projectId}:`, err);
    return false;
  }

  const mirrored = parseMirror(raw);
  if (mirrored === null) {
    return true;
  }
  const rows = await getVerifiedEmailDestinationsByProjectId(db, projectId);
  const expected = new Set(rows.map((r) => r.address.toLowerCase()));
  if (mirrored.size !== expected.size) {
    return true;
  }
  for (const address of expected) {
    if (!mirrored.has(address)) {
      return true;
    }
  }
  return false;
}

/**
 * The addresses the mirror currently grants, parsed the way the proxy's
 * `readAllowlist` parses them. `null` means the key holds something that is
 * not a mirror at all.
 */
function parseMirror(raw: string | null): Set<string> | null {
  if (raw === null) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== 'string') {
      return null;
    }
    out.add(value.toLowerCase());
  }
  return out;
}
