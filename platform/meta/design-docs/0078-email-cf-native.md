---
title: Cloudflare-Native Email Decisions
status: implemented
created: 2026-04-24
updated: 2026-09-17
---

# Cloudflare-native email decisions

The [email guide](../../../docs/guide/email.md) describes the supported API and
setup. This record preserves the trust boundaries, lifecycle decisions and
accepted limitations behind that implementation. The earlier Resend/webhook
proposal, re-land transcript, copied source and unimplemented setup recipes
are retired.

## Hosting modes and lifecycle

### Mode A — managed platform

The platform proxy owns the account-level `send_email` binding. Tenant
Workers receive only the authenticated `__VOID_PROXY` interface; giving
them a raw send binding would bypass destination consent, suspension and
quota policy. Native Cloudflare Workers use their own account binding.

The mail domain is configured per environment as `EMAIL_SENDER_DOMAIN`
and injected as `__VOID_EMAIL_DOMAIN`. Missing configuration fails closed.
There is one project-slug binding, `__VOID_PROJECT_SLUG`. Senders must
belong to that project's namespace on the configured mail domain.

#### Verified destinations

Cloudflare's account-level verification does not establish consent for every
project on the account. Preserve the distinction recorded in
`email_destinations.verification_source`:

- **Option C — owner-relaxed reuse:** an already verified address matching
  the current project owner's email can inherit that owner's consent.
- **Option B — platform confirmation:** an address verified for another
  project remains pending until the recipient follows this project's
  signed confirmation link. A Cloudflare refresh cannot bypass this gate.
- A newly registered Cloudflare destination is promoted only when the
  verified tag matches the project's registration. An unrelated recreation
  of the same address does not prove this project's consent.

Owner inheritance must recheck the captured owner email inside the transaction
that writes or promotes the destination. Owner-email changes revoke inherited
consent and tighten the allowlist without silently committing a failed
tighten. Explicit revocation and project deletion also update the mirror.

The proxy reads `email-allowlist:<projectId>` from routing KV.
Destination listing repairs a missing or inconsistent mirror from the
authoritative verified rows. Preserve fail-closed behavior when a mirror is
absent. A verified platform row is not automatically revoked by an
out-of-band Cloudflare deletion; Cloudflare still refuses actual sends until
its destination is verified again.

#### Quotas and visibility

Outbound sends and inbound forward/reply actions share destination, suspension,
burst and monthly checks. The counters use KV read-modify-write and are
best-effort under concurrency, not strict distributed admission limits.
Increasing a time window does not make those updates atomic.

Project destination listing picks up pending Cloudflare verification;
Cloudflare does not push that event into the platform. Persistent project
delivery logs are not implemented: `void email logs` reports pending support.
A handled inbound message can still have a forward or reply refused by its
outbound gate. Do not present a handled receipt as proof of delivery.

### Mode B — the developer's own Cloudflare account

Native setup is implemented in
[email-cloudflare.ts](../../../packages/void/src/cli/email-cloudflare.ts).
`void deploy --platform cloudflare` and `void email setup|status`
share its read-only preflight and selected Wrangler session. The developer
supplies `email.from`; Void does not choose another mail domain silently.

#### One keystroke

Interactive deployment displays the selected account/domain and unfinished
account changes before offering setup. Noninteractive deployment reports
unfinished setup; `--require-email` makes it a deployment prerequisite.
Ready configuration is reconciled without repeating account mutations.

The checklist distinguishes account work from config updates and routing
rules. `wrangler deploy` owns rule application; a pending rule is not
itself a reason to rerun account onboarding. A previously attempted but
refused Sending onboarding can be retried explicitly with `void email setup`.

#### The flow, by lane

1. Read domain DNS, account identity, routing settings, existing rules and
   Sending state before applying changes.
2. Enable routing only where needed. Preserve unrelated apex mail records
   when the configured sender uses a subdomain.
3. Enable the zone's `support_subaddress` setting when needed; literal
   address routing alone does not guarantee `support+tag@` delivery.
