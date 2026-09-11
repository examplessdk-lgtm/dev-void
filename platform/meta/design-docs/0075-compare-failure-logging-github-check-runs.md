---
title: Compare-Failure Logging + GitHub Check Runs for Deploy-on-GitHub Builds (SDD Plan)
status: implemented
created: 2026-06-23
---

# Plan 0075 — Compare-Failure Logging (A) + GitHub Check Runs (B)

This is a subagent-driven-development (SDD) implementation plan. Each "Task N"
section is independently implementable by one subagent. The plan is derived
verbatim from the approved design (Design Doc 0028 synthesis). Do not invent new
scope.

---

## Context

Two features, both in `packages/api`:

- **Feature A — Compare-failure logging.** `getBranchHeadComparisonStatus`
  (`src/github/installation-token.ts:147-186`) collapses five distinct failure
  causes (token-mint throw, network error, 4xx, 5xx-exhausted, retry-exhausted)
  into a silent `string | null`. Add structured `console.warn` JSON logging
  (`area:'github'`) that distinguishes the five causes, and wrap the token mint
  in a try/catch so the documented "never throws" contract holds. **The return
  contract is preserved byte-for-byte** (still returns `null` on every failure,
  same retry count, same delay, same 4xx-vs-5xx semantics). No caller behavior
  changes.

- **Feature B — GitHub Check Runs.** Container builds get a GitHub Check Run
  ("Void Build") created when the build is past all pre-start rechecks and
  finalized at every terminal site (`onStop`, `onError`, `enforceTimeout`,
  `cancelBuild`). The `check_run.id` is persisted on a new additive nullable
  column `builds.check_run_id` and cached in DO storage. The head SHA comes from
  `BuildConfig.commitSha` (= `builds.commit_sha` = webhook `after`) — never from
  a deployment row, which sidesteps the container `commit=NULL` problem. The
  GitHub Actions executor is **explicitly deferred** (the native workflow check
  already covers it); the shared helper is written executor-agnostic so a future
  PR can wire Actions. App `Checks: Write` permission already exists — no
  manifest change.

The container teardown chokepoint across every cancel path
(`cancelContainerBuildDos` in `src/github/cancel-builds.ts`) already funnels into
`BuildManager.cancelBuild()`, so check-run cancellation is finalized in that one
RPC — not scattered across webhook/github routes.

Verified ground truth (all confirmed against current `main`):

| Fact                                                                                                                                                         | Location                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `getBranchHeadComparisonStatus` swallows all failures, returns `string \| null`, never throws                                                                | `src/github/installation-token.ts:147-186`     |
| Retry consts `COMPARE_RETRY_ATTEMPTS=2`, `COMPARE_RETRY_DELAY_MS=250`                                                                                        | `src/github/installation-token.ts:144-145`     |
| `GITHUB_API_BASE`, `GITHUB_API_VERSION='2026-03-10'`, header pattern                                                                                         | `src/github/installation-token.ts:4-5,157-165` |
| `builds.commit_sha` exists (nullable); NO `check_run_id` column                                                                                              | `src/schema.ts:460,440-479`                    |
| Latest migration is idx 27, `0027_github_deploy`, `when:1781253699032`                                                                                       | `drizzle/meta/_journal.json:146-150`           |
| `BuildConfig` carries `buildId, installationId, repoFullName, commitSha, branch, projectId, projectSlug, repositoryId`                                       | `src/build-types.ts:13-34`                     |
| `startBuild` rechecks: freshness (`:181/:202`), coverage (`:235`), cancel (`:258-265`); `signDeployToken` at `:293`, `this.start()` at `:394`                | `src/build-manager.ts:144-394`                 |
| `onStop` exit 0 (`:510-543`) / exit !=0 (`:544-556`); each sets local status then `markBuildTerminalIfActive` in a try/finally that always `pokeScheduler()` | `src/build-manager.ts:483-557`                 |
| `onError` (`:559-585`), `enforceTimeout` (`:628-654`), `cancelBuild` (`:668-697`) — same try/finally pattern                                                 | `src/build-manager.ts:559-697`                 |
| `onStop` already calls `getDeploymentByProjectAndCommit` best-effort (`:523`)                                                                                | `src/build-manager.ts:522-528`                 |
| `cancelContainerBuildDos` is the SINGLE chokepoint → `stub.cancelBuild(reason)`                                                                              | `src/github/cancel-builds.ts:25-43`            |
| `markBuildTerminalIfActive` at `src/db.ts:2298`; `getBuild` at `:2201`; `getDeploymentByProjectAndCommit` at `:3485`                                         | `src/db.ts`                                    |
| App has `Checks: Write` already                                                                                                                              | `meta/operations.md:313`                       |
| Webhook integration tests mock `installation-token.ts` at the module boundary via `vi.mock` → a logging change is invisible to them                          | `test/integration/api-webhooks.test.ts:96-107` |
| GitHub fetch mocking pattern: `vi.stubGlobal('fetch', vi.fn(...))`, unmocked URL throws `Unmocked fetch:`                                                    | `test/integration/api-github.test.ts:178-189`  |
| Existing DO test harness                                                                                                                                     | `test/unit/build-manager.test.ts`              |

