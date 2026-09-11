import { tokenizeSql } from '../sql/tokenize.ts';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export type RemoteMigration = Readonly<{
  name: string;
  sql: string;
}>;

export type MigrationFailure = Readonly<{
  name: string;
  error: string;
}>;

export type MigrationResult = {
  applied: Array<string>;
  skipped: Array<string>;
  /**
   * If a migration mid-batch fails with a hard D1 / SQL error, the runner
   * records the failure here and stops. The runner does NOT throw for
   * per-migration errors — it returns the partial progress instead so the
   * caller can persist the confirmed-landed subset to pg metadata before
   * surfacing the error. Throwing would discard the committed prefix
   * because the /apply handler runs inside a pg transaction that rolls
   * back on any thrown error, leaving pg missing rows that D1's
   * `_void_migrations` already contains and poisoning subsequent rollback
   * diffs + rename corroboration.
   *
   * Undefined on success. Non-undefined means the batch stopped at this
   * migration and the caller should treat the request as failed (500).
   */
  failed?: MigrationFailure;
};

/**
 * drizzle-kit unconditionally emits `--> statement-breakpoint` between
 * every generated statement in a migration (see drizzle-orm's
 * `migrator.js`, which splits on this exact literal at runtime). Its
 * presence in a migration body is a load-bearing declaration that the
 * body is multi-statement — independently of any SQL parsing.
 *
 * The regex is deliberately permissive so future drizzle-kit tweaks
 * (extra dashes, casing, whitespace, `_` / `-` separators) still match
 * and fail safely. A false positive on this check only disables the
 * narrow recovery path — the safe direction — so loosening is fine;
 * tightening would risk silently enabling recovery on a multi-statement
 * body and letting the second statement go un-applied.
 */
const DRIZZLE_STATEMENT_BREAKPOINT = /-{2,}\s*>\s*statement[\s\-_]*breakpoint/i;

/**
 * Returns `true` iff `sql` contains exactly one effective statement.
 *
 * Used to gate the "already exists / duplicate column" recovery path in
 * `runRemoteMigrations`. Only single-statement migrations can safely be
 * marked applied on an `already exists` error — multi-statement bodies
 * may have a half-applied partial commit where the failing statement is
 * NOT the one that already exists, in which case D1 aborts the batch at
 * the first error and later statements never run.
 *
 * Two-tier strategy:
 *
 *   1. **Marker short-circuit.** If `sql` contains drizzle-kit's
 *      `--> statement-breakpoint` marker anywhere, the body is
 *      declared multi-statement by drizzle itself — return `false`
 *      without tokenizing. This is the cheapest and most authoritative
 *      signal we have for the overwhelmingly common drizzle-generated
 *      case, and it is immune to the quote / comment edge cases that
 *      a tokenizer must handle.
 *   2. **Char-by-char tokenizer fallback.** For hand-written or
 *      non-drizzle migrations with no marker, walk the SQL char-by-char
 *      and count statements. A naive "strip comments, split on `;`"
 *      regex pipeline cannot tell the difference between a real
 *      comment / terminator and one that appears inside a quoted
 *      string literal — for example,
 *      `CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y)`
 *      would get "stripped" from the first `--` onward and misclassify
 *      as a single statement, masking a multi-statement body whose
 *      second statement would silently be marked applied.
 *
 * Lexical forms and the rationale for honoring quotes/comments live in
 * `../sql/tokenize.ts` — both the destructive-SQL guard in
 * `routes/projects.ts` and this classifier share that tokenizer so a
 * new quoting-form fix lands in one place.
 *
 * A `;` or `--` inside a backtick/bracket identifier must not be
 * interpreted as a terminator or comment — otherwise a body like
 * ``CREATE TABLE `a--x` (id INT); CREATE INDEX idx ON `a--x`(id);`` is
 * misclassified as a single statement and the recovery path could mark
 * a half-applied body as complete.
 *
 * Edge case, documented: if a hand-written migration embeds the literal
 * string `--> statement-breakpoint` inside a quoted literal (e.g. a
 * seed row), the marker short-circuit will return `false` and the
 * tokenizer is not consulted. That's a safe false-positive: recovery is
 * disabled, the operator sees the underlying error, no data is lost.
 */