4. Attempt Sending onboarding and report plan or permission refusals without
   treating them as permission to alter unrelated records.
5. Reconcile the owned sender/binding configuration. Write `addresses`
   only when inbound routing is ready, then let pinned Wrangler apply it.
6. Print the resulting inbound map and remaining manual steps.

Use pinned Wrangler commands wherever available. For zone classification,
subdomain routing and subaddressing calls without a Wrangler command, borrow
the selected session bearer through `wrangler auth token --json` inside
the narrow request closure. Do not persist, log, include in errors, or forward
that token to a different origin. Disable Wrangler disk logging on the token
handoff. Credentialed preflight runs before evaluating project code.

The session gate checks the required email scopes for OAuth sessions.
API-token permissions are established by the actual reads; a Global API Key
is refused where the bridge requires a bearer. Prose parsers are pinned to
the bundled Wrangler version and tested against its captured output. A
parser miss yields unknown state and setup guidance, not permission to write.

Void owns the entire derived top-level `addresses` array in this mode.
Hand-written entries that it cannot derive skip setup without changing that
array. Addresses already routed elsewhere are pruned from the proposed plan.
When routing is unready, omit/delete the config key rather than writing
`[]`, which would ask Wrangler to delete owned rules. Re-read the root
config after edits and preserve the deployment verifier's whole-array check.

#### Error map and degraded branches

The code classifies known provider errors for routing-not-enabled,
already-onboarded and Sending-entitlement refusals. Unknown failures remain
diagnosable and do not authorize retries of uncertain writes.

If subdomain routing or subaddressing is refused, print the explicit
Cloudflare dashboard step and withhold `addresses` for that run.
Never claim setup is complete merely because the Worker uploaded.
Sender config and an inert send binding can remain useful for verified
destinations when arbitrary-recipient Sending is unavailable.

#### Still unverified

Keep credentialed provider acceptance separate from unit-test evidence.
Live checks must establish the subdomain routing POST and subaddressing PATCH
with the selected credential type, rule-plan permissions, conflict behavior
after dashboard edits or Worker renames, and multi-label mail subdomains.
The earlier local source probes are not evidence that these operations
succeeded in an arbitrary account. Follow the
[live release procedure](../release-acceptance.md).

### Mode C — self-hosted platform

The same proxy and consent rules apply to an operator-owned platform.
Configure its mail domain, sender, proxy binding and Email Routing before
enabling email. Core installation does not make optional email setup
automatic. Use [platform operations](../operations.md) for the supported
operator workflow.

## Cross-worker dispatch

Cloudflare's real `ForwardableEmailMessage` is not serializable over RPC.
The proxy buffers a bounded envelope and calls the tenant's
`WorkerEntrypoint.email()`; the generated handler returns action intents.
The proxy validates and enacts those intents against the original message.

Keep the wire recipient as `__voidPlatformTo` for dispatch. Strip the
platform slug prefix exactly once for the user-facing message. Case-insensitive
matching must preserve the original case of captured parameters.

Pre-buffering bounds the inbound raw body and distinct header count before
constructing the RPC envelope. Forward/reply/reject validation also bounds
action count, address/header size and cumulative reply bytes. These are
independent limits; a raw byte cap alone permits an excessive number of
distinct short headers. Invalid actions cannot bypass the outbound gate.

### RPC result materialization — accepted limit

The tenant's entire RPC return value is materialized inside the shared proxy
before action validation. The framework's action queue constrains cooperative
handlers; an arbitrary tenant entrypoint can return another object graph.

The 2026-09-15 workerd probe established that the 32 MiB serialized RPC limit
does not bound the receiver's heap: a dense array of nulls near that cap
materialized about 128 MiB, and empty objects about 503 MiB. Those measurements
used local workerd without the production isolate-memory limit; they do not
claim a measured production eviction. The relevant provider contracts are
[RPC limits](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations)
and [Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory).

