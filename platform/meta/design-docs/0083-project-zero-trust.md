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
  100 domains);
- with a zone, one host-and-path bypass for the health probe path
  `void-platform-health.<domain>/health` (`healthApplicationName`,
  `healthApplication`).

Footprint: 1 + (1 with a zone) + public projects + protected projects with
custom domains, against Cloudflare's default 500 applications per account.

Health probes (admin system health, installer verification, domain
activation) send the probe token to `/health` on the health hostname. Access
treats the more specific host-and-path application as overriding the wildcard
for that path and its subpaths
([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/));
every other path on the health hostname, like every other project-domain
hostname, gets the wildcard's login redirect. Dispatch answers the token probe
before routing and answers every other request under `/health` on this hostname
with a non-cacheable 404, matching the broadest reading of Access path matching
(raw and normalized URL, any case, plain prefixes such as `/healthz`). All other
paths are routed normally. The slug is reserved for new projects, but an
installation may already have a project that owns it. That project keeps every
path except `/health`, under the same Access applications as any other
project hostname, so dispatch's route-based Access check is not its only gate
while route metadata propagates. A health application saved with the whole
hostname as its destination is drift: `status --check` reports it and
reconcile updates it in place. The wildcard phase creates the
bypass before the wildcard; `wildcard-delete` deletes it right after the
wildcard. A configuration saved without its name gets one committed (separate
CAS write) before the create. `status --check` reports it missing as drift.

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
a replaced operation fail the whole operation. During configure, a skipped
protected row keeps its protection and a row becoming protected keeps its
previous routes. During disable, the row is already public by intent: routes
cleared before the failure open with every other project at wildcard
deletion, and uncleared routes stay denied until the post-disable cleanup.
First-domain activation never publishes its target while a project is skipped:
such a project lacks the new hostnames (a protected route has no audience for
them, a public bypass does not cover them). Completion instead clears the skip
markers, records an error naming the projects and releases the lease, so the
hourly tier, `reconcile` or the rerun domain command retries those projects.
The fast tier does not, because the operation is in error.

The two-minute tier resumes an operation with a free lease that has not failed
and then owns that invocation. The hourly tier also retries failed operations,
pending project rows (errored rows move behind others), and, after a finished
disable, clears protection left on skipped rows.

Custom domain removal, by a user or by the hourly cleanup of pending domains
that never validated, takes the shared configuration lock right after the
project row lock, before it deletes the Cloudflare hostname or the route, so a
refusal during uninstall leaves the domain whole. It marks a settled row that
records a custom domain application as `reconciling` in the transaction that
deletes the domain; a pending domain can already be listed there, because
activation adds it before it publishes the route. The follow-up reconcile then
rewrites the application; if it fails or never runs, the hourly tier does. A freed hostname left in the old application is fail
closed: a new owner's visitors meet the installation's policies, and dispatch
checks the new owner's audience.

## Status and removal

Status reads return saved state. The live check (account, selections,
wildcard) runs in configure and reconcile, and only on request for status
(`status --check`, admin `?check=1`). The project detail page never calls
Cloudflare.

Project deletion removes its Access applications after retryable cleanup and
before the database cascade. Uninstall does not remove Void-managed Access
applications; administrators disable first. Uninstall turns off the API that
can remove them, so before any change, and in `--plan`, the CLI reads
`zeroTrust.configuration` and `project_zero_trust` straight from PostgreSQL and
refuses while Zero Trust is enabled, an operation is pending, or any row still
records an application handle (rows a finished disable skipped). It also
refuses when the state cannot be read. The error lists the recorded
application names for dashboard cleanup. After confirmation,
uninstall takes `zero-trust:configuration` exclusively as a session lock on
its lifecycle connection, checks again, and holds it until the routing KV
disable write. API Zero Trust writers take that lock, never the lifecycle
lock, so none can commit between the check and the disable write. A request
that passed the routing KV disable check before that write, or at a colo that
has not seen it yet, can still be waiting on the lock. So once the check
passes, uninstall writes the `platform.uninstall` platform setting on the same
session before it disables traffic. `lockZeroTrustConfiguration` reads that
setting in a new statement after it gets the lock, in both modes, and refuses
with `ZeroTrustUnavailableError` while it exists. Every Zero Trust writer,
deployment, and route publication goes through that function, so nothing
creates or records an Access application after the final check. If uninstall
stops before it starts the disable write, it removes the setting before it
releases the lock. After that point only installing or enabling the platform
removes it, just before it deletes the routing KV disable key; this also clears
a setting left in a database reused after an uninstall. Disable and
hourly maintenance skip projects marked `deleting`, so for those rows the
error asks for the project deletion to be rerun; its Access cleanup is
idempotent and the cascade drops the row.

Code: `platform/packages/api/src/zero-trust/` (`installation`, `operation`,
`project`, `routing`, `maintenance`, `status`, `lock`, `state`); the uninstall
check is `packages/void/src/cli/platform-zero-trust-uninstall.ts`.
