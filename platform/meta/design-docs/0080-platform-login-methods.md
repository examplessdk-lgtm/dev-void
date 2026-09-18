---
title: Configurable Platform Login Methods
status: implemented
created: 2026-09-18
---

# Configurable Platform Login Methods

Let an operator install a Void platform with GitHub, Google, generic OpenID
Connect (OIDC), Cloudflare Access, or a combination of these methods. Let platform
administrators configure, test, enable, and disable methods after installation
without redeploying the platform. Microsoft-specific integration is out of scope.

This is an implementation plan, not documentation of shipped behavior. No live
identity-provider configuration or deployed platform changes are part of this task.

## Product decisions

- Installation offers a multi-select of login methods, requires at least one, and
  collects credentials only for the selected methods. GitHub is optional.
- These are opt-in additions. Existing installations retain their configured
  login methods, signup rules, and perimeter settings; an upgrade never enables
  Access or a new provider automatically. GitHub remains the default choice for
  new installations that do not select another method. The session migration's
  one-time sign-in requirement is an explicit upgrade effect, not a configuration
  change. Do not silently change existing session lifetimes.
- Google, generic OIDC, and Cloudflare Access share the OIDC implementation.
  Cloudflare Access has a distinct setup experience and label. GitHub keeps its
  OAuth adapter.
- Management is available in the existing API-hosted administrator UI and the
  operator CLI. The optional user dashboard is not required.
- The agreed command group is `void platform config auth`. With no action it
  opens interactive configuration; `void platform auth` continues to manage
  the operator's own session.
- Disabling a method immediately revokes human sessions established through it,
  including derived operator sessions. This behavior was explicitly selected by
  the user. Independent project-scoped deployment/build tokens remain unchanged.
- A `VOID_TOKEN` copied from a human login remains a human session even if used
  in CI; it is revoked too. Do not classify credentials by environment-variable
  name or by which process presents them.
- Access setup offers automatic OIDC application creation in the installation
  account and an option to connect an existing application, including one in a
  separate identity account. Both paths were explicitly selected by the user.
- Full Cloudflare Access support is a first-release requirement, not a follow-up.
  Access protection and Access OIDC login are independent, opt-in settings:
  support protection only with another login method, login only without the
  outer gate, or both together. Recommend both for company installations without
  silently coupling them. Full support describes release completeness, not a
  requirement that every installation enable both features.
- When Access protection is enabled, enforce it on the platform UI and APIs by
  default and offer automatic enrollment for company-approved users. Disabling
  Access as a login method does not disable that protection, and selecting it
  as a login method does not implicitly enable protection.
- Disabling retains configuration and linked accounts. Re-enabling requires a
  fresh successful test and never restores previously revoked sessions.
- First release supports one GitHub and one Google configuration, and multiple
  named generic OIDC/Access connections. Use stable connection IDs throughout.
- Company installations must support automatic account creation for users who
  satisfy a configured company access policy, without individual invitations.
  Access approval and the identity used to sign in to Void are separate choices:
  an employee may pass an Access policy and then sign in to Void with GitHub.
- Present **Company-approved users**, **Invited/allowlisted users**, and
  **Public signup** as distinct admission modes. Recommend company-approved
  users once an enforceable company rule is configured. Until then retain
  restricted admission; never interpret an unrestricted social login as proof
  of employment. Automatically created accounts have the ordinary user role.

## Starting point and affected areas

The deployment manifest and discovery document accept only `github | google`.
Provider availability is derived from deployment-time capability flags; the core
manifest enables GitHub and disables Google. Installation, resume, repair, and
secret recovery require GitHub credentials and a GitHub administrator identity.

The API already has Google and GitHub login adapters, browser-bound OAuth state,
single-use callback codes, and a PKCE-protected CLI handoff. Browser administration
has a separate OAuth implementation. Normal account login can link identities by
verified email. Human API and browser-admin JWTs currently have no server-side
session record; operator sessions do. The proxy also accepts human API JWTs.

Principal source areas:

| Area                                   | Existing source                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts                       | `packages/platform/src/{manifest,discovery,installer}.ts`                                                                             |
| Installation and recovery              | `packages/void/src/cli/platform-{lifecycle,installer,setup,setup-draft,plan,management,recovery,registry,secret-update-authority}.ts` |
| CLI login and management               | `packages/void/src/cli/{auth,login,hosted-platform,operator-args,operator-cmd,operator-auth,operator-client}.ts`                      |
| Runtime discovery and capability flags | `platform/packages/api/src/{index,capabilities,env}.ts`                                                                               |
| Authentication and identities          | `platform/packages/api/src/{auth,routes/auth.ts,admin/routes/login.ts,db.ts,schema.ts}`                                               |
| Authentication enforcement             | API `middleware/auth.ts`, `admin/middleware/auth.ts`, `operator/auth.ts`, and `platform/packages/proxy/src/index.ts`                  |
| Administration                         | `platform/packages/api/src/{operator,admin}`                                                                                          |
| Optional dashboard                     | `platform/packages/dashboard/pages/login*` and `pages/auth/*`                                                                         |

## 1. Provider configuration and discovery

Introduce an installation-scoped PostgreSQL login-connection model with stable ID,
kind, display label, enabled state, configuration revision, session generation,
configuration, last successful test, and encrypted credentials. Store pending
revisions separately from the active revision so editing credentials does not
break an enabled method before its replacement has been tested.

Store settings in PostgreSQL, not eventually consistent routing KV. Use the
existing secret-keyring machinery with an explicit authentication-secret purpose
and connection-bound encryption context; extend rotation and backup coverage to
these secrets. Never reuse a project's identity or lifecycle for platform secrets.
Client secrets are write-only in APIs and redacted in previews, audit, and logs.
Do not retain upstream access or refresh tokens unless a specified feature needs
them; initial login needs neither long-term storage nor offline scopes.

The platform's dedicated Hyperdrive configuration must have SQL result caching
disabled. Hyperdrive otherwise caches reads by default and does not invalidate
them on writes, which would violate immediate revocation and read-after-write
configuration behavior. Configure and verify this during installation, upgrade,
repair, and adoption before activating managed authentication. Do not mutate an
unrelated or externally owned Hyperdrive configuration. Source-built/custom
runtimes must supply the same uncached database guarantee; connection pooling
remains enabled. Do not depend on SQL comments as a cache-control mechanism.

Separate runtime support from administrator enablement. The deployment manifest
declares supported authentication features and initial configuration, while the
database is authoritative after initialization. Upgrades and stale local recovery
files must not overwrite live settings or re-enable disabled providers.

Publish enabled connection descriptors with ID, kind, label, and supported login
flow through versioned discovery. Keep provider endpoints, policy details, and
secrets out of public discovery. Refresh discovery when starting login rather than
trusting an old locally cached provider list. Escape custom labels in HTML.

The existing discovery versions reject unknown providers. Introduce an explicit
compatible version/feature contract and an actionable CLI-update requirement for
older clients; do not silently advertise unsupported providers as GitHub/Google.
New clients continue to support old GitHub/Google-only installations. Keep
application-routing schema differences independent from authentication support.

## 2. Shared OAuth/OIDC engine

Build a Worker-compatible OIDC adapter using a maintained protocol library and
the existing `jose` dependency for supported cryptographic operations. Evaluate
the actual protocol library against Workers and packaged-runtime builds before
committing to it; avoid implementing a new token-verification stack by hand.

Use authorization-code flow, upstream PKCE S256, browser-bound state, OIDC nonce,
and strict issuer, audience, signature, expiry, and subject validation. Retain the
separate PKCE exchange between the browser and Void CLI. Bind authorization state
to the exact connection ID, configuration revision, flow audience, and callback.
Recheck enablement/revision before callback completion and code redemption so
an in-flight login cannot outlive a disable operation.

