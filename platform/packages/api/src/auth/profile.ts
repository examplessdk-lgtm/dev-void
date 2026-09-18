import { updateUser, revokeOwnerVerifiedDestinationsForUserChange, type Db } from '../db.ts';
import { lockEmailPolicy } from '../email/admission.ts';

/**
 * Refresh the primary provider's profile and revoke consent inherited from
 * the owner's previous address when that address changes. Admission reads
 * these SQL rows under the same policy lock, so the profile update and
 * revocation must commit together.
 */
export async function updateUserRevokingInheritedDestinations(
  db: Db,
  userId: string,
  login: string,
  previousEmail: string | null,
  nextEmail: string | null,
): Promise<void> {
  // A missing address is a data gap, not evidence of reassignment.
  if (!previousEmail || !nextEmail || previousEmail.toLowerCase() === nextEmail.toLowerCase()) {
    await updateUser(db, userId, login, nextEmail);
    return;
  }

  await db.transaction(async (tx) => {
    await lockEmailPolicy(tx);
    const txDb = tx as unknown as Db;
    await updateUser(txDb, userId, login, nextEmail);
    await revokeOwnerVerifiedDestinationsForUserChange(txDb, userId, previousEmail);
  });
}
