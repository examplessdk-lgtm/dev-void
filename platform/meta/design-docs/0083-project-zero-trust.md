---
title: Project Cloudflare Zero Trust protection
status: implemented
created: 2026-09-22
---

# Project Cloudflare Zero Trust protection

## Decision

A self-hosted Void installation can enforce Cloudflare Access on project
hostnames by default. Installation administrators configure the account,
identity providers, reusable policies, and default. A project owner or project
administrator can make an individual project public or protected. Readers may
inspect the state. Direct Cloudflare deployments are unchanged.

This feature is independent from the Access applications that protect the Void
API or provide an OIDC login method.

## Managed resources

Void owns only applications identified by a durable ID or pre-creation name
checkpoint in its PostgreSQL records:

- one self-hosted wildcard application for the installation's project domain
  and retained workers.dev project origins;
- one exact-host bypass application for each public project;
- one exact self-hosted application per protected project with custom domains.

The workers.dev wildcard includes the installation's project ingress prefix;
it must not match unrelated Workers or the platform's own API. Known resource
IDs are checked directly against Cloudflare. Recovery by name uses a fresh,
bounded inventory and never relies on a cached absence.

The wildcard and protected applications reference administrator-selected
reusable policies. A bypass application has an explicit Everyone bypass policy.
Void validates that selected protection policies include at least one allow
policy tied to company identity, and rejects bypass, non-identity, Everyone, or
arbitrary-service-token protection.

Cloudflare's default account limit is 500 Access applications. The installation
therefore consumes `1 + public projects + protected projects with custom domains`,
in addition to applications managed outside Void.

## Credentials and configuration

The Access management credential is separate from the platform runtime token.
It needs Apps and Policies Write plus Organizations, Identity Providers, and
Groups Read on the installation account. The token is accepted through the
operator API or standard input, encrypted with the platform credential keyring,
stored in PostgreSQL settings, redacted from reads and previews, and excluded
from audit targets.

The saved configuration includes a compare-and-swap revision, desired default,
account/team identity, selected resource IDs, encrypted credential, wildcard
application identity, reconciliation status, last error, and resumable
operation state. The operation state records a stable operation ID, kind, phase,
owner, lease, and database start time. Each project records the operation it
completed; unrelated project writes cannot count as reconciliation progress.
Reconfiguration changes the default for future projects but
preserves existing project overrides. The explicit existing-project choice is
used only on initial enable or re-enable.

## Project state and ordering

`project_zero_trust` records desired/effective protection, reconciliation state,
managed application IDs and names, audience, and error. Project-row locks fence
owner changes, domain changes, deletion, Access mutations, and routing
publication so that an older reconciliation cannot publish over a newer owner
choice. Shared configuration locks also fence these mutations against a new
installation operation. Wildcard provider mutations and their checkpoints run
under the exclusive configuration lock, so an expired owner cannot overwrite
or delete a newer wildcard. Project initialization preserves an existing row,
including checkpoints created by a concurrent installation batch.
Newly generated application names include an unguessable nonce and are
committed before a Cloudflare create request; this lets a retry recover the one
matching application if the request succeeds but its returned ID is not
persisted, without adopting a pre-existing predictable-name application.

Public transition:

1. Create or update the exact-host bypass.
2. Remove JWT enforcement from every live project route.
3. Mark the project effectively public.
4. Delete its protected custom-domain application.

Protected transition:

1. Create or update an exact application for custom domains, if any.
2. Publish the wildcard and exact application audiences into every live route.
3. Mark the project effectively protected.
4. Delete its public bypass.

This ordering is fail closed. During a public-to-protected transition, dispatch
requires a valid Access assertion before the bypass is removed. During a
protected-to-public transition, an old custom-domain application may temporarily
remain restrictive if cleanup fails, but the project is never accidentally
published before its bypass exists.

New public projects create their bypass before they can deploy. New protected
projects need no per-project API call until they add a custom domain. Custom
domain activation reconciles Access before publishing routing. Deploy, rollback,
recovery, suspension-preserving cutover, and routing repair all copy the current
effective enforcement data. Failed-deploy routing compensation restores the
previous deployment while retaining the latest suspension and Zero Trust state.

