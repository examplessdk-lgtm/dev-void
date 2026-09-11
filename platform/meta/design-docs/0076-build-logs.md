---
title: Build Logs
status: implemented
created: 2026-07-02
---

# Plan 0076 — Build Logs

This doc covers the two build-log surfaces for Deploy-on-GitHub **container** builds, both fronting the same BuildManager DO SQLite `logs` store:

- **Part A — `void build logs` CLI** (shipped via void-platform#211 + void#244)
- **Part B — build-log tail in the "Void Build" check run** (shipped via void-platform#224)

## Part A — `void build logs`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give project owners a CLI command (`void build logs`) to view, live-tail, and download the build logs of their Deploy-on-GitHub **container** builds — logs that today are only reachable through the internal `/admin/*` UI.

**Architecture:** Two new **owner-guarded** API routes on the `packages/api` `projects` router front the existing BuildManager Durable Object `GET /logs?since=N` store (exactly as the admin route does, but with user auth + a project-ownership check). A new top-level `void build` command group in the framework CLI (`framework/packages/void`) adds the `logs` subcommand: it resolves the project, resolves the latest build (or an explicit id), prints captured lines, and — with `-f` — polls the logs endpoint until the build reaches a terminal status. `github_actions` builds have no DO log store and instead print their GitHub Actions link.

**Tech Stack:** Hono (`packages/api`), Drizzle/PGlite tests, Cloudflare Durable Objects; framework CLI is plain TypeScript run on Node with `@clack/prompts`; Vite+ (`vp`) toolchain; oxfmt/oxlint.

## Global Constraints

These bind **every** task. Exact values, copied verbatim from the approved design.

- **Repo split.** API routes + their tests live in the **platform repo** (`packages/api`, committed at repo root). CLI + docs live in the **framework submodule** (`framework/packages/void`, committed inside `framework/`). **Do NOT bump the framework submodule pointer** (see memory `feedback_framework_pointer.md` — local pointer state is intentional). **Do NOT push, open a PR, or merge to `main`** without explicit user confirmation.
- **Logs response envelope (BOTH branches identical shape):** `{ lines: Array<{ seq: number; line: string; stream: 'stdout' | 'stderr'; ts: number }>, lastSeq: number, status: string, terminal: boolean, external: string | null }`.
- **List response envelope:** `{ builds: BuildSummary[] }` where `BuildSummary` = `{ id, status, executor, commit_sha, branch, exit_code, error, logs_url, created_at, started_at, completed_at }` (explicit map — never spread the raw DB row; do not leak `user_id`, `check_run_id`, `github_run_id`, `github_run_attempt`, `deployment_id`, `instance_type`).
- **Build status values:** `'queued' | 'starting' | 'building' | 'deploying' | 'complete' | 'failed' | 'cancelled'`. **Terminal = `complete`, `failed`, `cancelled`.**
- **Owner guard form (mirror `GET /projects/:id/logs`):** `getProject(db, id)` → `404 { error: 'project not found' }` if null → `403 { error: 'forbidden' }` if `project.user_id !== context.get('user').id`. For the logs route, after that: `getBuild(db, buildId)` → `404 { error: 'build not found' }` if null **or** `build.project_id !== project.id`.
- **DO fronting (mirror `admin/routes/builds.tsx`):** `buildManagerNamespace(context.env, build.instance_type)` → `ns.get(ns.idFromName(build.id))` → `stub.fetch(\`http://manager/logs?since=${since}\`)`. `since`: `const raw = Number(query('since')); const since = Number.isFinite(raw) ? raw : 0;`. Only container builds touch the DO.
- **Poll cadence:** `1000` ms. The DO retains only the **last 10 000** lines (older lines of a huge build are gone; `since=0` returns what is retained) — note this in the CLI help/docs, do not try to work around it.
- **CLI flags:** `[buildId]` optional positional; `-f`/`--follow` (boolean); `-o`/`--output <file>` (value); `-p`/`--project <slug>` (value). Unknown `-`-prefixed arg → throw; a second positional → throw. Project resolution order: `--project`/positional slug → `VOID_PROJECT` → linked `.void/project.json`.
- **Formatting:** oxfmt uses **single-quote** strings. Run `vp fmt` + `vp lint` before a task is done (memory `feedback_run_fmt_lint_before_push.md`).
- **Commands run from the right root.** Platform (`packages/api`) tests: from `packages/api`, `vp test run test/integration/<file>`. Framework tests: from the `framework/` submodule root, `vp test run packages/void/test/unit/<file>`. Typecheck: `vp run check` in the respective repo.

---

## File Structure

**Platform repo (`packages/api`):**

- Create: `packages/api/src/build-status.ts` — pure `isTerminalBuildStatus` + `TERMINAL_STATUSES` (relocated out of the `.tsx` admin view so a non-view route can import them without dragging JSX in).
- Modify: `packages/api/src/admin/views/build-logs.tsx` — re-export `isTerminalBuildStatus` from the new module (keeps `admin/routes/builds.tsx`'s import path working, zero change there).
- Modify: `packages/api/src/routes/projects.ts` — add the two owner-guarded routes + a `toBuildSummary` mapper.
- Create: `packages/api/test/unit/build-status.test.ts`.
- Create: `packages/api/test/integration/api-builds.test.ts`.

**Framework submodule (`framework/packages/void`):**

- Modify: `framework/packages/void/src/cli/client.ts` — `BuildSummary`, `BuildLogRow`, `BuildLogsResponse` types + `listBuilds` / `getBuildLogs` methods.
- Create: `framework/packages/void/src/cli/build-args.ts` — `buildSubcommands`, `BuildArgs`, `parseBuildArgs`.
- Create: `framework/packages/void/src/cli/build-cmd.ts` — `runBuildCommand`, `runBuildLogsCommand`, pure `followBuildLogs`.
- Modify: `framework/packages/void/src/cli/cli.ts` — import, top-level `else if (command === 'build')`, `topLevelCommands` entry, interactive-switch `case 'build'`.
- Modify: `framework/packages/void/src/cli/help.ts` — `HELP_TREE.build` node + `globalCommandGroup('build')` line.
- Create: `framework/packages/void/test/unit/build-args.test.ts`, `build-client.test.ts`, `build-logs-follow.test.ts`.
- Modify: `framework/docs/reference/cli.md` — cheat-sheet row + `## Build` section.
- Modify: platform `README.md` — amend the "container build logs are admin-only" pitfall note.

---

## Task 1: Relocate `isTerminalBuildStatus` to a shared module (`packages/api`)

**Files:**

- Create: `packages/api/src/build-status.ts`
- Modify: `packages/api/src/admin/views/build-logs.tsx:1-7`
- Test: `packages/api/test/unit/build-status.test.ts`

**Interfaces:**

- Produces: `isTerminalBuildStatus(status: Build['status']): boolean` and `TERMINAL_STATUSES: ReadonlyArray<Build['status']>` from `packages/api/src/build-status.ts`. Consumed by Task 2 (the new route) and by the existing `admin/views/build-logs.tsx` (re-export) + `admin/routes/builds.tsx` (unchanged import path).

Context: `isTerminalBuildStatus` currently lives inside the `.tsx` view `admin/views/build-logs.tsx` (lines 1-7). Importing a `.tsx` view into a plain user route would drag JSX into its import graph. This task extracts the pure helper; the view re-exports it so nothing downstream changes.

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/unit/build-status.test.ts`:

```ts
import { describe, expect, it } from 'vite-plus/test';
import { TERMINAL_STATUSES, isTerminalBuildStatus } from '../../src/build-status.ts';

describe('isTerminalBuildStatus', () => {
  it('treats complete/failed/cancelled as terminal', () => {
    expect(isTerminalBuildStatus('complete')).toBe(true);
    expect(isTerminalBuildStatus('failed')).toBe(true);
    expect(isTerminalBuildStatus('cancelled')).toBe(true);
  });

  it('treats in-flight statuses as non-terminal', () => {
    expect(isTerminalBuildStatus('queued')).toBe(false);
    expect(isTerminalBuildStatus('starting')).toBe(false);
    expect(isTerminalBuildStatus('building')).toBe(false);
    expect(isTerminalBuildStatus('deploying')).toBe(false);
  });

  it('exposes exactly the three terminal statuses', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'complete', 'failed']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/api`): `vp test run test/unit/build-status.test.ts`
Expected: FAIL — cannot resolve `../../src/build-status.ts`.

- [ ] **Step 3: Create the shared module**

Create `packages/api/src/build-status.ts`:

```ts
import type { Build } from './types.ts';

/** Build statuses that will never change again. */
export const TERMINAL_STATUSES: ReadonlyArray<Build['status']> = [
  'complete',
  'failed',
  'cancelled',
];

export function isTerminalBuildStatus(status: Build['status']): boolean {
  return TERMINAL_STATUSES.includes(status);
}
```

- [ ] **Step 4: Re-export from the admin view (keep its consumers unchanged)**

In `packages/api/src/admin/views/build-logs.tsx`, replace the local definition (the `TERMINAL_STATUSES` const + `isTerminalBuildStatus` function, currently lines ~3-7) with a re-export. The file's first lines become:

```tsx
import type { Build } from '../../types.ts';
export { isTerminalBuildStatus } from '../../build-status.ts';
```

Leave the rest of `build-logs.tsx` (the `BuildLogs` JSX component and any use of `Build`) intact. `admin/routes/builds.tsx:5` still does `import { BuildLogs, isTerminalBuildStatus } from '../views/build-logs.tsx'` — the re-export keeps that working. (If `Build` is no longer referenced anywhere else in the file after removing the const's type annotation, drop the now-unused `import type { Build }` line to satisfy the linter.)

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/api`): `vp test run test/unit/build-status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + fmt + lint**

Run (from `packages/api`): `vp run check` then `vp fmt` then `vp lint`
Expected: no type errors; no new lint errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/build-status.ts packages/api/src/admin/views/build-logs.tsx packages/api/test/unit/build-status.test.ts
git commit -m "refactor(api): extract isTerminalBuildStatus into shared build-status module"
```

---

## Task 2: Owner-guarded build routes (`packages/api`)

**Files:**

- Modify: `packages/api/src/routes/projects.ts` (add imports; add `toBuildSummary` helper; add two routes adjacent to the existing `.get('/:id/logs', ...)` route)
- Test: `packages/api/test/integration/api-builds.test.ts`

**Interfaces:**

- Consumes: `getProject`, `getBuild`, `getProjectBuilds` (`../db.ts`); `buildManagerNamespace` (`../build-namespace.ts`); `isTerminalBuildStatus` (`../build-status.ts`, Task 1); `Build` type (`../types.ts`).
- Produces (HTTP): `GET /projects/:id/builds?limit=N` → `{ builds: BuildSummary[] }` (newest-first, limit default 20, capped 100). `GET /projects/:id/builds/:buildId/logs?since=N` → the logs envelope (see Global Constraints). Both auto-guarded by the existing `.use('/projects/*', authMiddleware)` in `index.ts` — **no `index.ts` change**.

Context: `packages/api/src/routes/projects.ts` is one long chained `new Hono<ApiEnv>()...` instance (default-exported). Add the two routes by chaining `.get(...)` immediately after the existing `.get('/:id/logs', ...)` route. `context.get('db')` and `context.get('user')` are already populated by global + `/projects/*` middleware.

- [ ] **Step 1: Write the failing integration test**

Create `packages/api/test/integration/api-builds.test.ts`. This mirrors `test/integration/api-projects.test.ts` (auth via `user.jwt`) and `test/integration/admin-builds.test.ts` (the `spyNamespace` DO stub). Import `createBuild`/`updateBuildStatus` from `../../src/db.ts` and `builds` from `../../src/schema.ts` for teardown.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { createBuild } from '../../src/db.ts';
import { builds } from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// Reusable DO namespace spy (from admin-builds.test.ts). Records fetched URLs
// and returns a fixed JSON payload.
function spyNamespace(payload: unknown): { ns: DurableObjectNamespace; calls: Array<string> } {
  const calls: Array<string> = [];
  const ns = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      fetch: async (input: Request | string) => {
        const u = typeof input === 'string' ? input : input.url;
        calls.push(u);
        return Response.json(payload);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

function authGet(path: string, jwt: string, env: TestEnv): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${jwt}` } }),
    env,
  );
}

describe('user-facing build routes', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv();
  });
  afterAll(async () => {
    await teardownEnv();
  });
  beforeEach(async () => {
    await env.db.delete(builds);
    await clearTables(env.db);
  });

  it('lists a project builds newest-first for the owner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const b1 = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const b2 = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const res = await authGet(`/projects/${project.id}/builds`, user.jwt, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builds: Array<{ id: string }> };
    expect(body.builds.map((b) => b.id)).toEqual([b2.id, b1.id]);
    // BuildSummary must not leak internal columns.
    expect(body.builds[0]).not.toHaveProperty('user_id');
    expect(body.builds[0]).not.toHaveProperty('instance_type');
  });

  it('rejects listing another user builds with 403', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    const res = await authGet(`/projects/${project.id}/builds`, other.jwt, env);
    expect(res.status).toBe(403);
  });

  it('fronts the BuildManager DO for a container build logs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });

    const base = spyNamespace({
      lines: [{ seq: 1, line: 'hi', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
    });
    const large = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    env.BUILD_MANAGER_LARGE = large.ns;

    const res = await authGet(
      `/projects/${project.id}/builds/${build.id}/logs?since=0`,
      user.jwt,
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ line: string }>;
      lastSeq: number;
      status: string;
      terminal: boolean;
      external: string | null;
    };
    expect(body.lines).toEqual([{ seq: 1, line: 'hi', stream: 'stdout', ts: 1 }]);
    expect(body.lastSeq).toBe(1);
    expect(body.terminal).toBe(false); // 'queued' default
    expect(body.external).toBeNull();
    expect(base.calls[0]).toContain('/logs?since=0');
    expect(large.calls).toHaveLength(0);
  });

  it('normalizes a non-numeric since to 0 when fronting the DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const base = spyNamespace({ lines: [], lastSeq: 0 });
    env.BUILD_MANAGER = base.ns;
    await authGet(`/projects/${project.id}/builds/${build.id}/logs?since=abc`, user.jwt, env);
    expect(base.calls[0]).toContain('/logs?since=0');
  });

  it('returns the external GitHub URL for a github_actions build without touching the DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      logsUrl: 'https://github.com/o/r/actions/runs/1',
    });
    const base = spyNamespace({
      lines: [{ seq: 1, line: 'x', stream: 'stdout', ts: 1 }],
      lastSeq: 1,
    });
    env.BUILD_MANAGER = base.ns;

    const res = await authGet(`/projects/${project.id}/builds/${build.id}/logs`, user.jwt, env);
    const body = (await res.json()) as { lines: Array<unknown>; external: string | null };
    expect(body.lines).toEqual([]);
    expect(body.external).toBe('https://github.com/o/r/actions/runs/1');
    expect(base.calls).toHaveLength(0);
  });

  it('404s a build that does not belong to the project', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'a');
    const projectB = await createTestProject(env.db, user.id, 'b');
    const build = await createBuild(env.db, {
      projectId: projectB.id,
      userId: user.id,
      executor: 'container',
    });
    const res = await authGet(`/projects/${projectA.id}/builds/${build.id}/logs`, user.jwt, env);
    expect(res.status).toBe(404);
  });

  it('403s build logs for a non-owner', async () => {
    const owner = await createTestUser(env.db, 'owner2');
    const other = await createTestUser(env.db, 'intruder2');
    const project = await createTestProject(env.db, owner.id);
    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
    });
    const res = await authGet(`/projects/${project.id}/builds/${build.id}/logs`, other.jwt, env);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/api`): `vp test run test/integration/api-builds.test.ts`
Expected: FAIL — routes return 404 (not registered) so the list/logs assertions fail.

- [ ] **Step 3: Add imports + the `toBuildSummary` mapper to `projects.ts`**

At the top of `packages/api/src/routes/projects.ts`, ensure these are imported (add only the ones missing — `getProject` is already imported by the file):

```ts
import { getBuild, getProject, getProjectBuilds } from '../db.ts';
import { buildManagerNamespace } from '../build-namespace.ts';
import { isTerminalBuildStatus } from '../build-status.ts';
import type { Build } from '../types.ts';
```

Add the mapper near the top of the module (module scope, above `const app = new Hono<ApiEnv>()`):

```ts
function toBuildSummary(build: Build) {
  return {
    id: build.id,
    status: build.status,
    executor: build.executor,
    commit_sha: build.commit_sha,
    branch: build.branch,
    exit_code: build.exit_code,
    error: build.error,
    logs_url: build.logs_url,
    created_at: build.created_at,
    started_at: build.started_at,
    completed_at: build.completed_at,
  };
}
```

- [ ] **Step 4: Add the two routes**

Chain these immediately after the existing `.get('/:id/logs', async (context) => { ... })` route in `projects.ts`:

```ts
  // List recent builds for a project (owner-guarded).
  .get('/:id/builds', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    const rawLimit = Number(context.req.query('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const rows = await getProjectBuilds(context.get('db'), project.id, limit);
    return context.json({ builds: rows.map(toBuildSummary) });
  })
  // Build logs for one of a project's builds (owner-guarded). Fronts the
  // BuildManager DO for container builds; github_actions builds return their
  // external GitHub Actions URL (no DO log store exists for them).
  .get('/:id/builds/:buildId/logs', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    const build = await getBuild(context.get('db'), context.req.param('buildId'));
    if (!build || build.project_id !== project.id) {
      return context.json({ error: 'build not found' }, 404);
    }

    const raw = Number(context.req.query('since'));
    const since = Number.isFinite(raw) ? raw : 0;
    const terminal = isTerminalBuildStatus(build.status);

    if (build.executor !== 'container') {
      return context.json({
        lines: [],
        lastSeq: 0,
        status: build.status,
        terminal,
        external: build.logs_url ?? null,
      });
    }

    const ns = buildManagerNamespace(context.env, build.instance_type);
    const stub = ns.get(ns.idFromName(build.id));
    const res = await stub.fetch(`http://manager/logs?since=${since}`);
    const body = (await res.json()) as {
      lines: ReadonlyArray<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
    };
    return context.json({
      lines: body.lines,
      lastSeq: body.lastSeq,
      status: build.status,
      terminal,
      external: null,
    });
  })
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/api`): `vp test run test/integration/api-builds.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck + fmt + lint**

Run (from `packages/api`): `vp run check` then `vp fmt` then `vp lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/projects.ts packages/api/test/integration/api-builds.test.ts
git commit -m "feat(api): owner-guarded build list + build logs routes"
```

---

## Task 3: `PlatformClient` build types + methods (`framework/packages/void`)

> All Task 3-7 commands run from the **framework submodule root** (`framework/`), and commits are made **inside `framework/`**.

**Files:**

- Modify: `framework/packages/void/src/cli/client.ts`
- Test: `framework/packages/void/test/unit/build-client.test.ts`

**Interfaces:**

- Produces: exported types `BuildSummary`, `BuildLogRow`, `BuildLogsResponse`; methods `PlatformClient.listBuilds(projectId: string, limit?: number): Promise<Array<BuildSummary>>` and `PlatformClient.getBuildLogs(projectId: string, buildId: string, since?: number): Promise<BuildLogsResponse>`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `framework/packages/void/test/unit/build-client.test.ts` (mirrors `test/unit/github-client.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockReset();
});
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const token = 'auth-token-x';
const projectId = 'proj_test';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatformClient.listBuilds', () => {
  it('GETs /builds with the limit param and unwraps { builds }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ builds: [{ id: 'b1' }, { id: 'b2' }] }));
    const result = await makeClient().listBuilds(projectId, 5);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/projects/proj_test/builds');
    expect(parsed.searchParams.get('limit')).toBe('5');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer auth-token-x' });
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('maps a non-ok response to PlatformApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
    await expect(makeClient().listBuilds(projectId)).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 403,
    });
  });
});

describe('PlatformClient.getBuildLogs', () => {
  it('GETs /builds/:id/logs with since and returns the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        lines: [{ seq: 1, line: 'a', stream: 'stdout', ts: 1 }],
        lastSeq: 1,
        status: 'building',
        terminal: false,
        external: null,
      }),
    );
    const result = await makeClient().getBuildLogs(projectId, 'b1', 0);
    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/projects/proj_test/builds/b1/logs');
    expect(parsed.searchParams.get('since')).toBe('0');
    expect(result.lastSeq).toBe(1);
    expect(result.terminal).toBe(false);
    expect(result.lines[0]!.line).toBe('a');
  });

  it('maps a non-ok response to PlatformApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'build not found' }, 404));
    await expect(makeClient().getBuildLogs(projectId, 'nope', 0)).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 404,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `framework/`): `vp test run packages/void/test/unit/build-client.test.ts`
Expected: FAIL — `listBuilds`/`getBuildLogs` are not functions.

- [ ] **Step 3: Add the types**

In `framework/packages/void/src/cli/client.ts`, add near the other exported response types (e.g. after `LogEntry`):

```ts
export type BuildSummary = {
  id: string;
  status: string;
  executor: 'container' | 'github_actions';
  commit_sha: string | null;
  branch: string | null;
  exit_code: number | null;
  error: string | null;
  logs_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type BuildLogRow = {
  seq: number;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: number;
};

export type BuildLogsResponse = {
  lines: Array<BuildLogRow>;
  lastSeq: number;
  status: string;
  terminal: boolean;
  external: string | null;
};
```

- [ ] **Step 4: Add the methods**

Add to the `PlatformClient` class (e.g. after `getLogs`):

```ts
  async listBuilds(projectId: string, limit = 20): Promise<Array<BuildSummary>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/builds?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list builds', res);
    }

    const json = (await res.json()) as { builds: Array<BuildSummary> };
    return json.builds;
  }

  async getBuildLogs(projectId: string, buildId: string, since = 0): Promise<BuildLogsResponse> {
    const params = new URLSearchParams({ since: String(since) });
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/builds/${buildId}/logs?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch build logs', res);
    }

    return res.json();
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `framework/`): `vp test run packages/void/test/unit/build-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + fmt + lint**

Run (from `framework/`): `vp run check` then `vp fmt` then `vp lint`
Expected: clean.

- [ ] **Step 7: Commit (inside `framework/`)**

```bash
cd framework
git add packages/void/src/cli/client.ts packages/void/test/unit/build-client.test.ts
git commit -m "feat(cli): add PlatformClient listBuilds + getBuildLogs"
cd ..
```

---

## Task 4: `build-args.ts` argument parser (`framework/packages/void`)

**Files:**

- Create: `framework/packages/void/src/cli/build-args.ts`
- Test: `framework/packages/void/test/unit/build-args.test.ts`

**Interfaces:**

- Consumes: `SubcommandDef` (`./subcommand-prompt.ts`).
- Produces: `buildSubcommands: Array<SubcommandDef>`; `type BuildArgs = { subcommand: 'logs'; buildId?: string; follow: boolean; output?: string; projectName?: string }`; `parseBuildArgs(args: Array<string>): BuildArgs`. Consumed by Task 5 (`build-cmd.ts`) and Task 6 (`cli.ts`).

- [ ] **Step 1: Write the failing test**

Create `framework/packages/void/test/unit/build-args.test.ts` (mirrors `test/unit/github-args.test.ts`):

```ts
import { describe, expect, it } from 'vite-plus/test';
import { parseBuildArgs } from '../../src/cli/build-args.ts';

describe('parseBuildArgs', () => {
  it('parses bare logs', () => {
    expect(parseBuildArgs(['logs'])).toEqual({
      subcommand: 'logs',
      buildId: undefined,
      follow: false,
      output: undefined,
      projectName: undefined,
    });
  });

  it('captures a positional build id', () => {
    expect(parseBuildArgs(['logs', 'bld_1']).buildId).toBe('bld_1');
  });

  it('parses -f and --follow', () => {
    expect(parseBuildArgs(['logs', '-f']).follow).toBe(true);
    expect(parseBuildArgs(['logs', '--follow']).follow).toBe(true);
  });

  it('parses -o/--output and -p/--project values', () => {
    const a = parseBuildArgs(['logs', '-o', 'out.log', '-p', 'my-app']);
    expect(a.output).toBe('out.log');
    expect(a.projectName).toBe('my-app');
    const b = parseBuildArgs(['logs', '--output', 'x.log', '--project', 'app2']);
    expect(b.output).toBe('x.log');
    expect(b.projectName).toBe('app2');
  });

  it('parses a full combination', () => {
    expect(parseBuildArgs(['logs', 'bld_9', '-f', '-o', 'f.log', '-p', 'app'])).toEqual({
      subcommand: 'logs',
      buildId: 'bld_9',
      follow: true,
      output: 'f.log',
      projectName: 'app',
    });
  });

  it('throws when --output has no value', () => {
    expect(() => parseBuildArgs(['logs', '-o'])).toThrow('--output requires a value');
  });

  it('throws when --project has no value', () => {
    expect(() => parseBuildArgs(['logs', '--project'])).toThrow('--project requires a value');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseBuildArgs(['logs', '--nope'])).toThrow("Unexpected argument '--nope'");
  });

  it('throws on a second positional', () => {
    expect(() => parseBuildArgs(['logs', 'bld_1', 'bld_2'])).toThrow("Unexpected argument 'bld_2'");
  });

  it('throws on an unknown subcommand', () => {
    expect(() => parseBuildArgs(['bogus'])).toThrow('Usage: void build logs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `framework/`): `vp test run packages/void/test/unit/build-args.test.ts`
Expected: FAIL — cannot resolve `build-args.ts`.

- [ ] **Step 3: Implement the parser**

Create `framework/packages/void/src/cli/build-args.ts`:

```ts
import type { SubcommandDef } from './subcommand-prompt.ts';

export const buildSubcommands: Array<SubcommandDef> = [
  {
    name: 'logs',
    arg: '[build]',
    description: 'Stream, tail, or download logs for a build',
  },
];

export type BuildArgs = {
  subcommand: 'logs';
  buildId?: string;
  follow: boolean;
  output?: string;
  projectName?: string;
};

export function parseBuildArgs(args: Array<string>): BuildArgs {
  const subcommand = args[0];
  const rest = args.slice(1);

  if (subcommand !== 'logs') {
    throw new Error(
      'build: Usage: void build logs [build] [--follow] [--output <file>] [--project <slug>].',
    );
  }

  let buildId: string | undefined;
  let follow = false;
  let output: string | undefined;
  let projectName: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-o' || arg === '--output') {
      if (i + 1 >= rest.length) {
        throw new Error('build: --output requires a value.');
      }
      const value = rest[++i]!;
      if (value.trim() === '') {
        throw new Error('build: --output requires a value.');
      }
      output = value;
    } else if (arg === '-p' || arg === '--project') {
      if (i + 1 >= rest.length) {
        throw new Error('build: --project requires a value.');
      }
      const value = rest[++i]!;
      if (value.trim() === '') {
        throw new Error('build: --project requires a value.');
      }
      projectName = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`build: Unexpected argument '${arg}'.`);
    } else if (buildId) {
      throw new Error(`build: Unexpected argument '${arg}'.`);
    } else {
      buildId = arg;
    }
  }

  return { subcommand, buildId, follow, output, projectName };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `framework/`): `vp test run packages/void/test/unit/build-args.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck + fmt + lint**

Run (from `framework/`): `vp run check` then `vp fmt` then `vp lint`
Expected: clean.

- [ ] **Step 6: Commit (inside `framework/`)**

```bash
cd framework
git add packages/void/src/cli/build-args.ts packages/void/test/unit/build-args.test.ts
git commit -m "feat(cli): add void build args parser"
cd ..
```

---

## Task 5: `build-cmd.ts` command + follow loop (`framework/packages/void`)

**Files:**

- Create: `framework/packages/void/src/cli/build-cmd.ts`
- Test: `framework/packages/void/test/unit/build-logs-follow.test.ts`

**Interfaces:**

- Consumes: `getToken` (`./auth.ts`); `PlatformClient`, `PlatformApiError`, `BuildLogsResponse` (`./client.ts`, Task 3); `BuildArgs` (`./build-args.ts`, Task 4); `cliTitle`, `dim`, `pc` (`./output.ts`); `readProjectConfig` (`./project.ts`); `getRequestedProjectSlug`, `resolveProjectBySlug` (`./resolve-project.ts`).
- Produces: `runBuildCommand(root: string, args: BuildArgs): Promise<void>` (consumed by Task 6); pure `followBuildLogs(opts): Promise<{ status: string; terminal: boolean }>` (tested here).

- [ ] **Step 1: Write the failing test for the pure follow loop**

Create `framework/packages/void/test/unit/build-logs-follow.test.ts`:

```ts
import { describe, expect, it } from 'vite-plus/test';
import { followBuildLogs } from '../../src/cli/build-cmd.ts';
import type { BuildLogsResponse } from '../../src/cli/client.ts';

function page(partial: Partial<BuildLogsResponse>): BuildLogsResponse {
  return { lines: [], lastSeq: 0, status: 'building', terminal: false, external: null, ...partial };
}

describe('followBuildLogs', () => {
  it('polls from the cursor, writes new lines in order, and stops when terminal', async () => {
    const pages: Array<BuildLogsResponse> = [
      page({
        lines: [{ seq: 2, line: 'b', stream: 'stdout', ts: 2 }],
        lastSeq: 2,
        status: 'building',
        terminal: false,
      }),
      page({
        lines: [{ seq: 3, line: 'c', stream: 'stderr', ts: 3 }],
        lastSeq: 3,
        status: 'complete',
        terminal: true,
      }),
    ];
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];
    let i = 0;

    const result = await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        return Promise.resolve(pages[i++]!);
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 1,
      status: 'building',
      pollMs: 0,
    });

    expect(sinceCalls).toEqual([1, 2]); // advances cursor to each page's lastSeq
    expect(written).toEqual(['b', 'c']);
    expect(result).toEqual({ status: 'complete', terminal: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `framework/`): `vp test run packages/void/test/unit/build-logs-follow.test.ts`
Expected: FAIL — `followBuildLogs` not exported.

- [ ] **Step 3: Implement `build-cmd.ts`**

Create `framework/packages/void/src/cli/build-cmd.ts`:

```ts
import { appendFileSync } from 'node:fs';
import { intro, log, outro } from '@clack/prompts';
import { getToken } from './auth.ts';
import type { BuildArgs } from './build-args.ts';
import { PlatformApiError, PlatformClient, type BuildLogsResponse } from './client.ts';
import { cliTitle, dim, pc } from './output.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

const POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure follow-loop: repeatedly fetch pages since a cursor, write each new
 * line, and stop when the build reaches a terminal status. `fetchPage`,
 * `write`, and `sleep` are injected so this is unit-testable. Returns the
 * final status + terminal flag.
 */
export async function followBuildLogs(opts: {
  fetchPage: (since: number) => Promise<BuildLogsResponse>;
  write: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  since: number;
  status: string;
  pollMs?: number;
}): Promise<{ status: string; terminal: boolean }> {
  let cursor = opts.since;
  let status = opts.status;
  const pollMs = opts.pollMs ?? POLL_MS;
  for (;;) {
    await opts.sleep(pollMs);
    const pageResult = await opts.fetchPage(cursor);
    for (const l of pageResult.lines) {
      opts.write(l.line);
    }
    cursor = pageResult.lastSeq;
    status = pageResult.status;
    if (pageResult.terminal) {
      return { status, terminal: true };
    }
  }
}

export async function runBuildCommand(root: string, args: BuildArgs): Promise<void> {
  if (args.subcommand === 'logs') {
    return runBuildLogsCommand(root, args);
  }
}

async function runBuildLogsCommand(
  root: string,
  args: Extract<BuildArgs, { subcommand: 'logs' }>,
): Promise<void> {
  console.log();
  intro(cliTitle('build logs'));

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void auth login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  // Resolve project: --project/positional slug -> VOID_PROJECT -> linked config.
  let projectId: string;
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectName });
  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`build: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    projectId = resolved.projectId;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error(
        'build: No project specified. Pass a project with --project <slug>, set VOID_PROJECT, or link one with `void project link`.',
      );
      process.exit(1);
    }
    projectId = linked.projectId;
  }

  // Resolve build: explicit id or the newest build.
  let buildId = args.buildId;
  if (!buildId) {
    const builds = await client.listBuilds(projectId, 1);
    if (builds.length === 0) {
      outro('No builds found. Push to your connected branch to trigger one.');
      return;
    }
    buildId = builds[0]!.id;
  }

  // Writer: append to a file, or print to stdout.
  const write = args.output
    ? (line: string): void => appendFileSync(args.output!, `${line}\n`)
    : (line: string): void => console.log(line);

  // First page (since=0).
  let first: BuildLogsResponse;
  try {
    first = await client.getBuildLogs(projectId, buildId, 0);
  } catch (err) {
    if (err instanceof PlatformApiError && err.status === 404) {
      log.error(`build: Build '${buildId}' not found for this project.`);
      process.exit(1);
    }
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // github_actions builds keep their logs on GitHub.
  if (first.external) {
    log.message(`This build ran on GitHub Actions. View logs:\n${pc.cyan(first.external)}`);
    return;
  }

  for (const l of first.lines) {
    write(l.line);
  }

  let status = first.status;
  let terminal = first.terminal;

  if (args.follow && !terminal) {
    ({ status, terminal } = await followBuildLogs({
      fetchPage: (since) => client.getBuildLogs(projectId, buildId!, since),
      write,
      sleep,
      since: first.lastSeq,
      status,
    }));
  }

  if (!terminal) {
    outro(dim('Build still running — pass -f to follow.'));
    return;
  }

  outro(dim(`Build ${status}.`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `framework/`): `vp test run packages/void/test/unit/build-logs-follow.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + fmt + lint**

Run (from `framework/`): `vp run check` then `vp fmt` then `vp lint`
Expected: clean.

- [ ] **Step 6: Commit (inside `framework/`)**

```bash
cd framework
git add packages/void/src/cli/build-cmd.ts packages/void/test/unit/build-logs-follow.test.ts
git commit -m "feat(cli): add void build logs command with follow loop"
cd ..
```

---

## Task 6: Wire `build` into the CLI entry + help (`framework/packages/void`)

**Files:**

- Modify: `framework/packages/void/src/cli/cli.ts`
- Modify: `framework/packages/void/src/cli/help.ts`

**Interfaces:**

- Consumes: `buildSubcommands`, `parseBuildArgs` (Task 4); `runBuildCommand` (Task 5, dynamic import).

Context: `cli.ts` dispatches top-level commands with an `if/else if` chain and a separate interactive-switch (for the no-arg TTY prompt). `runSubcommandGroup` is the shared helper. `help.ts` holds `HELP_TREE` and `printGlobalHelp`. Per framework `CLAUDE.md`, a new command group requires updating: (1) the dispatch, (2) the no-arg interactive list, (3) the help tree, (4) `docs/reference/cli.md` (Task 7).

- [ ] **Step 1: Add the import to `cli.ts`**

Near the existing `import { githubSubcommands, parseGithubArgs } from './github-args.ts';` line, add:

```ts
import { buildSubcommands, parseBuildArgs } from './build-args.ts';
```

- [ ] **Step 2: Add the top-level dispatch branch**

In the `if/else if` chain (next to the `command === 'github'` branch), add:

```ts
} else if (command === 'build') {
  runSubcommandGroup('build', buildSubcommands, parseBuildArgs, (root, parsed) =>
    import('./build-cmd.ts').then(({ runBuildCommand }) => runBuildCommand(root, parsed)),
  );
```

- [ ] **Step 3: Add the no-arg interactive entry + switch case**

In `topLevelCommands` (the `Array<SubcommandDef>` in `cli.ts`), add next to the `github` entry:

```ts
    {
      name: 'build',
      hint: 'logs',
      description: 'Inspect remote builds',
    },
```

And in the interactive dispatch `switch` (next to `case 'github':`), add:

```ts
      case 'build':
        return runSubcommandGroup('build', buildSubcommands, parseBuildArgs, (r, p) =>
          import('./build-cmd.ts').then(({ runBuildCommand }) => runBuildCommand(r, p)),
        );
```

- [ ] **Step 4: Add the `build` help node to `HELP_TREE`**

In `framework/packages/void/src/cli/help.ts`, add a `build:` key to `HELP_TREE` (mirror the `github`/`logs` node shapes):

```ts
  build: {
    summary: 'Inspect remote builds.',
    usage: ['void build <command>'],
    commands: [{ command: 'logs [build]', description: 'Stream, tail, or download logs for a build' }],
    children: {
      logs: {
        summary: 'Stream, tail, or download logs for a build.',
        usage: ['void build logs [build] [options]'],
        options: [
          { command: '--follow, -f', description: 'Live-tail until the build finishes' },
          { command: '--output <file>, -o', description: 'Write logs to a file instead of stdout' },
          { command: '--project <slug>, -p', description: 'Target project (else linked / VOID_PROJECT)' },
        ],
        examples: [
          { command: 'void build logs', description: "Print the latest build's logs" },
          { command: 'void build logs -f', description: 'Follow the latest build until it finishes' },
          { command: 'void build logs bld_123 -o build.log', description: "Download a build's logs to a file" },
        ],
      },
    },
  },
```

- [ ] **Step 5: Add the global-help line**

In `printGlobalHelp` (`help.ts`), add `...globalCommandGroup('build'),` (and a `''` spacer, matching the surrounding entries) next to the `...globalCommandGroup('github')` line.

- [ ] **Step 6: Typecheck, then verify the command is wired end-to-end**

Run (from `framework/`):

```
vp run check
vp fmt
vp lint
```

Expected: clean.

Then build the CLI and exercise the new command's parse + help paths (non-TTY, so no interactive prompt):

```
vp run build:core
node packages/void/dist/cli/cli.js build --help
node packages/void/dist/cli/cli.js build logs --nope 2>&1 || true
```

Expected: the first prints the `void build logs` help page (summary, `--follow`/`--output`/`--project` options, examples); the second exits non-zero with `build: Unexpected argument '--nope'.` (confirms dispatch → parser wiring). If `dist/cli/cli.js` is not the built path, use the path emitted by `vp run build:core` / the package `bin` entry.

- [ ] **Step 7: Commit (inside `framework/`)**

```bash
cd framework
git add packages/void/src/cli/cli.ts packages/void/src/cli/help.ts
git commit -m "feat(cli): wire void build command group into entry + help"
cd ..
```

---

## Task 7: Documentation

**Files:**

- Modify: `framework/docs/reference/cli.md`
- Modify: `README.md` (platform repo root — the "container build logs" pitfall note)

**Interfaces:** none (docs only).

Context: `README.md` is the source of truth (symlinked as `CLAUDE.md`/`AGENTS.md`). Its pitfall note currently says container build logs are surfaced only in the internal admin panel; this feature adds a user-facing path.

- [ ] **Step 1: Add the cheat-sheet row + `## Build` section to `cli.md`**

In `framework/docs/reference/cli.md`, add a row to the top cheat-sheet table:

```
| `void build logs`                 | Stream, tail, or download build logs                                |
```

Then add a new `## Build` H2 section (place it near the `## Github` section), following the `void project logs` format (usage fence, flags table, examples fence):

````markdown
## Build

Inspect Deploy-on-GitHub builds.

### `void build logs`

```
void build logs [build] [--follow] [--output <file>] [--project <slug>]
```

Stream, tail, or download the build logs for a **container** build. With no
`[build]` argument, targets the project's most recent build.

| Flag                     | Purpose                                                           | Default |
| ------------------------ | ----------------------------------------------------------------- | ------- |
| `--follow`, `-f`         | Live-tail: poll until the build reaches a terminal status.        | off     |
| `--output <file>`, `-o`  | Write logs to a file instead of stdout (appends while following). | stdout  |
| `--project <slug>`, `-p` | Target project.                                                   | linked  |

**Project resolution** follows the same order as deploy: positional / `--project`,
`VOID_PROJECT`, linked project (`.void/project.json`).

Builds run on **GitHub Actions** keep their logs on GitHub — the command prints
the Actions run URL instead of streaming. Only the last 10,000 log lines of a
container build are retained.

Examples:

```
void build logs                     # print the latest build's logs
void build logs -f                  # follow the latest build until it finishes
void build logs bld_123 -o build.log  # download a specific build's logs
```
````

- [ ] **Step 2: Amend the platform README pitfall note**

In `README.md` (platform repo root), find the pitfall bullet describing the container→DO live-log transport / admin Builds panel. Append a sentence noting the new user-facing path, e.g.:

> Users can now also view container build logs for their own projects via the CLI (`void build logs`), which fronts the same DO log store through owner-guarded routes `GET /projects/:id/builds` and `GET /projects/:id/builds/:buildId/logs`.

- [ ] **Step 3: Commit**

The `cli.md` change is inside `framework/`; the `README.md` change is in the platform repo. Commit them separately:

```bash
cd framework
git add docs/reference/cli.md
git commit -m "docs: document void build logs command"
cd ..
git add README.md
git commit -m "docs: note user-facing container build logs via void build logs"
```

---

## Self-Review (author)

- **Spec coverage:** view/follow/download modes → Task 5 (`runBuildLogsCommand` + `-o` writer + `followBuildLogs`); `void build logs` command group → Tasks 4/6; latest-build resolution → Task 5; owner-guarded API → Task 2; github_actions link-out → Tasks 2 (`external`) + 5; docs → Task 7. All covered.
- **Type consistency:** `BuildLogsResponse`/`BuildLogRow`/`BuildSummary` names identical across client (Task 3), command (Task 5), and the API envelope (Task 2). `followBuildLogs` signature identical in Task 5 impl + test.
- **Placeholder scan:** none — every code/test/command step carries literal content.
- **Cross-repo:** framework commits wrapped in `cd framework` / `cd ..`; submodule pointer deliberately untouched; no push/merge.

## Open items for the executor to confirm with the human (not blockers)

1. **Submodule pointer:** left unbumped per memory `feedback_framework_pointer.md`. If the user wants the platform repo to reference the new framework CLI commit, that's a separate, explicit step.
2. **Default line rendering:** plain passthrough (stdout), no per-stream coloring. (Design left this open; plain was chosen for simplicity/testability.)

---

## Part B — Build-Log Tail in the "Void Build" Check Run

> Implemented via void-platform#224.

**Goal:** When a Deploy-on-GitHub **container** build's check run completes, embed the tail of the build log (last 100 captured lines) in the check run's `output.text` so users see the log directly on the GitHub check page — for every terminal outcome (success, failure, timeout, cancel). Approved in brainstorming: show **always**, **last ~100 lines**, assembled at the single chokepoint `BuildManager.finalizeCheckRun`.

**Architecture:** Two small changes, both in `packages/api`. (1) `completeCheckRun` (`src/github/check-run.ts`) gains an optional `text` option forwarded as GitHub's `output.text`. (2) `BuildManager` (`src/build-manager.ts`) gains a pure exported formatter `formatLogTailMarkdown` plus a private reader `readLogTailMarkdown()` over the DO's SQLite `logs` table; `finalizeCheckRun` calls the reader (best-effort) and passes `text` to `completeCheckRun`. All six container terminal paths route through `finalizeCheckRun`, so they all inherit the tail. The GitHub Actions executor path (`routes/webhooks.ts`, `routes/auth-oidc.ts`) is **unchanged** — no logs exist on our side; its check keeps linking to the Actions run.

**Tech Stack:** Cloudflare Durable Objects (SQLite storage), Hono, Vitest via Vite+ (`vp`), oxfmt/oxlint.

## Global Constraints

These bind **every** task. Exact values, copied verbatim from the approved design.

- `output.text` hard cap on GitHub is **65535 UTF-8 bytes** — GitHub validates **bytesize** (its 422 reads "maximum bytesize of 65535"), not UTF-16 length, so CJK/emoji content must be measured in bytes. Our formatter caps the joined log content at **`CHECK_RUN_LOG_TAIL_MAX_BYTES = 60000`** UTF-8 bytes (headroom for header + fence + marker), and the tail is **`CHECK_RUN_LOG_TAIL_LINES = 100`** lines. Both are named module-level constants in `build-manager.ts`.
- Fence is **dynamic**: `max(6, longest consecutive-backtick run in the rendered content + 1)` backticks, with info string `text` on the opener — so log content can NEVER close the fence (a fixed six-backtick fence was escapable by a log line of ≥6 backticks; found in the whole-branch review). The **whole returned string** must additionally stay ≤ `CHECK_RUN_OUTPUT_TEXT_MAX_BYTES = 65535` UTF-8 bytes (GitHub's hard bytesize cap — an oversized string makes GitHub reject the PATCH): enforce with a converging loop that drops the oldest line (or further tail-truncates a lone line, never splitting a surrogate pair at the cut) and recomputes the fence until it fits.
- Exact output.text format (blank line between blocks; marker line present **only when** more lines were captured than rendered, i.e. `totalCaptured > lines.length`):

  ```````
  **Last {M} log lines:**

  _…earlier lines omitted._

  ``````text
  {lines joined with \n}
  ```````

  ```

  where `{M}` is the number of rendered lines. No timestamps, no stream markers — raw `line` text only.
  ```

- Char-cap algorithm: start from the last 100 lines in chronological order; while the joined content exceeds 60000 chars and more than one line remains, drop the **oldest** remaining line (and the marker rule above applies since dropped lines count as not rendered). If a single line still exceeds the cap, keep its **last** 60000 chars.
- Empty log table (or zero rows) → formatter returns `null` → `output.text` is **omitted entirely** (PATCH body identical to today).
- Tail assembly is **best-effort and must never block or fail check-run completion**: the read in `finalizeCheckRun` is wrapped in try/catch; on throw, `console.warn` and finalize without `text`. Never throw out of `finalizeCheckRun` (existing invariant — callers rely on `finally { pokeScheduler() }`).
- `createCheckRun` (the in-progress create) is untouched. The `github_actions` completion path (`routes/webhooks.ts`) is untouched and continues to send **no** `text`.
- Do not modify the `logs` table schema, `ingestLines`, `pollLogs`, or `handleReadLogs`. Known accepted limitation (pre-existing, do not attempt to fix): the DO pull-loop may miss the final ~1s of container output.
- Repo hygiene: single-quote strings (oxfmt), run `vp fmt` + `vp lint` before finishing a task; typecheck via `vp run check`. Tests run from the **repo root** with root-relative globs, e.g. `vp test run packages/api/test/unit/check-run.test.ts`.
- No framework/submodule changes. `packages/api` only (plus README doc touch-up in T2).

## Task 1 — `completeCheckRun`: optional `output.text`

**Files:** `packages/api/src/github/check-run.ts`, `packages/api/test/unit/check-run.test.ts`

- [ ] Add `text?: string` to the `opts` parameter type of `completeCheckRun` (after `summary`).
- [ ] Include it in the PATCH body only when present:
      `output: { title: opts.title, summary: opts.summary, ...(opts.text ? { text: opts.text } : {}) }`.
      Nothing else in the function changes (retry/token/logging behavior identical).
- [ ] Update the function's JSDoc to mention the optional markdown `text` (GitHub cap 65535 chars; callers are responsible for staying under it).
- [ ] Tests (follow the existing fetch-mock idioms in `check-run.test.ts`):
  - `completeCheckRun` with `text` provided → PATCH body's `output.text` equals the given string, `title`/`summary` unchanged.
  - `completeCheckRun` without `text` → PATCH body's `output` has **no** `text` key (assert `'text' in output === false`, not just undefined).
- [ ] Run: `vp test run packages/api/test/unit/check-run.test.ts` (all pass), `vp run check`, `vp fmt`, `vp lint`.

## Task 2 — `BuildManager`: log-tail assembly in `finalizeCheckRun` (+ docs)

**Files:** `packages/api/src/build-manager.ts`, `packages/api/test/unit/build-manager.test.ts`, `README.md` (root)

- [ ] Add module-level exported constants `CHECK_RUN_LOG_TAIL_LINES = 100` and `CHECK_RUN_LOG_TAIL_MAX_CHARS = 60000` near `MAX_STORED_LOG_LINES`, with a short comment stating GitHub's 65535 cap and the headroom rationale.
- [ ] Add a **pure exported** function `formatLogTailMarkdown(lines: string[], totalCaptured: number): string | null` implementing the exact format and char-cap algorithm from Global Constraints (`lines` already chronological). Export it for unit tests (mirror how `MAX_STORED_LOG_LINES` is exported).
- [ ] Add `private readLogTailMarkdown(): string | null` on `BuildManager`: call `this.ensureLogTable()` (mirror the other `logs` readers), read the last `CHECK_RUN_LOG_TAIL_LINES` rows (`SELECT line FROM logs ORDER BY seq DESC LIMIT ?` — reverse to chronological; use the same `ctx.storage.sql` idiom as `handleReadLogs`) and the total row count (`SELECT COUNT(*)`), and delegate to `formatLogTailMarkdown`.
- [ ] In `finalizeCheckRun` (currently ~line 647), after the check-run id resolution succeeds and before the `completeCheckRun` call: assemble `text` via `this.readLogTailMarkdown()` inside its own try/catch (`console.warn('finalizeCheckRun: log tail read failed (best-effort)', err)` on throw, `text` stays `undefined`). Pass `...(text ? { text } : {})` into the existing `completeCheckRun` opts. Do not reorder or change anything else in the function.
- [ ] Tests (follow existing DO-harness idioms in `build-manager.test.ts`; `formatLogTailMarkdown` tests are pure — no harness):
  - `formatLogTailMarkdown([], 0)` → `null`.
  - A few lines, `totalCaptured === lines.length` → header says `**Last {M} log lines:**`, **no** omission marker, six-backtick fence with info string `text`, lines in given order.
  - `totalCaptured > lines.length` → omission marker line present.
  - Char cap: lines whose join exceeds 60000 chars → oldest dropped until it fits, marker present, result length of the whole returned string < 65535.
  - Single line longer than 60000 chars → its **last** 60000 chars kept.
  - Integration through the DO (reuse whatever harness the file already has for `finalizeCheckRun`/`onStop`/check-run assertions): with rows ingested into `logs`, the completion PATCH body contains `output.text` containing the ingested tail; with an empty `logs` table, the PATCH body's `output` has no `text` key; when the log read throws (e.g. stub `readLogTailMarkdown`/sql to throw), the PATCH still happens without `text`.
- [ ] Docs: in root `README.md` (source of truth; `CLAUDE.md`/`AGENTS.md` are symlinks — edit `README.md` only), append one sentence to the "Container→DO live-log transport" pitfall bullet: container-build check runs now embed the last 100 captured log lines in the check-run `output.text` at completion (all terminal outcomes; `github_actions` checks unchanged — they link to the Actions run).
- [ ] Run: `vp test run packages/api/test/unit/build-manager.test.ts` and `vp test run packages/api/test/unit/check-run.test.ts` (all pass), `vp run check`, `vp fmt`, `vp lint`.

## Final Verification

- [ ] Full api suite: `vp test run packages/api` (all pass).
- [ ] `vp run check` exit 0, `vp fmt --check` clean, `vp lint` clean.
- [ ] Whole-branch `/codex:adversarial-review` (foreground) — converge to approve.