---

## Global Constraints

These are binding requirements for every task. Copy them verbatim into each
subagent's brief. (Quoted here verbatim as exact requirements.)

- **behavior-preserving compare (still returns null):** Feature A is
  behavior-preserving — `getBranchHeadComparisonStatus` still returns `null` on
  every failure, with the same retry count, the same delay, and the same
  4xx-immediate-null / 5xx-retry semantics. Only logging (and a contract-honoring
  try/catch around the token mint that converts a latent unhandled rejection into
  the already-documented `null`) is added.
- **check-run writes are BEST-EFFORT (never fail a build/deploy on a GitHub API
  error, always logged):** Check-run create and complete are best-effort. A
  GitHub API error (4xx/5xx/network) must NEVER fail a build or deploy — the
  build starts anyway on a failed create (finalizers no-op on a null
  `check_run_id`), and a failed finalize is swallowed so the `finally { pokeScheduler() }`
  always runs. Every check-run API failure is logged.
- **additive-only schema change (backward compatible; old code tolerates new
  schema during deploy):** The only schema change is one additive nullable
  column `builds.check_run_id text`. It is backward compatible: during a rolling
  deploy old code never references it (inert), and new code tolerates `NULL` on
  pre-existing rows (finalizers no-op). No renames, drops, or type changes.
- **drizzle migration generated + stamped per repo convention (newer timestamp
  than the latest):** The migration is generated with `drizzle-kit` AFTER editing
  `src/schema.ts`, producing `drizzle/0028_check_runs.sql` +
  `drizzle/meta/0028_snapshot.json` + appending idx 28 to
  `drizzle/meta/_journal.json` with a `when` timestamp strictly greater than
  0027's `1781253699032` (auto-satisfied because generation runs after 0027 is on
  `main`; no re-stamp needed). Follow the repo migration convention.
- **App checks:write is the only new GitHub permission used:** `Checks: Write` is
  the only GitHub App permission required, and it is already granted
  (`meta/operations.md:313`). No App manifest/permission change is made.
- **both executors addressed:** Both executors are addressed — Container gets full
  check-run support in this plan; GitHub Actions is explicitly DEFERRED with the
  rationale documented in code + README (the native workflow check already
  covers it), and the shared helper is written executor-agnostic for a future
  Actions PR.
- **commit footer:** Any commit (made by the controller/owner, not the
  subagents) ends with the footer
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **run gates:** After each task and at the end, run
  `vp run --filter ./packages/api typecheck`, `vp fmt --check`, `vp lint`, and
  the relevant `vp test run` suites.
- **do NOT commit or deploy (controller/owner does):** Subagents must NOT commit
  or deploy. The controller/owner performs all commits and deploys.

---

## Task ordering rationale

```
Task 1 (Feature A) ── independent, small, early ──────────────► done
Task 2 (schema + migration) ─┐
Task 3 (check-run helper) ────┴─ land BEFORE lifecycle wiring ─► done
Task 4 (db.ts helper) ───── depends on Task 2 column ─────────► done
Task 5 (build-manager lifecycle wiring) ─ depends on 2,3,4 ───► done
Task 6 (docs) ── independent, can run any time ───────────────► done
```

Schema/migration (Task 2) and the check-run helper (Task 3) land before the
lifecycle wiring (Task 5). Feature A (Task 1) is its own small early task. Tasks
1, 2, 3, 6 are mutually independent. Task 4 needs Task 2's column. Task 5 needs
Tasks 2, 3, 4.

---

## Task 1 — Feature A: compare-failure structured logging

**Goal:** Add structured `console.warn` JSON logging to the five failure points
of `getBranchHeadComparisonStatus`, and wrap the token mint in a try/catch.
Behavior-preserving: still returns `null`/`string`, same retries/delay/4xx-5xx
semantics.

**Files / exact changes** — `src/github/installation-token.ts` (function at
`:147-186`; constants at `:144-145`; base/version/headers at `:4-5,157-165`):

1. Add two module-private helpers above `getBranchHeadComparisonStatus` (keep the
   "no deps" property of this module — do NOT import the deploy logger):

   ```ts
   function errInfo(err: unknown): { name?: string; message: string } {
     if (err instanceof Error) return { name: err.name, message: err.message };
     return { message: String(err) };
   }

   // area:'github' distinguishes from the deploy-pipeline logger (area:'deploy').
   function logCompareFailure(
     reason: 'token-mint-failed' | 'network-error' | 'http-4xx' | 'http-5xx' | 'exhausted',
     fields: Record<string, unknown>,
   ): void {
     try {
       console.warn(
         JSON.stringify({
           ts: Date.now(),
           lvl: 'warn',
           area: 'github',
           phase: 'branch-head-compare',
           msg: `branch-head compare failed: ${reason}`,
           ...fields,
         }),
       );
     } catch {
       console.warn(`branch-head compare failed: ${reason}`);
     }
   }
   ```

