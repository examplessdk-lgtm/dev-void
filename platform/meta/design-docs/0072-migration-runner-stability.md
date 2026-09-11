---
title: Stable Migration Execution Across Void SDK and Platform
status: draft
created: 2026-05-18
---

# Stable Migration Execution Across Void SDK and Platform

## Summary

Void has two production migration paths for customer databases:

1. The framework/SDK bundles migrations into the deployed worker, and the platform deploy pipeline calls that worker's internal migration endpoints.
2. The platform API exposes `POST /projects/:id/migrations/apply`, used by `void db migrate --remote`, which applies SQL to D1 through the Cloudflare REST API.

The deploy-time worker path is the first path this RFC makes stable. The remote REST path converges only if D1 REST `batch` proves equivalent to worker `db.batch()`; otherwise it remains an explicitly labeled legacy/compensating path.

Stable migration execution means:

> A supported migration either fully applies and is recorded, or it fails without being recorded and without leaving partial schema changes.

Until the remote REST path can execute migration SQL and the tracking insert in one verified atomic operation, `POST /projects/:id/migrations/apply` remains a legacy/compensating path and must not be described as satisfying this stable contract. It can remain available for backwards compatibility, but new stable remote migration behavior must either use verified REST batch semantics or a future explicitly designed safe execution mechanism.

Today that contract is not strong enough. The SDK worker D1 handler splits Drizzle breakpoint-framed SQL and runs each statement independently before writing `_void_migrations`. The platform legacy remote runner sends migration SQL to D1 and writes `_void_migrations` in a separate REST call. Both designs can leave D1 and metadata in an awkward state after mid-migration failure, timeout, retry, or race.

This RFC proposes a coordinated, backwards-compatible change:

- Make Drizzle `--> statement-breakpoint` markers the only supported statement-boundary format for split SQLite/D1 migrations.
- Execute breakpoint-framed D1 migrations as one atomic unit with the tracking insert included in that same unit.
- Keep SQL execution delegated to database/runtime APIs rather than building a general SQL parser.
- Compute tokenizer-backed migration execution plans in CLI/build-time/platform contexts and serialize those plans into the deployed worker, so the worker runtime stays small.
- Share or port the platform SQL tokenizer into the SDK so destructive validation and execution-plan classification do not diverge.
- Preserve existing SDK/platform wire contracts while adding optional protocol metadata for newer SDKs.
- Serialize project migration application across platform paths before claiming deploy-time migration stability.
- Use D1 REST `batch` only after verifying it gives the same rollback semantics as worker `db.batch()` for the migration shapes Void supports; otherwise explicitly classify old remote D1 REST application as a legacy path.
- Separate app migration results from Better Auth migration results so a post-app auth failure cannot hide app migrations that already committed.
- Split app migrations and Better Auth synchronization into separate stable deploy phases, so confirmed app migration metadata is persisted before auth can run.
- Treat unknown-outcome app migration dispatch retries as unsafe unless the retry path can reconcile the previous attempt from durable D1 state.
- Persist confirmed app migration metadata after any post-migration deploy failure, not only after Better Auth failures.

Cloudflare references checked for this draft:

- D1 worker binding API: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 REST query API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/

## Current Entry Points

### SDK Local SQLite

Code path:

- `framework/packages/void/src/migrations/runner.ts`

Behavior:

- Reads `db/migrations/*.sql`.
- Uses `better-sqlite3`.
- Executes each migration with SQLite's `exec()`.
- Wraps each migration and the tracking insert in a local SQLite transaction.
- Avoids splitting SQL on semicolons.

Assessment:

- This path is mostly sound at the database-atomicity layer and should remain database-delegated.
- For D1-targeted projects, local SQLite must still run the same execution-plan classifier and stable-mode warnings/errors before `exec()`. Otherwise a migration can pass locally but fail deploy because it uses legacy unsplit multi-statement SQL, unsupported trigger syntax, or transaction-control statements.

### SDK Local PostgreSQL

Code path:

- `framework/packages/void/src/migrations/runner-pg.ts`

Behavior:

- Uses `pg`.
- Runs each migration inside `BEGIN` / `COMMIT`.
- Inserts the tracking row before commit.

Assessment:

- This is sound for normal transactional PostgreSQL DDL.
- Future work may need `-- void:no-transaction` for PostgreSQL operations like `CREATE INDEX CONCURRENTLY`, but that is separate from the D1 stability issue.

### SDK Worker D1 Handler

Code path:

- `framework/packages/void/src/runtime/migration-handler.ts`

Invocation:

- Platform deploy uploads a versioned worker.
- Platform calls `POST /__void/migrate` on that new worker.

Behavior:

- Creates/upgrades `_void_migrations`.
- Reads applied migration rows.
- For each pending migration:
  - Splits on Drizzle statement breakpoint markers.
  - If split into multiple statements, runs each statement independently with `db.prepare(statement).run()`.
  - Inserts `_void_migrations` after the statements complete.
  - If not split, chooses between `prepare().run()` and `exec()` using a small scanner.

Risk:

- Split migrations are not atomic. A failing later statement can leave earlier schema changes committed without a tracking row.

### Platform Deploy Pipeline

Code path:

- `packages/api/src/routes/deploy.ts`

Behavior:

- Uploads the new worker.
- Marks deployment as `migrating`.
- Calls the new worker's `/__void/migrate`, with retry behavior for readiness/dispatch failures.
- Only switches routing after migrations succeed.
- Stores `applied_migrations` on the deployment row after success.

Assessment:

- The deploy pipeline delegates SQL execution to the SDK worker.
- The platform still owns orchestration, retry behavior, cancellation checks, deployment metadata, and whether multiple deploys can migrate the same project concurrently.
- The deploy migration phase currently does not hold the same project row lock as `POST /projects/:id/migrations/apply`, so deploy and remote-apply can race unless serialization is added around the migration phase.
- A platform row lock around the deploy migration phase does not by itself serialize two `/__void/migrate` calls created by retrying the same deployment after an unknown outcome. A timed-out service-binding request may still be executing in the user worker when the platform starts the next attempt.
- Any deploy phase after app migrations commit can still fail before routing switches. The platform must keep deployment metadata aligned with D1 even when queue setup, cancellation checks, Better Auth sync, or other post-migration work fails.

### SDK Better Auth Migrations

Code paths:

- `framework/packages/void/src/runtime/migration-handler.ts`
- `framework/packages/void/src/runtime/auth-migrations.ts`
- `framework/packages/void/src/runtime/better-auth.ts`
- `framework/packages/void/src/runtime/better-auth-pg.ts`

Behavior:

- `/__void/migrate` runs app migrations first.
- If app migrations succeed and auth is enabled, it runs Better Auth schema synchronization afterward.
- The auth phase uses idempotent schema checks, but it is a separate schema-mutating phase and is not tracked in `_void_migrations`.

Risk:

- If app migrations commit and auth migrations fail afterward, the current endpoint-level catch can return an empty migration result. The platform then fails the deploy without persisting the app migrations that already committed, leaving D1 and deployment metadata inconsistent.

### Platform `POST /projects/:id/migrations/apply`

Code paths:

- `packages/api/src/routes/projects.ts`
- `packages/api/src/migrations/remote-runner.ts`

