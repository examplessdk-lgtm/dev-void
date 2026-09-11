---
title: Cross-Script DO Host Architecture for Sandbox Projects
status: proposed
created: 2026-05-03
---

# Cross-Script DO Host Architecture for Sandbox Projects

## Context

Every platform deploy creates a fresh WfP worker script `user-${slug}-${deployment.id}` (`packages/api/src/routes/deploy.ts:2150`). Cloudflare mints a new Durable Object namespace per `(script_name, do_class_name)` pair on first PUT, so each deploy of a project that declares a DO class — including any project using `void/sandbox` — receives a brand-new `namespace_id`.

Sandbox projects also create a Cloudflare **container application** (one per project, scoped by `${projectId}-${containerName}`), whose `durable_objects.namespace_id` field is **immutable on PATCH** per CF API contract. The container app stays bound to the namespace of the first deploy. On the second deploy, `assertNamespaceMatch` (`packages/api/src/provisioning/containers.ts:266-279`) detects the mismatch and fails the deploy:

> container application "X" is bound to a different durable object namespace (expected NEW, found OLD). The DO namespace binding is immutable on PATCH; delete the existing application before redeploying to rebind it.

This is empirically reproducible: a fresh sandbox project deployed twice on prod fails on the second deploy with this exact error. The bug has been latent in every sandbox project since PR #115 (`99c9becd`, 2026-04-24) and was first surfaced by `assertNamespaceMatch` in PR #124 (`4ecc51f1`, 2026-04-30).

## Decision

Decouple the lifetime of the Sandbox Durable Object namespace and its container application from the per-deploy user worker. Introduce one stable WfP script per sandbox project — the **DO host** — that owns the `Sandbox` class. Per-deploy user worker scripts reference the namespace via a **cross-script DO binding** (`script_name: "do-host-${slug}"`).

Concretely:

1. **DO host script** (`do-host-${slug}`) is a tiny WfP script that exports `Sandbox` from `@cloudflare/sandbox`, declares `migrations.new_sqlite_classes: ['Sandbox']` on first PUT, and declares a same-script `durable_object_namespace` self-binding so its `namespace_id` is exposed via the per-script bindings endpoint. The DO namespace is minted against this stable script and never rotates.
2. **Container app** is created once per project, bound to the host's namespace, and remains valid for the project's lifetime. No per-deploy DELETE / POST. Container configuration drift (image / instance type / max_instances) is still reconciled via PATCH + rollout on every deploy — only the namespace binding is stable.
3. **Per-deploy user workers** declare the `SANDBOX` DO binding with `class_name: 'Sandbox', script_name: 'do-host-${slug}'`. They do not own the class; they have no `migrations` entry for `Sandbox`; they do not own the container app. The platform performs this metadata rewrite at upload time; the framework continues to emit same-script form for local `wrangler dev`.
4. **Sandbox state persists across deploys and rollbacks** as a positive feature of this architecture. Container apps are not versioned. Rollback flips the user-worker routing pointer; the host, namespace, and container app are all stable, so sandbox runtime calls from a rolled-back worker continue to resolve correctly.

## What this fix does and does not do

It DOES:

- Fix the deploy-fails-loudly bug for every sandbox tenant.
- Preserve sandbox container state (filesystem, processes, exposed ports, in-flight WebSockets) across deploys.
- Preserve sandbox container state across rollbacks.
- Eliminate per-deploy churn for sandbox-related CF resources (no DO namespace creation, no container app DELETE+POST, no `resources.cf_id` rotation).
- Continue to reconcile container configuration drift (image / instance_type / max_instances) via PATCH + rollout, mirroring today's behavior.

It does NOT:

- Address silent DO namespace rotation for non-sandbox DO users (latent footgun if a future tenant declares a DO class for non-sandbox use and writes to `state.storage`).
- Reduce per-deploy churn for secrets re-uploads, queue consumer registrations, tail consumer wiring, or cron triggers — those still rotate per script.
- Repair the pre-existing partial-routing-failure imperfection at `deploy.ts:3282-3297` where a deploy is marked live as soon as slug routing succeeds, even if a custom-domain ROUTING.put subsequently fails.
- Support changing a project's slug after its host has been provisioned. Slug rename for sandbox projects is out of scope.

## Sandbox UX impact

The public sandbox guide (`framework/docs/guide/sandboxes.md`) presents stable session IDs as a first-class API. With this fix:

- `getSandbox(id)` resolves to the same DO instance across deploys (state, filesystem, processes preserved).
- `getSandbox(id)` resolves to the same DO instance across rollbacks.
- A deploy never terminates a running sandbox container or drops in-flight WebSocket connections.
- Documented behavior matches actual behavior — no callouts about per-deploy resets are required.

The only visible state-loss event is project deletion. Document that explicitly.

## Implementation

### 1. Host script definition and bundling

Per-project host script: `do-host-${slug}`. Authoritative source lives at `packages/api/src/provisioning/sandbox-host-source/index.ts`:

```ts
export { Sandbox } from '@cloudflare/sandbox';
export default {
  fetch() {
    return new Response('do-host', { status: 404 });
  },
};
```

`@cloudflare/sandbox` is an npm dependency that imports other CF runtime modules. A bare `export ... from '@cloudflare/sandbox'` cannot be uploaded as-is — the WfP runtime does not resolve npm specifiers at PUT time. The host source MUST be **pre-bundled at API build time** into a single ESM module before upload.

**Bundling approach:**

- New script `packages/api/scripts/build-sandbox-host.ts` runs `tsdown` (or `rolldown`) over `sandbox-host-source/index.ts`, treats `cloudflare:*` and `node:*` as externals, and writes `packages/api/src/provisioning/sandbox-host-bundle.generated.ts` exporting `BUNDLE_BYTES: string`, `BUNDLE_SHA256: string`, and `COMPATIBILITY_DATE: string`.
- The generated file is committed to git. CI runs `pnpm -C packages/api build:sandbox-host && git diff --exit-code packages/api/src/provisioning/sandbox-host-bundle.generated.ts` to enforce that the committed bundle matches the source-of-truth.
- `@cloudflare/sandbox` is pinned to an exact version (no caret) in `packages/api/package.json`. Upgrading is an explicit two-step PR: bump version, regenerate bundle.
- The bundled output is small (a few KB); inline-string size is fine.
- `provisionSandboxHost` reads `BUNDLE_BYTES` and includes it as the host's `index.js` module in the multipart PUT body.