2. Inside the existing `for` loop, wrap the token mint (currently `const token =
await getInstallationToken(...)` at `:156`) in its own try/catch. On throw:
   log `token-mint-failed` with `{ installationId, repoFullName, baseSha, branch,
attempt, err: errInfo(err) }`, then fall through to the retry delay and
   `continue` (transient). This converts today's latent unhandled rejection into
   the already-documented `null` return — contract-honoring.

3. On `res.status < 500` (`:175`): before `return null`, read the body
   (`const body = await res.text().catch(() => '<unreadable>');` truncated to 500
   chars) and log `http-4xx` with `{ installationId, repoFullName, baseSha,
branch, attempt, status: res.status, statusText: res.statusText, body }`.
   `return null` unchanged.

4. On `res.status >= 500` (falling through to retry): read the body (truncated to
   500 chars) and log `http-5xx` with `{ ..., status: res.status, body }` before
   the existing fall-through. Behavior unchanged.

5. In the existing `catch {}` (`:178`): bind the error and log `network-error`
   with `{ installationId, repoFullName, baseSha, branch, attempt, err:
errInfo(err) }`. Fall-through unchanged.

6. After the loop, before the final `return null` (`:185`): log `exhausted` with
   `{ installationId, repoFullName, baseSha, branch, attempts:
COMPARE_RETRY_ATTEMPTS + 1 }`.

The success path (`res.ok → return data.status ?? null`) is untouched. Return
type, retry count, delay, and 4xx-immediate-null semantics are preserved.

**Constraints:** behavior-preserving compare (still returns null); do NOT import
the deploy logger (preserve "no deps"); use `console.warn` for all five (matches
existing precedent); do NOT commit/deploy.

**Tests to add** — NEW file `test/unit/installation-token.test.ts` (NOT
integration — the integration suite mocks this whole module via `vi.mock`, so it
cannot exercise the logging). Do NOT `vi.mock('../../src/github/installation-token.ts')`;
import the real function. Use `vi.stubGlobal('fetch', vi.fn(...))` (pattern from
`test/integration/api-github.test.ts:178-189`) and `vi.spyOn(console, 'warn')`.
Drive the access-token POST (`/app/installations/.../access_tokens`) and the
compare GET (`/repos/.../compare/`) separately.

Cases (assert `result === null` AND the right `area:'github'` warn line with the
right `reason`/`status`, unless noted):

| #   | fetch behavior                                | assert                                                                                                           |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | access-token POST → 401                       | `reason:'token-mint-failed'`, returns null, NO compare GET issued                                                |
| 2   | compare GET → 404 + body                      | `reason:'http-4xx'`, `status:404`, body present, returns null, exactly ONE compare GET (no retries on 4xx)       |
| 3   | compare GET → 403 + body                      | `reason:'http-4xx'`, `status:403`                                                                                |
| 4   | compare GET → 500 every time                  | `reason:'http-5xx'` on each attempt + one `reason:'exhausted'`, returns null, THREE compare GETs (1 + 2 retries) |
| 5   | compare GET throws (network) every time       | `reason:'network-error'` ×3 + `reason:'exhausted'`, returns null                                                 |
| 6   | compare GET → 200 `{status:'identical'}`      | returns `'identical'`, ZERO warn lines                                                                           |
| 7   | compare GET → 500 then 200 `{status:'ahead'}` | returns `'ahead'`, one `http-5xx`, NO `exhausted`                                                                |

Assert every failure log includes `installationId, repoFullName, baseSha, branch,
attempt` to lock the schema.

**Verification:**

```
vp run --filter ./packages/api typecheck
vp fmt --check
vp lint
vp test run test/unit/installation-token.test.ts
vp test run test/integration/api-webhooks.test.ts   # regression: callers unchanged
```

---

## Task 2 — Feature B: schema column + drizzle migration

**Goal:** Add the additive nullable `builds.check_run_id` column and generate the
stamped migration.

**Files / exact changes:**

1. `src/schema.ts` — in the `builds` table, after `logs_url: text('logs_url')`
   (`:472`), add:

   ```ts
   // GitHub Check Run id (numeric, stored as text like github_run_id), or NULL.
   // NULL = no check-run was created (Actions builds, builds that failed a
   // pre-create recheck, builds created before this column, or a best-effort
   // create failure). Finalizers no-op when NULL. Additive-only; backward-compat.
   check_run_id: text('check_run_id'),
   ```

   No index in this PR — there is no query that filters by `check_run_id` (always
   looked up via the in-memory `BuildConfig`/row). Document the deferral in the
   comment.

