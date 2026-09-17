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

A project can send as and receive at its own domain — `support@acme.com`,
`noreply@mail.acme.com` — when that domain's DNS zone is on Cloudflare. The
zone stays in the customer's own Cloudflare account. The customer grants the
platform a scoped credential once; the platform configures the zone and runs
both directions on the customer's behalf. Inbound crosses accounts in a
**relay worker** deployed into the customer's account; outbound crosses back
as a REST send with the same credential. The relay needs no operator mail
zone, so custom domains work identically on a self-hosted platform, and the
raw MIME arrives unmodified — no `To:` recovery, no BCC loss, no SRS/ARC
hop, no destination verification click. The price is one wider token scope —
`Workers Scripts: Write` — which the customer sees on the token form.

"On Cloudflare" means a zone under Cloudflare DNS in an account the customer
controls. A domain that only CNAMEs to Void through Cloudflare for SaaS is
**not** on Cloudflare in this sense and stays out of scope: Email Routing
needs MX records on a Cloudflare zone, and RFC 2181 forbids MX beside a
CNAME. Those customers keep the provider path in [Future Work](#future-work).

### Why this model

| Model                                            | What it needs from the customer                          | Why it is or is not the one                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bring your zone — a scoped token** _(adopted)_ | create one API token, one dashboard step for a subdomain | zone stays theirs; apex MX untouched; works on Free for routing, Paid for sending; the domain signs its own DKIM, so reputation is per customer |
| NS delegation of the whole domain to our account | move all of their DNS to us                              | we would own and have to manage every record they have; greenfield DNS UI                                                                       |
| `mail.acme.com` as its own zone in our account   | delegate one subdomain                                   | Cloudflare's subdomain setup is **Enterprise-only**                                                                                             |
| Self-hosted SMTP relay                           | nothing                                                  | reinvents what Email Routing gives for free                                                                                                     |

The "users never touch Cloudflare" premise is kept for the managed
platform's shared sender and dropped for a customer's **own domain**: the
customer already touches Cloudflare to own the zone, and the credential is
the same act of trust they give `wrangler login`. The rule that survives is
the one from [Hosting modes and lifecycle](#hosting-modes-and-lifecycle):
after the one-time grant, a developer sees an address, recipients, a counter
and an error code — never a zone, a rule or a token scope.

### The two paths

A routing rule can only name a worker in its own account — the rule's action
value is a bare worker name, and worker names are unique per account — so
inbound from a customer zone cannot reach `void-proxy` directly. It crosses
accounts inside a **relay worker** the platform deploys into the customer's
account with the stored credential, and outbound crosses back as a **REST
send** with the same credential.

```
INBOUND   support+T-42@acme.com
            │   MX in the customer's account (mail.acme.com, or the apex when its MX is empty)
            ▼
          catch-all rule → void-email-relay (a worker in the customer's account, deployed by setup)
            │   envelope recipient exact — To:, Cc: and BCC alike · raw MIME unmodified
            ▼
          POST proxy.void.cloud/email/relay   Authorization: the domain's relay secret
            │   secret → registered domain → project
            ▼
          project worker  email()   to = support+T-42@acme.com   viaDomain = acme.com
                                    dispatcher runs in no-prefix mode (Mode B item 4)

OUTBOUND  sendEmail({ from: "noreply@acme.com", … })
            │   proxy: from-domain is registered to this project → use that domain's credential
            ▼
          POST /accounts/{customer}/email/sending/send_raw   { from, recipients, mime_message }
                DKIM = acme.com (or mail.acme.com) · quota = the customer's · message_id returned
```

**The relay worker.** One per registered domain, named `void-email-relay`
(suffixed `-2`, `-3`… on collision within the account, up to 50). It is ~30
lines: the `email()` handler streams `message.raw` straight into a POST with
the domain's relay secret — no parsing, no buffering, so it stays inside
Workers Free CPU limits, and messages over the 25 MiB inbound cap never
reach it (Cloudflare rejects them first). `message.to` is a single address
(the envelope RCPT TO), so a multi-recipient message arrives as one
invocation per recipient. The catch-all is zone-scoped with no domain
parameter, so mail for a second domain on the same zone can land on the
first domain's relay: the relay refuses any message whose recipient domain
is not its own (`setReject` — a loud bounce, not a silent drop), and the
proxy's `/email/relay` branch independently 403s when the declared
`X-Void-Email-Domain` header does not equal the recipient's domain, keying
its mirror lookup on the recipient's domain. Attribution binds to the
envelope recipient, never the relay's claim.

Setup deploys the relay with the stored credential (`PUT
/accounts/{a}/workers/scripts/{name}` — one `Workers Scripts: Edit` token
covers both the script PUT and the secret PUT) and points the zone's
catch-all at it:

```
PUT /zones/{z}/email/routing/rules/catch_all
{ "matchers": [{ "type": "all" }],
  "actions":  [{ "type": "worker", "value": ["void-email-relay"] }],
  "enabled":  true }
```

`value` is an array with exactly one entry, and a catch-all holds exactly
one action. Omitted `source` defaults to `api`, which has one edge: if the
customer later runs `wrangler deploy` with an `addresses` array on the same
zone, wrangler reports our rule as an externally-managed conflict and asks
before taking over. Documented in `status` output, not fought. The name is
stable once chosen: renaming a worker detaches every routing rule pointing
at it, so `sync` redeploys in place and never renames. The chosen name is
recorded on the row BEFORE the script upload and secret PUT, so a failed
write still leaves the row knowing its relay — a retry redeploys in place
and a remove can find the worker; name exhaustion fails the deploy with no
name recorded (nothing was uploaded). The code is ours but the worker is the
customer's: they can read it, edit it or delete it, and `status` reports
drift on the next probe rather than fighting it. When the relay code
changes, `status` shows the deployed version and `void email domain sync`
redeploys with the stored credential. A leaked secret lets a stranger push
mail into one project's inbound, nothing else; `sync` rotates it. Worker
secrets are write-only — not even the account owner can read one back — so
rotation is overwrite with a new value, never read-compare.

**Inbound identity.** The relay sees the envelope recipient, so the address
the sender wrote arrives exact — a BCC included. The raw MIME passes through
unmodified: no SRS rewrite, no ARC seal, no `To:` recovery. `replyEmail` on
a relayed message defaults `from` to the address that received it, on the
customer domain, and goes out over the REST path.

**Trust.** The proxy accepts a relayed message only with the domain's relay
secret, generated by the platform at setup and stored on the row; the secret
maps to exactly one registered domain of one project, so `viaDomain` cannot
be forged without it. The proxy's auth branch applies header/length bounds
before any crypto, looks the domain's mirror up in ROUTING KV, compares the
secret's sha256 in constant time, and refuses any mirror whose status is not
`active` — a revoked or removed domain stops receiving at the proxy, not at
the relay. The reply-sender pin gains a second accepted shape: any address
on a domain registered to the receiving project.

### The flow — `void email domain add acme.com`

Mirrors `void domain add`: a row that goes `pending → active`, printed
instructions for the steps only a human can do, and `status` to poll.

```
$ void email domain add acme.com
  MX        acme.com carries MX for google.com → apex is off limits
            using mail.acme.com  [change with --subdomain]
  Grant     opening Cloudflare's consent page — it names Wrangler; that is expected   [Allow]
            ◀ access + refresh token · zone:read · email_routing:write · email_sending:write · workers_scripts:write
            (no browser here, or the consent fails? Enter switches to the template-link token path)
  Verify    grant works · zone acme.com found in account …f721
  Stored    refresh token on the platform, encrypted for this project · nothing kept on this machine
  Routing   mail.acme.com is not on Email Routing yet
            → add it: Email Routing → acme.com → Settings → Subdomains  (dashboard only)
  Sending   mail.acme.com onboarded — cf-bounce MX, SPF, DKIM, DMARC added
  Relay     void-email-relay deployed into account …f721 · catch-all → relay
  Status    pending · run `void email domain status acme.com`
```

Who does what:

| Step                     | Who                 | How                                                                                                                                             |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| grant                    | customer, one click | the CLI runs Cloudflare's OAuth consent on wrangler's public client; no browser or a failed consent falls back to the three-click template link |
| zone lookup, MX check    | platform            | `GET /zones?name=`, public DNS — no token needed for MX                                                                                         |
| routing on the apex      | platform            | `POST /zones/{z}/email/routing/dns`, only when MX is empty                                                                                      |
| routing on a subdomain   | customer, once      | dashboard — no API exists; the CLI prints the exact path and polls                                                                              |
| Email Sending onboarding | platform            | `POST /zones/{z}/email/sending/subdomains { name }`                                                                                             |
| relay worker             | platform            | `PUT /accounts/{c}/workers/scripts/void-email-relay` + the relay secret as a worker secret                                                      |
| catch-all → relay        | platform            | `GET` then `PUT /zones/{z}/email/routing/rules/catch_all`, action `worker` naming the relay — never written over an enabled foreign rule        |
| status → active          | platform            | every probe green; the map printed                                                                                                              |

The catch-all is never written blind. Setup reads it first (`GET
…/rules/catch_all`): an enabled rule naming anything but this row's relay
fails the row at `catch_all` with a conflict message — one zone routes one
email domain — and a rule already naming it makes the write a no-op.
`remove` resets the rule only when the same read shows it still naming this
row's relay; a foreign or unreadable rule is left alone (the latter reports
`catch_all` in `failed_steps`). The sending-onboard read-back paginates —
CF's list endpoint returns 20 per page, so confirmation walks
`?page=N&per_page=50` until a short page.

Email Sending is paid-plan-only while Email Routing is not, so an
entitlement refusal (CF error codes 2036/10105 — a Workers Free account)
does not fail setup: the relay and catch-all still deploy, and the row
lands `active` with `remaining_steps: ['sending_onboarding']`. Inbound
works; only the outbound lane (`send_raw`) stays refused at Cloudflare
until a plan upgrade, and the CLI prints that hint. Only the
inbound-blocking step gates the row: `routing_subdomain` holds it at
`pending`, while `sending_onboarding` rides along on an active row.

`void email domain status`, `list`, `sync`, `remove`. `sync` redeploys the
relay in place, rotates its secret, and runs the catch-all ensure whenever
the row carries a zone: missing, disabled or non-worker rules are repointed
(`ensured`); a rule already naming this row's relay is left alone
(`already_set`); an enabled rule naming a DIFFERENT worker is reported
(`foreign_conflict`) and never overwritten; a probe failure is
`probe_failed`. The status GET is read-only: it reports `catch_all`
(`points_here` / `points_elsewhere` / `missing` / `disabled` / `unknown`)
and `catch_all_drift` on live rows; healing is the sync POST, which the
CLI's drift hint names. A `pending` row whose only remaining step is
`routing_subdomain` self-clears: the status GET probes public DNS for MX
naming Cloudflare's inbound exchanges (`route1..3.mx.cloudflare.net`) — the
dashboard form's observable effect — and on evidence flips the row to
`active` and the mirror follows. The `sending_onboarding` step self-clears
the same way on its own evidence — the customer-credential read-back
showing the subdomain onboarded — and `sync` re-attempts the onboarding
POST outright, so a Workers Paid upgrade completes the row without
re-adding. The self-clear write is fenced on the probed status and setup
state, and is suppressed while a removal failure (`failed_step: 'remove'`)
is pending, so a poll never rewrites a row that a concurrent revocation or
an unfinished removal just changed. The customer can also revoke the credential
at Cloudflare at any time; the next probe sees it and the row reads
`token_revoked` / `token_expired`, with inbound continuing until they delete
the rule or the relay themselves.

### Setup is re-runnable

Re-adding a `failed` row re-runs the full engine against the row's recorded
progress, and a re-run never erases what the row already learned: the engine
seeds its returned progress from the row (`zone_id` / `account_id` / `mode`
/ `relay_worker_name`), so a re-run that fails early (a dead credential at
`verify_credential`) still persists them. A recorded mode skips the MX check
(the first attempt's enable_routing put OUR MX on the domain), a recorded
relay name redeploys in place rather than walking to a fresh `-2`, and an
"already done" 400/409 from enable_routing/onboard_sending is believed only
when a read-back of the actual zone state confirms it (`GET email/routing`'s
`enabled`, resp. the sending-subdomain list) — fail-closed otherwise.
Healthy rows (active / pending / credential renewal) take the sync-only
path.

### Concurrency and durability backstops

- **Two partial unique indexes backstop the engine's check-then-write.** One
  live row per zone (`status IN ('active','pending')`, so a `failed` row can
  still record the zone it failed in) and one relay name per account
  (`relay_worker_name IS NOT NULL` — a deployed relay really exists). A
  racing loser violates the index with a 23505 and gets a 409; the
  constraint name classifies the race, read by walking the error's cause
  chain (both drivers — PGlite and `pg` — expose it as `constraint` on the
  frame that carries the code). The loser's CF-side work is compensated
  best-effort from what its engine returned: a zone race fully removes, a
  relay-name race never deletes the contested worker — only its zone rule is
  conditionally detached, because the destructive misclassification would be
  deleting a worker another live row owns.
- **A deploy checkpoint closes the catch-all race structurally.** The engine
  fires a `persistProgress` dep once — after the relay deploy + secret PUT,
  before the catch-all write — and the route persists it
  (`applyEmailDomainDeployCheckpoint`, an UPDATE…RETURNING). With the
  indexes, a racing loser 23505s at the checkpoint and never writes its zone
  rule, so the last-write-wins window (loser's rule overwritten onto the
  zone, winner's row live but unrouted) cannot occur for fresh adds.
  Checkpoints are skipped on in-place redeploys — a row that already carries
  `relay_worker_name` already knows.
- **Any checkpoint failure compensates from the captured payload.** A
  non-unique checkpoint error, or the row cascade-deleted by teardown
  mid-setup, leaves the relay deployed but unrecorded; the route runs
  `removeEmailDomain` from the in-memory checkpoint before propagating (the
  catch-all was never written, so the conditional reset is a no-op). A gone
  row switches the grant refresh to the engine default, which acts on the
  held credential — the serialized chain needs the row — and 409s as
  `project is being deleted`; other failures rethrow.
- **A re-run that 23505s at the final apply repoints rather than resets.**
  The compensation does a winner lookup (`zone_id` + the index's live
  statuses + relay non-null, excluding the loser) and hands
  `repoint_catch_all_to` to the engine, which REPOINTS an owned rule at the
  winner instead of resetting it — the winner's existence is probed before
  AND after the PUT, and a lookup failure degrades to the plain reset. One
  zone keeps working mail through the conflict.
- **A non-unique apply failure does not orphan the relay.** The apply
  wrapper re-reads the row: committed (relay name AND `relay_version` match
  — the checkpoint never writes the version, so the pair distinguishes a
  committed apply from a checkpoint write) → the row stands as applied;
  otherwise the possibly-deployed CF state is compensated from the engine's
  result with its own account_id and the original error rethrows. A re-read
  failure logs and rethrows; a null relay (setup failed before the deploy)
  never compensates. The sync route's live-status flip can also 23505 (a
  `failed` row rejoining the live set while a winner holds its zone) —
  mapped to the same 409 zone message, deliberately without compensation.
- **Sync serializes the whole rotation under the project and credential
  row locks, in teardown's order.** Relay redeploy, secret PUT, row apply
  and mirror publication run in one transaction that takes the project row
  FOR UPDATE first — refusing when teardown has marked it `deleting`, so a
  sync that raced the route's entry guard can never redeploy or republish
  state teardown already cleared — and then the domain row FOR UPDATE, the
  lease chain's own. The row — credential included — is re-read under the
  lock: a credential replace that lands while a sync waits is synced as
  the new credential, never verified as the superseded one, and two
  overlapping syncs publish the worker secret and its mirror hash in the
  same order. A mirror PUT failure rolls the row apply back with it.

### Removal and teardown

- **Removal detaches before it deletes.** `removeEmailDomain` resets the
  zone catch-all (when the ownership read shows it still naming this row's
  relay) BEFORE deleting the relay script; if the read or the reset fails,
  the delete is deliberately skipped and both steps report failed — an
  enabled catch-all never points at a deleted worker; rule and relay stay a
  consistent pair.
- **A failed removal keeps the row.** DELETE's CF cleanup failing on a
  destructive step (`catch_all` or `delete_relay`) marks the row
  `setup_state.failed_step = 'remove'` + `removal_failed_steps` (both ride
  the existing jsonb — no migration) and answers `200 { ok: false, removed:
false, failed_steps }`. The owner retries once the CF-side problem is
  fixed, or forces with `?force=1` (`removed: true, forced: true`). Two
  exceptions still delete unconditionally: `token_revoked` rows (the grant
  is already dead, keeping buys no retry leverage) and a `revoke_grant`-only
  failure (a stranded grant breaks no mail). While a row carries the removal
  mark the status GET suppresses its mirror repair — the proxy's view must
  not be "repaired" against a removal the operator is about to finish. The
  CLI mirrors the contract: `--force`, exit 1 with retry guidance on
  `removed: false`, and manual-cleanup hints on a forced removal.
- **Removal runs under the same row lock.** The owner DELETE re-reads the
  row — credential included — inside the lease chain's FOR UPDATE and
  builds its cleanup from what the row holds at lock time: a replace that
  commits while a removal waits is removed as the NEW credential (its
  grant revoked), never orphaned by a row delete built on the stale
  snapshot — the replace never invalidates an old API token, so the stale
  cleanup would have succeeded and the new grant's only handle would have
  been deleted with the row. Mirror clear and row delete stay inside the
  same transaction; a KV failure rolls the row delete back with it.
- **Project teardown cleans the customer side.** After the KV mirrors are
  revoked (fail-closed) and before the DB cascade, teardown runs
  `removeEmailDomain` for each registered domain with a deployed relay,
  best-effort and never throwing: the mirrors being gone makes a stranded
  relay inert, and the grant refresh goes through the row's serialized chain
  so a crash before the cascade leaves the credential live for the retry.
- **The admin surface follows the same order.** The full-removal route
  clears the ROUTING mirror first, runs the same engine removal (with the
  grant deps below), then deletes the row; a mirror-clear failure keeps the
  row and runs nothing destructive. The operator escape hatch `POST
/admin/email/:projectId/domains/:domain/revoke-grant` kills one domain's
  grant without tearing the domain down: it writes the mirror as
  `token_revoked` FIRST (the proxy's relay auth checks `active`, so inbound
  stops here), then revokes, then flips the row. A failed revoke answers 502
  with the row still active, and the next status GET repairs the mirror —
  the same self-heal as any drift.

### Data and the credential

- `email_domains` — `project_id`, `domain` (the address domain, apex or
  subdomain), `zone_id`, `account_id`, `mode: 'apex' | 'subdomain'`,
  `status: 'pending' | 'active' | 'token_revoked' | 'token_expired' |
'failed'`, `relay_worker_name`, `relay_version`, the relay secret
  ciphertext triple, `setup_state` (a jsonb carrying `failed_step`,
  `remaining_steps` or `removal_failed_steps`), `token_id` and
  `token_expires_on` from `GET /user/tokens/verify` (so `status` can name
  the token to revoke and warn before a TTL runs out), timestamps. The two
  partial unique indexes from the backstops section ride the same table.
- The credential is stored with `encryptProjectSecret` under the project's
  envelope key, per domain, and only the api and proxy ever decrypt it. It
  is never written to a manifest or a log — the one worker it deploys is the
  relay, and the relay carries only its own domain's secret, never the
  credential. The relay secret is encrypted on the same envelope. The AAD is
  `${projectId}:${name}` with fixed per-row names —
  `email-domain-token:<domain>` and `email-domain-relay:<domain>`.
- The proxy never reads the row: the api mirrors what the proxy needs to
  ROUTING KV as `email-domain:<domain>` — `{ projectId, status,
relaySecretSha256, relayWorkerName, accountId, zoneId, mode }` — rewritten
  on every status transition and secret rotation, tightened before any
  revoke, deleted on removal, and repaired by the status GET when it drifts.
- Scopes, minimum: zone-scoped `Zone Read` (to find the zone id), `Email
Routing Rules Edit` (the catch-all) and `Zone Settings Edit` (the routing
  POST, both paths); account-scoped `Workers Scripts: Write` (to deploy and
  update the relay) and `Email Sending Edit`. `Email Routing Addresses Edit`
  is not needed — there is no destination address to manage — and `DNS Read`
  is not needed — MX is read over public DNS. Account-level scopes are
  necessarily account-wide, and `Workers Scripts: Write` is the wide one:
  per-script scoping does not exist (the token resource picker stops at the
  account), so it covers every script in the account, and the token summary
  page shows that before the customer clicks **Create Token**. That breadth
  is the honest price of "connect and we configure it for you" — Mode B
  already asks for the same trust through `wrangler login`.

### The OAuth grant on wrangler's client

The primary credential path is Cloudflare's OAuth consent on **wrangler's
public OAuth client**: the CLI opens the consent page with wrangler's
`client_id` (a public PKCE client with no secret; endpoints
`dash.cloudflare.com/oauth2/{auth,token,revoke}`), the customer clicks
**Allow**, and the platform stores the refresh token. The CLI uses a
`localhost:8976/oauth/callback` redirect, as wrangler does; every observed
third-party flow on this client id redirects to localhost, so whether
Cloudflare accepts any other redirect URI for it is unverified (probe 8) —
which is why the dashboard ships the template link + paste box either way.

What it costs, recorded with the decision:

- **Breadth.** An OAuth grant is user-wide — every account the user belongs
  to, every zone in them, for the granted scopes. `wrangler whoami` shows
  this today. A template-link token can be narrowed to one zone; a grant
  cannot. The template link stays as the narrow option for a company with
  many zones; the grant is the default for everyone else.
- **Refresh.** The access token lives about an hour. Refresh tokens are
  **single-use and rotate**, so the platform runs its own grant chain — it
  never touches the refresh token in the developer's `~/.wrangler`, which
  would race wrangler's own refreshes and kill both. Refresh is serialized
  per domain row and the rotated token is persisted atomically with it
  (the credential lease). A revoked grant surfaces as `token_revoked`.
- **Scopes.** The grant asks for wrangler's own names: `zone:read`,
  `email_routing:write` ("settings, rules, and destination addresses"),
  `email_sending:write`, `workers_scripts:write`, plus `offline_access`.
  There is **no `zone_settings` OAuth scope** — the session reaches the
  email zone-settings endpoints under `email_routing:write`'s "settings"
  wording.
- **The consent screen names Wrangler.** It is Cloudflare's hosted page for
  the wrangler client; it cannot say Void. The CLI prints one line before
  opening the browser so the customer is not surprised.
- **The client id is not ours.** Cloudflare can rotate or revoke it any
  day — so the template link + paste is not a legacy path, it is the
  permanent fallback the CLI drops to when the consent flow fails.

**The grant is revoked on every path that should kill it.**
`revokeOauthGrant` POSTs the RFC 7009 form to
`dash.cloudflare.com/oauth2/revoke` (wrangler's client id,
`token_type_hint=refresh_token`, no Authorization header — a public client
authenticates with the token itself, exactly wrangler's `logout`). It throws
on a network failure or non-2xx — CF answers 200 even for a bogus token, so
a failure leaves the grant's state genuinely unknown and callers record
`revoke_grant` in `failed_steps` — and it never logs the token. Removal
revokes LAST, with the rotated chain head (a transient refresh failure
revokes the original stored token instead; `invalid_grant` skips — CF
already killed it). Credential replace revokes the old grant after the
commit — a re-pasted identical grant is skipped (revoking it would brick the
just-stored credential) and a revoke failure is logged, never fatal.
Teardown and admin removal revoke. Conflict compensation deliberately does
NOT — the loser's credential may survive on another row. The revocation's
cascade scope (access tokens minted from the grant) is undocumented and
unprobed — accepted.

And the path that does **not** work, so nobody designs it again: minting a
long-lived scoped API token from the session (`POST /user/tokens` with the
bearer). Token creation requires the `API Tokens Write` group, which is not
in wrangler's OAuth scope set and does not exist as an OAuth scope at all.
The session bearer alone is no substitute either: it expires in an hour, and
its refresh chain belongs to wrangler — borrowing the **access** token via
`wrangler auth token` is safe (wrangler refreshes it); refreshing it outside
wrangler races the single-use rotation.

### Creating the token in three clicks

The fallback grant path, for a browserless terminal, a failed consent flow,
or a company that wants a zone-narrowed token. Cloudflare's dashboard
accepts a template URL that pre-fills the token form — name, permission
groups, resources. The CLI opens it; the customer clicks **Continue to
summary**, **Create Token**, **Copy** — and the CLI takes the token from the
clipboard. Three clicks, nothing typed (plus a login if the browser has
none).

```
CLI                                   browser                       CLI
 │ MX check over public DNS            │                              │
 │ → apex or subdomain decided         │                              │
 │ build the link (scopes fit the path)│                              │
 │ snapshot the clipboard              │                              │
 │ open ─────────────────────────────▶ │ form is pre-filled           │
 │ watch the clipboard (≤ 10 min)      │ 1 Continue to summary        │
 │                                     │ 2 Create Token               │
 │ ◀──────────────────────── clipboard │ 3 Copy                       │
 │ shape ok → GET /user/tokens/verify → clear the clipboard           │
 │ GET /zones?name=acme.com · scope check                             │
 │ send over TLS → platform stores with encryptProjectSecret          │
 │ drop it from memory · continue with Zone / Routing …               │
```

| Branch                                | What the developer sees                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| clipboard unchanged, or wrong shape   | nothing; still waiting. Enter switches to the paste prompt                                       |
| verify says not active                | "that is not an active Cloudflare token — still waiting"                                         |
| 10 minutes, nothing                   | the paste prompt; Esc cancels with nothing stored anywhere                                       |
| zone not found with this token        | `failed · acme.com is not in an account this token can see` → re-run `add`                       |
| 403 on a scope probe                  | `failed · missing Workers Scripts Edit` → re-run `add`; the link carries the key                 |
| `expires_on` passed, or revoked at CF | `status` reads `token expired` / `token revoked`; `add` again replaces the token, rules stay     |
| `remove`                              | catch-all rule and relay worker deleted with the token, best effort; then the row and ciphertext |

**The clipboard watch** reads only between opening the link and getting a
token, never otherwise, and says so on screen. It ignores whatever was on
the clipboard before the link opened (the snapshot) and accepts only a _new_
value shaped like a Cloudflare token: the current `cfut_` format (prefix, 40
characters, checksum) or a legacy 40-character `[A-Za-z0-9_-]` value; other
vendor prefixes (`ghp_`, `github_pat_`, `sk-`, `xox`, `cfk_`) are refused
without a network call. Only a value that passes the shape check is sent to
`GET /user/tokens/verify`, and only `status: active` is accepted. It clears
the clipboard once it has the token, so the token does not sit there for the
next paste — a clipboard manager's history is outside our reach, and the CLI
says so once. Enter at any time switches to the masked paste prompt; no
clipboard tool (SSH, CI, a Wayland session without `wl-paste`) falls back to
it silently. Nothing on the clipboard is ever printed or logged.

The link:

```
https://dash.cloudflare.com/profile/api-tokens
  ?permissionGroupKeys=<url-encoded JSON below>
  &accountId=*            # required by the form; "all accounts" — the customer narrows it in the summary if they like
  &zoneId=all             # required by the form; narrow to acme.com in the summary (undocumented whether honoured)
  &name=Void%20email%20%E2%80%94%20acme.com
```

```json
[
  { "key": "zone", "type": "read" },
  { "key": "email_routing_rule", "type": "edit" },
  { "key": "email_sending", "type": "edit" },
  { "key": "workers_scripts", "type": "edit" },
  { "key": "zone_settings", "type": "edit" }
]
```

Every key rides every link — there is no apex-only key, because `Zone
Settings Edit` gates the routing POST on both paths. The documented key
table stops at `workers_*` / `zone_settings`; the two email keys are
community-verified (`email_routing_rule` from the dashboard permission-group
dump, `email_sending` from erxes' shipped config), and unknown keys are
silently dropped — so the docs also show the manual token-creation steps
rather than relying on the pre-fill alone.

What this path does not do, so nobody expects it:

- The dashboard never hands the token back. There is no redirect, no
  callback, no local listener to receive it — the paste is the transport.
- Creating the token by API (`POST /accounts/{id}/tokens`) needs a token
  with `API Tokens: Edit` first — the same chicken, one egg earlier.
- The developer's local `wrangler login` session cannot replace the stored
  grant: the bearer expires in an hour and its refresh chain belongs to
  wrangler, and the session cannot mint the platform a long-lived token
  (above).

**Where the token lives.** On the platform, encrypted per project with
`encryptProjectSecret` — the proxy sends with it at runtime and the api
re-probes with it, so that copy is the one that must exist. On the
developer's machine: nowhere. The CLI holds it in memory, hands it to the
platform over TLS as its first call, and drops it; every later step
(`status`, `remove`, repair) goes through the platform. The one thing the
platform copy does not solve is a **TTL** the customer set on the form:
sends stop when it expires, `status` reads `token expired`, and `void email
domain add` again is the renewal. The account-token form is the better home
for a company, because the token survives the employee — but it needs an
Administrator and cannot carry `accountId`/`zoneId` parameters, so the user
token is the default.

### What changes in the existing rules

- **Reply-sender pin** — accepts the receiving slug on the shared domain
  _or_ any address on a domain registered to the project.
- **Recipient allowlist** — does not gate custom-domain sends: Cloudflare's
  verified-destination gate is lifted by the customer's own onboarding, and
  the reputation at stake is the customer's own. The burst cap and the kill
  switch still apply.
- **Quotas and kill switch** — the platform's burst cap and suspend switch
  keep applying to every send that passes through the proxy, custom domain
  or not; the daily quota is the customer's account's.
- **The 200-destination cap is untouched** — a relay consumes no destination
  address in either account.
- **One worker of ours lives in their account** — readable, editable and
  deletable by the customer, as everything in their account is. `status`
  reports drift; it does not fight it.

### Limits, stated plainly

- The customer's account must be on **Workers Paid** to send; routing alone
  works on Free.
- Two steps stay human: the credential grant (one Allow click, or three
  clicks and a paste) and the routing-subdomain dashboard form.
- The credential asks for `Workers Scripts: Write` — account-wide, and the
  customer sees that on the token form — and one relay worker lives in the
  customer's account.
- Inbound messages cap at 25 MiB (Cloudflare rejects larger ones before the
  relay runs), a zone holds at most 30 email domains, and a domain holds at
  most 200 routing rules.
- The relay name-walk caps at 50 names per account (`void-email-relay`
  through `-50`); exhaustion fails the deploy step with nothing uploaded.
- A domain that is not on Cloudflare DNS is not covered.

### Mode B

The developer's own zone needs none of this. Their worker holds the
`send_email` binding, the rules target their worker directly, and there is
no relay and no stored credential — [Mode
B](#mode-b--the-developers-own-cloudflare-account) already covers it.

### Verified against live Cloudflare

Probed on a real zone (voidcloud.dev, restored byte-identical afterward),
2026-09-17: `POST …/email/routing/dns {name}` enables a subdomain (200,
three MX auto-created); sending onboard with a user API token succeeds (200)
— the schema declares Global-key-only, so the declared auth lags the
endpoint — and also stamps the apex SPF + DKIM; apex enable is an empty-body
POST; ONE zone-scoped catch-all (auto-created drop+disabled on first
enable) covers apex and subdomain — there is no per-email-domain rule; relay
script PUT + secret PUT + catch-all PUT all accept an API token (200/201/200

- read-back enabled); `send_raw` takes the JSON envelope `{from, recipients,
mime_message}` (a raw `message/rfc822` body earns `10001
invalid_request_schema`) and returns `200 queued` with a message_id. The
  revocation endpoint is advertised by the OIDC discovery document and answers
  200 even for a bogus token. `routing/dns` is authorized by Zone Settings
  Write and rules by Email Routing Rules Write; `10103 bad_token_type` is
  Email Sending's credential-type rejection; `send_raw` accepts user and
  account tokens (account-owned recommended). CF's cleanup does not remove
  `_dmarc.<sub>` on subdomain/routing deletion — the engine never touches DNS
  by design, and the CLI prints the manual cleanup list.

Still open: the dashboard-UI probes, the browser PKCE run (what the consent
screen says, whether a non-localhost redirect is accepted, rotation over a
few cycles, whether the grant's `email_routing:write` covers the two calls
wrangler never makes), a message-level inbound E2E (needs observability an
API token cannot reach), and the narrow template-token variants.

### Where each piece lives

- **CF calls from the api** follow `cfFetch`
  (`platform/packages/api/src/provisioning/cloudflare-api.ts`). The relay
  deploy is a plain `PUT /accounts/{a}/workers/scripts/{name}` with a
  multipart FormData body, plus a non-namespace variant of `putWorkerSecret`.
- **The relay source is an embedded asset in the api worker** — one constant
  module plus a `relay_version`; `sync` redeploys it.
- **`/email/relay` in the proxy** is a branch in the global auth middleware,
  modelled on the `/email/internal/` branch: size bounds before any crypto,
  secret → mirror → project, then the second half of `routeInbound`
  (envelope → `stub.email` → `enactActions`) keyed by the domain's project
  instead of a slug parsed from the recipient.
- **Schema:** `email_domains` follows the `emailDestinations` template
  (`status` as a `$type` union, CHECK constraints declared in the schema so
  drizzle-kit doesn't diff them away); migration `0039_email_domains`.
- **CLI:** `void email domain …` verbs under the email group; API calls join
  `PlatformClient`'s `/projects/:id/email/…` methods; the owner-guard routes
  live in `routes/email.ts`; the admin section in `admin/routes/email.tsx`.

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