Invocation:

- `void db migrate --remote` calls this API through the SDK CLI.

Behavior:

- Authenticates project ownership.
- Acquires a Postgres row lock on the project.
- Finds the project's D1 resource.
- Ensures/upgrades `_void_migrations`.
- Filters pending migrations.
- Applies destructive SQL validation using platform tokenizer-backed matching.
- Calls `runRemoteMigrations()`.
- Appends applied/skipped names to active deployment metadata.

Risk:

- `runRemoteMigrations()` sends migration SQL through the D1 REST query endpoint, then sends a separate tracking insert. The code has careful recovery for retries and concurrency, but SQL + tracking is not one atomic operation.

## Problem

Void currently has more than one migration runner with different semantics:

- SDK worker D1 migrations can partially apply split statements.
- Platform remote D1 migrations can apply SQL but fail before the tracking row.
- Platform remote D1 has a stronger tokenizer/destructive guard than SDK validation.
- SDK deploy and `void db migrate --remote` can produce different outcomes for the same migration.
- Deploy-time app migrations and `void db migrate --remote` can race each other because only the remote API path currently takes the project row lock.
- Deploy migration retries can race with still-running prior attempts from the same deploy request after a timeout or unknown dispatch outcome.
- Better Auth migrations run after app migrations in the same endpoint but are not represented in app migration metadata.
- Post-migration deploy failures can leave app migrations committed in D1 while deployment metadata is not persisted because the route only writes `applied_migrations` on the success path.
- The SDK runtime contains custom SQL-ish scanning that can grow into an unmaintainable parser if we keep patching edge cases.

The user-facing failure is severe: a migration can fail, not be marked applied, and then fail forever on retry because some objects already exist. Recovery then requires manual D1 surgery.

## Goals

- Stability: supported migrations must not partially apply.
- Stability: tracking rows must be committed in the same atomic unit as migration SQL whenever the execution API supports it.
- Stability: SDK deploy reaches stable semantics in this RFC; platform remote apply reaches the same semantics only if REST batch verification succeeds, otherwise it remains explicitly legacy/compensating.
- Stability: platform-controlled migration paths must serialize per project before any path is declared stable.
- Stability: app migration metadata must be preserved even if a later auth migration phase fails.
- Stability: app migration metadata must be preserved after any later deploy failure once app migrations are confirmed committed.
- Stability: deploy migration retries after unknown outcomes must not overlap unsafely with in-flight prior attempts.
- Stability: destructive validation must not match comments, string literals, or identifier bodies.
- Performance: split D1 migrations should use one database operation per migration, not one operation per statement.
- Performance: no heavyweight SQL parser in the worker runtime.
- Maintainability: avoid inventing a general-purpose SQL parser.
- Compatibility: existing SDKs and CLIs must keep working against the platform API.
- Compatibility: existing Drizzle-generated migrations should work unchanged.

## Non-Goals

- Do not move all migration execution into the platform in this RFC.
- Do not replace Drizzle as the primary migration authoring path.
- Do not parse or rewrite arbitrary SQL.
- Do not support every SQL dialect feature through custom code.
- Do not solve PostgreSQL non-transactional migration escape hatches in this RFC.
- Do not require a breaking API change from SDK to platform.

## Design Principles

### Database APIs Own SQL Execution

Void should frame migrations, track state, validate obvious hazards, and report errors. It should not try to understand arbitrary SQL deeply enough to execute it itself.

### Statement Boundaries Must Be Explicit

For SQLite/D1 multi-statement migrations, the supported split format is Drizzle's statement breakpoint marker:

```sql
--> statement-breakpoint
```

including Drizzle's inline form:

```sql
CREATE INDEX ...;--> statement-breakpoint
```

Void must not split on semicolons. Semicolons can appear in strings, comments, identifiers, triggers, and generated SQL.

### Atomicity Beats Best-Effort Recovery

Best-effort recovery is valuable for legacy paths, but the desired steady state is atomic apply:

- migration SQL
- tracking row insert

must commit or fail together.

### Runtime Code Stays Small

The worker runtime migration handler should not bundle a full SQL parser. Any heavier validation should run in CLI/platform build-time contexts.

For new SDK builds, the CLI/plugin computes and serializes each app migration's execution plan into the worker bundle. The worker runtime consumes that plan and only performs simple validation that the plan shape is internally consistent. Existing workers and old SDK bundles keep their legacy runtime behavior.

## Proposed Architecture

## 1. Shared Migration Semantics

Define one logical migration execution model used by both SDK and platform:

```ts
type MigrationExecutionPlan = {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
  planHash: string;
  stability: 'stable' | 'legacy';
  warnings?: Array<string>;
} & (
  | {
      kind: 'single-statement';
    }
  | {
      kind: 'breakpoint-framed';
      statements: Array<string>;
    }
  | {
      kind: 'legacy-unsplit-multi-statement';
      allowLegacy: boolean;
    }
);
```

Rules:

- `breakpoint-framed` is selected only when Drizzle statement breakpoints are present.
- `single-statement` is selected by tokenizer-backed classification.
- `legacy-unsplit-multi-statement` is selected when SQL appears multi-statement without breakpoints.
- `legacy-unsplit-multi-statement` remains accepted initially for backwards compatibility, but should warn and eventually require an explicit pragma.
- For deployed workers built by new SDKs, this plan is computed before bundling and embedded alongside the migration SQL.
  - The plan is authoritative for worker execution, but it is not unchecked. The worker must verify migration name order, `sqlHash`, `planHash`, `dialect`, and supported `classifierVersion` against the bundled migration SQL before executing a stable plan.
- The worker runtime must not re-tokenize SQL to discover statement boundaries. It should only execute the embedded plan after the cheap integrity checks pass.
- Build-time tests must prove every `breakpoint-framed.statements` array reconstructs the executable segments derived from the migration SQL, every `single-statement` plan hashes the full SQL body, and every unsupported marker/comment/string edge case is rejected before bundling.
- The platform remote runner computes the same plan server-side for old `{ migrations }` payloads. For new payloads, client-supplied plans are accepted only after strict server-side validation or recomputation proves they match the submitted SQL.
- If the simple breakpoint splitter sees a marker-shaped line inside a string literal or comment, that file is unsupported unless the build-time tokenizer can prove it is executable SQL. The worker runtime should never guess.

Integrity fields:

- `sqlHash` is `sha256:<lowercase hex>` over the canonical migration SQL bytes.
- Canonical SQL normalizes `\r\n` and bare `\r` to `\n` and strips a leading UTF-8 BOM. No whitespace, comment, or trailing-semicolon normalization is allowed.
- `classifierVersion` is an integer incremented whenever statement-boundary, stability, or destructive-validation classification semantics change.
- `planHash` is `sha256:<lowercase hex>` over a canonical JSON object containing `name`, `dialect`, `classifierVersion`, `sqlHash`, `kind`, `stability`, and the ordered `statements` array when present. Object keys are sorted lexicographically and strings are JSON-escaped normally.
- A deploy also carries an ordered `migrationListHash` over the ordered `(name, sqlHash, planHash)` tuples so the worker can reject re-ordered or mixed-plan bundles.

Candidate pragma:

```sql
-- void:allow-unsplit-multi-statement
```

This pragma should be rare and should not imply atomicity.

## 2. SDK Worker D1 Handler

For `breakpoint-framed` D1 migrations:

1. Read the already-classified `statements` from the serialized execution plan.
2. Prepare each statement.
3. Prepare the `_void_migrations` insert.
4. Execute all prepared statements in one atomic D1 operation.

Preferred worker binding API:

```ts
await db.batch([
  ...statements.map((statement) => db.prepare(statement)),
  db.prepare('INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)').bind(name, now),
]);
```

The tracking insert must be part of the same operation. It must not be a follow-up request.

Stable D1 execution uses a plain `INSERT`, not `INSERT OR IGNORE`, for the tracking row. A duplicate tracking row means another attempt already recorded the migration, or the caller is racing stale state. In either case, the batch must abort and roll back user SQL rather than silently ignore tracking while committing potentially non-idempotent DML. Legitimate concurrency is handled by the platform/worker migration lock and by pre-batch reconciliation against `_void_migrations`.

For `single-statement` migrations:

- Use the same stable shape:

```ts
await db.batch([
  db.prepare(sql),
  db.prepare('INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)').bind(name, now),
]);
```

- Do not use `prepare().run()` followed by a separate tracking insert in stable D1 mode. That reintroduces the SQL-committed/tracking-missing failure this RFC is removing.

For `legacy-unsplit-multi-statement` migrations:

- Keep `db.exec(sql)` initially for compatibility.
- Warn at deploy time.
- Do not promise atomicity unless D1 documentation and tests prove it.
- Prefer asking users to add breakpoints.

### Tracking Table Setup and Legacy Upgrade

Stable worker app migration execution must establish tracking state before reading pending migrations:

1. Acquire the stable app migration attempt lock / attempt row for the platform-generated `attemptId`.
2. Create `_void_migrations` if it does not exist.
3. Probe for legacy `_migrations`.
4. If legacy `_migrations` exists, execute one atomic D1 `batch()` that:
   - creates `_void_migrations` if needed,
   - copies all rows from `_migrations` into `_void_migrations`,
   - drops `_migrations`.
5. Re-read `_void_migrations` after setup/upgrade and use that read as the applied set.
6. If any setup or upgrade step fails, stop before pending migration execution and return a setup failure. Do not continue with a possibly incomplete applied set.

`INSERT OR IGNORE ... SELECT` is acceptable for the legacy copy step because the goal is to merge historical tracking rows, not record the current migration. It is not acceptable for the current migration's tracking insert in stable mode.

Concurrent setup/upgrade is expected to be prevented by the stable app migration attempt lock. If an old runtime or legacy platform overlaps anyway, the new runtime must not swallow upgrade errors blindly; it may only treat a race as harmless after re-reading `_void_migrations` and proving the legacy rows are present.

### Stable Worker Migration Protocol

Stable deploys do not call one endpoint that runs app migrations and Better Auth synchronization back-to-back. They use separate platform phases:

1. `POST /__void/migrate/app` runs only app migrations and returns confirmed app migration state.
2. Platform persists confirmed app migration state to the project-level migration source of truth.
3. `POST /__void/migrate/auth` runs Better Auth synchronization only after app migration state is durably persisted.

The legacy `POST /__void/migrate` endpoint can remain for old platforms/workers, but it is not the stable protocol because app migration success can be hidden by an auth hang, worker eviction, timeout, or non-JSON response.

App migration response shape:

```ts
type WorkerAppMigrationResponse = {
  ok: boolean;
  protocolVersion: 2;
  attemptId: string;
  migrations: Array<MigrationResult>;
  confirmedApplied: Array<string>;
  confirmedSkipped: Array<string>;
  stability: 'stable' | 'legacy';
  warnings?: Array<string>;
  error?: string;
};
```

Rules:

- If app migrations fail, `ok` is `false`, `migrations` includes the attempted app migration prefix, and auth migrations do not run.
- If app migrations succeed, the platform persists confirmed app migration state before starting auth.
- If auth fails, hangs, or returns an unknown outcome, app migration metadata is already durable.
- Platform deploy must persist confirmed app migration state to the project-level migration source of truth before surfacing any later post-migration deploy failure.
- `confirmedApplied` contains names whose SQL and tracking rows were committed by this call.
- `confirmedSkipped` contains names already present in `_void_migrations` when this call reconciled state.
- `stability` is `legacy` if any executed or skipped pending migration used a legacy execution plan. A deployment with `stability: "legacy"` must not be described as satisfying the stable migration contract.
- Each `MigrationResult` should include `stability: "stable" | "legacy"` and a protocol-v2 `status: "applied" | "skipped" | "failed"`. Keep the legacy `applied` boolean only for backwards compatibility.
- Platform metadata updates must use `confirmedApplied ∪ confirmedSkipped`, not `migrations.map((m) => m.name)`. The legacy `MigrationResult.applied: false` value is ambiguous because it currently means both "already applied/skipped" and "failed" depending on whether `error` is present.
- Better Auth migrations remain idempotent schema synchronization in this RFC. They are not recorded in `_void_migrations`, and the RFC does not claim the whole `/__void/migrate` endpoint is one atomic database transaction across app and auth phases.
- Follow-up work should make SQLite auth schema mutations use D1 `batch()` for internally grouped changes where practical, but that is separate from app migration tracking correctness.

Auth migration response shape:

```ts
type WorkerAuthMigrationResponse = {
  ok: boolean;
  protocolVersion: 2;
  error?: string;
};
```

### Protocol Versioning and Capability Negotiation

There are two capability checks:

Platform API capability for SDK/CLI:

- `GET /capabilities` returns `{ migrationProtocolVersion: 2, acceptsExecutionPlans: true, supportedClassifierVersions: [1] }`.
- New SDKs call this before sending optional remote migration metadata. If the platform does not expose the capability or reports version `< 2`, the SDK sends the legacy `{ migrations }` payload and labels remote apply as legacy.

Worker capability for deploy:

- Stable workers expose `GET /__void/migrate/capabilities`.
- Response shape:

```ts
type WorkerMigrationCapabilities = {
  protocolVersion: 2;
  endpoints: {
    app: '/__void/migrate/app';
    auth?: '/__void/migrate/auth';
    reconcile: '/__void/migrate/app/attempt/:attemptId';
  };
  dialect: 'sqlite';
  classifierVersion: number;
  migrationListHash: string;
  destructiveValidation: 'passed';
};
```

Deploy cutover:

1. Platform uploads the worker and performs readiness probing.
2. Platform calls `GET /__void/migrate/capabilities`.
3. If the worker returns protocol v2 with matching `migrationListHash`, supported `classifierVersion`, and `destructiveValidation: "passed"`, deploy uses the stable app/auth endpoints.
4. If the capabilities endpoint is missing or invalid, deploy may fall back to legacy `POST /__void/migrate` for backwards compatibility, but the deployment is marked `migration_protocol: "legacy"` and cannot be reported as satisfying the stable migration contract.
5. If the deploy manifest claims protocol v2 but the worker capability check fails, fail the deploy instead of silently falling back. Silent fallback would hide build/platform skew.
6. The exact point a deploy is considered stable protocol is after the platform has successfully used `POST /__void/migrate/app`, persisted confirmed app migration state, and, if auth is configured, completed `POST /__void/migrate/auth`.