2. Generate the migration with drizzle-kit (the repo's existing generate
   command/script for `packages/api`) AFTER editing the schema. This produces:
   - `drizzle/0028_check_runs.sql` containing exactly:
     ```sql
     ALTER TABLE "builds" ADD COLUMN "check_run_id" text;
     ```
   - `drizzle/meta/0028_snapshot.json`
   - an appended idx-28 entry in `drizzle/meta/_journal.json` with a `when`
     timestamp `> 1781253699032` (auto-satisfied; no re-stamp needed because 0027
     is already on `main`).

   If the generator emits a different random tag than `0028_check_runs`, rename
   the SQL + snapshot + journal `tag` to `0028_check_runs` to match the design's
   filename, keeping the generated `when`.

**Constraints:** additive-only schema change (backward compatible; old code
tolerates new schema during deploy); drizzle migration generated + stamped per
repo convention (newer timestamp than the latest); do NOT hand-edit the `when`
to a fake value — use the generated one; do NOT commit/deploy.

**Tests:** No new test file for the column alone. Verify the migration applies
against the test harness DB (PGlite) by running an existing builds-touching suite
(below) — a malformed migration breaks setup loudly.

**Verification:**

```
vp run --filter ./packages/api typecheck
vp fmt --check
vp lint
vp test run test/integration/db-builds.test.ts
```

Also confirm the journal ordering by hand: idx 28 `when` > `1781253699032`.

---

## Task 3 — Feature B: GitHub check-run helper module

**Goal:** New `src/github/check-run.ts` with `createCheckRun` and
`completeCheckRun`, mirroring `installation-token.ts` conventions (same base/
version/headers, same `getInstallationToken`, same retry-5xx-not-4xx shape).
Both are best-effort and NEVER throw.

**Files / exact changes** — NEW `src/github/check-run.ts`:

- Reuse `GITHUB_API_BASE`, `GITHUB_API_VERSION`, header pattern, and
  `getInstallationToken` from `installation-token.ts` (import them; if
  `GITHUB_API_BASE`/`GITHUB_API_VERSION` are not exported, export them or
  re-declare matching constants — keep them identical to `:4-5`).
- Reuse the same retry shape as `getBranchHeadComparisonStatus`: up to
  `COMPARE_RETRY_ATTEMPTS` (2) extra attempts with `COMPARE_RETRY_DELAY_MS` (250)
  delay on transient 5xx/network; do NOT retry 4xx.
- Reuse the Feature-A `area:'github'` JSON warn shape for every failure (phase
  `check-run-create` / `check-run-complete`). On permanent failure return
  `null` / `false`.

```ts
export type CheckRunConclusion = 'success' | 'failure' | 'cancelled';

// POST /repos/{owner}/{repo}/check-runs  → returns numeric id as string, or null on failure.
export async function createCheckRun(
  env,
  installationId,
  repoFullName,
  opts: {
    name: string; // 'Void Build'
    headSha: string; // BuildConfig.commitSha
    externalId: string; // buildId (dedupe / audit)
    detailsUrl?: string;
    title: string;
    summary: string; // output.{title,summary}
  },
): Promise<string | null>;

// PATCH /repos/{owner}/{repo}/check-runs/{checkRunId}  → returns boolean ok.
export async function completeCheckRun(
  env,
  installationId,
  repoFullName,
  checkRunId: string,
  opts: {
    conclusion: CheckRunConclusion;
    detailsUrl?: string;
    title: string;
    summary: string;
  },
): Promise<boolean>;
```

Behavior:

- Create body: `status: 'in_progress'` (no `queued` — the build is already past
  the queue), `head_sha`, `external_id`, optional `details_url`, `output:
{ title, summary }`. Parse `id` from the response and return it as a string.
- Complete body (PATCH): `status: 'completed'`, `conclusion`, optional
  `details_url`, `output: { title, summary }`. Return `true` on `res.ok`.
- `external_id = buildId` gives create idempotency + audit (a redelivery reusing
  the same build row → same `external_id` → same logical run).
- `name = 'Void Build'` distinct from any native workflow check.
- Never throw: catch network errors, retry transient, log every failure, return
  `null`/`false` on permanent failure.

**Constraints:** check-run writes are BEST-EFFORT (never throw; always logged);
App checks:write is the only new GitHub permission used (already granted — no
manifest change); helper must stay executor-agnostic (both executors addressed —
Actions deferred); do NOT commit/deploy.

**Tests to add** — NEW unit test (e.g. `test/unit/check-run.test.ts`) mirroring
Feature A's fetch-stub style (`vi.stubGlobal('fetch')`, real module, no mock):

