import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { markProjectError } from './state.ts';

/**
 * The installation configuration lock. Project mutations, deployments and
 * route publication hold it shared; installation operations take it exclusive
 * to claim, checkpoint and finish, so they never overtake project work.
 * Platform uninstall holds the same key from its final check until it disables
 * traffic (packages/void/src/cli/platform-zero-trust-uninstall.ts).
 */
export async function lockZeroTrustConfiguration(
  db: DbOrTx,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  await db.execute(
    mode === 'shared'
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtext('zero-trust:configuration'))`
      : sql`SELECT pg_advisory_xact_lock(hashtext('zero-trust:configuration'))`,
  );
}

/** Carries a failure out of the transaction once its project error is recorded. */
class RecordedProjectError {
  constructor(readonly error: unknown) {}
}

/** Runs a step whose failure is recorded on the project row and committed. */
export type RecordProjectErrors = <T>(step: () => Promise<T>) => Promise<T>;

/**
 * Run `work` in one transaction holding the project row lock and the shared
 * configuration lock. An error thrown by `work` rolls the transaction back.
 * An error thrown inside `recordErrors` instead marks the project failed,
 * commits that mark with the work done before it, and is then rethrown.
 */
export async function withProjectZeroTrustLock<T>(
  db: Db,
  projectId: string,
  work: (lockedDb: Db, recordErrors: RecordProjectErrors) => Promise<T>,
): Promise<T> {
  let recorded: RecordedProjectError | undefined;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    await lockZeroTrustConfiguration(tx, 'shared');
    const lockedDb = tx as unknown as Db;
    const recordErrors: RecordProjectErrors = async (step) => {
      try {
        return await step();
      } catch (error) {
        await markProjectError(lockedDb, projectId, error);
        throw new RecordedProjectError(error);
      }
    };
    try {
      return await work(lockedDb, recordErrors);
    } catch (error) {
      if (!(error instanceof RecordedProjectError)) {
        throw error;
      }
      recorded = error;
      return undefined;
    }
  });
  if (recorded) {
    throw recorded.error;
  }
  return result as T;
}