Discovery and token fetches need bounded responses, timeouts, safe redirects,
key-cache refresh on rotation, and protection against arbitrary outbound requests.
Accept HTTPS issuers in production; constrain discovered endpoints and validate
the returned issuer exactly. Define the supported trusted/private-network access
path explicitly rather than bypassing network validation for arbitrary URLs.

Unify administrator and developer login around the same identity resolution and
connection checks, preserving their separate token audiences and permissions.
Keep `/auth/callback` as the registered callback for existing installations;
the signed state selects the connection, so toggles do not change callback URLs.

Provider-specific behavior:

- **GitHub:** preserve existing account IDs and callback compatibility. Login
  enablement remains independent of GitHub repository/build integration.
- **Google:** fixed trusted issuer and default `openid email profile` scopes,
  client ID/secret, and optional allowed Workspace domains. Validate the signed
  `hd` claim for Workspace membership; the request's `hd` hint and an email
  suffix are not authorization checks. Use stable subject IDs.
- **Generic OIDC:** issuer/discovery URL, client ID/secret, label, and narrowly
  defined optional group restrictions. Accommodate providers without verified
  email; do not invent an email address or treat a missing verification claim as
  verified. Identity-based admission remains possible without email.
- **Cloudflare Access:** standard OIDC protocol with a guided Access for SaaS
  configuration. Offer normal claims/scopes and an explicit upstream provider
  selection. An Access service token is a machine credential, never a human login.

## 3. Identity linking, admission, and first administrator

Represent external identities using the connection namespace, exact issuer, and
stable subject. Preserve existing GitHub/Google identities during migration and
keep all project ownership on the existing Void user ID. Changing an issuer or
client identity namespace creates a new connection instead of silently rebinding
existing users. Client-secret rotation preserves identity.

For newly configured connections, do not merge accounts solely because emails
match. Add an explicit linking flow requiring an existing authenticated account,
recent reauthentication, and successful authentication at the new provider.
Reject identities already linked to a different user. Preserve existing links;
review and replace the current implicit email-linking branch consistently.
Do not turn an email match to a seeded administrator into an implicit admin grant.

Keep login restrictions distinct from signup admission. Provider/domain/group
restrictions apply to existing users too. Add connection-and-subject admission
where email is unavailable. Allow a verified Workspace domain, an explicitly
scoped enterprise OIDC connection/group policy, or a required Access gate to
qualify users for automatic account creation. Merely configuring Google's public
issuer or unrestricted GitHub login does not establish a company restriction.
Keep invite/allowlist admission available as an alternative. Never map arbitrary
upstream groups to admin.

### Company access with independent GitHub login

The required company onboarding scenario is:

1. A person opens the platform or starts `void connect`.
2. The configured company gate authenticates them and approves access.
3. They sign in to Void through an enabled login method, for example GitHub.
4. Void validates both proofs and creates an ordinary account automatically if
   none exists. There is no invitation email or per-user administrator approval.

The company gate must be independently enforced for human platform/API access,
not just the login page or first signup. For Access, verify the signed assertion's
issuer, audience, expiry, and human identity against the configured application;
do not trust an email header or mere reachability. Cover alternate origins and
workers.dev routes so they cannot bypass the requirement. Validate and bind the
company identity through login start, callback, code exchange, and subsequent
human requests, with CLI support for the outer Access authorization as well.

Bind the company's stable subject to the Void account alongside the GitHub
identity through a browser-bound, two-proof enrollment. Do not require matching
email addresses: a personal GitHub account can legitimately use another address.
Enforce identity uniqueness and use the explicit linking/recovery rules when an
existing account is involved. A different employee must not reuse someone else's
Void token just because both can pass the same outer gate. Machine service-auth
tokens cannot satisfy human enrollment; scoped CI paths remain separately defined.

Cloudflare Access can alternatively be the OIDC login method itself. In that
configuration its scoped company policy and login can supply both proofs in one
flow, without an additional GitHub login. Show the distinction in setup rather
than presenting Access as only another optional login button.