| case                             | assert                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| create: POST → 201 `{id: 99001}` | returns `'99001'`, body has `status:'in_progress'`, `head_sha`, `external_id`, `name:'Void Build'` |
| create: POST → 404               | returns `null`, exactly ONE POST (no retry on 4xx), one `check-run-create` warn                    |
| create: POST → 500 ×3            | returns `null`, THREE POSTs, `http-5xx` ×3 + `exhausted` warn                                      |
| complete: PATCH → 200            | returns `true`, body has `status:'completed'`, `conclusion`                                        |
| complete: PATCH → 500 ×3         | returns `false`, one `exhausted` warn                                                              |
| token-mint throws                | returns `null`/`false`, never throws                                                               |

**Verification:**

```
vp run --filter ./packages/api typecheck
vp fmt --check
vp lint
vp test run test/unit/check-run.test.ts
```

---

## Task 4 — Feature B: db.ts `setBuildCheckRunId` helper

**Goal:** Add a small unguarded UPDATE helper to persist `check_run_id`.

**Files / exact changes** — `src/db.ts`, near `markBuildTerminalIfActive`
(`:2298`):

```ts
export async function setBuildCheckRunId(db: Db, id: string, checkRunId: string): Promise<void> {
  await db.update(builds).set({ check_run_id: checkRunId }).where(eq(builds.id, id));
}
```

Unguarded by status: the create happens right before container start and the only
writer of a given build's `check_run_id` is its own DO, so no
`updatedRowCount`/CAS check is needed. (`builds` and `eq` are already imported in
`db.ts`.)

**Constraints:** additive-only schema change consumer; do NOT commit/deploy.
Depends on Task 2's column existing.

**Tests:** Covered by Task 5's lifecycle test (asserts `builds.check_run_id ==
'99001'` after create). No standalone test required, but if convenient add a unit
case to `test/integration/db-builds.test.ts` that inserts a build, calls
`setBuildCheckRunId`, and reads it back.

**Verification:**

```
vp run --filter ./packages/api typecheck
vp fmt --check
vp lint
vp test run test/integration/db-builds.test.ts
```

---

## Task 5 — Feature B: BuildManager check-run lifecycle wiring (container)

**Goal:** Create the check-run after all pre-start rechecks pass, store the id in
Postgres + DO storage, and finalize it at every terminal site. All best-effort.

**Files / exact changes** — `src/build-manager.ts`:

1. Add a storage-key const near the others (`:27`):

   ```ts
   const STORAGE_KEY_CHECK_RUN = 'checkRunId';
   ```

   Import `createCheckRun`, `completeCheckRun`, `type CheckRunConclusion` from
   `./github/check-run.ts`, and `setBuildCheckRunId` from `./db.ts`.

2. **Create** — inside `startBuild`, AFTER the cancel recheck passes (`:265`) and
   BEFORE the staging-misconfig check / `signDeployToken` (`:277`/`:293`). All
   pre-create rechecks have passed, so this build WILL start. **Locate the site by
   structure, not by the line numbers above — they drift; the anchor is "right
   after the `getBuild`/`row.status !== 'starting'` cancel recheck returns".**

   Two guards on creation:

   - **Idempotent reuse across requeue:** a capacity-to-start error
     (`isContainerCapacityError`) re-throws WITHOUT terminalizing, the scheduler
     re-queues the build, and it re-invokes `startBuild` on the SAME DO — which
     would POST a SECOND `Void Build` check-run. So FIRST read any check-run id
     already in DO storage and reuse it; only create when absent. (The DO storage
     write below persists across the requeue.)
   - **SHA guard:** `config.commitSha` is `build.commit_sha ?? ''`
     (`build-scheduler.ts:192`) — the standard webhook path always supplies the
     non-empty webhook `after`, but a NULL `commit_sha` coalesces to `''`, and a
     check-run POST with `head_sha: ''` is a guaranteed GitHub 422. So SKIP creation
     when the SHA is empty (no check-run to orphan; finalizers no-op on the absent id).

   ```ts
   let checkRunId = await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN);
   if (!checkRunId && config.commitSha) {
     checkRunId = await createCheckRun(this.env, config.installationId, config.repoFullName, {
       name: 'Void Build',
       headSha: config.commitSha,
       externalId: config.buildId,
       detailsUrl: `https://${config.projectSlug}.void.app`,
       title: 'Void build in progress',
       summary: `Building \`${config.branch}\` @ ${config.commitSha.slice(0, 7)}`,
     });
     if (checkRunId) {
       await this.ctx.storage.put<string>(STORAGE_KEY_CHECK_RUN, checkRunId); // input-gated DO cache
       try {
         await setBuildCheckRunId(this.db(), config.buildId, checkRunId); // durable, ops-visible
       } catch (err) {
         console.warn('startBuild: persisting check_run_id failed (DO cache retains it)', err);
       }
     }
   }
   ```

   On `null` (create failed, or empty SHA, or a transient create failure on a
   prior requeue attempt) the build starts anyway and finalizers no-op. The DO
   storage write is the input-gated source of truth for finalizers; the DB write
   is best-effort (per memory `DO KV/DB awaits aren't input-gated`). A transient
   create failure that returns `null` is NOT stored, so a later requeue attempt
   retries the create — desirable.