**Host script metadata on first PUT:**

```jsonc
{
  "main_module": "index.js",
  "compatibility_date": "<COMPATIBILITY_DATE from sandbox-host-bundle.generated.ts>",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [{ "tag": "void-sandbox-host-v1", "new_sqlite_classes": ["Sandbox"] }],
  "bindings": [{ "type": "durable_object_namespace", "name": "SANDBOX", "class_name": "Sandbox" }],
}
```

The same-script `durable_object_namespace` binding is **REQUIRED**. It is the source of `namespace_id` for the container app POST. `findDurableObjectNamespaceId` (`packages/api/src/provisioning/containers.ts:52-68`) reads exactly this binding shape from the per-script bindings endpoint and would otherwise throw. The host's own runtime never invokes the `SANDBOX` binding (its fetch handler is a 404); the binding exists solely so the namespace_id is reflected on the bindings endpoint.

Every host PUT — whether for first creation, partial-failure recovery, or future `@cloudflare/sandbox` upgrades — goes through the `putSandboxHostScript` helper (§2a). That helper reads the script's current `migration_tag` from CF first; if the live tag matches `'void-sandbox-host-v1'` (host already migrated) it OMITS the `migrations` field entirely. This is the wrangler protocol and is the only way to safely re-PUT an existing host without rotating the namespace by re-running `new_sqlite_classes`. No call site constructs the `migrations` field directly.

### 2. Host provisioning helper

New file `packages/api/src/provisioning/sandbox-host.ts`:

```ts
export type SandboxHostInfo = {
  scriptName: string;
  namespaceId: string;
  containerApplicationId: string;
};

export async function provisionSandboxHost(
  env: Env,
  db: Database,
  projectId: string,
  slug: string,
  desiredImage: string,
  desiredInstanceType: string,
  desiredMaxInstances: number,
): Promise<SandboxHostInfo>;
```

Behavior — runs at the **start** of every sandbox-using deploy, BEFORE user-worker metadata assembly and BEFORE user-worker PUT. The entire body runs inside a `db.transaction` whose first statement is `SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`. Holding the project-row lock across CF API calls is the only way to genuinely serialize concurrent first-deploy CF mutations (host PUT, container POST). Sandbox deploys are rare per-project and the lock is project-scoped, so the cost is acceptable.

Inside the transaction:

1. `SELECT * FROM resources WHERE project_id = $1 AND type = 'container' AND binding_name = $2` — where `$2` is the manifest's `sandbox.containerName` (default `'void-sandbox'`). This MUST match the existing key written by `upsertContainerResource(db, projectId, sandbox.containerName, application.id)` at `packages/api/src/routes/deploy.ts:1201-1205` and persisted at `packages/api/src/db.ts:889-900`. Today the binding-name column already holds `containerName` (NOT the DO binding name `'SANDBOX'`), so stuck-tenant rows are keyed as `'void-sandbox'`. Using the same key is what makes the stuck-tenant fast-path lookup hit existing rows instead of creating a duplicate. The existing `container` resource row is the canonical record; we do NOT introduce a new resource type and we do NOT change the natural key.
2. **Cached fast path.** If the row exists with `metadata.namespaceId`, `metadata.hostScriptName`, and a non-null `cf_id`:
   - HEAD `GET /accounts/{a}/workers/dispatch/namespaces/{ns}/scripts/{hostScriptName}` — verify host script exists.
   - GET the container app by `cf_id` — verify it exists and `durable_objects.namespace_id === metadata.namespaceId`.
   - **Always reconcile container config:** if `image / instance_type / max_instances` differ from desired, PATCH the container and POST a rollout. This preserves the existing `upsertSandboxContainerApplication` PATCH+rollout body at `containers.ts:140-179`.
   - On all verifications pass, return `SandboxHostInfo` (no host PUTs, no container POSTs/DELETEs).
   - On any verification miss (HEAD 404 on host, GET 404 on container, namespace mismatch), fall through to step 4.
3. If no row exists, OR the row lacks `metadata.namespaceId` (pre-fix-schema rows for stuck tenants), OR step 2 fell through: run create-or-recover (step 4).
4. **Create-or-recover sequence (still inside the transaction):**
   - Call `putSandboxHostScript(env, slug)` (new helper, §2a). Internally: GET the current script's `migration_tag` from CF; if it equals `'void-sandbox-host-v1'`, PUT with NO `migrations` field (host already migrated, tag preserved); if 404 / no tag, PUT with the initial `migrations: [{ tag: 'void-sandbox-host-v1', new_sqlite_classes: ['Sandbox'] }]`. Always includes the self-binding (§1) and the bundled module body (`BUNDLE_BYTES`). This makes the helper safe under partial-failure replays (host PUT succeeded, container POST or row UPSERT failed, next deploy re-enters this branch and MUST NOT replay the create-Sandbox migration).
   - Call `findDurableObjectNamespaceId(... 'SANDBOX', 'Sandbox')` to read the minted namespace_id from the host's bindings endpoint.
   - Find any pre-existing container app named `${projectId}-${containerName}` via `findContainerApplication` (`containers.ts:299-310`).
   - If found and its `durable_objects.namespace_id` does NOT match the host's namespace, throw with a runbook hint (manual operator cleanup expected — see "Pre-PR cutover" below). The DO namespace binding is immutable on PATCH, so the platform cannot self-heal; the operator runs `wrangler containers delete` once before the tenant's next deploy.
   - POST a fresh container app with the host's namespace + desired image / instance_type / max_instances. With the project-row lock held, no concurrent first deploy can be racing here, so `tryCreateContainerApplication` returning 409 indicates an out-of-band creation (operator action, prior failed teardown) — re-find, require namespace match, log the unexpected race at WARN. Do NOT silently fall through to PATCH on 409 with the lock held; that masks an inconsistency we want to see.
   - UPSERT the `resources` row using the SAME key the existing code writes: `(id, project_id, type='container', cf_id=<applicationId>, binding_name=<manifest.sandbox.containerName>, metadata={ namespaceId, hostScriptName: 'do-host-${slug}' })`. The unique constraint is `(project_id, type, binding_name)` — existing constraint, no schema change. The natural key matches `upsertContainerResource`'s existing writes.
   - Return the SandboxHostInfo.

Concurrent first deploys serialize through the project-row `FOR UPDATE`: the second waits, then sees the now-cached row in step 1, and is a no-op for host/container creation.