KV reads remain [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/#consistency)
even under a database lock. Every route rewrite derives its Zero Trust metadata
from PostgreSQL instead of copying that
field from a KV snapshot. This includes domain activation, ownership changes,
suspension, legacy backfills, and deployment compensation. Pending or invalid
protection uses an empty audience set to keep metadata maintenance possible
while dispatch denies access; unexpected database failures abort publication.
Public intent with a durable bypass remains public during partial routing
cleanup, so a metadata rewrite cannot reintroduce denial behind the cleanup
cursor. Deployment admission still requires completed public reconciliation. It
is checked before any paid provisioning and again inside the cutover fence.
Recovery that restores already-committed code uses the fail-closed publication
resolver instead, so pending protection cannot block it.
During platform disablement, each project's first cleanup batch saves public
intent before rewriting any routes. Both deployment and metadata publication
honor that intent through partial pages and retries after an error, while
unvisited projects retain their protection. Transitioning a previously protected
row also resets any older cleanup cursor, so no restored protection is stranded
behind a completed page. Effective state and provider handles remain until
cleanup finishes.

Protection reconciliation also checks project identity and the current cutover
target or committed deployment. Missing live routes, a previous project's route
under a reused slug, and stale deployment snapshots retain retryable state.
Undeployed projects and unpublished domains can have no route; stale
pending-domain residue for the same project is removed so activation can publish
a fresh route. Before rewriting a matching deployment, reconciliation derives
the current owner, suspension, and Worker limits from PostgreSQL, so a stale KV
snapshot cannot undo a completed operator change.

Adding the first application domain is an authenticated installer handoff to
the platform API. The operation durably saves its target, prepares public
exceptions, updates the wildcard and all protected routes, and only then
publishes canonical application routing. The saved target takes precedence
over stale Worker variables and KV reads, including scheduled retries.

Project deletion treats Access application deletion as critical because the
project row is the durable handle. The database cascade occurs only after those
deletes succeed. They run after the retryable resource cleanup, so a retried
deletion never leaves a routed project without its Access exception. Platform disablement clears route enforcement and protected
custom-domain applications first, retaining public bypasses until the wildcard
is deleted. Wildcard deletion checkpoints enforcement as disabled and advances
to bounded bypass cleanup. The saved disable operation remains pending until
every retained bypass is removed, so failures can resume without interrupting
previously public applications or repeating completed routing writes.

## Independent dispatch verification

Cloudflare Access normally rejects a request before it reaches the dispatch
Worker. Dispatch also verifies `Cf-Access-Jwt-Assertion` against the configured
team's non-redirecting JWKS endpoint. It pins issuer, application audience,
RS256, expiry, issued-at, and `type=app`. Exact custom-domain audiences take
precedence over the one-label wildcard. Missing, malformed, oversized, expired,
wrong-audience, or unverifiable assertions return a non-cacheable 403 before the
user Worker or static assets run.

This second check prevents a deleted or drifted Access application from silently
making a protected project public.

Access assertions are credentials for shared-cache eligibility, even when no
cookie or Authorization header accompanies them. They bypass both reads and
writes for static-response and ISR caches, keeping authenticated users' origin
responses separate. The shared privacy-policy marker rejects entries admitted
before this credential was recognized.

## Administration and recovery

The browser admin UI and `/operator/v1/zero-trust` expose redacted status,
configuration, reconcile, disable, and per-project operations. The user API
exposes project status to readers and mutations to the `settings` capability
(project administrators and owners). Its `available` field reports whether a
project administrator can change protection now: enabled, ready, and with no
running operation. Mutations recheck the capability under the project row lock
shared with team and ownership changes. Configuration rejects a wildcard that
would cover the API, proxy, or email gateway hostname.

Errored or interrupted project reconciliations retain their resource IDs and are
retried by scheduled maintenance while the platform configuration is ready.
Inside an installation operation, a project-specific failure is recorded on
that project, which the operation then skips so the remaining projects finish.
Credential, rate-limit, and provider outage errors stop the whole operation
instead. After a disable finishes, the same maintenance clears protection left
on skipped projects. The two-minute tier resumes only operations that have not
failed; a failed operation retries hourly or through an explicit reconcile.
Administrators can explicitly reconcile the installation or one project after
fixing token permissions, policies, or account quota.

A replacement token can resume the same inactive operation without discarding
its application handles. Administrators can instead cancel a failed setup by
disabling and cleaning up. Teardown does not require deleted policy or identity
provider selections to validate, and a failed teardown remains authoritative
until cleanup finishes: project and domain updates cannot recreate applications.

Installation-wide configure, reconcile, and disable operations are bounded and
resumable. A short advisory-lock transaction claims a durable owner/lease, and
each later configuration update uses the saved revision as a compare-and-swap
token. One invocation handles at most 100 projects and 300 routing keys. A
protected project may have at most 100 custom domains. Public projects have no
Access destination cap; route cleanup persists a domain cursor across calls.
These limits keep one invocation below the Workers subrequest limit and Cloudflare's
Access API rate limit; unfinished work releases its lease and continues through
an explicit or scheduled reconcile.