Turning off an optional login method and removing a required company gate have
different consequences. Never drop the gate because its optional login button
was disabled, and never silently convert company admission into public signup
when the gate is removed or misconfigured. Fail closed until another company
rule is verified or the administrator explicitly chooses a different admission
mode. Existing `signup open` behavior is public admission, not automatic setup
of company protection; reconcile that command with the new admission model.

Remove the first-admin GitHub dependency using an installation-bound bootstrap:

1. The installer generates a high-entropy, short-lived, single-use setup credential
   and stores only its hash in the claimed database; local recovery remains encrypted.
2. The administrator authenticates through a selected connection and proves
   possession of that credential using a POST/browser-bound ceremony. Keep it out
   of query strings, history, referrers, and server logs.
3. Show the authenticated identity on the setup browser page for confirmation before
   consuming the setup claim and granting the first admin role atomically.
4. Bind the ceremony to the installation, selected connection/revision, and browser.
   Serialize concurrent first-admin attempts. An ordinary first visitor gets no role.

For unattended installation, allow an explicitly pinned provider identity or
finish provisioning with setup pending, returning a secure completion step.
Provisioning complete and administrator setup complete must be separate statuses.
Existing interrupted installations retain their pinned GitHub bootstrap until
explicitly migrated; a timeout must not reopen unrestricted first-user signup.

For new installations using configurable authentication, the chosen administrator
method becomes enabled after that confirmation. Other selected methods remain
configured and pending; the administrator tests and enables them in Settings.
Bootstrap initialization uses its own installation-only setup capability, never
the health-probe credential, and stops accepting configuration replacement once
the first administrator has been created.

## 4. Installation experience and Cloudflare Access setup

Ask for login methods early enough that `install --plan` can show the correct
credential instructions, callback URL, and any proposed Access resources. Pin
these choices in the encrypted setup draft and support resume and explicit edits.
Non-interactive installs provide stable connection IDs plus configuration through
a validated configuration input and secrets through environment/stdin references;
never require a secret in a command-line argument or committed JSON file.

For Google and generic OIDC, open the relevant setup guide, show the exact callback,
collect the minimum fields, check discovery, and perform a real sign-in test after
the API is available. Do not require GitHub credentials or issue GitHub API calls
for a Google/OIDC/Access-only installation.

Expose **Platform protection** and **Login methods** separately in installation
and `void platform config auth`. For Cloudflare Access OIDC login, offer:

- **Create an application:** use the selected installation account by default;
  discover its Zero Trust organization, existing identity providers, and policies.
  Let the operator select an existing approved policy or explicitly describe the
  initial users/groups. Create a dedicated OIDC SaaS app with exact callback URLs,
  explicit provider selection, and PKCE. Never create an Everyone/bypass policy or
  silently enable an email-code fallback alongside enterprise SSO.
- **Connect an existing application:** collect issuer/discovery URL, client ID,
  and secret. Support identity accounts separate from the deployment account and
  applications managed through Terraform. No Cloudflare management token is
  required by Void at runtime to authenticate against that OIDC application.

When Access protection is selected, offer automatic creation or connection of
the self-hosted Access applications and policies that protect the platform UI,
API, and relevant human-facing proxy endpoints. Protection-only setup does not
create an OIDC SaaS application or request its client ID/secret. Login-only setup
does not provision perimeter applications or require machine perimeter credentials.
Treat perimeter applications separately from the OIDC SaaS application, with
their own ownership records and expected audience tags. An
existing OIDC application's credentials alone cannot establish perimeter coverage.
For an externally managed gate, collect and verify the team domain, audience tags,
protected origins, and required policy coverage without taking over its resources.
Configure the corporate identity policy once; individual employees do not need
to be invited to Void separately.

Automatic creation requires suitable setup credentials; Workers deployment access
does not imply Access administration. Preflight and document the exact Access app,
policy, organization, and identity-provider permissions for the chosen operations.
Request these only when automatic Access setup is selected, using an operator-side
management credential. Do not expand the API Worker's runtime token permissions.
If the account lacks an organization, an upstream IdP, or permissions, preserve the
draft and explain the missing prerequisite or offer existing-app setup. Do not
configure corporate identity systems on the user's behalf.

