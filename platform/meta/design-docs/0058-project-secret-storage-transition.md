---
title: Project Secret Storage Transition
status: proposed
created: 2026-03-09
depends:
  - 0054-versioned-deployments.md
  - 0057-better-auth-integration.md
---

# Project Secret Storage Transition

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Move project secrets from Cloudflare per-worker secret storage to an encrypted platform-side secret store, backed by the platform PostgreSQL database.

The platform database becomes the control-plane source of truth for project secrets. Deploys read secrets from that store and inject them into each versioned worker upload. Runtime requests continue to read secrets from worker environment bindings, not from the platform database.

This change is required because the current secret model no longer fits versioned deployments:

- `void secret` currently writes to a single worker name, `user-{slug}`
- versioned deploys run as `user-{slug}-{deploymentId}`
- Cloudflare lets us list secret names on a worker, but not read secret values back
- first deploy can fail because the stable worker does not exist yet

Better Auth made this gap visible immediately because it requires a stable per-project secret. The underlying problem is broader: all project secrets need a real project-scoped source of truth that survives redeploys.

## Problem

### Current behavior

Today:

- `GET /projects/:id/secrets` lists secret names from Cloudflare worker secrets
- `PUT /projects/:id/secrets/:name` writes a secret directly to Cloudflare worker secrets
- deploy-time auth secret auto-generation attempts to create `BETTER_AUTH_SECRET` through that same mechanism

This behavior lives in:

- `platform/packages/api/src/routes/secrets.ts`
- `platform/packages/api/src/routes/deploy.ts`

### Why it breaks

The current model assumes there is one durable worker script per project that can also act as the secret store. That assumption is no longer true.

With versioned deploys:

- each deploy gets a distinct script name
- the unversioned `user-{slug}` script may not exist
- even if it exists, it is not the running deployment
- Cloudflare does not expose secret values for reuse in future uploads

That creates three concrete failures:

1. First deploy with managed auth can fail because the target worker for secret creation does not exist.
2. Secret updates do not have a reliable project-scoped home.
3. Future deploys cannot reconstruct secret bindings from prior workers because only names are readable, not values.

## Goals

- Preserve the existing `void secret` product surface.
- Make project secrets truly project-scoped instead of worker-scoped.
- Keep runtime secret access on the worker, not on the platform DB hot path.
- Support versioned deploys without any dependency on a stable worker name.
- Auto-generate and persist `BETTER_AUTH_SECRET` for auth-enabled projects when missing.
- Keep secrets write-only from the user perspective; names can be listed, values cannot.

## Non-Goals

- Reading plaintext secrets back to users.
- Per-request secret fetching from the platform database.
- Cross-project or organization-wide secret sharing.
- A backward-compatible attempt to recover secret values from Cloudflare workers.
- Solving secret management for self-hosted or non-platform targets in this design.

## Decision

Use the platform PostgreSQL database as the encrypted source of truth for project secrets.

At deploy time, the API decrypts the needed values and uploads them into the new versioned worker as `secret_text` bindings. At runtime, the app still reads normal worker env bindings.

This means:

- the database is the durable control-plane state
- the worker environment is the runtime state
- no auth request or app request reads secrets from the platform DB

## Proposed Design

### 1. Data model

Add a `project_secrets` table owned by the control plane.

Suggested shape:

```ts
project_secrets
- id text primary key
- project_id text not null references projects(id) on delete cascade
- name text not null
- ciphertext text not null
- iv text not null
- key_version text not null
- managed_reason text null
- created_at timestamp not null default now()
- updated_at timestamp not null default now()

unique(project_id, name)
```

Notes:

- `managed_reason` is null for user-managed secrets and set for platform-managed secrets such as `auth-default`.
- No plaintext column is stored.
- We do not need soft deletes in v1.

### 2. Encryption model

Secrets must be encrypted before they are written to the database.

Minimum design:

- symmetric AES-GCM encryption
- random IV per secret value
- application-level encryption before DB write
- master key stored outside the database