**Why hold the lock across CF calls?** The alternative — taking the lock only around the resources upsert — leaves a window where two concurrent first deploys both PUT the host (CF idempotently handles same-content PUTs but not racey `migrations` fields), both POST the container app (one wins, the other 409s), and one ends up with a resource row that disagrees with CF reality. Holding the lock through CF reconciliation eliminates the race entirely.

### 2a. `putSandboxHostScript` — read-tag-first PUT helper

Wrangler's `migration_tag` discipline is well-defined: the script's CURRENT migration_tag is the source of truth, and the next PUT either omits `migrations` (preserving the tag) or sends `{ old_tag, new_tag, steps }` only for unapplied steps. Replaying a `new_sqlite_classes` step against a script that already has the class is what would rotate the namespace and break this whole design.

New helper in `packages/api/src/provisioning/sandbox-host.ts`:

```ts
async function fetchScriptMigrationTag(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<string | null>;

export async function putSandboxHostScript(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  slug: string,
): Promise<void>;
```

`fetchScriptMigrationTag` mirrors the wrangler implementation (`node_modules/.pnpm/wrangler/wrangler-dist/cli.js:301012-301083`): GET `/accounts/{a}/workers/dispatch/namespaces/{ns}/scripts/{name}` and read the `migration_tag` from the response. Returns `null` on 404 or when the script has no tag yet.

`putSandboxHostScript` behavior:

1. `tag = await fetchScriptMigrationTag(...)`.
2. Build metadata with `main_module: 'index.js'`, `compatibility_date: COMPATIBILITY_DATE`, `compatibility_flags: ['nodejs_compat']`, `bindings: [<self-binding>]`.
3. **First create** (`tag === null`): include `migrations: [{ tag: 'void-sandbox-host-v1', new_sqlite_classes: ['Sandbox'] }]`.
4. **Re-PUT after partial failure** (`tag === 'void-sandbox-host-v1'`): omit `migrations` entirely. CF preserves the existing tag and the namespace.
5. **Future host upgrades** (tag is some later tag): out of scope here; tracked TODO.
6. PUT with the multipart body containing `BUNDLE_BYTES` as `index.js`.

This helper is the single insertion point for "PUT the host" in §2 step 4. Step 4 never constructs the migrations field directly.

### 3. User worker metadata rewrite (platform-side)

The framework continues to emit same-script `Sandbox` bindings + `containers` block + `Sandbox` entry in `migrations.new_sqlite_classes` so local `wrangler dev` workflows keep working. The deploy pipeline rewrites this metadata at upload time.

Insertion point: in metadata assembly at `deploy.ts:~2680-2705`, after `provisionSandboxHost` has run and before `workerFormData.append('metadata', ...)`. Apply three transforms when `manifest.sandbox` is present:

- **Bindings rewrite.** Replace each `{ type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' }` (no `script_name`) with `{ ..., script_name: 'do-host-${slug}' }`. Keyed by `manifest.sandbox.bindingName` and `manifest.sandbox.className`.
- **Migrations strip.** Remove `Sandbox` from any `new_sqlite_classes` / `new_classes` array on the user worker. Implement inside `buildDurableObjectUploadMigrations` (it already composes websocket + sandbox migrations; it must stop emitting the sandbox class entirely for the user worker).
- **Containers strip.** `buildSandboxUploadContainers` returns `null` when emitting cross-script form, so the `containers` field is omitted from user-worker metadata.

The existing helpers (`buildSandboxUploadBindings`, `buildSandboxUploadContainers`, `buildDurableObjectUploadMigrations`) accept a new `crossScriptHost: { scriptName: string } | null` argument and produce the rewritten shape.

The framework is NOT modified. Local `wrangler dev` continues to declare the class same-script with a `containers` block, which works for local development.

### 4. Provisioning ordering in the deploy pipeline

The host MUST be PUT before the user worker, because cross-script bindings fail at user-worker PUT time if `script_name` does not exist in the dispatch namespace.

Insertion point: a single `provisionSandboxHost(...)` call placed AFTER the deployment row has been created (`deploy.ts:~2138-2150`) and BEFORE metadata assembly begins (`deploy.ts:~2674`). Concretely: insert immediately after the `assertDeploymentNotCanceled` that follows the deployment-row-insert, around line ~2160-2170 (precise line determined at implementation; the constraint is "after row insert, before metadata assembly").

The existing `deploySandboxContainer` call at `deploy.ts:2771-2782` is REMOVED entirely — its responsibilities (namespace lookup + container POST) are absorbed into `provisionSandboxHost`.

The new ordering is:

1. Deploy row insert (existing).
2. `provisionSandboxHost` (new — runs inside its own `db.transaction` with `FOR UPDATE`).
3. `assertDeploymentNotCanceled` (existing pattern after each external-side-effect step).
4. Metadata assembly with cross-script-host rewrite (existing assembly + new rewrite).
5. User-worker PUT (existing, ~line 2740-2768).
6. Continue with migrations, asset session, routing flip, etc. (existing).

If `provisionSandboxHost` throws, the deploy fails before user-worker PUT — clean failure shape. The deployment row is left as `status='failed'`.

### 5. No changes to rollback

Rollback is left untouched. The target deployment's user worker has a cross-script binding to `do-host-${slug}`; the host and namespace are stable; the container app is stable. Sandbox runtime calls from the rolled-back worker resolve to the same DOs as before — same state, same filesystem, same running processes.

This is the explicit "container apps don't roll back, by design" property: container app lifecycle is decoupled from deploy lifecycle.

### 6. Pre-PR cutover for stuck tenants

A small set of projects deployed under the pre-PR-#0067 codepath have stale CF container apps bound to per-deploy DO namespaces. The platform does NOT self-heal them: the DO namespace binding is immutable on PATCH, so the only way to rebind is a CF-side DELETE + POST, and silently destroying a tenant's container state on their next deploy is exactly the failure mode this architecture exists to prevent. Instead, `provisionSandboxHost` throws a clear runbook-pointing error when it sees a same-name container app on a mismatched namespace, and the operator runs `wrangler containers delete proj-<id>-void-sandbox` once per affected tenant before that tenant's next deploy.

The full operator runbook lives in `meta/operations.md` under "Pre-PR-#0067 sandbox cutover". The affected tenants (recappi, `dtnyzh0qckg3`, `2ves8mgqb4po`, `60c3lfqptd2i`) are notified ~24h in advance so they can communicate the one-time reset to their users; sandbox state from before the cutover is unrecoverable by design.