Track owned Access resources and external references in installation state, with
checkpointed provisioning intent, resource IDs, and an encrypted secret checkpoint.
Reconcile ambiguous creation responses instead of blindly retrying and creating
duplicates. Recovery of an unavailable generated secret must be explicit. Resume,
repair, and discovery must distinguish owned resources from adopted resources.
Disabling a login method does not delete its Access app; uninstallation lists it
for deliberate cleanup rather than deleting an externally managed application.

Access OIDC and protection of the platform's hostnames are separate enforcement
layers; configure and verify only those explicitly selected, supporting either
one independently or both together. Login-only installations still require normal
Void authentication and the selected signup restrictions, but do not claim that
Access checks every subsequent API request. Do not silently change account-wide
Default-Deny,
weaken existing policies, or remove WARP requirements. This requirement covers
platform administration and developer services; deployed applications keep their
own explicitly configured access policies.

The first-release acceptance matrix includes browser login/callbacks and admin UI,
interactive CLI login and API calls, discovery, proxy access, CI, install/resume
health probes, upgrade, and repair checks under enforced perimeter protection.
Carry narrowly scoped Access credentials only to the configured origin, strip
them on redirects, and keep service-auth credentials distinct from human sessions.
The CLI must handle company authentication as part of its normal connection flow,
without requiring users to copy browser cookies. CI and installation probes use
separately configured, narrowly scoped machine policies and still need the
appropriate Void credentials; an Access service token never grants Void admin
or human signup rights.

When protection is selected, establish it before opening platform access. Until
expected audience tags,
policies, and runtime validation are configured, keep the installation in a closed
setup state. Authentication failures, unavailable Access configuration, or blocked
health checks stop or suspend setup with resumable instructions. Never fall back
to a public origin, open signup, an Everyone policy, or a health-check bypass.
Protect every supported external origin through Access and validate signed
identity at the runtime, including any supported workers.dev or preview URL.
Disable origins that cannot meet both requirements. Signature validation alone
on an otherwise unprotected alternate origin is not equivalent to Access policy
enforcement or Access credential revocation. Preserve these invariants during
upgrade, repair, rollback, and recovery.

The optional source-built GitHub integration uses a dedicated exception that does
not expose an alternate API origin. A standalone Worker accepts only
`POST /github`, applies GitHub's 25 MB payload class as a hard body bound, verifies
the raw GitHub HMAC, and forwards only `POST /internal/github-webhook` over an API
service binding. It strips caller authorization, cookies, and Access headers and
adds a purpose-separated five-minute HMAC over timestamp, GitHub delivery GUID,
event, and body digest. The API exempts only that exact internal operation from
its runtime Access assertion, independently verifies the ingress proof and raw
GitHub signature, then reuses the existing idempotent, capability-gated webhook
handler. The ingress secret is optional and distinct from platform management,
JWT, Access, and GitHub webhook credentials. The core installer does not deploy
or configure this optional Worker; source operators configure its private secrets,
API binding, and isolated GitHub App webhook URL explicitly. Unprotected installs
retain the direct `/webhooks/github` path.

The feature is complete only after Access-login-only, Access-protection-only with
GitHub automatic enrollment, and combined Access protection/login pass the relevant
full matrix, including rejection tests, along with unchanged non-Access
configurations. Earlier
implementation batches are development milestones, not a reduced initial release.

## 5. Administration, live toggles, and revocation

Add **Settings → Login methods** to the API-hosted administrator UI with add,
configure, test, enable, and disable actions. Show readiness, enabled status,
display label, issuer, last test time, and credential-presence indicators.
Do not display saved secret values or link changes to deployment capability flags.

Agreed command group, preserving `platform auth` for the operator's session:

```sh
void platform config auth
void platform config auth list
void platform config auth show company
void platform config auth add google
void platform config auth add oidc --id company
void platform config auth add cloudflare-access --id access
void platform config auth configure company
void platform config auth test company
void platform config auth enable company
void platform config auth disable github
```