Required platform config:

- active encryption key version
- a keyring that supports decrypting older rows during key rotation

#### Project secret key configuration

The platform uses two env vars for project-secret encryption:

- `PROJECT_SECRET_KEYS_JSON`: JSON object mapping key-version strings to base64-encoded 32-byte AES keys
- `PROJECT_SECRET_ACTIVE_KEY_VERSION`: the key-version string used for new writes

Example:

```json
{
  "1": "<base64-32-byte-key-v1>",
  "2": "<base64-32-byte-key-v2>"
}
```

With:

```text
PROJECT_SECRET_ACTIVE_KEY_VERSION=2
```

Behavior:

- new or updated secrets are encrypted with the active key version
- each row stores `key_version`, so older rows remain decryptable after rotation
- old keys stay in the keyring until all rows using them have been re-encrypted or deleted

Validation requirements:

- `PROJECT_SECRET_KEYS_JSON` must parse as an object
- every configured key must decode to exactly 32 bytes
- `PROJECT_SECRET_ACTIVE_KEY_VERSION` must exist in the keyring

Rotation flow:

1. add a new key version to `PROJECT_SECRET_KEYS_JSON`
2. switch `PROJECT_SECRET_ACTIVE_KEY_VERSION` to the new version
3. optionally re-encrypt old rows in place
4. remove old key versions only after no rows depend on them

Expected behavior:

- new writes use the active key version
- reads can decrypt with any configured historical key version
- rotation can re-encrypt rows in place later without breaking running apps

Important boundary:

- DB encryption protects against DB-only compromise
- it does not protect against full API-environment compromise, because the API must decrypt secrets to deploy them

### 3. API behavior

The user-facing CLI stays the same:

- `void secret list`
- `void secret put <name>`
- `void secret delete <name>`
- `void secret sync <file>`

The API implementation changes:

#### `GET /projects/:id/secrets`

- list names from `project_secrets`
- do not read secret values

#### `PUT /projects/:id/secrets/:name`

- validate name
- encrypt value
- upsert into `project_secrets`
- if the project has an active worker deployment, propagate the update to that active versioned worker

This route is the primary write path for both normal user secrets and platform-managed auth secret creation.

#### `DELETE /projects/:id/secrets/:name`

- delete from `project_secrets`
- if the project has an active worker deployment, delete from that active versioned worker

### 4. Runtime propagation model

The source of truth is the DB, but live apps should still see secret changes quickly.

When a secret changes:

1. persist the desired state in `project_secrets`
2. if there is an active deployment, update that deployment's worker secret state

The active worker name is deterministic:

```text
user-{slug}-{activeDeploymentId}
```

We should no longer treat `user-{slug}` as the live secret target.

#### Failure semantics

For v1, keep this simple and explicit:

- DB write happens first
- active-worker propagation happens second
- if propagation fails, return an error that tells the caller the secret is stored but not yet live on the current deployment
- retries are safe and idempotent

This keeps deploy correctness intact even if live propagation temporarily fails.

We can add queued retries later if operationally necessary.

### 5. Deploy integration

Deploy must read secrets from `project_secrets`, not from Cloudflare worker secret listings.

Deploy flow changes:

1. load all project secret rows for the project
2. decrypt them in memory
3. add them to the new worker upload as actual `secret_text` bindings
4. complete deploy as usual

This makes each versioned worker self-contained at upload time.

Deploy should not depend on:

- the existence of `user-{slug}`
- secret names listed on previous workers
- reading secret values back from Cloudflare

### 6. Managed auth secret behavior

When `manifest.auth` is true:

- if `BETTER_AUTH_SECRET` exists in `project_secrets`, use it
- else generate `BETTER_AUTH_SECRET`, encrypt it, store it, and include it in the deploy

Rules:

- generation happens once per project, not once per deploy
- generated auth secrets are marked with `managed_reason = "auth-default"`
- users can later overwrite `BETTER_AUTH_SECRET` explicitly through `void secret put`
- `BETTER_AUTH_SECRET` is the only platform-managed auth secret name