### Deploy Retry Discipline

Calling `POST /__void/migrate/app` is not safely retryable after an unknown outcome unless the next attempt can prove what the previous attempt committed.

Stable deploy chooses this state machine:

1. Retry readiness/proxy propagation before the app migration request starts.
2. Generate an `attemptId` in the platform and send exactly one `POST /__void/migrate/app` request for that deploy attempt.
3. If the app migration request returns a structured response, persist `confirmedApplied ∪ confirmedSkipped`.
4. If the app migration request times out, returns non-JSON, or has any unknown outcome after the request may have reached the worker, do not send a second app migration request for that deploy attempt.
5. Query a reconciliation endpoint, `GET /__void/migrate/app/attempt/:attemptId`, which reads durable D1 state and returns the attempt record plus `_void_migrations` rows for the attempt's planned migration names.
6. If reconciliation proves all pending names are tracked, persist them and continue to auth. If reconciliation cannot prove completion, mark the deploy failed with an unknown migration outcome and require an explicit retry/reconciliation command.

Required behavior:

- If the platform receives a structured worker response, use `confirmedApplied` and `confirmedSkipped` to persist confirmed state before returning any failure.
- The app migration endpoint records an attempt row before executing pending migrations. The row includes `attemptId`, project/deployment identifiers if available, planned migration names, plan hashes, status, started timestamp, and completed timestamp/error fields.
- The reconciliation endpoint never trusts the attempt row alone. It re-reads `_void_migrations` for the planned names and reports which names are confirmed tracked.
- A project row lock in the platform database coordinates platform endpoints; it does not stop multiple service-binding calls already sent to the same user worker from overlapping.

Attempt tables:

```sql
CREATE TABLE IF NOT EXISTS _void_migration_attempts (
  attempt_id TEXT PRIMARY KEY,
  deployment_id TEXT,
  migration_list_hash TEXT NOT NULL,
  planned_names_json TEXT NOT NULL,
  plan_hashes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'unknown')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS _void_migration_lock (
  name TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
```

Attempt acquisition protocol:

1. Insert `_void_migration_lock(name='app', attempt_id, acquired_at)` first.
2. If the lock insert fails, read the existing lock.
3. If the existing lock belongs to the same `attemptId`, return/reconcile the existing attempt without executing a second copy.
4. If the existing lock belongs to a different attempt, return `409 in_progress` with that attempt id. Do not create a new attempt row before returning 409, and do not steal the lock automatically even if it appears old; the prior Worker may still be executing after a platform timeout.
5. After acquiring the lock, insert `_void_migration_attempts(attempt_id, ..., status='running')`.
6. If the attempt insert finds the same `attempt_id` already exists, delete the just-acquired lock if it still belongs to this attempt and return/reconcile the existing attempt. A reused `attemptId` must not execute a second copy.
7. If the attempt insert fails for any other reason, delete the just-acquired lock if it still belongs to this attempt and return setup failure before executing migrations.
8. After all app migrations finish and tracking rows are committed, update the attempt to `completed`, then delete the lock.
9. If execution fails before or during a migration, update the attempt to `failed` with the error and delete the lock only after all confirmed migration state has been reported.
10. If the Worker is killed, the lock may remain. Reconciliation can prove tracked migrations and mark the attempt completed from the platform side; otherwise the project requires an explicit repair/reconcile command before another app migration execution may start.

This deliberately favors a terminal unknown outcome over automatic stale-lock stealing. It prevents two different `attemptId`s from executing app migrations concurrently in the same D1 database.

## 3. Platform Remote D1 Runner

The platform remote runner must be updated or explicitly classified as legacy.

Current platform path:

- `runRemoteMigrations()` calls D1 REST query for migration SQL.
- Then calls D1 REST query again for tracking insert.

Target behavior:

- As of 2026-05-18, Cloudflare documents that the D1 REST `/query` endpoint accepts either a single query object or a `batch` request body, and that SQL text can contain multiple semicolon-separated statements. This resolves API-shape discovery but not the transactional semantics Void depends on.
- If Cloudflare D1 REST `batch` proves equivalent to worker `db.batch()` for supported migration DDL/DML and parameterized tracking inserts, use it for `breakpoint-framed` and `single-statement` migrations, with the tracking insert included.
- If REST `batch` exists but does not roll back prior statements and tracking rows exactly like worker `db.batch()`, keep current compensating behavior but label it as legacy and make its limitations explicit in docs/errors.
- In either case, platform should reuse the same execution-plan classifier as the SDK.
- Updating `runRemoteMigrations()` for REST `batch` requires changing result handling. The existing `queryD1()` helper returns only `json.result[0]`; batch execution must preserve enough per-statement or per-migration result/error context to report the migration name that failed and to avoid marking an unconfirmed prefix as applied.
- Client-supplied execution plans are advisory, not trusted. The platform must either recompute plans from the submitted SQL or validate that every supplied plan exactly corresponds to the submitted migration name and SQL before it affects execution or validation.
- Destructive validation always runs on the server against the submitted SQL for the pending migration set. Protocol metadata must never bypass destructive validation.

Important constraint:

- Do not break the existing platform API payload:

```json
{
  "migrations": [{ "name": "001.sql", "sql": "..." }]
}
```

Additive metadata is allowed for new SDKs:

```json
{
  "migrations": [{ "name": "001.sql", "sql": "..." }],
  "dialect": "sqlite",
  "migrationProtocolVersion": 2,
  "executionPlans": [
    {
      "name": "001.sql",
      "dialect": "sqlite",
      "classifierVersion": 1,
      "sqlHash": "sha256:...",
      "planHash": "sha256:...",
      "stability": "stable",
      "kind": "breakpoint-framed",
      "statements": ["CREATE TABLE users (id TEXT PRIMARY KEY)"]
    }
  ]
}
```

The platform must continue to accept old clients with no extra fields.

Validation rules for `executionPlans`:

- The plan array length and names must exactly match `migrations`.
- Every plan `sqlHash` must match the submitted migration SQL.
- Every `planHash` must match the canonical plan object.
- `dialect` and `classifierVersion` must be supported by the platform.
- Every `breakpoint-framed.statements` array must reconstruct the same executable SQL segments that the server-side classifier derives from the migration SQL.
- A `single-statement` plan is accepted only if the server-side classifier also classifies the SQL as single-statement.
- A `legacy-unsplit-multi-statement` plan is accepted only if the platform would also classify the SQL as legacy and the applicable legacy pragma/protocol rule allows it.
- If validation fails, reject the request with a 400 rather than silently falling back to a weaker interpretation.

## 4. Platform Migration Serialization

`POST /projects/:id/migrations/apply` already serializes per project with a Postgres row lock on `projects`.

The deploy migration phase must take equivalent serialization before this RFC can claim deploy-time migration stability. Platform deploy currently calls the worker migration endpoint directly after worker upload. Stable deploy will call `POST /__void/migrate/app`. If deploy and `POST /projects/:id/migrations/apply` can both reach the migration phase for one project, they can race at D1 even when each individual app migration uses an atomic D1 batch.

