---
title: Project Cloudflare Zero Trust protection
status: implemented
created: 2026-09-22
---

# Project Cloudflare Zero Trust protection

## Decision

A self-hosted installation can put Cloudflare Access in front of project
hostnames. Installation administrators choose identity providers, reusable
policies, and the default for new projects. Owners and project administrators
override one project (`protect` / `public`); readers inspect. This is separate
from the Access applications that protect the platform API or provide an OIDC
login method.

Direct Cloudflare deployments get no project protection. They share the cache
change below: a request with `Cf-Access-Jwt-Assertion` bypasses the direct ISR
KV and edge caches, and `SHARED_CACHE_POLICY_VERSION` 2 makes direct ISR entries
written under version 1 unreadable, so they render once after upgrade.

## Resources and credentials

Void owns only applications recorded in PostgreSQL by ID or by a name committed
before the create request (names carry a random nonce, so recovery never adopts
a pre-existing application). When a recorded ID is gone, the single application
holding its name is Void's own replacement and is adopted:

- one wildcard application for the project domain and workers.dev project
  origins (limited to the installation's ingress prefix);
- one exact-host bypass per public project;
- one exact application per protected project with custom domains (at most
  100 domains).

Footprint: `1 + public projects + protected projects with custom domains`
against Cloudflare's default 500 applications per account.

The Access token is separate from the runtime token, always used with the
installation's `CF_ACCOUNT_ID`, encrypted with the platform credential keyring,
and redacted from reads, previews, and audit targets. Protection policies need
an identity-bound Allow policy; Bypass, Service Auth, Everyone, and
any-service-token rules are rejected.

## State

`zeroTrust.configuration` (platform setting) holds: `revision` (compare-and-swap;
every write increments it, so equal revision means equal snapshot), `enabled`,
`protectNewProjects`, selections, account/team, credential, the lifetime
`wildcardApplicationName`, the wildcard handle, `lastError`, and `operation`
(`id`, `kind`, `phase`, lease owner/expiry, database `startedAt`,
`existingProjects`, optional `applicationTarget`). Status is not stored:
`error` if `lastError`, else `ready` without an operation, else `configuring`
or `disabling` by kind. A corrupt saved value is server state: reads report
`invalid_configuration`; operator/admin mutations return 500 naming the
setting, project mutations return 409.

`project_zero_trust` holds desired/effective protection, `status`
(`ready|reconciling|error`, with `ready` implying desired = effective),
application handles, routing cursor, `reconciled_operation`, and last error.
Users see one label: `public`/`protected` when ready, otherwise the status.

`--existing-projects` is required when enabling from disabled, rejected once
enabled, and must be omitted or equal while an operation is pending (token
replacement). Projects that existed when an enabling operation started follow
that choice; later projects follow `protectNewProjects`.

## Locks

- `lockZeroTrustConfiguration(db, 'shared' | 'exclusive')`: project work,
  deploy fences, and route publication hold it shared; installation claims,
  checkpoints, wildcard mutations, and completion hold it exclusive.
- `withProjectZeroTrustLock(db, projectId, work)`: `projects FOR UPDATE` plus
  the shared lock in one transaction. Errors from `work` roll back; errors
  inside its `recordErrors(step)` mark the row failed, commit, then rethrow.
  User mutations recheck the `settings` capability under this lock.

## Ordering (fail closed)

Public: bypass, then remove JWT enforcement from live routes, then mark public,
then delete the protected application. Protected: exact application if needed,
then publish audiences into live routes, then mark protected, then delete the
bypass. A project is never public before its bypass exists.

Every route rewrite (deploy, rollback, suspension, ownership, domain
activation, backfill, compensation) takes Zero Trust metadata from PostgreSQL,
not from KV. The publication resolver never fails open: unsettled or invalid
protection publishes an empty audience set (dispatch denies) for desired or
effective protected rows; a public row with a recorded bypass stays public;
unknown rows make domain activation keep the domain pending and every other
writer publish deny-all. A cached route whose `projectId` names another project
(reused slug or hostname) is never rewritten; the writer fails and retries.

Dispatch re-verifies `Cf-Access-Jwt-Assertion` against the team JWKS (no
redirects; RS256, issuer, audience, `iat`, `exp`, `type=app`; exact custom
domain audience before wildcard). Failures return a non-cacheable 403 before
the user Worker or assets run, so a deleted or drifted Access application
cannot silently expose a protected project.

## Admission and control plane

Deploys run the strict check after manifest validation and before paid
provisioning, and again inside the cutover fence; rollbacks check too.
Recovery that restores already-committed code uses the publication resolver,
so pending protection cannot block it. Project creation succeeds with a warning
when initialization fails.

Configure and first-domain activation reject a wildcard that would cover the
API (request URL on configure, `AUTH_REDIRECT_URI`), `PROXY_URL`, or `EMAIL_GATEWAY_ORIGIN`
(`*` matches across labels). A replacement token for a pending disable skips
this check. First-domain activation is an API handoff: the operation saves its
target, prepares bypasses, updates the wildcard and protected routes, and only
then publishes `PLATFORM_APPLICATION_KEY`.

## Operations and retries

Configure: `seed`, `public-bypasses` (finishes each public project), `wildcard`,
`projects` (protected projects, after the audience is final). Disable: `seed`,
`projects` (clear enforcement and protected applications, keep bypasses),
`wildcard-delete`, `bypass-delete`. One run handles at most 100 projects and
300 routing keys, then releases its lease.

Per-project failures are recorded on the row with a `skipped:<operation id>`
marker and skipped. Cloudflare 401/403/429/5xx, network errors, timeouts, and
a replaced operation fail the whole operation. A skipped protected row keeps
its protection; a row becoming protected keeps its previous routes.

The two-minute tier resumes an operation with a free lease that has not failed
and then owns that invocation. The hourly tier also retries failed operations,
pending project rows (errored rows move behind others), and, after a finished
disable, clears protection left on skipped rows.

## Status and removal

Status reads return saved state. The live check (account, selections,
wildcard) runs in configure and reconcile, and only on request for status
(`status --check`, admin `?check=1`). The project detail page never calls
Cloudflare.

Project deletion removes its Access applications after retryable cleanup and
before the database cascade. Uninstall does not remove Void-managed Access
applications; administrators disable first.

Code: `platform/packages/api/src/zero-trust/` (`installation`, `operation`,
`project`, `routing`, `maintenance`, `status`, `lock`, `state`).