3. Add a DO-private `finalizeCheckRun` method:

   ```ts
   private async finalizeCheckRun(
     config: BuildConfig,
     conclusion: CheckRunConclusion,
     opts: { detailsUrl?: string; title: string; summary: string },
   ): Promise<void> {
     const checkRunId = await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN);
     if (!checkRunId) return; // no check-run created → no-op
     try {
       await completeCheckRun(this.env, config.installationId, config.repoFullName, checkRunId, {
         conclusion, ...opts,
       });
     } catch (err) {
       console.warn('finalizeCheckRun: best-effort PATCH failed', err); // never throw
     }
   }
   ```

   (`completeCheckRun` already swallows internally; the extra try/catch is
   belt-and-suspenders so the callers' `finally { pokeScheduler() }` always runs.)

   **Why finalize at EVERY terminal site (and why this does NOT double-PATCH):**
   every force-stop path (`enforceTimeout`, `cancelBuild`, and `startBuild`'s catch)
   sets the LOCAL terminal status via `setStatus(...)` BEFORE calling
   `forceStopContainer()`. `forceStopContainer` → `destroy()` triggers `onStop`, but
   `onStop`'s `TERMINAL_STATUSES.includes(current)` guard (`build-manager.ts:493`)
   makes it a no-op (it only pokes the scheduler) — so `onStop` will NOT finalize the
   check-run on any force-stop path. Therefore finalize MUST be called explicitly at
   each terminal site; `onStop` only finalizes on a genuine, unforced container exit.
   There is consequently no double-PATCH, so do NOT add extra de-dupe guards.

4. **Finalize success** — `onStop` exit-0 branch, inside the existing `try` after
   `markBuildTerminalIfActive(...'complete'...)` and `broadcast` (`:540`), before
   the `finally`:

   ```ts
   await this.finalizeCheckRun(config, 'success', {
     detailsUrl: `https://${config.projectSlug}.void.app`,
     title: 'Void build succeeded',
     summary: deploymentId ? 'Deployment is live.' : 'Build complete.',
   });
   ```

   The success `details_url` comes from `projectSlug` (already in hand), so a
   deployment-lookup miss does NOT cost the link.

5. **Finalize failure** — same shape (`conclusion: 'failure'`) inside the
   existing `try` of:
   - `onStop` exit-!=0 (`:552`): `summary` mentions the exit code; `detailsUrl`
     = `config.logsUrl ?? https://${config.projectSlug}.void.app`.
   - `onError` (`:581`): `summary` = the error message; same fallback URL.
   - `enforceTimeout` (`:649`): `summary: 'build timed out'`; same fallback URL.
   - **`startBuild`'s own catch — the NON-capacity branch ONLY** (`build-manager.ts`
     ~`:448-456`, the `try` that does `markBuildTerminalIfActive(...'failed'...)` +
     `broadcast`, before its `finally { pokeScheduler() }`). This site is REQUIRED,
     not optional: the check-run is created BEFORE `signDeployToken`/`this.start()`/
     the staging-misconfig check, so a throw in that window (token mint, container
     start, schedule arming, staging misconfig) marks the build `failed` here and NO
     `onStop` ever finalizes it (force-stop → terminal-status guard no-op) — without
     finalizing here the check-run is stranded `in_progress` forever. `summary` = the
     error message; same fallback URL. Place it AFTER the `broadcast`, inside the same
     `try`, so the `finally { pokeScheduler() }` still always runs (finalize is
     best-effort and never throws).
     **Do NOT finalize in the capacity-error branch** (`if (isContainerCapacityError(error)) { throw error }` at ~`:417-421`, which returns before the terminal write): that build is REQUEUED and re-runs `startBuild`, reusing the same check-run (idempotent create) — it correctly stays `in_progress` across the requeue. Putting the finalize next to `markBuildTerminalIfActive('failed')` naturally excludes the capacity path, which never reaches it.

   Use `builds.logs_url` if available on the config; container `logs_url` is often
   null today, so fall back to the dashboard URL `https://${config.projectSlug}.void.app`.