Required decision:

- Either prove the deploy pipeline already serializes migrations per project.
- Or add an explicit per-project migration lock around the deploy migration phase.

Lock scope should cover:

- read of current applied migration state
- invocation of `POST /__void/migrate/app`
- persistence of confirmed app migrations to the project-level migration source of truth
- metadata healing after any confirmed app migration result, including failures that happen after the migration phase

The lock must not route traffic to the new deployment until migrations succeed.

This work is a prerequisite for marking SDK worker D1 migrations stable. Atomic D1 execution prevents partial application by one caller; it does not make two platform-controlled callers coordinate with each other.

This lock is necessary but not sufficient for deploy retry safety. Retry safety also needs the worker dispatch discipline described above, because a previous app migration request may still be running outside the platform transaction after the platform has observed a timeout.

### Project Migration Truth and Deployment Snapshots

Confirmed app migrations are current project database state, not proof that the deployment that executed them became live. If a new deployment applies migrations and then fails during Better Auth sync, queue setup, cancellation checks, or any later phase before routing switches, writing only to the failed deployment row is insufficient: the platform still needs to know the current D1 database includes those migrations.

The RFC separates two concepts:

- `project_migrations`: current database truth for the project's D1 database.
- deployment migration snapshots: the migration set associated with a particular deployment artifact, used for rollback/diff decisions.

Required behavior:

- Introduce a project-level migration source of truth, preferred as a normalized `project_migrations` table keyed by `(project_id, name)`, populated from D1 `_void_migrations` confirmations.
- Backfill `project_migrations` from D1 `_void_migrations` where possible, falling back to the union of existing deployment `applied_migrations` only when D1 is unavailable during migration.
- Every path that confirms app migrations writes `project_migrations` while holding the project migration lock.
- The deployment that executed the migrations records a deployment snapshot for diagnostics and future target comparisons, even if it never becomes live.
- Existing `deployments.applied_migrations` remains a per-deployment snapshot. Do not overwrite an older active deployment's snapshot merely because the current database has advanced; that would corrupt rollback diffs.
- Rollback current-vs-target comparison must use `project_migrations` for the current database state and the target deployment's snapshot for the target state. It must not use `project_migrations` for both sides.
- Rename flows update `project_migrations` as current truth and update deployment snapshots only when they intentionally rewrite historical names for compatibility.
- Read precedence during the rollout is: current DB state reads use `project_migrations` when present, otherwise the active deployment snapshot; target deployment reads use that deployment's snapshot.
- The deployment that executed the migrations may also record the confirmed snapshot for diagnostics, but failed deployment metadata must not be the only durable copy.
- Exit plan: after rollback, rename, remote apply, dashboard, and CLI status all distinguish current truth from deployment snapshots, stop treating `deployments.applied_migrations` as current database truth.
- Any future rollback/diff logic should read from the project-level source of truth or an explicitly captured snapshot derived from it, not infer committed database state solely from whether a deployment reached `live`.

## 5. Shared Tokenizer and Validation

The platform already has a tokenizer-backed destructive guard:

- `packages/api/src/sql/tokenize.ts`
- `packages/api/src/routes/projects.ts`

The SDK currently uses raw regex matching.

The RFC should not create a second weaker implementation. Instead:

- Port the tokenizer into the SDK, or
- move the tokenizer to a shared package if practical, or
- copy it with tests and a clear comment that the SDK copy must stay behaviorally aligned with platform.

Validation behavior should converge:

- Match destructive patterns only in executable SQL segments.
- Ignore comments, string literals, and quoted identifier bodies.
- Honor `-- void:allow-destructive` only as a standalone line comment.
- Apply the same pending-only filtering before checking destructive migrations.

SDK and platform should agree on these destructive forms:

- `DROP TABLE`
- `DROP VIEW`
- `DROP INDEX`
- `DROP TRIGGER`
- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... RENAME TO`
- `ALTER TABLE ... RENAME COLUMN`
- SQLite legacy `ALTER TABLE ... RENAME <old> TO <new>`
- `TRUNCATE`
- unbounded `DELETE FROM`
- unbounded `UPDATE ... SET`
- `INSERT OR REPLACE`

This is intentionally stricter than the current SDK behavior because the platform already enforces many of these for remote D1.

Deploy-time enforcement:

- SDK build/CLI validation is the first gate. A stable deploy bundle must not be produced with unauthorized destructive pending migrations.
- The stable worker also carries validation metadata in its migration capabilities: `destructiveValidation: "passed"`, `classifierVersion`, and `migrationListHash`.
- The worker rejects stable app migration execution if its bundled execution plans are missing, hashes do not match, classifier version is unsupported, or build-time validation did not pass.
- The platform does not trust client-supplied metadata for remote apply; it recomputes validation server-side from submitted SQL.
- Old SDK workers that expose only legacy `POST /__void/migrate` cannot prove stable validation. Platform may run them for compatibility, but deploy events/status must mark `migration_protocol: "legacy"` and `migration_stability: "legacy"`.
- A deployment that contains any legacy migration plan, or that runs through the legacy endpoint, is a legacy migration deployment even if it succeeds.

## 6. D1 Atomicity Verification Gate

This RFC depends on D1 atomic execution semantics. Before implementation, verify the exact behavior with tests against the real APIs we use.

Required checks for worker binding `db.batch()`:

- Tracking table setup succeeds before pending migration execution and does not leave a half-created or unreadable `_void_migrations` table.
- Legacy `_migrations` upgrade copies all rows to `_void_migrations` or fails before pending migration execution. A failed upgrade must not continue with an incomplete applied set.
- Concurrent tracking-table setup / legacy upgrade calls either serialize safely or produce one winner and one harmless observer; no caller may drop `_migrations` before its rows are durably copied.
- `CREATE TABLE a; CREATE TABLE b` success commits both and tracking row.
- `CREATE TABLE a; INVALID SQL` rolls back `a` and does not write tracking row.
- `CREATE TABLE a; CREATE INDEX idx ON a(id); INVALID SQL` rolls back table and index.
- `ALTER TABLE a ADD COLUMN x; INVALID SQL` rolls back column addition when wrapped in batch.
- Drizzle SQLite table-rebuild shape with `PRAGMA defer_foreign_keys`, temporary table creation, data copy, drop, rename, and final tracking insert rolls back completely on a later invalid statement.
- Trigger-shaped SQL is either proven to execute as one stable statement when represented in an execution plan or explicitly rejected from stable D1 mode with an actionable error.
- tracking insert failure rolls back user SQL.
- duplicate migration race causes the duplicate tracking insert to fail and roll back that attempt's user SQL, or the duplicate attempt observes the already-recorded row before entering the batch and reports `skipped`.
- unknown-outcome retry behavior does not run two active executions of the same deploy migration attempt concurrently, or proves the second attempt only observes the first attempt's recorded result.

Required checks for D1 REST API:

- Verify the documented `batch` request body against the exact API endpoint and account tokens Void uses.
- Does REST `batch` roll back all prior statements on failure?
- Can parameterized tracking inserts be included in the same REST batch?
- Are there statement count, body size, timeout, or DDL restrictions?
- Does the REST response preserve enough per-statement information to attribute failures without guessing?

If REST cannot provide equivalent semantics, the platform remote path must stay classified as legacy/compensating until a better platform execution method exists.

Current documentation distinction to verify in practice:

- Worker `db.batch()` documentation explicitly describes batched statements as transactional and says the sequence is rolled back on failure.
- REST `/query` documentation describes a `{ batch }` body and semicolon-joined multi-statement SQL executed as a batch, but this RFC must not treat that wording as proof of rollback semantics until Void's own checks confirm it.

## 7. Limits and Fallbacks

Do not auto-chunk one migration across multiple D1 batches. Chunking breaks atomicity.

Documented D1 limits that matter for this design include:

- maximum SQL statement length
- maximum bound parameters per statement
- maximum query duration
- maximum request body size
- maximum statements or practical execution cost per batch, if enforced by the API

The exact values must be rechecked before implementation because Cloudflare may change them. The design must treat the batch duration limit as applying to the whole migration batch, not to each statement independently.

If a breakpoint-framed migration exceeds D1 limits:

- fail before execution when possible
- include the migration name
- explain that schema migrations should be split into multiple migration files
- explain that large data rewrites are outside the stable atomic migration contract and need an explicit legacy/maintenance path
- do not partially apply it

If limit detection is not possible before execution, fail loud and do not mark the migration applied.

Supported stable D1 migrations are schema migrations and small bounded DML migrations that fit inside one D1 atomic operation. Large backfills, table-wide rewrites, and seed/data loads that exceed D1 batch limits are not covered by the strong atomicity guarantee unless they can be represented as one verified D1 batch.

## 8. Transaction Statements and PRAGMAs

D1 migrations should reject or warn on transaction-control statements in stable execution modes:

- `BEGIN`
- `COMMIT`
- `ROLLBACK`
- `SAVEPOINT`
- `RELEASE`

Rationale:

- Void owns the atomic wrapper for stable migration modes.
- User-authored transaction control inside a D1 batch can produce undefined or runtime-specific behavior.

SQLite PRAGMAs should be handled conservatively:

- harmless introspection PRAGMAs are unnecessary in migrations and should be discouraged.
- D1-incompatible PRAGMAs such as `PRAGMA foreign_keys=OFF` should remain documented as unsupported.
- `PRAGMA defer_foreign_keys=on/off` remains the preferred D1-compatible workaround for Drizzle table rebuilds.

SQLite triggers need an explicit stable-mode decision:

- If trigger bodies are supported, the classifier must include fixtures showing semicolons inside `CREATE TRIGGER ... BEGIN ... END` do not split the statement.
- If trigger bodies are not supported, stable D1 mode should reject them and point users to a legacy/maintenance path.

## 9. Rollout Plan

### Phase 0: Verify D1 API Semantics

- Add focused experiments/tests for worker binding `db.batch()`.
- Add focused experiments/tests for D1 REST API `batch` support and rollback behavior.
- Include tracking-table creation, legacy `_migrations` upgrade success/failure/races, Drizzle table-rebuild migrations, `PRAGMA defer_foreign_keys`, trigger-shaped SQL, duplicate plain tracking inserts, tracking insert failures, and unknown-outcome retry scenarios.
- Document the result in this RFC before marking it accepted.

Exit criteria:

- We know which APIs can atomically execute migration SQL plus tracking insert.
- We know the D1 limits that can make a single atomic operation impossible.

### Phase 1: SDK Worker Protocol and Execution Plans

- Port/adapt the shared migration execution-plan classifier into the SDK build/CLI path before serializing plans. This includes tokenizer support needed to classify `single-statement`, `breakpoint-framed`, and `legacy-unsplit-multi-statement` safely.
- Use the same tokenizer-backed pass for deploy-time destructive validation. A worker may advertise protocol v2 only when pending app migrations have passed validation or carry explicit accepted destructive pragmas.
- Apply the same classifier and stable-mode warnings/errors to local SQLite runs for D1-targeted projects before executing with `better-sqlite3`.
- Compute `MigrationExecutionPlan` in the SDK build/CLI path and serialize it into the worker bundle.
- Add `GET /__void/migrate/capabilities`, `POST /__void/migrate/app`, `GET /__void/migrate/app/attempt/:attemptId`, and `POST /__void/migrate/auth`.
- Replace independent per-statement `run()` calls for breakpoint-framed D1 migrations with atomic `batch()`.
- Execute single-statement D1 migrations through `batch([statement, trackingInsert])` too.
- Include a plain `_void_migrations` `INSERT` in the same `batch()` for all stable D1 app migration plans.
- Add app migration attempt tables and the attempt lock/reconciliation protocol.
- Add unambiguous `confirmedApplied` / `confirmedSkipped` response fields plus per-migration protocol-v2 status and stability reporting. Keep legacy `applied` only as compatibility metadata.
- Add tests for plan integrity hashes, statement reconstruction, destructive validation parity fixtures, success, rollback, tracking table setup/upgrade, tracking insert failure, and retry/reconciliation behavior.

Exit criteria:

- A generated worker can advertise protocol v2 capabilities, run app migrations through the stable app endpoint, and run auth through the separate auth endpoint.
- Stable local SQLite preflight agrees with deploy on execution-plan classification and stable-mode rejections.
- Protocol v2 workers advertise `destructiveValidation: "passed"` only after SDK build/CLI validation has accepted the pending migration set.
- Old platforms can still call legacy `POST /__void/migrate`.

### Phase 2: Platform Capability Negotiation and Migration Serialization

- Add worker capability probing after readiness: `GET /__void/migrate/capabilities`.
- Use stable endpoints only when the worker advertises protocol v2, matching `migrationListHash`, supported `classifierVersion`, and `destructiveValidation: "passed"`.
- Fall back to legacy `POST /__void/migrate` only when the worker does not claim protocol v2. Mark the deployment `migration_protocol: "legacy"` and `migration_stability: "legacy"`.
- Fail instead of falling back when the deploy manifest claims protocol v2 but worker capability negotiation fails.
- Add a per-project migration lock around the deploy migration phase, or document a concrete proof that deploy, remote apply, rename, and rollback cannot overlap in ways that mutate or reinterpret one project's migration state.
- Use the same project row lock as `/migrations/apply` unless an advisory lock is chosen for a concrete reason.
- Ensure lock behavior is backwards compatible with cancellation and deployment retries.
- Add `project_migrations`, backfill it, dual-write confirmed migrations, and update rollback/rename/read paths to distinguish current DB truth from deployment snapshots.
- Update deploy so confirmed app migration metadata is persisted before leaving the migration critical section and before auth, queue setup, cancellation checks, or any later post-migration phase can fail.
- Split stable deploy into app migration and auth migration phases.
- Define and implement the app migration attempt/reconciliation protocol before allowing automatic re-entry into app migration execution.

Exit criteria:

- At most one platform-controlled path mutates or reconciles a project's D1 migration state at a time.
- Deploy uses `POST /__void/migrate/app` only after successful worker capability negotiation.
- Deploy does not call `POST /__void/migrate/app` concurrently with `POST /projects/:id/migrations/apply` for the same project.
- A timed-out or unknown-outcome deploy migration dispatch cannot create an overlapping second app migration execution for the same deploy attempt.
- D1 and the project-level migration source of truth stay aligned after post-migration deploy failures.
- Failed deployment rows are not the only place confirmed app migrations are persisted.
- Rollback, rename, remote apply, CLI status, and dashboard reads have a documented read precedence during the dual-write period.
- A Better Auth migration failure cannot erase or hide confirmed app migration results.

### Phase 3: SDK Destructive Validation Hardening

- Remove any remaining raw-regex destructive checks from SDK paths that were not needed for protocol v2 deploy cutover.
- Keep local dev, `void db migrate`, deploy, and platform remote apply on the same fixture suite as new destructive forms are added.
- Keep `-- void:allow-destructive` semantics aligned with platform for legacy and stable paths.

Exit criteria:

- SDK and platform destructive validation continue to agree on the same fixtures after legacy cleanup.

### Phase 4: Platform Remote Runner

If D1 REST supports atomic batch:

- Update `runRemoteMigrations()` to use REST atomic batch for breakpoint-framed and single-statement migrations.
- Include a plain tracking `INSERT` in the same request.
- Add a batch-specific D1 REST helper that returns the full `result` array and preserves per-statement/per-migration metadata. Do not reuse the current single-query helper shape that collapses results to `result[0]`.
- Attribute batch failures to the migration being executed without guessing from a truncated response.
- Keep existing compensating recovery as a fallback only for legacy unsplit migrations.

If D1 REST does not support atomic batch:

- Keep current runner for backwards compatibility.
- Add clear warnings/results for legacy unsplit and REST-limited paths.
- Do not claim stable remote mode. `void db migrate --remote` remains legacy/compensating unless and until a concrete alternate execution path is designed. The active deployed worker is not assumed to contain newly generated local migration SQL, so there is no implicit worker-side fallback in this RFC.

Exit criteria:

- `void db migrate --remote` has a documented stability level that matches implementation reality.
- Stable remote mode is only enabled when SQL plus plain tracking `INSERT` are committed atomically by the chosen execution mechanism. Otherwise the endpoint remains legacy/compensating and outside the stable migration contract.
- The REST batch implementation does not discard batch result entries needed for failure attribution or confirmed-prefix decisions.

### Phase 5: Legacy Multi-Statement Warnings

- Add warning fields to SDK worker migration responses and platform remote migration responses for D1 migrations that appear multi-statement without Drizzle breakpoints.
- Surface deploy-time warnings in platform logs/events so users can see them without inspecting worker internals.
- Add platform deploy fields/events for `migration_protocol: "stable" | "legacy"` and `migration_stability: "stable" | "legacy"`. If any pending migration uses a legacy plan, the whole deployment's migration stability is `legacy`.
- Do not break old clients immediately.
- Introduce explicit `-- void:allow-unsplit-multi-statement` escape hatch.
- Later consider making ambiguous unsplit multi-statement D1 migrations a hard error for new SDK protocol versions.

Exit criteria:

- Users are steered toward stable, breakpoint-framed migrations without breaking existing deployments.

## Backwards Compatibility

### Old SDK to New Platform

Must continue to work.

- Platform accepts `{ migrations }`.
- Platform applies current destructive validation.
- Platform does not require new metadata.
- Platform may return better structured errors, but should preserve existing `ok`, `applied`, `skipped`, and `error` fields.
- Platform computes execution plans server-side for old clients.
- Platform treats any client-supplied execution plan as advisory and validates/recomputes it before use.

### New SDK to Old Platform

Should continue to work where possible.

- New SDK can send old payload shape unless it detects the platform supports newer protocol fields.
- Optional metadata must not be required for correctness.
- New SDK must not rely on old platforms honoring `executionPlans`, warning fields, or auth phase details.

### Existing Deployed Workers

Existing workers already deployed with old SDK runtime code keep their old `/__void/migrate` behavior. Platform cannot patch those workers in place.

Mitigation:

- New deploys bundle the fixed runtime.
- Rollback to an old deployment should not re-run new migrations through old code unless platform rollback flow explicitly invokes migration changes.
- Platform should surface old-runtime limitations in diagnostics where detectable.
- Existing deployed workers cannot return separated auth phase results. Platform must treat missing `auth` fields as legacy runtime behavior.

### Existing Migration Files

Drizzle-generated SQLite/D1 migrations should work unchanged.

Hand-written single-statement migrations should work unchanged.

Hand-written multi-statement D1 migrations without breakpoints:

- continue to work initially
- warn as legacy
- may require escape hatch in a later SDK protocol version

Migration files containing a literal `--> statement-breakpoint` inside strings or comments:

- are unsupported unless build-time classification can prove the marker is executable SQL
- should be rejected with an actionable error instead of being split by the worker runtime

### Local SQLite Compatibility

Local SQLite can still use `better-sqlite3` transactions for execution, but D1-targeted projects must run the stable execution-plan classifier before local execution. If a migration is outside the stable D1 contract, local commands should show the same warning or error that deploy would show. A local-only legacy escape hatch may remain for maintenance work, but it must be labeled as outside stable D1 deploy semantics.

## Performance

Expected improvements:

- SDK worker breakpoint-framed migrations use one D1 `batch()` call instead of one call per statement plus one tracking insert.
- SDK worker single-statement migrations use one D1 `batch()` call instead of two independent operations.
- Less network overhead during deploy migration phase.
- Less retry complexity because SQL and tracking commit together.

Expected costs:

- Tokenizer-backed validation is O(file size), run in CLI/platform contexts.
- Execution-plan serialization slightly increases worker bundle metadata size.
- Breakpoint splitting is O(file size), run in CLI/platform contexts before worker execution.
- Platform migration locks may hold a Postgres connection during migration calls; this already happens for `/migrations/apply`. If added to deploy, measure pool impact.

Performance guardrails:

- No parser in worker runtime.
- No automatic migration chunking.
- Fail early on D1 limits rather than splitting one logical migration across multiple operations.

## Failure Handling

### Supported Breakpoint-Framed D1 Migration Fails

Expected final behavior:

- Atomic operation fails.
- No tracking row is inserted.
- No partial schema changes remain.
- User fixes SQL and retries.

### Supported Single-Statement D1 Migration Fails

Expected final behavior:

- Atomic `batch([statement, trackingInsert])` fails.
- No tracking row is inserted.
- No schema/data change from that statement remains if D1 verified rollback semantics cover the statement shape.
- User fixes SQL and retries.

### Legacy Unsplit Multi-Statement D1 Migration Fails

Expected behavior:

- Migration is not recorded unless recovery is provably safe.
- Error identifies the migration.
- User is told to add breakpoints or manually repair the DB.
- Platform/SDK must not claim no partial changes if the path cannot guarantee that.

### Tracking Insert Fails

In stable paths:

- tracking insert failure rolls back user SQL. This requires a plain `INSERT` in the atomic batch; `INSERT OR IGNORE` is not a stable-path tracking write because it can hide duplicate tracking rows while allowing user SQL to commit.

In legacy paths:

- existing compensating recovery may reconcile single-statement migrations.
- multi-statement reconciliation requires independent proof that another caller recorded the migration.
- otherwise fail loud.

### App Migrations Succeed, Auth Migrations Fail

Expected behavior:

- The app migration phase has already returned `ok: true` with `migrations`, `confirmedApplied`, and `confirmedSkipped`.
- Platform deploy has already persisted confirmed app migrations to the project-level migration source of truth before starting the auth phase.
- The auth endpoint returns `ok: false` or the platform marks auth outcome unknown; neither case can hide app migration confirmation.
- A later retry skips already-recorded app migrations and retries auth migrations.

### App Migrations Succeed, Later Deploy Phase Fails

Expected behavior:

- The platform has already persisted confirmed app migration metadata before the later phase returns failure.
- That metadata is stored in the project-level migration source of truth. Deployment rows may also retain per-deployment snapshots, but they are not the durable current database truth.
- The failed deployment is not routed live unless all deploy phases succeed.
- A later deploy retry observes D1 and the project-level migration source of truth in agreement and skips already-recorded app migrations.

### Migration Dispatch Outcome Unknown

Expected behavior:

- The platform does not blindly send another app migration request while the previous request may still be executing.
- The platform queries the app migration attempt reconciliation endpoint using its platform-generated `attemptId`.
- Any reconciliation reads `_void_migrations` as the source of truth before updating platform metadata.
- If reconciliation cannot prove completion, the deploy attempt fails with a clear "migration outcome unknown, retry after status reconciliation" error.

### Already-Partially-Applied Historical Migration

The system should fail with an actionable message:

- migration name
- detected condition, such as object already exists and no tracking row
- guidance to inspect D1 manually
- guidance to add missing tracking row only after verifying all intended statements landed

Future optional command:

```text
void db doctor
```

This is not required for the first implementation but should remain a follow-up candidate.

## Alternatives Considered

### Full SQL Parser in Worker Runtime

Rejected.

It increases bundle size and still may not match D1 SQLite behavior. It also creates a false sense that Void can safely understand arbitrary SQL.

### Split on Semicolons

Rejected.

Semicolon splitting breaks valid SQL.

### Always Use D1 `exec()`

Rejected as the stable path.

`exec()` is useful for legacy maintenance-style SQL, but does not let Void include the tracking insert in the same prepared atomic unit.

### Use `prepare().run()` For Single Statements

Rejected as a stable path.

Single-statement SQL followed by a separate tracking insert still has the core split-brain failure: SQL can commit while tracking fails. Stable D1 execution uses `batch([statement, trackingInsert])` for single statements too.

### Keep Platform Runner As-Is Forever

Rejected.

The existing platform runner has thoughtful compensating recovery, but it is still a workaround for non-atomic SQL + tracking. It should either be upgraded to atomic execution or explicitly classified as legacy with warnings and limits.

### Move All Remote Migration Execution to Platform

Rejected for this RFC.

The SDK worker path is already the deploy-time path. Moving all execution to platform would be larger and would still need the same atomicity and validation decisions.

### Blindly Retry Unknown Migration Dispatch Outcomes

Rejected.

Retrying propagation failures before the migration handler starts is useful, but retrying after the platform has sent a request that may still be executing can create overlapping migration attempts. Stable retry behavior needs either a confirmed worker response, a worker-side idempotency/lock protocol, or a terminal unknown-outcome failure that an explicit reconciliation flow can heal.

## Open Questions

- D1 REST documents a `batch` request body; does that batch execution have atomic rollback semantics equivalent to worker `db.batch()` for supported migrations and parameterized tracking inserts?
- Does worker binding `db.batch()` roll back all relevant DDL forms used by Drizzle-generated migrations?
- Should deploy migration serialization use the same Postgres project row lock as `/migrations/apply`, or a separate advisory lock with lower pool impact?
- Should old SDK clients receive warnings for legacy unsplit multi-statement SQL through response fields, logs, deploy events, or all three?
- Should the tokenizer live in a shared package, or should SDK copy platform code with fixture parity tests?
- When should ambiguous unsplit multi-statement D1 migrations become a hard error for new SDK protocol versions?
- Should Better Auth SQLite schema synchronization get its own tracking table or remain idempotent untracked schema sync?
- Should the app migration attempt table live in `_void_migration_attempts` inside the user D1 database, or use a differently named internal table to avoid future namespace conflicts?

## Acceptance Criteria

- The RFC records verified D1 batch semantics before implementation is considered accepted.
- SDK shared execution-plan classifier/tokenizer work lands before plan serialization and worker stable execution.
- SDK build/CLI serializes execution plans so the worker runtime does not need tokenizer-backed SQL classification.
- Worker-bundled execution plans include integrity metadata: `sqlHash`, `planHash`, `classifierVersion`, `dialect`, and ordered `migrationListHash`. The worker validates name order, dialect, supported classifier version, and hashes before executing a stable plan.
- SDK worker D1 breakpoint-framed and single-statement app migrations execute SQL and tracking insert atomically.
- Stable paths use plain tracking `INSERT` inside the atomic operation. Duplicate tracking rows abort and roll back the attempted user SQL.
- Platform deploy uses explicit worker capability negotiation. Stable deploy requires worker protocol v2, matching `migrationListHash`, supported classifier version, and `destructiveValidation: "passed"`; otherwise it falls back only to explicitly labeled legacy mode or fails on manifest/capability skew.
- Platform `POST /projects/:id/migrations/apply` only satisfies the stable migration contract if it is upgraded to equivalent atomic execution; otherwise it is explicitly documented as legacy/compensating and outside the stable contract.
- SDK and platform destructive validation agree on shared fixtures.
- Local dev, deploy, and `void db migrate` consistently refuse unauthorized destructive pending migrations.
- Local SQLite for D1-targeted projects runs the same stable execution-plan classifier and warnings/errors before local execution.
- Project migration application is serialized across platform-controlled paths before deploy migration stability is declared.
- Stable deploy uses separate app and auth migration phases; app migration confirmation is persisted before auth starts.
- Unknown app migration outcomes are reconciled through the platform-generated `attemptId` endpoint before retrying or failing.
- Project-level migration metadata has a concrete rollout: schema/backfill, dual-write, read precedence, rollback/rename updates, and exit from deployment-row truth. Current database truth and per-deployment snapshots are separate concepts.
- Deploy persists confirmed app migration metadata to a project-level source of truth after any post-migration deploy failure; failed deployment rows are never the only durable copy.
- Deploy migration retries after unknown outcomes are disabled after execution may have started; reconciliation is attempted through the app migration attempt endpoint instead.
- Client-supplied execution plans are recomputed or strictly validated by the platform before they affect execution.
- REST batch execution uses a helper that preserves all batch result entries needed for failure attribution and confirmed-prefix decisions.
- Phase 0 verification covers tracking-table creation, legacy `_migrations` upgrade success/failure/races, Drizzle table rebuilds, `PRAGMA defer_foreign_keys`, trigger-shaped SQL support/rejection, tracking insert failures, and duplicate/unknown-outcome retry behavior.
- Per-migration and deployment-level stable-vs-legacy reporting is surfaced through response fields, persisted deploy metadata, and deploy logs/events. Any legacy migration plan makes the deployment's migration stability `legacy`.
- Existing SDK clients remain compatible with platform APIs.
- No SQL parser is bundled into the worker runtime.