Use the existing operator API's preview/confirmation, origin binding, and audit
patterns. UI and CLI call the same service. Provisioning an Access application
uses separate Cloudflare authority through the installer/CLI; the browser UI can
connect an existing application or provide the CLI setup command. Do not retain
a Cloudflare management token in the platform database to implement this UI.

Updates are revision-checked transactions. A successful test is bound to the
pending revision, authenticated identity, initiating administrator, and a short
expiry; an old successful test must not authorize changed credentials or policy.
Testing a disabled/pending connection is a privileged, browser-bound flow that
cannot create an ordinary login session or admit new users. Initial installation
uses the bootstrap credential to authorize that same flow and activate the tested
connection when committing the first administrator. Enabling publishes a tested
revision. Disabling must:

- leave at least one enabled method;
- require the acting admin to have a recently verified, linked identity through
  an enabled alternative, and preserve at least one active reachable admin;
- serialize with account unlinking, administrator suspension/deletion, and other
  provider mutations so concurrent changes cannot bypass the guard;
- show affected human-session counts and any users who have no linked alternative;
- disable callbacks/code exchanges and revoke the method's human sessions and
  derived operator sessions atomically; audit the committed result.

Introduce revocable human-session records with connection ID, generation, user,
audience, expiry, and parent-session provenance. Add session references to new
JWTs and propagate provenance through dashboard/CLI code exchanges and operator
elevation. Check the authoritative active session and connection generation in
every human-token consumer, including proxy local-development authorization.
Do not implement immediate revocation using a stale positive cache or KV mirror.

Immediate means subsequent authenticated requests are rejected after the disable
transaction commits. Stop or revalidate long-lived authenticated streams; already
completed operations are not undone. Keep independent `deploy`/build credentials,
short-lived scoped prerender credentials, and deployed-app service-binding HMAC
credentials outside human-session revocation. Existing suspension/build-scope
checks still apply. Re-enabling increments/uses a new generation and cannot revive
old sessions. Do not rotate the global JWT signing key to disable one provider.

Add a narrowly scoped operator recovery command for lost-provider situations. It
requires existing installation ownership, management/database authority, and the
original recovery secrets. It can repair/re-enable a provider or bind a replacement
identity to an existing administrator with explicit identity confirmation; it
cannot reopen first-user signup or grant arbitrary platform administration.
Preserve the normal audit trail. Never expose an unauthenticated recovery route.

## 6. Migration, upgrades, and rollback

Use additive schema migrations and a coordinated runtime transition:

1. Import existing deployment-enabled GitHub/Google connections and their secrets
   once, preserving linked identities and all users/projects. Mark initialization
   explicitly; subsequent upgrades never repeat the import over live settings.
2. Upgrade all human-token consumers and publish the new discovery contract before
   exposing live disable controls. Test the compatible previous/current CLI pairs.
3. Legacy human JWTs have no trustworthy provider provenance. Require a one-time
   sign-in when revocation enforcement is activated; do not infer the issuing
   provider from the user's primary account. Clear legacy operator sessions at
   that boundary. Announce this in upgrade preview, including user tokens used in CI.
4. Preserve scoped build/deploy and runtime service credentials. Audit every token
   consumer so older proxy/admin paths cannot bypass the new session requirement.
5. Block rollback to a runtime that cannot enforce the active auth configuration or
   revocation schema. Prefer an explicit minimum-compatible runtime over restoring
   hard-coded GitHub flags. Back up encrypted provider data with its keyring.

Extend upgrade secret rotation, discover, resume, repair, and disaster recovery to
all configured methods. A normal upgrade reads live settings; replacing a missing
Worker restores its keys but does not reconstruct provider configuration from a
stale workstation. Include the optional hosted/dashboard environment in migration
coverage even though it is not part of the core installer.

## Delivery sequence and acceptance