export function isSingleStatement(sql: string): boolean {
  // Primary: drizzle-kit marker is authoritative. Present ⇒ multi-statement.
  if (DRIZZLE_STATEMENT_BREAKPOINT.test(sql)) {
    return false;
  }
  // Fallback: walk tokenized segments and count `;`-terminated runs.
  let statements = 0;
  let inStatement = false;

  for (const seg of tokenizeSql(sql)) {
    if (seg.kind === 'line-comment' || seg.kind === 'block-comment') {
      continue;
    }
    if (seg.kind === 'string' || seg.kind === 'ident-quote') {
      inStatement = true;
      continue;
    }
    // seg.kind === 'sql' — raw run between special regions.
    for (let i = seg.start; i < seg.end; i++) {
      const character = sql[i];
      if (character === ';') {
        if (inStatement) {
          statements++;
          inStatement = false;
        }
        continue;
      }
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        inStatement = true;
      }
    }
  }

  if (inStatement) {
    statements++;
  }
  return statements === 1;
}

/**
 * One-time migration: rename legacy `_migrations` table to `_void_migrations`.
 * Copies all rows from the old table to the new one, then drops the old table.
 */
async function upgradeTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  const result = await queryD1(accountId, apiToken, databaseId, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
  });
  if (!result.results || result.results.length === 0) {
    return;
  }
  // INSERT must succeed — propagate failures so the applied set is complete.
  // The one tolerated failure is a concurrent upgrade race: two overlapping
  // ensureTrackingTable() callers both pass the sqlite_master probe above, the
  // winner completes the copy and the DROP, and the loser's INSERT then hits
  // `no such table: _migrations` because the winner already dropped it. That
  // is a benign interleaving — the rows were copied successfully by the
  // winner — so swallow exactly that error text and continue. Any other
  // failure (auth, quota, schema mismatch on `_void_migrations`) still
  // propagates. Mirrors the `already exists` recovery pattern in
  // runRemoteMigrations.
  try {
    await queryD1(accountId, apiToken, databaseId, {
      sql: `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!/no such table/i.test(msg)) {
      throw err;
    }
    // Concurrent upgrade winner already copied the rows and dropped the
    // legacy table between our probe and our INSERT — nothing to do.
  }
  // DROP can fail if a concurrent caller already dropped the table — safe to ignore.
  try {
    await queryD1(accountId, apiToken, databaseId, {
      sql: `DROP TABLE _migrations`,
    });
  } catch {
    // Concurrent upgrade already dropped the table
  }
}

/**
 * Bounded retry/poll on `_void_migrations` for a specific migration name.
 *
 * This exists to close a remaining race in the multi-statement concurrent
 * recovery path. The winner's flow is two awaited HTTP calls — apply SQL,
 * then write the tracking row — with no atomicity between them. A loser
 * arriving in between will see `already exists` from the SQL, then a
 * recheck of `_void_migrations` that is racing the winner's still-in-flight
 * tracking INSERT. A single recheck can return zero rows even though the
 * winner is microseconds away from inserting.
 *
 * Polling a few times with a short backoff turns that interleaving into a
 * harmless wait: the loser pauses long enough for the winner's tracking
 * INSERT to land (typically a few ms in practice — the winner's SQL
 * already committed before the loser's failing call returned), then sees
 * the row and reports skipped. If the row genuinely never appears within
 * the bound, the failure is real (a true partial commit, or an unrelated
 * `already exists` from a hand-merged schema conflict) and we propagate.
 *
 * Bound: 5 attempts × 50ms ≈ 250ms total wall time on a missed first
 * check. The first attempt is immediate, so the happy path (winner already
 * landed) pays nothing. The maximum wait only fires when the winner is
 * genuinely still in flight, which is exactly the case we are trying to
 * survive.
 */
async function isMigrationTracked(
  accountId: string,
  apiToken: string,
  databaseId: string,
  name: string,
): Promise<boolean> {
  const RECHECK_ATTEMPTS = 5;
  const RECHECK_DELAY_MS = 50;
  for (let attempt = 0; attempt < RECHECK_ATTEMPTS; attempt++) {
    const recheck = await queryD1(accountId, apiToken, databaseId, {
      sql: 'SELECT name FROM _void_migrations WHERE name = ?',
      params: [name],
    });
    if (recheck.results && recheck.results.length > 0) {
      return true;
    }
    if (attempt < RECHECK_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS));
    }
  }
  return false;
}

/**
 * Run migrations against a remote D1 database via the CF REST API.
 *
 * 1. Ensure _void_migrations tracking table exists
 * 2. Query already-applied migrations
 * 3. For each pending: execute SQL + record in _void_migrations
 */
/**
 * Ensure _void_migrations table exists and upgrade legacy _migrations if present.
 * Returns the set of already-applied migration names.
 */
export async function ensureTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<Set<string>> {
  await queryD1(accountId, apiToken, databaseId, {
    sql: `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  });
  await upgradeTrackingTable(accountId, apiToken, databaseId);
  const appliedResult = await queryD1(accountId, apiToken, databaseId, {
    sql: 'SELECT name FROM _void_migrations',
  });
  return new Set(appliedResult.results.map((row) => row.name as string));
}