Pre-existing per-deploy `user-${slug}-${dpl_*}` scripts created BEFORE the fix have inline `Sandbox` class declarations and same-script bindings; those scripts continue to mint orphaned per-script namespaces but are harmless and age out via the platform's existing 5-deploy retention loop at `deploy.ts:3203-3232`.

### 7. Project teardown

Today's teardown (`packages/api/src/routes/delete.ts:8-30` → `cleanupProjectResources` at `packages/api/src/provisioning/cleanup.ts:50-80`) snapshots `getAllProjectDeployments` + `getProjectResources` + `getDomainsByProjectId` BEFORE running CF cleanup, and the snapshot is taken outside any project-row lock. A sandbox deploy that is about to acquire `provisionSandboxHost`'s `FOR UPDATE` lock can race this snapshot: teardown reads "no host resource", deploy then writes the host + container + resource row, teardown deletes the DB rows via `deleteProjectCascade` and the CF host/container is now orphaned with no DB pointer.

To close this race, teardown MUST take the same per-project serialization primitive as provisioning, AND it must mark the project as terminal so any deploy already past its precheck either fails fast or no-ops cleanly.

**Required changes to the teardown path:**

1. **Add `projects.status` (or reuse an existing column)** with values like `'active' | 'deleting'`. If the schema already has a suitable column, reuse it; otherwise add one (additive migration).
2. **In the delete route** (`delete.ts:8-30`), wrap the entire flow in a `db.transaction` that begins with `SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`, then sets `status = 'deleting'`, then commits (releasing the lock). The `'deleting'` flag is the durable hand-off — any subsequent `provisionSandboxHost` that tries to grab the lock will see `status = 'deleting'` after acquiring it and abort with a clear error before mutating CF state.
3. **In `provisionSandboxHost`** (§2 step 1, after acquiring the FOR UPDATE lock), check `project.status`. If `'deleting'`, throw `ProjectDeletingError` (deploy fails fast; host/container are not created).
4. **In `cleanupProjectResources`**, the snapshot read happens AFTER the status flip. Any deploy that did pass provisioning before the flip has already created its host/container, and those CF resources will be in the snapshot's `getProjectResources` result.
5. **CF cleanup steps remain as today** but extend the worker-name set to also include the host script `do-host-${slug}` (idempotent DELETE) and the resources iteration to DELETE the container app via `deleteContainerApplicationIdempotent`.
6. **`deleteProjectCascade` runs after CF cleanup** as today; cascade removes the `resources` rows including the sandbox host's row.

Each CF step is independently idempotent. Partial failure modes:

- Host script DELETE 404 → swallowed, continue.
- Container app DELETE 404 → swallowed, continue.
- Container app DELETE 5xx → propagate; project-deletion endpoint returns 5xx; operator retries (project stays in `'deleting'` state, no deploys can run, CF DELETEs replay idempotently).
- DB cascade fails after CF DELETEs succeed → orphaned `resources` row references nothing but is harmless. Operator can re-run teardown.

Status flip ordering matters: status MUST be flipped to `'deleting'` BEFORE the cleanup snapshot is taken, so a concurrent deploy either runs to completion before the flip (its CF resources show up in the snapshot) or aborts at the post-lock status check.

The teardown handler logs the final state (which CF resources were deleted, which DB rows cascaded) so operations can audit incomplete teardowns.

### 8. Idempotent DELETE wrapper

Add `deleteContainerApplicationIdempotent` next to the existing `deleteContainerApplication` (`containers.ts:193`). The new helper catches `CloudflareApiError` with `status === 404` and returns silently; other errors re-throw.

```ts
export async function deleteContainerApplicationIdempotent(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  try {
    await deleteContainerApplication(accountId, apiToken, applicationId);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return;
    }
    throw err;
  }
}
```

### 9. Removal of per-deploy container plumbing

With the host owning the namespace and the container app, the following code becomes unnecessary:

- `assertNamespaceMatch` (`containers.ts:266-279`) — convert to a defensive predicate used inside `provisionSandboxHost`'s verification, or delete entirely.
- `upsertSandboxContainerApplication` (`containers.ts:116-191`) — replaced by `provisionSandboxHost`. Its PATCH+rollout body lifts into the new helper.
- `deploySandboxContainer` call at `deploy.ts:2771-2782` — removed; `provisionSandboxHost` runs much earlier in the pipeline (§4).
- Same-script DO migration entry for `Sandbox` in user-worker metadata (stripped via §3 rewrite).
- Per-deploy `containers: [{ name, class_name, image }]` block in user-worker metadata (stripped via §3 rewrite).

### 10. Schema migration

Live `resources` schema (`packages/api/src/schema.ts:151-164`):

```ts
export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    type: text('type').notNull().$type<'d1' | 'kv' | 'r2' | 'queue' | 'hyperdrive' | 'container'>(),
    cf_id: text('cf_id').notNull(),
    binding_name: text('binding_name').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.project_id, t.type, t.binding_name)],
);
```

Add a `metadata` jsonb column to `resources`:

```ts
metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
```

Add a `status` text column to `projects` (or reuse an existing equivalent if one exists; verify before generating the migration):

```ts
status: text('status').notNull().default('active').$type<'active' | 'deleting'>(),
```

Generate the Drizzle migration via `pnpm -C packages/api drizzle-kit generate`. Both columns are additive with NOT NULL DEFAULTs and forward-compatible per the platform's deploy-protocol-stability rule (CLAUDE.md): old code ignores both; new code reads `status` to gate provisioning and writes `metadata` for sandbox provisioning.

The `type` enum is NOT changed — the existing `'container'` row captures sandbox container apps, with `metadata.namespaceId` and `metadata.hostScriptName` carrying the additional fields. No new enum value, no check-constraint changes.