### 7. Manifest vars and reserved auth secret names

Hosted deploys should not accept `BETTER_AUTH_SECRET` through `manifest.vars`.

Reason:

- deploy manifests are stored as deployment records
- manifest vars are not treated as secrets
- allowing auth secrets there would persist sensitive plaintext in the control plane

Proposed behavior:

- on hosted deploys, reject `BETTER_AUTH_SECRET` in `manifest.vars` with an actionable error
- direct users to `void secret put BETTER_AUTH_SECRET`

This keeps the secret path unambiguous and avoids accidental plaintext persistence.

### 8. Operational decisions for v1

The design makes two explicit v1 decisions:

- secret propagation to the active versioned worker is inline-only; we are not adding an outbox or retry queue in the initial implementation
- `BETTER_AUTH_SECRET` is the only reserved public auth secret name; we are not supporting `AUTH_SECRET`

Rationale:

- inline propagation is the smallest design that keeps desired state in the DB and runtime state in the worker; if Cloudflare propagation fails, the DB remains correct and the next deploy will converge
- dropping `AUTH_SECRET` avoids alias ambiguity before launch and keeps the managed-auth path and docs centered on one secret name

## Transition Plan

### Phase 1: Add encrypted platform secret storage

- add `project_secrets` table
- add encryption helpers and key configuration
- update secret APIs to read and write the DB-backed store
- keep CLI unchanged

### Phase 2: Propagate to active versioned workers

- resolve active deployment from `projects.active_deployment_id`
- on secret put/delete, patch the active versioned worker's secrets
- stop writing to `user-{slug}`

### Phase 3: Make deploys DB-backed

- remove deploy-time secret discovery from Cloudflare worker secret listings
- load project secrets from the DB and inject them into each new worker upload
- auto-generate `BETTER_AUTH_SECRET` by writing to the DB first, then deploying

### Phase 4: Remove worker-scoped secret assumptions

- stop querying `user-{slug}` for project secret state
- keep the DB as the only supported project secret source of truth

## Security Implications

This change expands Void's responsibility.

Today, the platform proxies secret writes to Cloudflare. Under the proposed model, the platform stores recoverable encrypted secret material itself.

That means we must treat the platform as a real secret manager:

- application-level encryption at write time
- no plaintext secret values in DB rows
- no plaintext in API responses
- strict log redaction
- careful handling of backups and SQL access
- explicit key rotation support

This is still preferable to the current design because the current design is not correct under versioned deployments.

## Alternatives Considered

### 1. Keep Cloudflare worker secrets as the source of truth

Rejected.

It does not work with versioned workers because:

- the stable worker may not exist
- the active worker name changes every deploy
- secret values cannot be read back for future uploads

### 2. Read secrets from the DB on every auth request

Rejected.

That would put the platform database on the runtime hot path, add latency, and couple app auth availability to control-plane DB availability.

### 3. Store only `BETTER_AUTH_SECRET` in the DB

Rejected.

It solves the Better Auth symptom, but not the general project-secret problem. `void secret` would still not have a correct project-scoped source of truth for other secrets.

### 4. Use a provider-native project secret store instead of the DB

Still attractive long term, but not assumed available here.

If Cloudflare offers a project-level secret store that supports:

- write-only secret creation
- deploy-time binding by reference
- versioned worker compatibility

then we could revisit this and potentially avoid storing user secrets in platform Postgres.

## Recommendation

Implement the DB-backed encrypted project secret store now, with:

- DB as source of truth
- worker env as runtime state
- inline propagation to the active versioned worker
- one-time managed `BETTER_AUTH_SECRET` generation for auth-enabled projects
- `BETTER_AUTH_SECRET` as the only reserved auth secret name

This is the smallest design that is actually correct under versioned deployments and supports the Better Auth rollout without putting the platform DB on the request path.