export async function runRemoteMigrations(
  accountId: string,
  apiToken: string,
  databaseId: string,
  migrations: ReadonlyArray<RemoteMigration>,
  appliedSet?: Set<string>,
): Promise<MigrationResult> {
  const applied = appliedSet ?? (await ensureTrackingTable(accountId, apiToken, databaseId));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }

    // Execute migration SQL, then record the tracking row. The two queries
    // are not atomic (D1 exposes them as separate HTTP requests), so a retry
    // after the SQL committed but before the tracking INSERT landed will
    // re-run the migration against an object that already exists.
    //
    // The narrow recovery below catches exactly that case: if `applied`
    // (populated from `_void_migrations`) does NOT contain this migration,
    // we have never successfully recorded it, so the only way to hit an
    // "already exists" / "duplicate column" error from a fresh run is a
    // prior post-SQL failure (network blip, 429, timeout) that committed
    // the SQL but lost the tracking INSERT. Reconciling via INSERT OR
    // IGNORE is correct in that case and restores the deploy-retry path
    // that void-sdk/void#6 is about.
    //
    // Restriction: the unconditional fall-through is gated on
    // `isSingleStatement(migration.sql)`. For a multi-statement migration
    // (e.g. `CREATE TABLE a; CREATE INDEX idx ON a(id);`) a mid-migration
    // partial commit is not safely recoverable from a stale `applied` set
    // alone: if statement 1 committed on a prior deploy and statement 2
    // failed, the retry re-runs the whole body, D1 aborts the batch at the
    // first "already exists" error, and marking the migration applied
    // would let statement 2 silently never run.
    //
    // However, the multi-statement path also has a benign concurrent-winner
    // case that we must NOT confuse with partial commits: two overlapping
    // /apply requests racing on the same multi-statement migration. The
    // first call lands the SQL and the tracking INSERT, the second call
    // (with its stale preflight `appliedSet` from before the winner
    // finished) re-runs the body, hits "already exists", and previously
    // got rejected as a 500 even though the database was already in the
    // intended state. To distinguish a true concurrent winner from a
    // partial commit, re-check `_void_migrations` directly: if the row
    // is present, a concurrent caller fully reconciled this migration and
    // we can mark it skipped; otherwise the failure is real and we
    // propagate so an operator can investigate.
    //
    // Trade-off (single-statement path): the unconditional fall-through
    // CAN mask a hand-merged schema conflict where two different migrations
    // create the same object. In a drizzle-managed workflow that's
    // extremely unlikely (drizzle-kit guarantees unique object names per
    // snapshot), and the alternative — propagate every such error — breaks
    // deploy retries for every transient network failure, which is the
    // main symptom users hit.
    //
    // Per-migration errors are NEVER thrown. A thrown error inside
    // /apply's pg transaction rolls the transaction back, discarding the
    // committed prefix (earlier migrations whose SQL AND tracking row both
    // landed in D1) and releasing the row lock without persisting the
    // `applied + skipped` union to pg metadata. D1 keeps the prefix, pg
    // forgets it — durable drift that poisons rollback diffs and rename
    // corroboration. Instead, stash the failure on `result.failed`, break
    // out of the loop, and let the caller persist the confirmed-landed
    // subset before surfacing the error.
    try {
      await queryD1(accountId, apiToken, databaseId, { sql: migration.sql });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/already exists|duplicate column/i.test(msg)) {
        result.failed = { name: migration.name, error: msg };
        return result;
      }
      if (!isSingleStatement(migration.sql)) {
        // Multi-statement: only safe to recover if a concurrent caller has
        // already recorded the tracking row for this migration. Otherwise
        // a partial commit would silently be marked applied.
        //
        // The recheck is bounded-retried because the winner's SQL commit and
        // tracking INSERT are two non-atomic awaited HTTP calls. A loser that
        // fires between them must wait long enough for the winner's tracking
        // write to land before treating absence as a partial commit; see
        // `isMigrationTracked` for the full rationale.
        let tracked = false;
        try {
          tracked = await isMigrationTracked(accountId, apiToken, databaseId, migration.name);
        } catch (recheckErr) {
          // A failure on the recheck itself must also return a partial
          // result, not throw — otherwise we lose the committed prefix
          // that landed before this migration.
          result.failed = {
            name: migration.name,
            error: String((recheckErr as Error)?.message ?? recheckErr),
          };
          return result;
        }
        if (!tracked) {
          result.failed = { name: migration.name, error: msg };
          return result;
        }
        result.skipped.push(migration.name);
        continue;
      }
      // Single-statement: fall through to the tracking INSERT below — the
      // object already exists on the remote DB and the applied set says we
      // never recorded it, so reconcile by writing the tracking row.
    }

    // INSERT OR IGNORE makes the tracking write idempotent, so a retry that
    // re-runs the same migration (e.g. after a network blip on a previous
    // tracking INSERT) never produces a duplicate tracking row.
    //
    // Same partial-result discipline as the SQL execute above — a
    // tracking INSERT failure after the SQL committed must still return
    // the already-committed prefix to the caller.
    try {
      await queryD1(accountId, apiToken, databaseId, {
        sql: 'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
        params: [migration.name, new Date().toISOString()],
      });
    } catch (err) {
      result.failed = {
        name: migration.name,
        error: String((err as Error)?.message ?? err),
      };
      return result;
    }

    result.applied.push(migration.name);
  }

  return result;
}

