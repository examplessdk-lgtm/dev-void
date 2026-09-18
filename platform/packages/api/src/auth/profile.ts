import { updateUser, revokeOwnerVerifiedDestinationsForUserChange, type Db } from '../db.ts';
import { lockEmailPolicy } from '../email/admission.ts';
import {
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../provisioning/email-allowlist.ts';

/**
 * A mirror tighten inside `updateUserRevokingInheritedDestinations` failed.
 * Thrown from inside the transaction so drizzle rolls it back, then caught
 * by name outside it so the sign-in can go on; any other error from the same
 * transaction keeps propagating.
 */
class AllowlistTightenError extends Error {
  constructor(
    readonly projectId: string,
    cause: unknown,
  ) {
    super(`allowlist tighten failed for project=${projectId}`, { cause });
    this.name = 'AllowlistTightenError';
  }
}

/**
 * Write the provider's current login/email back to `users`, and when the
 * email actually changed, retire the owner-inherited destinations that the
 * OLD address was granted.
 *
 * This runs on EVERY login for the user's primary provider and writes back
 * whatever the provider currently reports, so `users.email` is a mutable
 * field, not a signup-time constant. Two places mint destination rows that
 * are verified purely on "this address IS the project owner's" — the
 * Option C owner branch in `routes/email.ts` and `autoAddOwnerDestination` in
 * `routes/projects.ts`. Once the owner's address changes, that claim is stale:
 * the old mailbox may have been handed to someone else, while the row stays
 * `verified` and stays in the project's `email-allowlist:<projectId>` mirror,
 * which is the ONLY per-project send boundary the proxy enforces. So demote
 * those rows and re-derive each affected project's mirror from the remaining
 * verified rows.
 *
 * The email write, the demotion and the mirror tighten commit TOGETHER, in
 * that order, with the tighten INSIDE the transaction. The only retry this
 * path has is the next login, and it retries only while the stored address
 * still differs from the provider's — so anything committed ahead of a
 * failed step is permanent. A demotion that fails after `users.email` is
 * committed is never retried (every later login compares equal); a mirror
 * write that fails after the demotion is committed is never retried either,
 * and nothing else re-derives the key on its own: the listing repairs a
 * differing mirror (`projectAllowlistKvDiffers`) only when the owner lists,
 * and until then the proxy keeps authorizing the old address from the stale
 * key. Tightening BEFORE the commit inverts that: a lost write rolls the
 * whole change back, `users.email` still reads the old address, and the next
 * login retries the (idempotent, old-snapshot-keyed) demotion and the
 * tighten. The mirror can then only ever be AHEAD of Postgres in the
 * tightening direction — a rolled-back login leaves the key without the old
 * address next to rows still `verified` — which the proxy reads as deny and
 * the listing re-widens to match the rows. `activate-domain.ts` and the
 * rollback route write routing KV under their project lock the same way; the
 * deploy go-live path writes routing only AFTER its commit because there a
 * write ahead of the row would widen. The tighten reads the verified rows
 * through the transaction so it sees the uncommitted demotion; a pool read
 * would write the old address straight back.
 *
 * Interleavings. `L` is this transaction. `I` is an owner-audited Option C
 * write (`tryCreateEmailDestination`, `promoteEmailDestinationWithOwnerAudit`):
 * it locks the owner's `users` row `FOR SHARE`, so it waits on the
 * `FOR NO KEY UPDATE` the email write takes. `G` is a listing repair or a
 * confirm click: no lock, best-effort re-derive.
 *
 *   I commits before L locks   L demotes I's row; L's tighten (transaction
 *                              view) excludes it. I's own post-commit widen
 *                              can still land after L's — the residual.
 *   I waits, L commits         I re-reads the rotated address, writes nothing.
 *   I waits, L rolls back      I re-reads the unchanged address and writes a
 *                              `verified` row keyed on it; the next login
 *                              demotes that one too.
 *   G derives between L's      G sees a tight key next to still-`verified`
 *   tighten and L's commit     rows and writes the old address back; the
 *                              best-effort re-derive after the commit undoes
 *                              it, as the DELETE route re-derives after its
 *                              row delete.
 *   two logins, same change    The second waits on the row lock, demotes
 *                              nothing, tightens to the same value.
 *
 * Residual, shared with the DELETE route: KV has no compare-and-swap, so a
 * writer that derived its mirror while the row was still `verified` can land
 * its put after BOTH of L's, and that grant lasts until the project's next
 * mirror write. Serializing the mirror writers is the project-level lock
 * class from design doc 0067, deliberately not taken here.
 *
 * A failure of the email write or the demotion surfaces as a failed sign-in,
 * exactly as a failure of the plain `updateUser` write always has. A failed
 * tighten (its row read or its KV write) does not: nothing is committed, the
 * sign-in proceeds on the stored address, and the retry is the next login —
 * failing an OAuth callback over a KV blip would buy nothing the rollback
 * has not already bought.
 */
export async function updateUserRevokingInheritedDestinations(
  db: Db,
  kv: KVNamespace,
  userId: string,
  login: string,
  previousEmail: string | null,
  nextEmail: string | null,
): Promise<void> {
  // Only a real address-to-address change revokes. A first-ever email (no
  // previous) grants nothing to revoke, and a provider that stops reporting
  // one is a data gap, not a reassignment.
  if (!previousEmail || !nextEmail || previousEmail.toLowerCase() === nextEmail.toLowerCase()) {
    await updateUser(db, userId, login, nextEmail);
    return;
  }
  let projectIds: Array<string>;
  try {
    projectIds = await db.transaction(async (tx) => {
      await lockEmailPolicy(tx);
      const txDb = tx as unknown as Db;
      await updateUser(txDb, userId, login, nextEmail);
      const affected = await revokeOwnerVerifiedDestinationsForUserChange(
        txDb,
        userId,
        previousEmail,
      );
      for (const projectId of affected) {
        try {
          await syncProjectAllowlistKv(txDb, kv, projectId);
        } catch (err) {
          throw new AllowlistTightenError(projectId, err);
        }
      }
      return affected;
    });
  } catch (err) {
    if (!(err instanceof AllowlistTightenError)) {
      throw err;
    }
    console.error(
      `[auth] allowlist tighten failed for project=${err.projectId}; keeping the stored email for user=${userId} so the next login retries:`,
      err.cause,
    );
    return;
  }
  // Undo a re-widen by a listing or confirm click that derived its mirror
  // between the tighten and the commit (see the table above). Best-effort:
  // the tighten already committed the boundary, so there is nothing left for
  // a failure here to strand.
  for (const projectId of projectIds) {
    await syncProjectAllowlistKvBestEffort(db, kv, projectId);
  }
}