6. **Finalize cancelled** — `cancelBuild`, inside the existing
   `if (shouldTerminalize)` block after `markBuildTerminalIfActive(...'cancelled'...)`
   and `broadcast` (`:691`):

   ```ts
   await this.finalizeCheckRun(config, 'cancelled', {
     title: 'Void build cancelled',
     summary: reason,
   });
   ```

   Only when `shouldTerminalize` (a late cancel against an already-terminal row
   must not re-PATCH and clobber the recorded outcome). `config` is non-null in
   that branch (`shouldTerminalize` requires `config != null`).

   Do NOT touch the two in-DO `startBuild` cancel branches (non-identical `:202`,
   uncovered `:235`): they occur BEFORE check-run creation, so there is nothing
   to finalize and they create no check-run.

**Constraints:** check-run writes are BEST-EFFORT (never fail a build/deploy on a
GitHub API error, always logged); both executors addressed (container here;
Actions deferred — do NOT wire the Actions paths in `auth-oidc.ts` /
`webhooks.ts`); commit footer applies to the controller's commit; do NOT
commit/deploy. Depends on Tasks 2, 3, 4.

**Tests to add** — NEW `test/integration/api-check-runs.test.ts` driving
`BuildManager` directly (reuse the harness from `test/unit/build-manager.test.ts`).
Use `vi.stubGlobal('fetch', vi.fn(...))` matchers:

- `POST …/check-runs` → `Response.json({ id: 99001, status: 'in_progress' }, { status: 201 })`, record call + captured body.
- `PATCH …/check-runs/99001` → `Response.json({ id: 99001, status: 'completed' })`, record call + captured body.
- access-token POST → `{ token: 'tok', expires_at }`.