For stuck tenants whose `resources` row predates this change, `metadata` defaults to `{}` and `binding_name` is already `'void-sandbox'` (the manifest's `containerName`). The §2 step 1 lookup uses `binding_name = manifest.sandbox.containerName` and HITS the existing row; the cached-fast-path check (§2 step 2) treats missing `metadata.namespaceId` as a verification miss and falls through to create-or-recover (§2 step 4). Step 4's UPSERT writes the same key, updating the existing row in place rather than creating a duplicate. This is what makes the stuck-tenant migration self-healing without a one-shot backfill job.

### 11. Test infrastructure

`packages/api/test/integration/helpers.ts` `mockCfApi` (lines 551-577 and 579-642) does not currently model container applications, host scripts, or per-script binding endpoints. Extend the mock:

- Stateful container application handlers keyed by name (POST/PATCH/DELETE/GET).
- Stateful host scripts: PUT on `dispatch/namespaces/{ns}/scripts/{name}` mints a stable `(script_name, class_name) → namespace_id` map only when `migrations.new_sqlite_classes` is present; subsequent PUTs without migrations preserve the namespace.
- GET on the script's bindings endpoint returns a `durable_object_namespace` binding row with the minted namespace_id whenever the script's metadata declared one.
- 409 on POST when a container app name conflict exists.
- 404 on DELETE/GET for unknown ids.
- Cross-script binding resolution: when a user worker is PUT with `script_name: do-host-${slug}` in any binding, the mock validates the host exists in the dispatch namespace (404s if missing) — catches a framework-emits-same-script regression.
- Recording of CF call ordering so tests can assert "host PUT preceded user-worker PUT".

### 12. Tests

Unit (`packages/api/test/unit/sandbox-host.test.ts`):

1. `provisionSandboxHost`: no existing host → `putSandboxHostScript` GETs migration_tag (mock returns null), PUTs host with self-binding + initial migrations + bundled bytes, GET bindings, POST container, UPSERT resource row with `binding_name='void-sandbox'` and metadata.
2. `provisionSandboxHost`: existing valid host (namespace + container match cache; config unchanged) → no host PUT, no namespace lookup, no container POST/DELETE/PATCH.
3. `provisionSandboxHost`: existing valid host, container config drift (image change) → existing-host fast path PATCHes container + posts rollout; no host PUT.
4. `provisionSandboxHost`: existing host record but host script HEAD 404 → recovery runs `putSandboxHostScript` (mock returns tag null → initial migrations sent) + GET + idempotent DELETE of any orphaned container + POST.
5. `provisionSandboxHost`: pre-PR-#0067 stuck-tenant fixture — pre-fix `container` resource row keyed by `binding_name='void-sandbox'` with empty `metadata`, container app on a mismatched namespace. Lookup HITS the existing row; create-or-recover runs; `findContainerApplication` returns the stale app on a different namespace → throws an Error whose message contains `wrangler containers delete` (the runbook hint). NO compensating DELETE; CF state untouched; transaction rolls back so no UPSERT lands.
6. **Partial-failure replay**: existing host PUT succeeded earlier but resource row UPSERT never happened (transaction rolled back). Next call to `provisionSandboxHost` enters create-or-recover; `fetchScriptMigrationTag` returns `'void-sandbox-host-v1'`; `putSandboxHostScript` PUTs the host with NO `migrations` field (mock asserts the migrations field is omitted); namespace_id is preserved (not rotated); container POST creates fresh container; row written.
7. `provisionSandboxHost`: stale container POST after DELETE returns 409 with the lock held → re-find, namespace match → returns it but logs WARN about unexpected race (no concurrent first deploy was possible under the lock).
8. `provisionSandboxHost`: project status is `'deleting'` → throws `ProjectDeletingError` BEFORE any CF mutation.
9. `putSandboxHostScript`: mock returns tag `null` → PUT body includes `migrations: [{ tag: 'void-sandbox-host-v1', new_sqlite_classes: ['Sandbox'] }]`.
10. `putSandboxHostScript`: mock returns tag `'void-sandbox-host-v1'` → PUT body OMITS `migrations` field entirely.
11. `deleteContainerApplicationIdempotent`: 404 swallowed; non-404 propagates.
12. `rewriteSandboxMetadataForCrossScriptHost`: same-script `Sandbox` binding rewritten to cross-script form; `Sandbox` removed from `new_sqlite_classes`; `containers` block removed.
13. `rewriteSandboxMetadataForCrossScriptHost`: non-sandbox manifest is passed through unchanged.

Integration (`packages/api/test/integration/api-sandbox.test.ts` — new file):

1. **First sandbox deploy** — host script created, namespace minted, container app created, user worker uses cross-script binding. Assert CF call ordering: host PUT precedes user-worker PUT (mock-recorded).
2. **Sandbox redeploy unchanged config** — second deploy's mock recorder shows zero host PUTs, zero container POSTs/DELETEs/PATCHes. Only the new user worker is PUT.
3. **Sandbox redeploy with container config change** — manifest carries new image; existing-host fast path PATCHes container + posts rollout.
4. **Sandbox redeploy after stale host script (HEAD 404)** — DB cache says host exists; CF disagrees; recovery re-PUTs host (initial migrations because the script truly does not exist; mock returns tag null); container verified.
5. **Sandbox redeploy after partial-failure replay** — fixture: previous deploy's host PUT succeeded but the transaction rolled back so the resource row is missing. Next deploy enters create-or-recover; `fetchScriptMigrationTag` returns `'void-sandbox-host-v1'`; `putSandboxHostScript` PUTs with NO migrations field (mock-asserted); namespace_id is unchanged from before; container POSTed; row written. Critical regression test for finding #2 from review round 2.
6. **Pre-PR-#0067 stuck-tenant cutover** — fixture seeded with pre-fix `resources` row keyed by `binding_name='void-sandbox'` (matches `containerName`) with empty `metadata`, container app on a mismatched namespace. Deploy returns an SSE `error` event whose message contains `wrangler containers delete` and `meta/operations.md` (the runbook). No `done` event. Assert that no DELETE was issued against the stale container app (operator owns cutover via runbook) and the stale app is still present in CF state on the original mismatched namespace.
7. **Concurrent two sandbox deploys for same project (first deploy)** — both run `provisionSandboxHost`; project-row `FOR UPDATE` serializes them; only one PUT host + POST container; both deploys succeed.
8. **Deploy in progress + rollback initiated** — rollback's `FOR UPDATE` blocks; after deploy commits, rollback observes the active row and 409s.
9. **Rollback preserves sandbox state** — deploy v1 (sandbox), deploy v2 (sandbox), rollback to v1 → routing flips to v1's user worker; v1's metadata has cross-script binding to host; sandbox state survives. Mock-asserted: zero host operations, zero container DELETEs during rollback.
10. **Project teardown serializes with provisioning** — fire `DELETE /projects/:id` and `POST /projects/:id/deploy` (sandbox) concurrently. Outcome A: deploy wins the lock first → host/container created; teardown waits, takes the lock, sets `status='deleting'`, snapshot includes the new resources, CF cleanup deletes them. Outcome B: teardown wins the lock first → status flipped to `'deleting'`; deploy then takes the lock and sees the status, throws `ProjectDeletingError`, no host/container created; teardown's snapshot is empty for sandbox resources, no orphans. Critical regression test for finding #3 from review round 2.
11. **Project teardown deletes host + container** — DELETE project triggers host script DELETE + container app DELETE + resources cascade. Verify all three.
12. **Regression: framework-emitted same-script binding fails fast** — fixture user worker manifest has `class_name: 'Sandbox'` without `script_name` AND the rewrite is intentionally skipped → user-worker PUT validates against the dispatch namespace mock and fails because the same-script Sandbox class is not declared on the user script. Catches a rewrite-bypass regression.

### 13. Documentation

`framework/docs/guide/sandboxes.md` — affirm that sandbox state persists across deploys and rollbacks; project deletion is the only state-loss event.

`framework/docs/reference/api.md` — sentence near `getSandbox` confirming session-id stability across deploys.

`meta/lessons.md` appends:

```
## Sandbox DO namespaces are owned by a stable per-project host script

Per-deploy WfP scripts mint a fresh DO namespace on each PUT. Sandbox container
apps' `durable_objects.namespace_id` is immutable on PATCH, so per-deploy
ownership of the Sandbox class breaks on the second deploy.

The fix: a stable `do-host-${slug}` WfP script per sandbox project owns the
`Sandbox` class. Per-deploy user workers reference the namespace via cross-
script DO bindings (`script_name: "do-host-${slug}"`). Container apps bind to
the host's namespace once and remain valid for the project's lifetime.

Consequences worth knowing:
  - Sandbox container state persists across deploys and rollbacks. Feature.
  - Container apps are not versioned and do not roll back. Lifecycle is bound
    to the project, not to deploys. Configuration drift (image/size) is still
    reconciled via PATCH+rollout on every deploy.
  - Cross-script bindings fail at PUT time if the host script does not exist;
    provisioning runs BEFORE user-worker metadata assembly and PUT.
  - Host script PUTs after the first MUST use the `migration_tag` protocol so
    the namespace does not rotate.
  - The host script must declare a same-script `durable_object_namespace`
    self-binding so namespace_id is exposed via the per-script bindings
    endpoint (the only way to read namespace_id without paging the global
    listing).
  - Host source `@cloudflare/sandbox` is bundled at API build time into a
    committed artifact; runtime PUT inlines the bundled bytes.
  - Framework continues to emit same-script bindings for local `wrangler dev`;
    the platform rewrites metadata at upload time.
```

`meta/operations.md` — runbook entries for (a) "host script orphaned after partial teardown failure" (operator action is to DELETE the host script + container app via the CF API) and (b) "Pre-PR-#0067 sandbox cutover" (one-time `wrangler containers delete` for the four affected stuck tenants before their next deploy).

## Edge cases

| Case                                                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand-new sandbox project, first deploy                                               | Host PUT mints namespace. Container POST. User worker PUT with cross-script binding. Three CF objects total, all stable thereafter.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sandbox redeploy, no config change                                                    | Host fast path is HEAD-only; no PUTs/POSTs/PATCHes for host or container. Only the user worker is PUT. Sandbox state preserved.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sandbox redeploy, container config change                                             | Existing-host path PATCHes container + posts rollout. Namespace and host script untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pre-PR-#0067 stuck-tenant first post-fix deploy                                       | `provisionSandboxHost` looks up `(project_id, type='container', binding_name='void-sandbox')` — HITS existing row. Empty metadata triggers create-or-recover; host PUT mints fresh namespace; `findContainerApplication` locates stale container on a different namespace → THROWS with `"wrangler containers delete <name>"` runbook hint. Deploy fails fast; transaction rolls back; no DELETE is issued by the platform. Operator runs `wrangler containers delete` per the cutover runbook (`meta/operations.md`); next deploy succeeds. |
| Partial-failure replay: prior deploy created host, then failed before resource UPSERT | Next deploy enters create-or-recover. `fetchScriptMigrationTag` returns `'void-sandbox-host-v1'`. `putSandboxHostScript` PUTs WITHOUT `migrations` field — namespace_id preserved. Container POSTed (or PATCHed if already present on host namespace). Row written.                                                                                                                                                                                                                                                                          |
| Concurrent project-delete + sandbox deploy                                            | Per §7: teardown takes `FOR UPDATE`, flips `status='deleting'`, commits. Deploy then takes the lock, sees `status='deleting'`, throws `ProjectDeletingError` before any CF mutation. OR deploy wins first: host/container created; teardown then waits, takes lock, snapshots resources (now including the host), CF cleanup deletes them. No orphans either way.                                                                                                                                                                            |
| Stuck tenant has concurrent deploys                                                   | First wins via `FOR UPDATE` on the project row; second observes the cached host record and is a no-op for host/container.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Two concurrent first deploys for the same brand-new project                           | `FOR UPDATE` serializes them inside `provisionSandboxHost`; loser observes the cached row in step 2 and is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Host script PUT fails                                                                 | Deploy fails before user worker PUT and before metadata assembly; no partial state.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Stale container app DELETE fails (5xx/network)                                        | Provisioning fails; transaction rolls back; user worker not PUT. Operator retries deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Container app POST fails after stale DELETE                                           | Provisioning fails; resource row not updated; transaction rolls back. Next deploy retries host create-or-recover, sees existing host but no container, re-POSTs.                                                                                                                                                                                                                                                                                                                                                                             |
| Tenant manually deletes host script via CF dashboard                                  | Next deploy's fast-path HEAD returns 404; create-or-recover runs PUT (mints fresh namespace) + idempotent DELETE of any container on stale namespace + POST. One-time state loss; logged at WARN.                                                                                                                                                                                                                                                                                                                                            |
| User worker PUT fails because cross-script binding can't resolve                      | Cannot happen with §4 ordering — host PUT always precedes user-worker PUT. Caught by integration tests #1 (ordering) and #10 (regression).                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sandbox runtime call from a rolled-back user worker                                   | Resolves to the host's namespace. Same DOs as the latest forward deploy. **No fix needed; this is the architectural property.**                                                                                                                                                                                                                                                                                                                                                                                                              |
| Project deletion                                                                      | Teardown DELETEs the host script and container app via idempotent helpers; resources rows cascade-deleted. Sandbox state lost (by design).                                                                                                                                                                                                                                                                                                                                                                                                   |
| Slug rename for a sandbox project                                                     | Out of scope. Host script name encodes the slug; renaming would orphan the host. Treat slug as immutable for sandbox projects.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Host script needs upgrade (`@cloudflare/sandbox` version bump)                        | Re-PUT host using the `migration_tag` protocol with no new migration steps. Namespace stays put. Container app untouched. CI enforces that the regenerated bundle is committed.                                                                                                                                                                                                                                                                                                                                                              |
| Compatibility window during fix rollout                                               | A user deploy in flight at the moment the platform deploys this fix uses the OLD code path (containers block + same-script binding). It completes (or fails) per old behavior. The next deploy after the fix lands sees a `resources` row with empty `metadata` (or a stale per-deploy container app) and runs the stuck-tenant migration path automatically.                                                                                                                                                                                |

## Concrete file plan

- `packages/api/src/provisioning/sandbox-host.ts` (new) — `provisionSandboxHost`, `putSandboxHostScript`, `fetchScriptMigrationTag`, `SandboxHostInfo` type, `ProjectDeletingError`. Uses `findDurableObjectNamespaceId`, `findContainerApplication`, `tryCreateContainerApplication`, `deleteContainerApplicationIdempotent`, container PATCH+rollout. Wraps everything in a `db.transaction` with `FOR UPDATE` on the project row, and checks `project.status !== 'deleting'` after acquiring the lock.
- `packages/api/src/provisioning/sandbox-host-source/index.ts` (new) — authoritative source for the host script.
- `packages/api/src/provisioning/sandbox-host-bundle.generated.ts` (new, committed) — generated. Exports `BUNDLE_BYTES`, `BUNDLE_SHA256`, `COMPATIBILITY_DATE`.
- `packages/api/scripts/build-sandbox-host.ts` (new) — runs tsdown/rolldown over the source, writes the generated file. Wired to `packages/api/package.json` as `build:sandbox-host` and enforced in CI via `git diff --exit-code`.
- `packages/api/package.json` — pin `@cloudflare/sandbox` (exact version), add `build:sandbox-host` script.
- `packages/api/src/provisioning/containers.ts`:
  - Add `deleteContainerApplicationIdempotent`.
  - Remove `upsertSandboxContainerApplication` (PATCH+rollout body lifts into `provisionSandboxHost`).
  - Convert `assertNamespaceMatch` to a defensive predicate or delete.
  - Keep `findDurableObjectNamespaceId`, `findContainerApplication`, `tryCreateContainerApplication`.
- `packages/api/src/routes/deploy.ts`:
  - Insert `provisionSandboxHost` call at line ~2160-2170 (after deployment row insert + `assertDeploymentNotCanceled`, BEFORE metadata assembly).
  - Update metadata-assembly helpers (`buildSandboxUploadBindings`, `buildSandboxUploadContainers`, `buildDurableObjectUploadMigrations`) to accept a `crossScriptHost: { scriptName: string } | null` argument and produce the rewritten shape. The metadata-assembly call site (~lines 2674-2705) passes the SandboxHostInfo through.
  - Remove the `deploySandboxContainer` call at lines 2771-2782 entirely.
  - Wrap the deploy precheck (lines 1244-1263) and the deployment row insert (lines 2138-2150) in a single `db.transaction` that begins with `SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`.
- `packages/api/src/routes/delete.ts` — wrap the entire handler in a `db.transaction` with `SELECT ... FOR UPDATE` on the project row; flip `status='deleting'` and commit BEFORE calling `cleanupProjectResources`. Subsequent CF cleanup snapshot is taken after the status flip is durable.
- `packages/api/src/provisioning/cleanup.ts` — extend the worker-name set to include `do-host-${slug}`; iterate `resources` of `type='container'` and DELETE each via `deleteContainerApplicationIdempotent`.
- `packages/api/src/schema.ts`:
  - Add `metadata: jsonb('metadata').notNull().default(sql\`'{}'::jsonb\`).$type<Record<string, unknown>>()`to`resources`.
  - Add `status: text('status').notNull().default('active').$type<'active' | 'deleting'>()` to `projects` (or reuse if a suitable column already exists — verify before generating migration).
- `packages/api/drizzle/<next>.sql` — generated migration adding both columns.
- `packages/api/test/integration/helpers.ts` — extend `mockCfApi` with stateful host scripts, container application handlers, cross-script binding validation, and call-order recording.
- `packages/api/test/unit/sandbox-host.test.ts` (new) — 13 cases per §12 (test #5 asserts the pre-PR-#0067 cutover error path; no auto-migration).
- `packages/api/test/integration/api-sandbox.test.ts` (new) — 12 cases per §12 (test #6 asserts the pre-PR-#0067 cutover SSE error event; no auto-migration).
- `framework/docs/guide/sandboxes.md` — affirm cross-deploy state persistence.
- `framework/docs/reference/api.md` — sentence near `getSandbox`.
- `meta/lessons.md` — append the lesson per §13.
- `meta/operations.md` — orphan-host runbook entry.

NO changes to `framework/packages/void/src/runtime/sandbox.ts`, `framework/packages/void/src/cli/wrangler.ts`, or any framework codegen — local `wrangler dev` continues to use same-script bindings + containers block; the platform rewrites at upload time.

Estimated diff: ~600-700 lines including code, generated bundle, mock infrastructure, tests, and docs.

## Pre-PR cutover

The four pre-PR-#0067 stuck sandbox tenants (recappi, `dtnyzh0qckg3`, `2ves8mgqb4po`, `60c3lfqptd2i`) need a one-time operator-driven cutover before their next deploy after this PR ships: the platform throws a clear runbook-pointing error when it sees a same-name container app on a mismatched namespace, and the operator runs `wrangler containers delete proj-<id>-void-sandbox` once per affected tenant to clear the stale CF state. The tenants are notified ~24h in advance so they can communicate the one-time reset to their users; sandbox state from before the cutover is unrecoverable by design.

The exact operator steps live in `meta/operations.md` under "Pre-PR-#0067 sandbox cutover". After the cutover, the tenant's next deploy creates a fresh host and container app, and sandbox state persists across all subsequent deploys and rollbacks per the architecture's normal guarantees.

## Verification

1. `pnpm -C packages/api build:sandbox-host && git diff --exit-code packages/api/src/provisioning/sandbox-host-bundle.generated.ts` — committed bundle matches source-of-truth.
2. `pnpm -C packages/api test test/unit/sandbox-host.test.ts` — all cases pass (test #5 asserts the cutover throw, not auto-migration).
3. `pnpm -C packages/api test test/integration/api-sandbox.test.ts` — all cases pass; existing tests unaffected (test #6 asserts the cutover SSE error event, not auto-migration).
4. `pnpm -C packages/api test test/integration/api-migrations.test.ts` — regression: the existing `hashtext` / `pg_advisory_xact_lock` rejection test (line 5620) MUST still pass.
5. `pnpm -C packages/api typecheck` clean.
6. `pnpm -C packages/api lint` clean.
7. Staging:
   - Brand-new sandbox project: deploy → succeeds; verify host script + container app + user worker present; confirm host PUT precedes user PUT (CF audit logs).
   - Redeploy with no config change → CF mock records zero host PUTs, zero container POSTs/DELETEs/PATCHes.
   - Redeploy with image change → container PATCH+rollout fires; host untouched.
   - Concurrent two deploys → both succeed (one short-circuits via cached host).
   - Project deletion → host script and container app deleted.
8. Production after merge: run the "Pre-PR-#0067 sandbox cutover" runbook in `meta/operations.md` for the four affected tenants (24h heads-up, then `wrangler containers delete proj-<id>-void-sandbox`), then verify their next deploy succeeds with a fresh host + container.

## Out of scope (TODOs)

- **Silent DO storage rotation footgun for non-sandbox DO users.** Latent today; document as a known limitation in deploy lifecycle docs. A general fix would extend the host pattern to all user-declared DO classes — separate effort.
- **Per-deploy churn for secrets, queue consumers, tail consumers, cron triggers.** Not addressed here.
- **Pre-existing partial-routing-failure imperfection** (`deploy.ts:3282-3297`). Not fixed here.
- **Slug rename for sandbox projects.** Document as unsupported, or design a rename migration as a separate runbook.
- **Host script upgrades (`@cloudflare/sandbox` version bump).** When we eventually upgrade, ship a one-shot migration job that walks all sandbox projects and re-PUTs the host using `migration_tag` protocol with no new migration steps. Out of scope; deferred until a real upgrade is needed.
- **Local `wrangler dev` for projects that share container state with prod.** Local dev creates its own per-developer Sandbox namespace; not connected to the prod host. Matches today's behavior.

## Resolution: per-deploy architecture

The cross-script-host architecture above shipped in PR #131 (`e21d0a75`) and was empirically rejected by Cloudflare in production. The user-worker PUT — which carried `durable_object_namespace` bindings with `script_name: "do-host-${slug}"` — failed with CF error code 10061: `Cannot create binding for class in script 'do-host-${slug}' that does not exist.` The host script DOES exist in the same dispatch namespace, but CF's resolver does not look there.

A subagent investigation against the upstream `~/workspace/github/workers-sdk` source confirmed the cause. The `script_name` field on a `durable_object_namespace` binding has no scope qualifier — no `dispatch_namespace`, no `account_namespace_id`. CF resolves it against account-level Workers only. WfP scripts inside a dispatch namespace are not visible to that resolver. The two unblocked options were: (a) move the host out of the dispatch namespace into account-level Workers; or (b) abandon stable-host ownership and put the `Sandbox` class back on the per-deploy user worker.

We picked (b) — per-deploy isolation. Each sandbox deploy now creates a fresh user worker that owns its own `Sandbox` class via a same-script DO binding plus a `containers` declaration plus the `void-sandbox-v1` migration step. Because each deploy gets a fresh `(script_name, class_name)` pair, CF mints a fresh DO namespace, and each deploy POSTs its own per-deploy container application bound to that fresh namespace. The container app name is deterministic: `${projectId}-${deploymentId}-${containerName}`, lowercased with `_` → `-` (CF rejects uppercase / underscores). See `packages/api/src/provisioning/containers.ts:189-195` (`perDeployContainerApplicationName`) and `:212-` (`provisionPerDeployContainer`).

Worker module bytes are stored in R2 at `worker-bundles/{projectId}/{deploymentId}/...` (`packages/api/src/assets.ts:1228-1234`) so a future rollback-beyond-retention path can re-PUT a deleted user worker. The re-PUT path is deferred; for now, retained deployments rollback by flipping the routing pointer to a still-live user worker + container.

Lifecycle:

- **First deploy / redeploy:** PUT user worker (mints DO namespace via `new_sqlite_classes: ["Sandbox"]`), GET namespace_id off the bindings endpoint, POST a fresh container app, write a `resources` row with `cf_id = <containerApplicationId>` and `binding_name = manifest.sandbox.containerName`.
- **Retention loop:** DELETE the aged-out user-worker script, its container application (deterministic-name lookup from manifest — `packages/api/src/provisioning/cleanup.ts:129-159` `sweepPerDeployContainerOrphans`), and its R2 bundle objects. Deleting the script alone does NOT free the container app.
- **Project teardown:** enumerates retained deployments via `getAllProjectDeployments`, recomputes each container app name via `perDeployContainerApplicationName`, and DELETEs idempotently.
- **Rollback within retention:** existing pointer-flip works; the target deploy's script + container are still alive.
- **Rollback beyond retention:** re-PUT user worker from the R2 bundle. Deferred follow-up.

Trade-offs accepted:

- ~5s extra per-deploy latency for the per-deploy container application POST.
- Sandbox container state is ephemeral per deploy. Users who need persistence across deploys persist into D1 / KV / R2 explicitly. The previous design's "container state survives deploys" property was a side effect of the stable host; it is not a contract we can keep without account-level Workers.
- The framework's same-script `Sandbox` declaration + `containers` block + migrations entry pass through unchanged. No upload-time metadata rewrite is needed. `wrangler dev` continues to work locally with no platform-specific shape.

The earlier sections (Context, Decision, Implementation, Edge cases, Concrete file plan, Pre-PR cutover) are preserved as archival history of the rejected design. All references to `do-host-${slug}`, `provisionSandboxHost`, `putSandboxHostScript`, the bundled `@cloudflare/sandbox` host source, the `metadata.namespaceId` / `metadata.hostScriptName` fields on the `resources` row, and the cross-script binding rewrite at upload time are obsolete and should be read against the per-deploy resolution above.
