/** Postgres SQLSTATEs — surfaced by both `pg` and PGlite. */
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Does this error carry the given Postgres SQLSTATE anywhere in its cause
 * chain?
 *
 * The SQLSTATE rides on the DRIVER error, and drizzle wraps that in a
 * `DrizzleQueryError` whose own `code` is undefined — so the `cause` chain
 * has to be walked, not just the frame that was thrown. Verified against
 * PGlite in `api-delete.test.ts`; `pg` reports the same code the same way.
 * Bounded so a self-referencing `cause` cannot spin.
 */
export function hasSqlState(err: unknown, code: string): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return false;
    }
    if ((cursor as { code?: unknown }).code === code) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The project row vanished under an insert that references it. */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, PG_FOREIGN_KEY_VIOLATION);
}

/** Lost an insert race on a unique index (the add/add domains race). */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, PG_UNIQUE_VIOLATION);
}

/**
 * The constraint behind a unique violation, walked like hasSqlState: the
 * `23505` code can sit on a nested cause (drizzle wraps the driver error),
 * and the constraint name rides the same frame the code does. Both drivers
 * here — PGlite and `pg` via pg-protocol — expose it as `constraint`
 * (`constraint_name` is postgres.js naming, not used in this repo). An
 * empty answer classifies as a zone race — the relay race is the
 * destructive misclassification (its compensation would delete a worker
 * another live row owns), so the name must be found wherever the driver
 * put it.
 */
export function uniqueViolationConstraintName(err: unknown): string {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cursor !== 'object' || cursor === null) {
      return '';
    }
    const name = (cursor as { constraint?: unknown }).constraint;
    if (typeof name === 'string' && name !== '') {
      return name;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return '';
}