| Batch | Deliverable                                                                  | Acceptance                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Contracts, database model, session provenance, and migration scaffolding     | Existing GitHub installations retain identity/ownership; old/new discovery behavior is explicit; enforcement can be activated coherently.                       |
| 2     | Shared login engine, Google, generic OIDC, identity linking, and bootstrap   | Fresh Google-only and OIDC-only installs create the intended administrator and support browser/CLI login without GitHub credentials or network calls.           |
| 3     | Installer multi-select, provider-specific setup, and Access OIDC integration | Access-only and mixed-provider installs work; automatic and existing-app paths resume safely; non-Access installs perform no Access probes/provisioning.        |
| 4     | Operator API/CLI and administrator UI                                        | Add/test/enable/disable/configure work without deployment; revision races, last-method/admin guards, secret handling, and immediate revocation are covered.     |
| 5     | Full lifecycle and mandatory Access perimeter support                        | Upgrade, rotation, repair, recovery, and compatible rollback pass; browser/CLI/CI/health probes work with enforced protection wherever that option is selected. |
| 6     | Final verification and public documentation                                  | Complete test suite and relevant packed-runtime checks pass; installation/admin/CLI docs describe the verified behavior.                                        |

## Verification plan

During implementation run `vp test run` against the affected files only and
`vp run check` after each batch. Use the repository's Node version and Vite+
tooling. Run `vp install` if dependency or package structure changes are needed.
Investigate slow or hanging tests immediately rather than increasing timeouts.

Required meaningful regressions:

- Fake OIDC issuer with real signed tokens for nonce/state/PKCE, issuer/audience,
  subject, expiry, discovery mismatch, key rotation, unsafe endpoints, and missing
  or unverified email. Reuse one deterministic fixture per test worker and close
  servers/timers on teardown; no real identity-provider network in unit tests.
- Browser and CLI login, admin login, operator elevation, dashboard code exchange,
  proxy access, and relevant authenticated streams obey the same provider state.
- Same email across providers does not take over an account; explicit linking
  preserves the user's project ownership; identities cannot be linked twice.
- First-admin replay/concurrency, expired bootstrap, interrupted install, unattended
  pinned identity, and legacy GitHub bootstrap migration remain closed to outsiders.
- Disable during login or code exchange; concurrent disable/unlink/suspend;
  alternative-admin proof; re-enable does not resurrect sessions; scoped deployment
  tokens and app runtime credentials continue working. Distinguish human `VOID_TOKEN`.
- Per-provider credential rotation uses a tested pending revision, does not leak
  secrets, and is preserved by upgrade/repair. Cover keyring rotation and restore.
- Google-only, OIDC-only, Access-only, GitHub-only, and mixed installations on
  custom domains and workers.dev; optional dashboard absent and present.
- Independently exercise Access login only, protection only with another login,
  both together, and neither. Each provisions only its selected resources and
  requests only its required credentials/permissions. Existing non-Access
  installations preserve their settings through upgrade; toggling Access login
  never changes the independent perimeter setting.
- Access-approved employee plus GitHub login creates a normal account without
  an invite, including different company/GitHub emails. Outsiders, a changed
  company subject during login, another employee presenting a stolen Void token,
  machine tokens, and alternate-origin requests cannot bypass the company gate.
  Disabled or missing gate configuration never silently opens public signup.
- Access permission failures, unavailable organization/IdP, external-account
  issuer, externally managed app, ambiguous create, interrupted checkpoint,
  existing policy preservation, and machine-auth origin scoping.
- Full Access protection from initial installation through maintenance: no
  unprotected setup window, public/preview/alternate-origin fallback, service-token
  human enrollment, or disabled validation when probes fail. Interactive CLI
  acquisition/renewal and scoped headless credentials work without manual cookie
  copying. Revocation/expiry of Access credentials denies access even when the
  independently issued Void token remains valid.
- Apps that do not use platform Access cause no Access permissions, entitlement
  probes, provisioning, or bindings. Native `void deploy --platform cloudflare`
  remains unaffected and Workers Free-compatible by default.
- Supported runtime/CLI upgrade pairs; disabled providers survive an upgrade;
  incompatible rollback cannot restore a revoked login path.