This was accepted as an architectural limitation. Callee CPU limits reduce
some inputs but do not establish a hard caller-heap bound. Returning a string,
stream or `RpcTarget` by convention cannot constrain a hostile callee.
Possible future boundaries are a reserved HTTP endpoint with a bounded body,
a dedicated inbound-email dispatch Worker, or a separate email CPU budget.
They change the framework contract or deployment architecture and remain
separate design decisions.

## Local development and testing

The development inbox captures outbound MIME and requires the project's
dev-trigger token on every route. It is not a production send transport.
Skipping capture with `sendInDev` does not create a binding or guarantee
real delivery. Preserve the user's independently named send bindings when
removing Void's own dev transport.

Test harnesses exercise the same message construction, routing and action
semantics as production. Inbound parsing consumes a stream; handlers choose
when to parse it. Threaded replies treat sender-supplied headers as untrusted
and fall back safely when threading metadata is malformed.

## Custom domains on Cloudflare

### Fix round — cross-domain attribution and catch-all ownership _(added 2026-09-17)_

Raised by adversarial review after the first build; fixed and pinned by
tests:

- **Inbound attribution binds to the envelope recipient, never the relay's
  claim.** The catch-all is zone-scoped with no domain parameter, so mail
  for a second domain on the same zone can land on the first domain's
  relay. Relay v2 refuses any message whose recipient domain is not its own
  (`setReject` — a loud bounce, not a silent drop), and the proxy's
  `/email/relay` branch 403s when the declared `X-Void-Email-Domain` header
  does not equal the recipient's domain, then keys the mirror lookup on the
  recipient's domain.
- **The catch-all is never written blind.** Setup reads it first
  (`GET …/rules/catch_all`): an enabled rule naming anything but this row's
  relay fails the row at `catch_all` with a conflict message — one zone
  routes one email domain — and a rule already naming it makes the write a
  no-op. `remove` resets the rule only when the same read shows it still
  naming this row's relay; a foreign or unreadable rule is left alone (the
  latter reports `catch_all` in `failed_steps`).