| Scenario                                                                  | Assert                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| startBuild all-rechecks-pass                                              | one `POST /check-runs` with `head_sha == commitSha`, `external_id == buildId`, `name == 'Void Build'`, `status == 'in_progress'`; `builds.check_run_id == '99001'` |
| startBuild freshness null/non-identical (`:181`/`:202`)                   | NO POST; `check_run_id` stays NULL                                                                                                                                 |
| startBuild uncovered (`:235`)                                             | NO POST; NULL                                                                                                                                                      |
| onStop exit 0                                                             | one `PATCH …/99001` with `conclusion:'success'`, `details_url == 'https://{slug}.void.app'`                                                                        |
| onStop exit 1                                                             | `PATCH` `conclusion:'failure'`, summary mentions exit code                                                                                                         |
| onError                                                                   | `PATCH` `conclusion:'failure'`                                                                                                                                     |
| enforceTimeout                                                            | `PATCH` `conclusion:'failure'`, summary `'build timed out'`                                                                                                        |
| cancelBuild (active row)                                                  | `PATCH` `conclusion:'cancelled'`, summary == reason                                                                                                                |
| cancelBuild (already-terminal row)                                        | NO PATCH (no clobber)                                                                                                                                              |
| create returns 500 ×3                                                     | build still starts (container start invoked), `check_run_id` NULL, finalizers no-op (no PATCH), one `area:'github'` warn                                           |
| PATCH returns 500 in onStop                                               | build still finalized terminal, `pokeScheduler` still called (assert via existing scheduler-poke spy), error logged, no throw                                      |
| 4xx on create                                                             | no retry (exactly one POST), NULL stored                                                                                                                           |
| startBuild throws AFTER create (non-capacity, e.g. `this.start()` throws) | build `failed` via the catch; exactly one `PATCH …/99001` `conclusion:'failure'`; `pokeScheduler` still called; no `in_progress` left stranded                     |
| startBuild capacity error AFTER create, then re-run (requeue)             | first run: one POST, NO PATCH (capacity re-throw doesn't finalize); second `startBuild` reuses the DO-stored id → NO second POST; total exactly ONE POST           |
| redelivery (same commit)                                                  | `supersedeAndCreateContainerBuild` returns the reused build → only one build, one POST total                                                                       |

**Verification:**

```
vp run --filter ./packages/api typecheck
vp fmt --check
vp lint
vp test run test/integration/api-check-runs.test.ts
vp test run test/unit/build-manager.test.ts
vp test run test/integration/db-builds.test.ts
```

---

## Task 6 — Docs: Actions deferral, Checks:Write note, details_url convention

**Goal:** Document the scope cut and conventions. Docs only.

**Files / exact changes:**

- `packages/api/README.md` (Deploy-on-GitHub section, around the build-executor
  description, ~`:155-165`): note that container builds publish a "Void Build"
  GitHub Check Run; that GitHub Actions check-runs are deferred (the native
  workflow check already covers them) and the helper is executor-agnostic for a
  future PR; that `details_url` is `https://{projectSlug}.void.app` (success /
  fallback) or `logs_url` (failure when set); that `Checks: Write` is already
  granted and no permission change was needed; that `check_run_id` has no index
  (no query filters by it — deferred).
- `meta/operations.md` (near the GitHub App permissions list, `:306-318`): a
  one-line note that `Checks: Write` (`:313`) is now exercised by container
  check-runs.

**Constraints:** docs only; do NOT commit/deploy.

**Verification:** `vp fmt --check` (markdown formatting), visual read-through. No
test run.

---

## Adversarial self-check resolution (carried from design)

| #   | Concern                                                       | Resolution                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | head_sha source (container commit=NULL)                       | SHA = `BuildConfig.commitSha` = `builds.commit_sha` = webhook `after`. Never read from deployment. No new column for it.                                                                                                                                                                                    |
| 2   | backward-compat / generate+stamp                              | Single additive nullable `text` column; old code inert, new code tolerates NULL; generate after 0027 → `when` auto-newer, no re-stamp.                                                                                                                                                                      |
| 3   | idempotency (retry/supersede/cancel — no stuck `in_progress`) | retry reuses `external_id`; cancel funnels through `cancelBuild` → PATCH cancelled; a cancel landing DURING the create POST is caught by the post-create recheck in `startBuild` (re-reads the row, finalizes to its recorded outcome, skips the container) — NOT by `onStop`, whose terminal guard no-ops. |
| 4   | executor coverage                                             | Container full; Actions explicitly deferred with documented rationale; helper executor-agnostic for the future PR.                                                                                                                                                                                          |
| 5   | details_url + how URL is known                                | `https://{projectSlug}.void.app` from in-hand `BuildConfig` (no lookup/column) at EVERY finalize site incl. failure; `cancelBuild` omits it. No `logs_url` use.                                                                                                                                             |
| 6   | failure isolation                                             | helper never throws; create wrapped (start proceeds on null); finalize swallowed inside the try whose `finally` always pokes scheduler.                                                                                                                                                                     |
| 7   | permission                                                    | `Checks: Write` already granted (`operations.md:313`); no manifest change.                                                                                                                                                                                                                                  |
| 8   | test strategy                                                 | Feature A: real-module unit test + `console.warn` spy + fetch stub. Feature B: `vi.stubGlobal('fetch')` lifecycle assertions on the DO + helper unit test.                                                                                                                                                  |

### Residual risks (controller, read before execution)

- **create-vs-cancel interleave window (CLOSED in the fix wave):** a `cancelBuild`
  that interleaves during the create POST runs its own finalize before the id is
  stored (no-op). The original plan assumed the subsequent `onStop` would re-PATCH
  `cancelled` — that is FALSE: every force-stop path sets the local terminal status
  before `forceStopContainer()`, so `onStop` hits the `TERMINAL_STATUSES` guard and
  no-ops. The fix closes it directly: after the create+store, `startBuild` re-reads
  the authoritative row and, if no longer `starting`, finalizes the just-created run
  to the recorded outcome (`finalizeCheckRunToStatus`) and returns WITHOUT starting a
  container. Companion hardening: every terminal site is now CAS-aware — on a lost
  `markBuildTerminalIfActive`, it finalizes to the actual recorded DB status, so the
  check-run never contradicts the DB. `ctx.storage.put` for the create write is
  wrapped best-effort so a cache-write rejection can't fail the build.
- **DO-storage-miss finalize fallback (CLOSED in the fix wave):** finalizers read
  the run id from input-gated DO storage, but a miss (eviction, a rejected cache
  put, transient loss) used to strand an already-created run `in_progress` because
  nothing read the persisted `builds.check_run_id`. `finalizeCheckRun` now falls back
  to that column (best-effort, caught) when DO storage is empty; the lost-CAS branch
  reads the authoritative status through `finalizeCheckRunToRecordedOutcome`, which
  wraps its `getBuild` so a transient read can neither skip the PATCH nor propagate
  out of a terminal handler. The persisted column is now load-bearing, not write-only.
- **cancel-before-`this.start()` window (PRE-EXISTING, bounded — NOT fixed here):** a
  cancel landing AFTER the post-create recheck but during the token-mint awaits can
  let `startBuild` launch a container for a DB-cancelled build. This window predates
  the check-run feature. It is benign: the deploy token is gated on
  `builds.status ∈ ACTIVE` at three layers (auth middleware, the deploy handler's
  up-front guard, and a FOR-UPDATE recheck inside the deploy transaction), so a
  cancelled build's container cannot deploy; `enforceTimeout` + `cancelBuild`'s
  force-stop + the stale-build reaper bound the orphan. Left as-is per owner decision
  (re-fixing a pre-existing bounded class is out of scope for 0075).
- **Actions executor has NO check-run** in this plan (deferred). If product later
  wants an Actions check, the helper is ready; wire at `auth-oidc.ts:261` (create)
  - `webhooks.ts:789` (finalize) with `name:'Void Deploy'` and `external_id =
projectId:runId:runAttempt`.
- **`details_url` is always the project dashboard URL** (`https://{slug}.void.app`)
  at create/success/failure; `cancelBuild` omits it. There is no `logs_url` wiring
  here — acceptable per the README follow-up about container→DO log streaming not
  yet wired.