- Platform Hyperdrive creation and owned upgrades explicitly disable result
  caching; preflight verifies that guarantee before authentication activation,
  including adopted/custom-runtime cases. Application Hyperdrive settings remain
  independent.

After all code changes, run the final full `vp test run` and required formatting,
lint, builds, and typechecks through the repository's `vpr test:all` workflow;
avoid redundant full-suite reruns without changes or failures. Include the packed
CLI/runtime consumer checks selected by `TESTING.md`. Use an explicitly configured
nonproduction live smoke environment for real Google and Access sign-in and a
real OIDC provider; never provision corporate identity resources as ordinary tests.

After verification, update `docs/guide/self-hosted-platform.md`,
`docs/guide/platform-administration.md`, and `docs/reference/cli.md`; update root
and affected package READMEs where public scope/setup changes. Update CLI help,
the no-argument command-group hint, and `packages/void/skills/void` guidance.
Only change `packages/void/AGENTS_TEMPLATE.md` if essential and keep its four-bullet
limit. Keep protocol details and implementation rationale in this design/source,
and organization-specific identity details out of public repository documentation.

## Public references

- [Google OIDC and hosted-domain validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [OIDC discovery specification](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [Cloudflare Access as an OIDC provider](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)
- [Validating Access assertions at the origin](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare identity-provider API and permissions](https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/list/)

Recheck exact Access provisioning API permissions, available plan limits, and the
selected OIDC library's Workers support while implementing. These are verification
tasks, not assumptions that deployment credentials or a paid service are required.

## Reconciliation of the remaining implementation

The core provider/session work was already committed when this branch was resumed.
The completion work covers these previously unfinished paths:

- Access installer create/connect flows, encrypted provisioning checkpoints and
  resource inventory, independent protection-only/login-only selection, scoped
  machine credentials, and disabled unprotected preview/alternate origins.
- Post-install protection management through `platform config auth protection`,
  with Cloudflare coverage verification, installation authority, lifecycle and
  settings revision checks, human company proof, and session revocation.
- Expired setup-code renewal during resume/repair and owner-authorized recovery
  of an existing administrator after a real provider test. Recovery preserves
  the required company gate and never creates an administrator or reopens signup.
- Live authentication preservation and runtime compatibility checks during
  lifecycle operations, including refusal of authentication-incompatible rollback.
- Ordinary-user account linking in the CLI/dashboard, current dashboard login
  discovery, scoped development/prerender Access credentials, and authoritative
  revalidation of long-lived human proxy streams. API build-log clients poll
  authenticated endpoints; internal BuildManager sockets are not public routes.
- Exact connection-and-subject allowlisting for identities without verified
  email, and owner-issued project deployment credentials with expiry, renewal,
  revocation, and derived-prerender authority checks for protected CI.
- An optional isolated GitHub webhook ingress for source-built managed-build
  installations, preserving signature checks without opening the protected API.
  This service remains outside the core installer's footprint.
- Access-safe optional GitHub webhook delivery through the standalone source
  ingress, with an exact service-binding operation and no external API bypass.

Focused regression suites exercise the installer combinations, explicit linking
and callback races, Access policy verification and ambiguous creation, recovery,
revocation, scoped machine paths, and compatibility checks. The final repository
workflow, packed-consumer checks, and four independent review results are recorded
with the task handoff. Real provider sign-in and live Cloudflare provisioning are
separate acceptance evidence: no live identity-provider or deployed-platform
changes are authorized by this design task.

Local verification completed on Node 24.21.0: `vpr test:all` passed 537 files
and 10,544 tests, with 11 skipped. The full packed-consumer matrix passed for
npm and pnpm across React, Vue, Svelte, and Solid, and the optional webhook
Worker compiled in deployment dry-run mode. Four independent GPT-6 Astra high
reviews were completed; GPT-5.6 Sol high fixes and follow-up reviews resolved
all reported P1 findings. A shared browser-test readiness fix requires both
islands on the two-island fixture, without changing production behavior or
timeouts.