- **Setup is re-runnable.** Re-adding a `failed` row re-runs the full
  engine against the row's recorded progress: a recorded mode skips the MX
  check (the first attempt's enable_routing put OUR MX on the domain), a
  recorded relay name redeploys in place rather than walking to a fresh
  `-2`, and an "already done" 400/409 from enable_routing/onboard_sending
  is believed only when a read-back confirms it (`GET email/routing`'s
  `enabled`, resp. the sending-subdomain list) — fail-closed otherwise.
  Healthy rows (active / pending / credential renewal) still take the
  sync-only path.
- **`pending` self-clears.** The status GET takes a `pending` row whose
  only remaining step is `routing_subdomain` and probes public DNS for MX
  naming Cloudflare's inbound exchanges (`route1..3.mx.cloudflare.net`) —
  the dashboard form's observable effect. On evidence the row flips to
  `active` and the mirror follows; otherwise it stays pending.

### Fix round — concurrency backstops, removal order, teardown coverage _(added 2026-09-17)_

Raised by a second adversarial review of the same build; fixed and pinned
by tests:

- **A re-run never erases recorded progress.** `setupEmailDomain` seeds
  its returned progress from the row (`zone_id` / `account_id` / `mode` /
  `relay_worker_name`), and the replace route passes them in — a re-run
  that fails early (a dead credential at `verify_credential`) still
  persists what the row already learned, so the next retry still skips
  the MX check and still redeploys its relay in place.
- **Concurrent adds are backstopped in the DB, not just prechecked.** Two
  partial unique indexes — one live row per zone (`status IN
('active','pending')`, so a `failed` row can still record the zone it
  failed in) and one relay name per account (a deployed relay really
  exists) — turn the engine's check-then-write window into a 409 for the
  loser. The loser's CF-side work is compensated best-effort from what
  its engine returned: a zone race fully removes, a relay-name race never
  deletes the contested worker (only its zone rule is conditionally
  detached). The violation's constraint name classifies the race; both
  drivers here (PGlite, `pg` via pg-protocol) expose it as `constraint`
  on the same frame that carries the `23505` code, and the read walks the
  cause chain — the destructive misclassification is deleting a worker
  another live row owns, so the name must be found wherever the driver
  put it.
- **Removal detaches before it deletes.** `removeEmailDomain` resets the
  zone catch-all (when the ownership read shows it still naming this
  row's relay) BEFORE deleting the relay script; if the read or the reset
  fails, the delete is deliberately skipped and both steps report
  failed — an enabled catch-all never points at a deleted worker; rule
  and relay stay a consistent pair.
- **Project teardown now cleans the customer side.** After the KV mirrors
  are revoked (fail-closed) and before the DB cascade, teardown runs
  `removeEmailDomain` for each registered domain with a deployed relay,
  best-effort and never throwing: the mirrors being gone makes a stranded
  relay inert, and the grant refresh goes through the row's serialized
  chain so a crash before the cascade leaves the credential live for the
  retry.
- **The sending-subdomain read-back paginates.** CF's list endpoint
  returns 20/page; the onboard confirmation now walks
  `?page=N&per_page=50` until a short page, so a domain past the first
  page still confirms.

### Fix round — removal durability, race closure, grant revocation _(added 2026-09-17)_

The residual items the second round handed back, settled in code; all
response shapes below are pre-launch wire changes, free to make:

- **A failed removal keeps the row.** DELETE's CF cleanup failing on a
  destructive step (`catch_all` or `delete_relay`) no longer deletes the
  row and mirror anyway: the row is marked `setup_state.failed_step =
'remove'` + `removal_failed_steps` (both ride the existing jsonb — no
  migration) and the route answers `200 { ok: false, removed: false,
failed_steps }`. The owner retries once the CF-side problem is fixed,
  or forces with `?force=1` (`removed: true, forced: true`). Two
  exceptions still delete unconditionally: `token_revoked` rows (the
  grant is already dead, keeping buys no retry leverage) and a
  `revoke_grant`-only failure (a stranded grant breaks no mail). While a
  row carries the removal mark the status GET suppresses its mirror
  repair — the proxy's view must not be "repaired" against a removal the
  operator is about to finish. The CLI mirrors the contract: `--force`,
  exit 1 with retry guidance on `removed: false`, and manual-cleanup
  hints on a forced removal.
- **The deploy checkpoint closes the catch-all race structurally.**
  `setupEmailDomain` fires a `persistProgress` dep once — after the
  relay deploy + secret PUT, before the catch-all write — and the route
  persists it (`applyEmailDomainDeployCheckpoint`, an UPDATE…RETURNING).
  With the partial unique indexes, a racing loser now 23505s at the
  checkpoint and never writes its zone rule; the previous
  last-write-wins window (loser's rule overwritten onto the zone,
  winner's row live but unrouted) cannot occur for fresh adds. A
  checkpoint that finds the row gone (teardown's cascade won) 409s as
  `project is being deleted`. Checkpoints are skipped on in-place
  redeploys, so a re-run of a crashed/failed row can still 23505 at the
  final apply — and there the compensation does more than reset: a
  winner lookup (`zone_id` + the index's live statuses + relay non-null
  - not the loser) hands `repoint_catch_all_to` to the engine, which
    REPOINTS an owned rule at the winner instead of resetting it (winner
    existence probed before AND after the PUT; lookup failure degrades to
    the plain reset). One zone keeps working mail through the conflict.
- **A non-unique apply failure no longer orphans the relay.** The apply
  wrapper re-reads the row: committed (relay name AND `relay_version`
  match — the checkpoint never writes the version, so the pair
  distinguishes a committed apply from a checkpoint write) → the row
  stands as applied; otherwise the possibly-deployed CF state is
  compensated from the engine's result with its own account_id and the
  original error rethrows. A re-read failure logs and rethrows, and a
  null relay (setup failed before the deploy) never compensates. The
  sync route's live-status flip can also 23505 (a `failed` row rejoining
  the live set while a winner holds its zone) — mapped to the same 409
  zone message, deliberately without compensation.
- **Catch-all drift is reported, never fought.** The sync POST runs the
  engine's catch-all ensure whenever the row carries a zone (missing,
  disabled, or non-worker rules are repointed — `ensured`; already ours
  — `already_set`; an enabled rule naming a DIFFERENT worker —
  `foreign_conflict`, reported and never overwritten; probe failure —
  `probe_failed`) and surfaces the outcome on the response. The status
  GET probes read-only: `catch_all`
  (`points_here`/`points_elsewhere`/`missing`/`disabled`/`unknown`) and
  `catch_all_drift` on live rows; healing is the sync POST, which the
  CLI's drift hint names.
- **The OAuth grant is revoked on every path that should kill it.** New
  `revokeOauthGrant` POSTs RFC 7009 form to
  `dash.cloudflare.com/oauth2/revoke` (wrangler's public client id,
  `token_type_hint=refresh_token`, no secret — exactly wrangler's
  `logout`; it never throws and never logs the token). Remove revokes
  LAST, with the rotated chain head (a transient refresh failure revokes
  the original stored token instead; `invalid_grant` skips — CF already
  killed it). Replace revokes the old grant after the credential commit
  (a re-pasted identical grant is skipped — revoking it would brick the
  just-stored credential). Teardown revokes. Conflict compensation
  deliberately does NOT — the loser's credential may survive. The
  operator escape hatch is `POST
/admin/email/:projectId/domains/:domain/revoke-grant` (revoke + flip
  to `token_revoked`; the proxy mirror keeps the old status until the
  next repair — accepted for an operator tool). Revocation's cascade
  scope (access tokens minted from the grant) is undocumented and
  unprobed — accepted.
- **Live write probes settled the API-level questions** (voidcloud.dev,
  restored byte-identical afterward): `POST …/email/routing/dns {name}`
  enables a subdomain (200, three MX auto-created); sending onboard with
  an API token succeeds (the schema declares Global-key-only — the
  declared auth lags the endpoint) and also stamps the apex SPF + DKIM;
  apex enable is an empty-body POST; ONE zone-scoped catch-all
  auto-created drop+disabled covers apex and subdomain (probe 6 settled
  at the API level); relay script PUT + secret PUT + catch-all PUT all
  accept an API token; `send_raw` takes the JSON envelope `{from,
recipients, mime_message}` (a raw `message/rfc822` body earns
  `10001 invalid_request_schema`) → `200 queued`. CF's cleanup does not
  remove `_dmarc.<sub>` on subdomain/routing deletion — the engine never
  touches DNS by design, and the CLI prints the manual cleanup list.
  Still open: the dashboard-UI-only probes (2/4/5), the browser PKCE run
  (8 — owner's manual pass), narrow template-token variants of 1/7, and
  a message-level inbound E2E (needs observability the API token cannot
  reach).
- **Deep research pinned the permission and template facts** (cited in
  the session report): the revocation endpoint is advertised by the OIDC
  discovery document; `routing/dns` is authorized by Zone Settings Write
  and rules by Email Routing Rules Write; `10103 bad_token_type` is
  Email Sending's credential-type rejection; template URLs officially
  support `permissionGroupKeys` but publish NO email keys — the
  community-verified ones are `email_routing_address` and
  `email_routing_rule`, unknown keys are silently dropped, and narrowing
  `zoneId` to one zone is undocumented — so the CLI/docs deliberately
  show the manual token-creation steps rather than a guessed pre-fill
  link; `send_raw` accepts user and account tokens (account-owned
  recommended).

## Deferred decisions

Custom sender domains on the managed platform ARE implemented — see
[Custom domains on Cloudflare](#custom-domains-on-cloudflare). Third-party
provider wrappers, component templates, typed sender discovery and persistent
delivery logs are not implemented by this record. Users can call a provider
SDK directly where appropriate.

Native setup currently detects email at the feature level rather than
separately onboarding inbound-only apps. Splitting that detection would also
need to handle sends from dependencies, dynamic imports and direct binding
access; it is not a safe deletion of the existing binding.