type D1Query = Readonly<{
  sql: string;
  params?: ReadonlyArray<unknown>;
}>;

/**
 * D1 REST query response shape. `meta` is optional because older callers
 * (and the minimal test mock) only ever produced `{ results }`, and the
 * real CF response always includes `meta` on successful queries. When
 * present, callers can inspect `meta.changes` to see how many rows were
 * affected by an UPDATE / DELETE / INSERT — the rename endpoint uses this
 * to detect concurrent-rename conflicts where the winner already renamed
 * the row out from under us and our own UPDATE was a no-op.
 */
type D1QueryResponseMeta = Readonly<{
  changes?: number;
  rows_written?: number;
  rows_read?: number;
  [key: string]: unknown;
}>;

type D1QueryResponse = Readonly<{
  results: ReadonlyArray<Record<string, unknown>>;
  meta?: D1QueryResponseMeta;
}>;

export const D1_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound on a single D1 REST call. Without this, a hung upstream request
 * (outage, partition, TCP black hole) would hold the rename/apply/rollback
 * row lock for the duration of the pending fetch — minutes or until TCP
 * RST — and every other migration request on the same project would pile up
 * on the same lock, burning pg pool connections. Aborting fast with a clear
 * error lets the transaction unwind and releases the lock.
 *
 * The timeout is an optional parameter so unit tests can pass a short override
 * without global monkey-patching.
 *
 * The timer MUST remain active until `response.json()` completes.
 * `fetch()` resolves on HEADERS, not full body, so clearing the timeout at
 * header receipt leaves the body parse unguarded. A D1 that sends headers
 * and then stalls the chunked body (or sends a truncated stream) would make
 * `response.json()` hang forever, holding the row lock and pg pool connection
 * for the duration. Keeping the controller active across the parse lets
 * abort propagate into the body stream and reject `json()`.
 */
export async function queryD1(
  accountId: string,
  apiToken: string,
  databaseId: string,
  query: D1Query,
  timeoutMs: number = D1_REQUEST_TIMEOUT_MS,
): Promise<D1QueryResponse> {
  const url = `${CF_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json: {
    success: boolean;
    errors: ReadonlyArray<{ code: number; message: string }>;
    result: ReadonlyArray<D1QueryResponse & { meta?: D1QueryResponseMeta }>;
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(query),
      signal: controller.signal,
    });
    // Keep the timer armed across the body parse — `fetch()` resolves on
    // headers, and a stalled / truncated body would otherwise hang the
    // `response.json()` await indefinitely. `controller.abort()` fires when
    // the timer elapses and propagates into the body stream, rejecting
    // `json()` with an AbortError that we translate to a timeout below.
    json = (await response.json()) as typeof json;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const preview = query.sql.length > 80 ? `${query.sql.slice(0, 80)}…` : query.sql;
      throw new Error(`D1 request timed out after ${timeoutMs}ms (${preview})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!json.success) {
    const message = json.errors.map((error) => error.message).join(', ');
    throw new Error(`D1 migration failed: ${message}`);
  }

  // D1 query API returns an array of results (one per statement). Forward
  // `meta` through so callers that need to inspect rows-affected (e.g. the
  // rename handler's concurrent-conflict detection) can read it without
  // issuing a follow-up SELECT.
  const first = json.result[0];
  if (!first) {
    return { results: [] };
  }
  return { results: first.results ?? [], meta: first.meta };
}
