# Implementation Plan: Void Builds Service

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Updated:** 2026-06-08
**Status:** Implemented (backend, no UI)

> **Implementation note (2026-06):** This plan shipped its backend, but with
> material divergences. See
> [0010-builds.md → Implementation divergences (2026-06)](./0010-builds.md#implementation-divergences-2026-06)
> for the authoritative summary. Per-step status is annotated inline below.
>
> Quick map of what changed vs this plan:
>
> | Step                          | Status                         | Note                                                                                                                                                                                                                                        |
> | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 1 Schema/types/helpers        | Done (+)                       | Also added `github_installations` table and `github_connections.build_executor` column. Migration is `0027_github_deploy.sql` (re-stamped past 0026 during the #179 routing split); `0028_check_runs.sql` later adds `builds.check_run_id`. |
> | 2 Tiers                       | Done (changed)                 | Limits as written; getBuildInstanceType changed to a two-size model (free -> standard-3, paid -> standard-4), with a second BuildManagerLarge DO at migration tag v6.                                                                       |
> | 3 Refactor deploy pipeline    | **Dropped**                    | No pipeline extraction; `deploy.ts` unchanged. Container runs the real `void deploy` CLI instead.                                                                                                                                           |
> | 4 Platform API routes         | Done (changed)                 | `POST /builds/:id/artifacts` **dropped**. Added `routes/github.ts`, `routes/auth-oidc.ts` (GitHub Actions OIDC), and the `workflow_run` webhook path. Build-token replaced by a scoped deploy-token JWT.                                    |
> | 5 BuildScheduler DO           | Done                           | File is flat at `src/build-scheduler.ts`, not `durable-objects/`.                                                                                                                                                                           |
> | 6 BuildManager DO + Container | Done (changed)                 | File is flat at `src/build-manager.ts`. GitHub helpers split into `src/github/{app-jwt,installation-token,webhook-verify,oidc-verify}.ts` (not `github/token.ts`). Build-token → `auth/deploy-token.ts`.                                    |
> | 7 Wrangler config             | Done                           | Migration tag is **v5**, not v3.                                                                                                                                                                                                            |
> | 8 Build container image       | Done                           | Agent runs `npx void deploy`, not FormData packaging.                                                                                                                                                                                       |
> | 9 Dashboard / admin UI        | Done (admin) / Deferred (user) | Admin Hono-JSX build UI shipped (per-project Builds section + GET /admin/builds/:id with a client-side polling live-log panel, not WebSocket). User-facing Vue dashboard build views remain deferred.                                       |
> | 10 Integration testing        | Done (backend)                 | ~180 tests across new suites.                                                                                                                                                                                                               |
> | 11 Documentation              | Done                           | This annotation + 0010 divergences + progress.md.                                                                                                                                                                                           |
>
> A second executor — **GitHub Actions via OIDC** — was added on top of this
> plan (it was container-only). `void init --github` scaffolds a workflow that
> deploys with no stored secret.

## Context

Void currently requires users to build locally via `void deploy`. This plan implements a remote build service triggered by GitHub push webhooks, running in Cloudflare Containers orchestrated by Durable Objects. The design is documented in `platform/meta/design-docs/0010-builds.md`.

Two deploy paths will coexist:

- **`void deploy`** — build locally, upload artifacts (existing, unchanged)
- **GitHub push** — build remotely on Void infra, deploy automatically

## Critical Files (Existing)

| File                                           | Purpose                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `platform/packages/api/src/routes/deploy.ts`   | Deploy pipeline (provision → migrate → assets → WfP → KV → prerender → cron) |
| `platform/packages/api/src/assets.ts`          | Asset collection, upload sessions, bucket uploads                            |
| `platform/packages/api/src/index.ts`           | Hono app entry, route mounting, `scheduled()` handler, DO exports            |
| `platform/packages/api/src/env.ts`             | `ApiEnv` type with all bindings (Hyperdrive, KV, DO, etc.)                   |
| `platform/packages/api/src/schema.ts`          | Drizzle PostgreSQL schema (users, projects, deployments, resources, domains) |
| `platform/packages/api/src/types.ts`           | Types inferred via `InferSelectModel`, plus `DeployManifest`, `DeployEvent`  |
| `platform/packages/api/src/db.ts`              | All Drizzle query helpers (`generateId`, CRUD functions)                     |
| `platform/packages/api/src/id.ts`              | `generateId(prefix)` — reuse for `bld_` and `ghc_` prefixes                  |
| `platform/packages/api/src/tiers.ts`           | `PlanId`, `PlanLimits`, `PLAN_LIMITS`, `getPlanLimits()`                     |
| `platform/packages/api/src/middleware/auth.ts` | JWT Bearer auth middleware                                                   |
| `platform/packages/api/wrangler.jsonc`         | Worker config (Hyperdrive, KV, DOs, queues, crons)                           |

---

## Step 1: Database Schema + Types + Helpers

### 1a. Drizzle schema

**Edit `platform/packages/api/src/schema.ts`** — add two new tables following existing patterns:

```typescript
import { index, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------
export const builds = pgTable(
  'builds',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<
        'queued' | 'starting' | 'building' | 'deploying' | 'complete' | 'failed' | 'cancelled'
      >(),
    commit_sha: text('commit_sha').notNull(),
    branch: text('branch').notNull(),
    deployment_id: text('deployment_id').references(() => deployments.id),
    error: text('error'),
    exit_code: text('exit_code'),
    instance_type: text('instance_type'),
    started_at: timestamp('started_at', { mode: 'string' }),
    completed_at: timestamp('completed_at', { mode: 'string' }),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_builds_project').on(t.project_id, t.created_at),
    index('idx_builds_status').on(t.status),
    index('idx_builds_user_status').on(t.user_id, t.status),
  ],
);

// ---------------------------------------------------------------------------
// github_connections
// ---------------------------------------------------------------------------
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .unique()
      .references(() => projects.id),
    installation_id: text('installation_id').notNull(),
    repo_full_name: text('repo_full_name').notNull(),
    branch: text('branch').notNull().default('main'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('idx_github_repo').on(t.installation_id, t.repo_full_name)],
);
```

Then run `pnpm db:generate` to auto-generate the migration SQL. This is a safe migration (new tables only — no breaking changes). The `schema-compat` CI job will validate.

### 1b. TypeScript types

**Edit `platform/packages/api/src/types.ts`** — add inferred types (following existing pattern):

```typescript
import type { builds, githubConnections } from './schema';

export type Build = InferSelectModel<typeof builds>;
export type GitHubConnection = InferSelectModel<typeof githubConnections>;
```

### 1c. DB query helpers

**Edit `platform/packages/api/src/db.ts`** — add build + github_connection CRUD using Drizzle query builder (following existing patterns like `createDeployment`, `getProjectDeployments`, etc.):

```typescript
import { builds, githubConnections } from './schema';
import type { Build, GitHubConnection } from './types';

// --- Builds ---

export async function createBuild(
  db: Db,
  projectId: string,
  userId: string,
  commitSha: string,
  branch: string,
): Promise<Build> {
  const id = generateId('bld');
  const [row] = await db
    .insert(builds)
    .values({ id, project_id: projectId, user_id: userId, commit_sha: commitSha, branch })
    .returning();
  return row;
}

export async function getBuild(db: Db, id: string): Promise<Build | null> {
  const [row] = await db.select().from(builds).where(eq(builds.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBuilds(db: Db, projectId: string, limit = 10): Promise<Build[]> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.project_id, projectId))
    .orderBy(desc(builds.created_at))
    .limit(limit);
}

export async function updateBuildStatus(
  db: Db,
  id: string,
  status: Build['status'],
  opts?: {
    error?: string;
    exitCode?: string;
    instanceType?: string;
    startedAt?: string;
    completedAt?: string;
    deploymentId?: string;
  },
): Promise<void> {
  await db
    .update(builds)
    .set({
      status,
      ...(opts && {
        error: opts.error,
        exit_code: opts.exitCode,
        instance_type: opts.instanceType,
        started_at: opts.startedAt,
        completed_at: opts.completedAt,
        deployment_id: opts.deploymentId,
      }),
    })
    .where(eq(builds.id, id));
}

export async function countUserActiveBuilds(db: Db, userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(builds)
    .where(
      and(
        eq(builds.user_id, userId),
        inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
      ),
    );
  return result?.count ?? 0;
}

export async function getQueuedBuilds(db: Db, limit = 50): Promise<Build[]> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.status, 'queued'))
    .orderBy(asc(builds.created_at))
    .limit(limit);
}

export async function getBuildByDeploymentId(db: Db, deploymentId: string): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(eq(builds.deployment_id, deploymentId))
    .limit(1);
  return row ?? null;
}

// --- GitHub Connections ---

export async function createGitHubConnection(
  db: Db,
  projectId: string,
  installationId: string,
  repoFullName: string,
  branch: string,
): Promise<GitHubConnection> {
  const id = generateId('ghc');
  const [row] = await db
    .insert(githubConnections)
    .values({
      id,
      project_id: projectId,
      installation_id: installationId,
      repo_full_name: repoFullName,
      branch,
    })
    .returning();
  return row;
}

export async function getGitHubConnection(
  db: Db,
  projectId: string,
): Promise<GitHubConnection | null> {
  const [row] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export async function getGitHubConnectionByRepo(
  db: Db,
  installationId: string,
  repoFullName: string,
): Promise<(GitHubConnection & { user_id: string }) | null> {
  const [row] = await db
    .select({
      ...getTableColumns(githubConnections),
      user_id: projects.user_id,
    })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .where(
      and(
        eq(githubConnections.installation_id, installationId),
        eq(githubConnections.repo_full_name, repoFullName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteGitHubConnection(db: Db, projectId: string): Promise<void> {
  await db.delete(githubConnections).where(eq(githubConnections.project_id, projectId));
}
```

Admin queries:

```typescript
export async function getAllBuildsWithProject(
  db: Db,
  limit: number,
  offset: number,
): Promise<(Build & { project_slug: string | null })[]> {
  return db
    .select({ ...getTableColumns(builds), project_slug: projects.slug })
    .from(builds)
    .leftJoin(projects, eq(builds.project_id, projects.id))
    .orderBy(desc(builds.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countBuilds(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(builds);
  return result?.count ?? 0;
}
```

### Verify

- `pnpm check` (types compile)
- Write unit tests for the new DB functions in `platform/packages/api/test/`

---

## Step 2: Tier System Update

**Edit `platform/packages/api/src/tiers.ts`:**

Add to `PlanLimits`:

```typescript
/** Max concurrent builds (0 = unlimited) */
concurrentBuilds: number;
/** Max build timeout in minutes (0 = unlimited) */
buildTimeoutMinutes: number;
```

Add to each plan:

| Plan      | `concurrentBuilds` | `buildTimeoutMinutes` |
| --------- | ------------------ | --------------------- |
| free      | 1                  | 10                    |
| solo      | 2                  | 15                    |
| pro       | 3                  | 15                    |
| sponsored | 6                  | 20                    |
| custom    | 0 (unlimited)      | 0 (unlimited)         |

Add helper:

```typescript
export function getBuildInstanceType(plan: PlanId): string {
  const map: Record<PlanId, string> = {
    free: 'standard-1',
    solo: 'standard-1',
    pro: 'standard-2',
    sponsored: 'standard-3',
    custom: 'standard-3',
  };
  return map[plan] ?? 'standard-1';
}
```

### Verify

- `pnpm check`
- Existing tier tests still pass

---

## Step 3: Refactor Deploy Pipeline

> **DROPPED (2026-06).** This step was not done and is not needed. The build
> container runs the **real `void deploy` CLI** with a short-lived scoped token,
> so it reuses the existing deploy endpoint as-is. `deploy.ts` is **unchanged**;
> there is no `deploy-pipeline.ts` and no `POST /builds/:id/artifacts`. The
> premise (a new internal artifacts endpoint re-running the pipeline) was stale:
> the deploy endpoint is now JSON-manifest-only with direct-to-R2 asset upload.
> The rest of this section is retained for historical context only.

Extract the core deploy logic from the `POST /:id/deploy` handler (~818 lines) into a reusable function so both the existing CLI deploy endpoint and the new internal build artifacts endpoint can call it.

**Create `platform/packages/api/src/deploy-pipeline.ts`:**

Extract from `deploy.ts`:

- `runDeployPipeline(env, project, user, formData, manifest, source): Promise<DeployResult>` — the full pipeline from "create deployment record" through "mark live"
- Move shared helper functions that both endpoints need

**Edit `platform/packages/api/src/routes/deploy.ts`:**

- `POST /:id/deploy` becomes: auth check → rate limit check → parse FormData → call `runDeployPipeline()`
- All extracted helpers are imported from `deploy-pipeline.ts`

Note: The deploy pipeline now includes asset preflight dedup, ISR, prerendering, queue consumers, cron sync, and header/redirect rules. All of these must be preserved in the extracted function.

### Verify

- `pnpm check`
- Deploy a playground app with `void deploy` — must still work identically
- Run existing platform tests

---

## Step 4: Platform API Routes

> **CHANGED (2026-06).**
>
> - `POST /builds/:buildId/artifacts` (4b) was **dropped** — see Step 3.
> - The HMAC build-token was replaced by a scoped deploy-token JWT
>   (`auth/deploy-token.ts`, `aud: 'deploy'`, 15-min, project-scoped).
> - GitHub connection routes (4c) live in `routes/github.ts` (split into
>   `githubRoutes` + `githubProjectRoutes`), with `POST/GET/PATCH/DELETE
/projects/:id/github`, plus install-url / installations / callback.
> - A new `routes/auth-oidc.ts` (`POST /auth/github-oidc`) was added for the
>   **GitHub Actions executor**: verify the runner's OIDC token against GitHub's
>   JWKS, create an Actions build row, mint a scoped `VOID_TOKEN`.
> - The webhook handler also handles `workflow_run` (completes Actions builds)
>   and `installation_repositories`; the OAuth callback backfills
>   installation → user.

### 4a. GitHub webhook handler

**Create `platform/packages/api/src/routes/webhooks.ts`:**

`POST /webhooks/github`:

1. Verify HMAC-SHA256 signature using `GITHUB_WEBHOOK_SECRET`
2. Parse event type from `X-GitHub-Event` header
3. For `push` events:
   - Extract `installation.id`, `repository.full_name`, `ref` (branch), `after` (commit SHA)
   - Look up project via `getGitHubConnectionByRepo(db, installationId, repoFullName)`
   - Check branch matches the configured branch
   - Insert build: `createBuild(db, projectId, userId, commitSha, branch)`
   - Poke scheduler DO: `env.BUILD_SCHEDULER.get(env.BUILD_SCHEDULER.idFromName("global")).fetch("/poke")`
4. For `installation` events (installed/uninstalled): log for now, handle later
5. Return 200 OK

**Mount in `index.ts`:**

```typescript
app.route('/webhooks', webhooks); // No auth middleware — uses webhook signature verification
```

### 4b. Build management routes

**Create `platform/packages/api/src/routes/builds.ts`:**

All routes use `authMiddleware` and ownership checks.

- `GET /:id/builds` — list builds for a project (`getProjectBuilds()`)
- `GET /:id/builds/:buildId` — get build status
- `POST /:id/builds/:buildId/cancel` — cancel a build:
  - If queued: update PostgreSQL status to `cancelled`
  - If active: forward cancel to BuildManager DO
- `GET /:id/builds/:buildId/logs` — WebSocket upgrade, proxy to BuildManager DO
- `POST /builds/:buildId/artifacts` — **internal endpoint**, authenticated with build token (not user JWT):
  - Verify build token (HMAC of build ID + secret)
  - Look up build → project → user
  - Parse FormData
  - Call `runDeployPipeline()`
  - Update build status to `complete` or `failed`

**Mount in `index.ts`:**

```typescript
app.use('/projects/*', authMiddleware);
app.route('/projects', builds);
// Internal artifacts endpoint (no user auth — build token auth)
app.post('/builds/:buildId/artifacts', buildArtifactsHandler);
```

### 4c. GitHub connection management routes

Add to `platform/packages/api/src/routes/builds.ts` (or a separate `github.ts`):

- `POST /:id/github` — connect a GitHub repo to a project (stores connection)
- `GET /:id/github` — get current GitHub connection
- `DELETE /:id/github` — disconnect

### 4d. Environment updates

**Edit `platform/packages/api/src/env.ts`:**

```typescript
// Add to Bindings:
BUILD_SCHEDULER: DurableObjectNamespace;
BUILD_MANAGER: DurableObjectNamespace;
GITHUB_APP_ID?: string;
GITHUB_APP_PRIVATE_KEY?: string;
GITHUB_WEBHOOK_SECRET?: string;
```

### Verify

- `pnpm check`
- Test webhook handler with a mock payload (unit test)
- Test build routes with mock data

---

## Step 5: BuildScheduler Durable Object

> **CHANGED (2026-06).** The DO file is **flat** at
> `platform/packages/api/src/build-scheduler.ts`, not in a `durable-objects/` directory.

**Create `platform/packages/api/src/build-scheduler.ts`:**

```typescript
import { DurableObject } from 'cloudflare:workers';
import type { ApiEnv } from '../env';
import { createDb } from '../db';

export class BuildScheduler extends DurableObject<ApiEnv['Bindings']> {
  constructor(ctx: DurableObjectState, env: ApiEnv['Bindings']) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    // POST /poke — wake up and reschedule alarm
    await this.ctx.storage.setAlarm(Date.now() + 100); // immediate tick
    return new Response('ok');
  }

  async alarm() {
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    // 1. Query PostgreSQL for queued builds (ordered by created_at)
    // 2. For each build:
    //    a. Look up user plan → get concurrentBuilds limit
    //    b. Count user's active builds
    //    c. If under limit:
    //       - Update build status to 'starting'
    //       - Get BuildManager DO stub: env.BUILD_MANAGER.get(env.BUILD_MANAGER.idFromName(buildId))
    //       - Call buildManager.startBuild(buildConfig) via RPC
    // 3. If there are still queued builds, reschedule alarm for +2s
    //    (don't reschedule if queue is empty — poke will restart)
  }
}
```

The scheduler only reschedules its alarm when there are queued builds. When the queue empties, it stops polling. The webhook handler pokes it awake when a new build is queued.

### Verify

- Unit test: mock DB queries, verify concurrency enforcement
- Unit test: verify alarm rescheduling logic

---

## Step 6: BuildManager Durable Object + Container

> **CHANGED (2026-06).**
>
> - The DO file is **flat** at `platform/packages/api/src/build-manager.ts` (extends
>   `Container` from `@cloudflare/containers@0.3.3`). Build config/types in
>   `src/build-types.ts`.
> - GitHub crypto helpers were split into `src/github/` — `app-jwt.ts` (RS256
>   App JWT via `jose`), `installation-token.ts` (cached 1h installation token +
>   `generateSourceTarballUrl`), `webhook-verify.ts` (HMAC-SHA256),
>   `oidc-verify.ts` (Actions JWKS verify) — **not** a single `github/token.ts`.
> - "Build token generation" was replaced by `auth/deploy-token.ts`
>   (`signDeployToken` — scoped `aud: 'deploy'` JWT), **not** an HMAC build-token.
> - Container → DO live-log transport is now wired via a DO pull-loop:
>   `pollLogs()` (build-manager.ts) PULLS the agent's `GET /logs?since=N` into
>   the SQLite `logs` table + WS fan-out (~1s, self-terminating), using a
>   non-starting `getTcpPort().fetch()` (not `containerFetch`).

**Create `platform/packages/api/src/build-manager.ts`:**

This is the most complex component. It extends `Container` from `@cloudflare/containers`.

```typescript
import { Container } from '@cloudflare/containers';
import type { ApiEnv } from '../env';
import { createDb, updateBuildStatus } from '../db';

export class BuildManager extends Container<ApiEnv['Bindings']> {
  defaultPort = 4000;
  enableInternet = true;

  // RPC method called by BuildScheduler
  async startBuild(config: BuildConfig) {
    // 1. Store config in DO SQLite
    // 2. Set timeout alarm based on tier
    // 3. Start container with env vars:
    //    BUILD_ID, PROJECT_ID, SOURCE_URL, SOURCE_TOKEN,
    //    BUILD_TOKEN, PLATFORM_URL, DO_URL
  }

  override onStart() {
    // Container ready — update PostgreSQL build status to 'building' via Hyperdrive
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    // updateBuildStatus(db, this.buildId, "building", { startedAt: new Date().toISOString() });
  }

  override onStop({ exitCode, reason }) {
    // Build finished — update PostgreSQL build status via Hyperdrive
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    // updateBuildStatus based on exit code
  }

  override onError(error: string) {
    // Container crashed — mark build as failed in PostgreSQL
  }

  async alarm() {
    // Build timeout — send SIGTERM to container, mark as failed
  }

  // HTTP endpoints (called by container agent)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/logs' && request.method === 'POST') {
      // Receive batched log lines from container
      // Store in DO SQLite, broadcast to WebSocket clients
    }

    if (url.pathname === '/status' && request.method === 'POST') {
      // Receive status updates from container (building → deploying)
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      // Accept WebSocket for log streaming
      // Send buffered logs from DO SQLite, then live-stream
    }

    return new Response('not found', { status: 404 });
  }
}
```

### GitHub App token generation

> **CHANGED (2026-06).** Split into `platform/packages/api/src/github/app-jwt.ts`
> (RS256 App JWT via `jose`) and `installation-token.ts` (cached 1h installation
> token + `generateSourceTarballUrl`), not a single `github/token.ts`.

**Create `platform/packages/api/src/github/{app-jwt,installation-token}.ts`:**

- App JWT signed with the app private key, then `POST /app/installations/{id}/access_tokens` for the cached installation token
- `generateSourceTarballUrl(repoFullName, commitSha)` — Returns `https://api.github.com/repos/{owner}/{repo}/tarball/{sha}`

### Build token generation

> **CHANGED (2026-06).** Replaced by a scoped **deploy-token JWT**
> (`platform/packages/api/src/auth/deploy-token.ts`), not an HMAC build-token. The
> container authenticates `void deploy` with this token; there is no artifacts
> endpoint to authenticate against.

**Create `platform/packages/api/src/auth/deploy-token.ts`:**

- `signDeployToken(...)` — mints a 15-min `aud: 'deploy'`, project-scoped JWT
- `middleware/auth.ts` accepts `aud` `'api'` or `'deploy'`; `routes/deploy.ts` adds a one-line project-scope guard

### Verify

- Unit test BuildManager state machine transitions
- Unit test WebSocket log buffering and replay
- Unit test alarm timeout handling

---

## Step 7: Wrangler Configuration

**Edit `platform/packages/api/wrangler.jsonc`:**

Add to existing `durable_objects.bindings` array (alongside `UsageCounter` and `CronScheduler`):

```jsonc
{
  "name": "BUILD_SCHEDULER",
  "class_name": "BuildScheduler",
},
{
  "name": "BUILD_MANAGER",
  "class_name": "BuildManager",
},
```

Add container definition:

```jsonc
"containers": [
  {
    "class_name": "BuildManager",
    "image": "./container/Dockerfile",
    "max_instances": 50,
  },
],
```

Add DO migration (appended to existing migrations array):

> **CHANGED (2026-06).** The actual tag is **v5** (not v3), applied to
> top-level + `env.production` + `env.staging`.

```jsonc
{
  "tag": "v5",
  "new_sqlite_classes": ["BuildScheduler", "BuildManager"],
},
```

Mirror all changes in the `env.staging` (and `env.production`) section with equivalent config.

**Update exports in `platform/packages/api/src/index.ts`:**

> **CHANGED (2026-06).** Flat paths, not `durable-objects/`.

```typescript
export { BuildScheduler } from './build-scheduler';
export { BuildManager } from './build-manager';
```

Add new secrets (via `wrangler secret put`):

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

### Verify

- `wrangler dev` starts without errors
- DOs are accessible via bindings

---

## Step 8: Build Container Image

**Create `platform/packages/api/container/Dockerfile`:**

```dockerfile
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g bun
COPY build-agent.mjs /build-agent.mjs
EXPOSE 4000
CMD ["node", "/build-agent.mjs"]
```

**Create `platform/packages/api/container/build-agent.mjs`:**

> **CHANGED (2026-06).** The agent does **not** package FormData or POST to an
> artifacts endpoint. It downloads the GitHub tarball, installs deps, and runs
> the **real CLI**: `npx void deploy --project $slug` with `VOID_TOKEN` +
> `VOID_API_URL` in env (the scoped deploy-token). Steps 5–6 below (package
> output / assets-check / POST artifacts) are obsolete. The CLI version is
> pinned (`PINNED_VOID_CLI_VERSION = '0.9.1'`, build-manager.ts), injected as
> the `VOID_CLI_VERSION` build env var; the agent runs `npx --yes void@<ver> deploy`.

The agent script handles the full build lifecycle inside the container:

1. **HTTP server** on port 4000:
   - `GET /` — health check (returns 200)
   - `POST /cancel` — set cancellation flag, SIGTERM child processes

2. **Build pipeline** (runs on startup after server is ready):
   - Read config from env vars (`BUILD_ID`, `PROJECT_ID`, `SOURCE_URL`, `SOURCE_TOKEN`, `BUILD_TOKEN`, `PLATFORM_URL`, `DO_URL`)
   - Download tarball: `curl -sL -H "Authorization: token $TOKEN" "$URL" | tar xz --strip-components=1`
   - Detect package manager from lockfile (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `bun.lock` → bun)
   - Install dependencies
   - Run `npx vite build`
   - Package build output (replicate `packageBuild()` logic — read dist/, build FormData)
   - Check assets delta: `POST /projects/{id}/assets/check` on platform
   - POST FormData to `POST /builds/{id}/artifacts` on platform with build token

3. **Log streaming**: Buffer stdout/stderr, POST to DO every 500ms:

   ```
   POST $DO_URL/logs
   Body: [{ "line": "...", "ts": 1234567890 }, ...]
   ```

4. **Status reporting**: POST to DO on state changes:

   ```
   POST $DO_URL/status
   Body: { "status": "building" | "deploying" }
   ```

5. **Exit**: 0 on success, 1 on failure. The DO's `onStop()` hook handles status updates.

### Verify

- Build the Docker image locally: `docker build -t void-builder platform/packages/api/container/`
- Test the agent with a mock project (mount a test project as volume)

---

## Step 9: Dashboard — Builds Views

> **DEFERRED (2026-06).** The admin Hono-JSX build UI shipped: a per-project
> Builds section (`admin/routes/projects.tsx` + `admin/views/build-table.tsx`)
> and a build detail page `GET /admin/builds/:id` (`admin/routes/builds.tsx`)
> with a client-side polling live-log panel (`admin/views/build-logs.tsx`) —
> not a WebSocket; the DO WebSocket broadcast still has no consumer. The
> user-facing Vue dashboard build views remain deferred. The rest of this
> section is the intended future design.

### 9a. User-Facing Dashboard (`platform/packages/dashboard`)

Build-related pages for end users, following existing Vue Pages patterns:

**Build list page** — shows builds for a project:

- Read-only loader queries `builds` table via Hyperdrive (direct Drizzle queries)
- Table: status badge, branch, commit SHA (truncated, links to GitHub), duration, timestamp
- Auto-refresh for in-progress builds

**Build detail page** — shows build status + logs:

- Status, commit, branch, duration, error (if failed)
- Real-time log viewer via WebSocket to `GET /builds/:id/logs` on the API
- Cancel button (mutation via API HTTP)

**GitHub connection management** — in project settings:

- Connect repo (install GitHub App, store connection via API HTTP)
- Show current connection (repo name, branch)
- Disconnect (mutation via API HTTP)

### 9b. Admin Dashboard (`platform/packages/api/src/admin/`)

Admin builds view for operational visibility, following existing Hono JSX patterns.

**Create `platform/packages/api/src/admin/views/builds-list.tsx`:**

- Paginated table of builds with columns: ID, Project, Branch, Commit, Status, Error, Duration, Created
- Status badges: `complete` → green, `failed` → red, `building`/`deploying` → blue, `queued`/`starting` → gray, `cancelled` → gray
- Commit SHA truncated to 7 chars, links to GitHub commit (if github_connection exists)
- Duration column: `completedAt - startedAt` formatted as "Xs" or "Xm Ys"

**Create `platform/packages/api/src/admin/routes/builds.tsx`:**

`GET /builds` — list page:

- Query `getAllBuildsWithProject()` with pagination
- Render `BuildsListPage`

`GET /builds/:id` — detail page:

- Query `getBuild()` + `getProject()` + `getGitHubConnection()`
- Show: build ID, project link, status badge, commit SHA, branch, instance type, timing
- If `error` is set: show error card (red background, same as deployment error card)
- If `deployment_id` is set: link to `/admin/deployments/:deploymentId`
- Build logs section: fetch logs from BuildManager DO via internal fetch, display in a `<pre>` block

### Modify existing admin views

**Edit `platform/packages/api/src/admin/views/layout.tsx`:**

- Add `<a href="/admin/builds">Builds</a>` to nav bar after Deployments link

**Edit `platform/packages/api/src/admin/routes/deployments.tsx`:**

- In `GET /deployments/:id` detail view, add "Build" row: query `getBuildByDeploymentId()` — if found, link to build; otherwise show "-"

**Edit `platform/packages/api/src/admin/views/dashboard.tsx`:**

- Add build count stat card (alongside existing users/projects/deployments counts via `getSystemStats()` — extend to include builds)

**Mount in `src/index.ts`:**

```typescript
import adminBuilds from './admin/routes/builds';
app.route('/admin/builds', adminBuilds);
```

### Verify

- Navigate to `/admin/builds` — paginated list renders
- Click a build → detail page with status, error, logs
- Navigate to `/admin/deployments/:id` — "Build" row shows link to associated build (or "-")
- Dashboard stat card shows build count
- User dashboard build list and detail pages render correctly

---

## Step 10: Integration Testing

1. **End-to-end with wrangler dev:**
   - Start platform worker with `wrangler dev`
   - Create a project and link a GitHub repo (manually via API)
   - Simulate a webhook push event via curl
   - Verify: build row created → scheduler picks it up → container starts → build runs → artifacts uploaded → deployment live

2. **Unit tests for each component:**
   - Webhook signature verification
   - Build DB helpers (using PGlite test infrastructure)
   - Scheduler concurrency logic
   - BuildManager state machine
   - Build token generation/verification
   - Deploy pipeline extraction (regression test existing deploys)

3. **Verify existing functionality:**
   - `pnpm test` — all existing tests pass
   - `cd playground/spa && pnpm dev` — still works
   - `pnpm lint && pnpm fmt && pnpm check`

---

## Step 11: Documentation

- Update `platform/meta/design-docs/0010-builds.md` status from "Design" to "Implemented"
- Update `platform/README.md`:
  - Add builds system to platform overview
  - Add new secrets to operations reference
  - Update monorepo structure table if new packages added
- Update `platform/packages/api/README.md` with new routes, DOs, container config
- Update `platform/meta/operations.md` with new secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`)

---

## New Files Summary

> **As-shipped (2026-06).** Strikethrough = dropped/deferred; bold = renamed or
> added relative to this plan.

| File                                                                                              | Purpose                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ~~`platform/packages/api/src/deploy-pipeline.ts`~~                                                | **DROPPED** — no pipeline extraction (container runs `void deploy`)        |
| `platform/packages/api/src/routes/webhooks.ts`                                                    | GitHub webhook handler (push / installation / `workflow_run`)              |
| **`platform/packages/api/src/routes/github.ts`**                                                  | **ADDED** — install-url, installations, callback, connect/get/patch/delete |
| **`platform/packages/api/src/routes/auth-oidc.ts`**                                               | **ADDED** — `POST /auth/github-oidc` (GitHub Actions executor)             |
| **`platform/packages/api/src/build-scheduler.ts`**                                                | BuildScheduler DO (**flat**, not `durable-objects/`)                       |
| **`platform/packages/api/src/build-manager.ts`**                                                  | BuildManager DO + Container (**flat**)                                     |
| **`platform/packages/api/src/build-types.ts`**                                                    | **ADDED** — `BuildConfig`, `BuildLogLine`                                  |
| **`platform/packages/api/src/github/{app-jwt,installation-token,webhook-verify,oidc-verify}.ts`** | **RENAMED/SPLIT** — was `github/token.ts`                                  |
| **`platform/packages/api/src/auth/deploy-token.ts`**                                              | **RENAMED** — scoped deploy-token JWT, was `auth/build-token.ts`           |
| `platform/packages/api/container/Dockerfile`                                                      | Build container image                                                      |
| `platform/packages/api/container/build-agent.mjs`                                                 | Build agent script (runs `void deploy`)                                    |
| **`platform/packages/api/src/admin/views/build-table.tsx`**                                       | **ADDED** — per-project Builds table view                                  |
| **`platform/packages/api/src/admin/views/build-logs.tsx`**                                        | **ADDED** — client-side polling live-log panel                             |
| **`platform/packages/api/src/admin/routes/builds.tsx`**                                           | **ADDED** — build detail page + log poll endpoint                          |
| ~~`platform/packages/dashboard/pages/projects/[id]/builds/`~~                                     | **DEFERRED** — no user UI this round                                       |
| `platform/packages/api/drizzle/0027_github_deploy.sql`                                            | **ADDED** — migration (builds, github_connections, github_installations)   |
| `platform/packages/api/drizzle/0028_check_runs.sql`                                               | **ADDED** — migration (builds.check_run_id)                                |
| framework: `.github/workflows/void-deploy.yml` (scaffolded)                                       | **ADDED** — `void init --github` OIDC workflow                             |

## Modified Files Summary

| File                                                      | Changes                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `platform/packages/api/src/schema.ts`                     | Add `builds`, `githubConnections` tables                                                |
| `platform/packages/api/src/types.ts`                      | Add `Build`, `GitHubConnection` inferred types                                          |
| `platform/packages/api/src/db.ts`                         | Add build + github_connection Drizzle query helpers                                     |
| `platform/packages/api/src/tiers.ts`                      | Add `concurrentBuilds`, `buildTimeoutMinutes`, `getBuildInstanceType()`                 |
| `platform/packages/api/src/env.ts`                        | Add DO bindings, GitHub App secrets to `ApiEnv`                                         |
| `platform/packages/api/src/index.ts`                      | Mount webhook/build routes, export DO classes                                           |
| `platform/packages/api/src/routes/deploy.ts`              | **UNCHANGED pipeline** — added a one-line project-scope guard only                      |
| `platform/packages/api/src/auth/jwt` (`signJwt`)          | **ADDED** — optional `{ ttlSeconds }`                                                   |
| `platform/packages/api/src/middleware/auth.ts`            | **ADDED** — accept `aud` `'api'` or `'deploy'`, set `deployScope`                       |
| `platform/packages/api/wrangler.jsonc`                    | Add containers, durable_objects bindings, **v5** migration (top-level + prod + staging) |
| `platform/packages/api/src/admin/views/layout.tsx`        | **MODIFIED** — build-active highlight CSS + Builds surfacing                            |
| `platform/packages/api/src/admin/routes/projects.tsx`     | **MODIFIED** — per-project Builds section                                               |
| ~~`platform/packages/api/src/admin/views/dashboard.tsx`~~ | **DEFERRED** — no build count stat card                                                 |
| framework: `cli/init.ts`, `cli/help.ts`, `docs/*`         | **ADDED** — `void init --github` scaffolding + docs                                     |
