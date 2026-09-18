---
title: Cloudflare-Native Email Design
status: implemented
created: 2026-04-24
updated: 2026-09-18
---

# Cloudflare-native email design

The [email guide](../../../docs/guide/email.md) describes the supported API
and setup. This record holds the trust boundaries, lifecycle rules and
accepted limitations behind it. Sections marked **planned** describe the
target design for a self-hosted platform whose users hold no Cloudflare
credential; they are not built yet.

## Hosting modes

### Mode A — managed platform

The platform proxy owns the account-level `send_email` binding. Tenant
Workers receive only the authenticated `__VOID_PROXY` interface; a raw send
binding would bypass destination consent, suspension and quota policy.

The mail domain is configured per environment as `EMAIL_SENDER_DOMAIN` and
injected as `__VOID_EMAIL_DOMAIN`. Missing configuration fails closed. The
project-slug binding is `__VOID_PROJECT_SLUG`; senders must belong to that
project's namespace on the configured mail domain.

#### Verified destinations

Cloudflare's account-level verification does not establish consent for every
project on the account. `email_destinations.verification_source` keeps the
distinction:

- **Owner inheritance** — an already verified address matching the current
  project owner's email inherits that owner's consent. The owner email is
  rechecked inside the transaction that writes or promotes the destination;
  an owner-email change revokes inherited consent and tightens the allowlist
  without silently committing a failed tighten.
- **Platform confirmation** — an address verified for another project stays
  pending until the recipient follows this project's signed confirmation
  link. A Cloudflare refresh cannot bypass this gate.
- A newly registered Cloudflare destination is promoted only when the
  verified tag matches the project's registration; an unrelated recreation of
  the same address proves nothing.

The proxy reads `email-allowlist:<projectId>` from routing KV. Destination
listing repairs a missing or inconsistent mirror from the authoritative
verified rows; an absent mirror fails closed. A verified platform row is not
revoked by an out-of-band Cloudflare deletion; Cloudflare refuses the actual
send until its destination is verified again.

#### Recipient policy (planned)

One installation-wide setting decides whether the per-project allowlist gates
shared-sender recipients:

```
 mode        shared-sender recipient passes when …                 default
 ─────────   ────────────────────────────────────────────────────  ───────
 verified    it is on the project's allowlist                       yes
 domains     its domain is in the policy list, OR it is allowlisted
 any         always
```

The policy does not fake delivery: Cloudflare's `send_email` binding still
refuses an unverified destination unless the platform mail domain is onboarded
for Email Sending (Workers Paid on the operator's account). Under `domains` or
`any` that refusal still arrives as a per-recipient `UNVERIFIED_DESTINATION`;
the admin UI, the CLI and the health check say so next to the policy.

Scope: shared-sender sends and the inbound forward/reply gate. Custom-domain
sends are unchanged. Burst cap, monthly cap, the `email-suspended:` kill
switch and the reply-sender pin do not move.

Storage: authoritative in PostgreSQL with the other installation settings,
mirrored to routing KV as `email-recipient-policy` for the proxy's hot path
(`cacheTtl: 60`, like the allowlist). An absent or unreadable mirror means
`verified`. Surface: a platform-wide email section in the admin UI and
`void platform email policy show | set <mode> [--domain example.com …]`,
recorded in `operator_events`.

#### Quotas and visibility

Outbound sends and inbound forward/reply actions share destination,
suspension, burst and monthly checks. Burst and monthly caps apply to every
send through the proxy, custom domain included, and are
administrator-controlled per project. The counters are KV read-modify-write
and best-effort under concurrency, not strict admission limits.

Destination listing picks up pending Cloudflare verification; Cloudflare does
not push that event. Persistent project delivery logs are not implemented:
`void email logs` reports pending support. A handled inbound message can still
have a forward or reply refused by its outbound gate; a handled receipt is not
proof of delivery.

### Mode B — the developer's own Cloudflare account

Native setup lives in
[email-cloudflare.ts](../../../packages/void/src/cli/email-cloudflare.ts).
`void deploy --platform cloudflare` and `void email setup|status` share its
read-only preflight and selected Wrangler session. The developer supplies
`email.from`; Void never chooses a mail domain.

#### One keystroke

Interactive deployment shows the selected account, the domain and the
unfinished account changes before offering setup. Non-interactive deployment
reports unfinished setup and deploys without email; `--require-email` makes
setup a prerequisite. Ready configuration is reconciled without repeating
account mutations.

The checklist separates account work, config updates and routing rules.
`wrangler deploy` owns rule application; a pending rule is not a reason to
rerun account onboarding. A refused Sending onboarding is retried only by an
explicit `void email setup`.

#### The flow, by lane

1. Read domain DNS, account identity, routing settings, existing rules and
   Sending state before applying anything.
2. Enable routing only where needed; leave apex mail records alone when the
   sender uses a subdomain.
3. Enable the zone's `support_subaddress` setting when needed; a literal
   address rule alone does not deliver `support+tag@`.
4. Attempt Sending onboarding; report plan or permission refusals without
   touching unrelated records.
5. Reconcile the owned sender and binding configuration. Write `addresses`
   only when inbound routing is ready, then let pinned Wrangler apply it.
6. Print the inbound map and the remaining manual steps.

#### Credentials

Use pinned Wrangler commands wherever one exists. For zone classification,
subdomain routing and subaddressing — calls with no Wrangler command — borrow
the session bearer through `wrangler auth token --json` inside the narrow
request closure. Never persist, log, include in errors or forward it to
another origin; disable Wrangler disk logging on the handoff. Credentialed
preflight runs before any project code is evaluated.

The session gate checks the required email scopes on OAuth sessions. API-token
permissions are established by the actual reads. A Global API Key is refused
where the bridge needs a bearer. Prose parsers are pinned to the bundled
Wrangler version and tested against its captured output; a parser miss yields
unknown state and setup guidance, never permission to write.

#### The `addresses` array

Void owns the whole derived top-level `addresses` array. Hand-written entries
it cannot derive skip setup without changing the array. Addresses already
routed elsewhere are pruned from the plan. When routing is unready the key is
deleted, never written as `[]` — that would ask Wrangler to delete every owned
rule. The root config is re-read after edits and the deployment verifier's
whole-array check is preserved.

#### Error map and degraded branches

Known provider errors are classified for routing-not-enabled,
already-onboarded and Sending-entitlement refusals. Unknown failures stay
diagnosable and never authorize retrying an uncertain write.

A refused subdomain-routing or subaddressing call prints the explicit
Cloudflare dashboard step and withholds `addresses` for that run. Setup is
never reported complete merely because the Worker uploaded. Sender config and
an inert send binding remain useful for verified destinations when
arbitrary-recipient Sending is unavailable.

#### Unverified against live Cloudflare

Unit tests are not provider acceptance. Still to establish with the selected
credential type, per the [live release procedure](../release-acceptance.md):
the subdomain routing POST and subaddressing PATCH, rule-plan permissions,
conflict behavior after dashboard edits or Worker renames, and multi-label
mail subdomains.

### Mode C — self-hosted platform

The same proxy and consent rules apply to an operator-owned platform. The
operator configures its mail domain, sender, proxy binding and Email Routing
before enabling email; core installation does not do this automatically. Use
[platform operations](../operations.md) for the operator workflow.

Users of a self-hosted platform may hold no Cloudflare credential at all.
[Administrator-managed domains](#administrator-managed-domains-planned) covers
that case; the engine below is unchanged by it.

## Cross-worker dispatch

Cloudflare's `ForwardableEmailMessage` is not serializable over RPC. The
proxy buffers a bounded envelope and calls the tenant's
`WorkerEntrypoint.email()`; the generated handler returns action intents,
and the proxy validates and enacts them against the original message.

The wire recipient travels as `__voidPlatformTo` for dispatch. The platform
slug prefix is stripped exactly once for the user-facing message. Matching is
case-insensitive and preserves the original case of captured parameters.

Pre-buffering bounds the inbound raw body and the distinct header count before
the RPC envelope is built. Forward/reply/reject validation bounds action
count, address and header size and cumulative reply bytes. These limits are
independent — a raw byte cap alone permits an excessive number of short
headers. Invalid actions cannot bypass the outbound gate.

### RPC result materialization — accepted limit

The tenant's entire RPC return value is materialized inside the shared proxy
before action validation. The framework's action queue constrains cooperative
handlers; an arbitrary tenant entrypoint can return any object graph, and the
32 MiB serialized [RPC limit](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations)
does not bound the receiver's heap — a dense array near the cap materializes
several times its serialized size against
[Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory).

This is an accepted architectural limitation. Callee CPU limits reduce some
inputs but give no hard caller-heap bound, and no return-type convention can
constrain a hostile callee. Possible future boundaries — a reserved HTTP
endpoint with a bounded body, a dedicated inbound-email dispatch Worker, or a
separate email CPU budget — change the framework contract or deployment
architecture and are separate decisions.

## Local development and testing

The development inbox captures outbound MIME and requires the project's
dev-trigger token on every route. It is not a production transport. Skipping
capture with `sendInDev` creates no binding and guarantees no delivery. When
Void removes its own dev send transport it preserves the user's independently
named send bindings.

Test harnesses exercise the same message construction, routing and action
semantics as production. Inbound parsing consumes a stream; handlers choose
when to parse it. Threaded replies treat sender-supplied headers as untrusted
and fall back safely when threading metadata is malformed.

## Custom domains on Cloudflare

A project can send as and receive at its own domain — `support@example.com`,
`noreply@mail.example.com` — when that domain's DNS zone is on Cloudflare.
The zone stays in the customer's own account. The customer grants the platform
a scoped credential once; the platform configures the zone and runs both
directions on their behalf. Inbound crosses accounts in a **relay worker**
deployed into the customer's account; outbound crosses back as a REST send
with the same credential. The relay needs no operator mail zone, so custom
domains work identically on a self-hosted platform, and the raw MIME arrives
unmodified — no `To:` recovery, no BCC loss, no SRS/ARC hop, no destination
verification click. The price is one wider token scope, `Workers Scripts:
Write`, which the customer sees on the token form.

"On Cloudflare" means a zone under Cloudflare DNS in an account the customer
controls. A domain that only CNAMEs to Void through Cloudflare for SaaS is out
of scope: Email Routing needs MX records on a Cloudflare zone, and RFC 2181
forbids MX beside a CNAME.

After the one-time grant, a developer sees an address, recipients, a counter
and an error code — never a zone, a rule or a token scope. One domain belongs
to one project; a company uses one subdomain per project.

### Why this model

| Model                                            | Needs from the customer                     | Verdict                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Bring your zone — a scoped token** _(adopted)_ | one credential, one dashboard step per sub. | zone stays theirs; apex MX untouched; routing on Free, sending on Paid; the domain signs its own DKIM, reputation per customer |
| NS delegation of the whole domain                | move all DNS to us                          | we would own every record they have                                                                                            |
| `mail.example.com` as a zone in our account      | delegate one subdomain                      | Cloudflare subdomain setup is Enterprise-only                                                                                  |
| Self-hosted SMTP relay                           | nothing                                     | reinvents Email Routing                                                                                                        |

### The two paths

A routing rule can only name a worker in its own account, so inbound from a
customer zone cannot reach `void-proxy` directly.

```
INBOUND   support+T-42@example.com
            │   MX in the customer's account (mail.example.com, or the apex when its MX is empty)
            ▼
          catch-all rule → void-email-relay (a worker in the customer's account, deployed by setup)
            │   envelope recipient exact — To:, Cc: and BCC alike · raw MIME unmodified
            ▼
          POST <proxy>/email/relay   Authorization: the domain's relay secret
            │   secret → registered domain → project
            ▼
          project worker  email()   to = support+T-42@example.com   viaDomain = example.com
                                    dispatcher runs in no-prefix mode

OUTBOUND  sendEmail({ from: "noreply@example.com", … })
            │   proxy: from-domain is registered to this project → lease that domain's credential
            ▼
          POST /accounts/{customer}/email/sending/send_raw   { from, recipients, mime_message }
                DKIM = the customer's domain · daily quota = the customer's · message_id returned
```

**The relay worker.** One per registered domain, named `void-email-relay`
(suffixed `-2`, `-3`… on collision within the account, up to 50). Its
`email()` handler streams `message.raw` straight into a POST with the domain's
relay secret — no parsing, no buffering, so it stays inside Workers Free CPU
limits. The stream rides through a `FixedLengthStream(rawSize)` because the
runtime derives Content-Length from the body and the proxy refuses a
length-less body before any crypto. `message.to` is the single envelope
recipient, so a multi-recipient message is one invocation per recipient.

The catch-all is zone-scoped, so mail for a second domain on the same zone can
land on the first domain's relay: the relay `setReject`s any message whose
recipient domain is not its own — a loud bounce — and the proxy's `/email/relay`
branch independently 403s when the declared `X-Void-Email-Domain` does not
equal the recipient's domain, keying its mirror lookup on the recipient's
domain. Attribution binds to the envelope recipient, never the relay's claim.

Setup deploys the relay with the stored credential (`PUT
/accounts/{a}/workers/scripts/{name}` plus the secret PUT — one `Workers
Scripts: Edit` token covers both) and points the zone's catch-all at it:

```
PUT /zones/{z}/email/routing/rules/catch_all
{ "matchers": [{ "type": "all" }],
  "actions":  [{ "type": "worker", "value": ["void-email-relay"] }],
  "enabled":  true }
```

The rule's omitted `source` defaults to `api`; if the customer later runs
`wrangler deploy` with an `addresses` array on the same zone, Wrangler reports
our rule as an externally-managed conflict and asks before taking over. This
is stated in `status` output, not fought. The relay name is stable once
chosen — renaming a worker detaches every rule pointing at it — so `sync`
redeploys in place. The code is ours but the worker is the customer's: they
can read, edit or delete it, and `status` reports drift rather than fighting
it. A leaked secret lets a stranger push mail into one project's inbound and
nothing else; `sync` rotates it. Worker secrets are write-only, so rotation is
overwrite, never read-compare.

**Trust.** The proxy accepts a relayed message only with the domain's relay
secret, generated by the platform at setup. The secret maps to one registered
domain of one project, so `viaDomain` cannot be forged. The auth branch applies
header and length bounds before any crypto, looks the domain's mirror up in
routing KV, compares the secret's sha256 in constant time, and refuses any
mirror whose status is not `active` — a revoked or removed domain stops
receiving at the proxy, and the relay never learns why.

The reply-sender pin accepts a second shape: any address on a domain
registered to the receiving project. Such a reply runs through the FROM
domain's own mirror and credential lease — two domains of one project may live
in different customer accounts.

`replyEmail` on a relayed message defaults `from` to the address that received
it and goes out over the REST path.

### Setup — `void email domain add example.com`

Mirrors `void domain add`: a row that goes `pending → active`, printed
instructions for the steps only a human can do, and `status` to poll.

| Step                     | Who                 | How                                                                                                                          |
| ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| grant                    | customer, one click | Cloudflare's OAuth consent on Wrangler's public client; no browser or a failed consent falls back to the template-link token |
| zone lookup, MX check    | platform            | `GET /zones?name=`; MX over public DNS, no token needed                                                                      |
| routing on the apex      | platform            | `POST /zones/{z}/email/routing/dns`, only when the apex carries no MX                                                        |
| routing on a subdomain   | customer, once      | dashboard — no API exists; the CLI prints the exact path and `status` polls                                                  |
| Email Sending onboarding | platform            | `POST /zones/{z}/email/sending/subdomains { name }`                                                                          |
| relay worker             | platform            | script PUT + relay secret as a worker secret                                                                                 |
| catch-all → relay        | platform            | `GET` then `PUT …/rules/catch_all` naming the relay — never written over an enabled foreign rule                             |
| status → active          | platform            | every probe green; the map printed                                                                                           |

When the apex already carries MX records, the CLI proposes `mail.<domain>`
(`--subdomain` overrides). The catch-all is never written blind: an enabled
rule naming anything but this row's relay fails the row at `catch_all` with a
conflict message; a rule already naming it makes the write a no-op. The
sending-onboard read-back paginates the list endpoint until a short page.

**Steps that ride along.** Email Sending is paid-plan-only while Email Routing
is not. An entitlement refusal (CF error codes 2036/10105) does not fail
setup: the relay and catch-all still deploy and the row lands `active` with
`remaining_steps: ['sending_onboarding']`; inbound works, outbound stays
refused at Cloudflare until a plan upgrade. Only `routing_subdomain` holds a
row at `pending`.

**Self-clearing.** The status GET is read-only. A `pending` row whose only
remaining step is `routing_subdomain` probes public DNS for MX naming
Cloudflare's inbound exchanges (`route1..3.mx.cloudflare.net`) and on evidence
flips the row to `active`, mirror following. The `sending_onboarding` step
clears on the customer-credential read-back showing the subdomain onboarded;
**`sync` re-attempts the onboarding POST outright**, so after a Workers Paid
upgrade the answer is `sync`, not `status`. Every self-clear write is fenced on
the probed status and setup state and suppressed while a removal failure is
pending.

**Verbs.** `status` reports `catch_all` (`points_here` / `points_elsewhere` /
`missing` / `disabled` / `unknown`) and `catch_all_drift`; it re-probes the
credential and the relay on every call. `sync` redeploys the relay in place,
rotates its secret and ensures the catch-all: missing, disabled or non-worker
rules are repointed; a rule already naming this relay is left alone; an enabled
rule naming a different worker is reported and never overwritten. `remove`
deletes the platform row, the credential and the relay secret, with Cloudflare
cleanup best-effort. A credential the customer revokes at Cloudflare shows as
`token_revoked` / `token_expired` on the next probe, inbound continuing until
they delete the rule or the relay themselves.

**Re-runnable.** Re-adding a `failed` row re-runs the engine against the row's
recorded progress and never erases what the row learned: `zone_id`,
`account_id`, `mode` and `relay_worker_name` are seeded from the row. A
recorded mode skips the MX check (the first attempt put our MX on the domain);
a recorded relay name redeploys in place rather than walking to a fresh `-2`;
an "already done" 400/409 from enable-routing or onboard-sending is believed
only when a read-back of the zone confirms it. Healthy rows take the
sync-only path.

### Concurrency and durability invariants

- **Two partial unique indexes backstop check-then-write**: one live row per
  zone (`status IN ('active','pending')`, so a `failed` row can still record
  its zone) and one relay name per account (`relay_worker_name IS NOT NULL`).
  Setup claims its walked relay name on its own row before any upload, so two
  setups racing one account serialize first-to-claim; an engine throw after a
  successful claim restores the row's pre-engine values. A loser that still
  violates an index gets a 409, classified by the constraint name read from the
  error's cause chain. The loser's Cloudflare-side work is compensated
  best-effort: a zone race fully removes; a relay-name race never deletes the
  contested worker, only conditionally detaches its zone rule.
- **A deploy checkpoint closes the catch-all race.** The engine persists
  progress once — after the relay deploy and secret PUT, before the catch-all
  write. A racing loser fails there and never writes its zone rule.
  Checkpoints are skipped on in-place redeploys.
- **Any checkpoint failure compensates from the captured payload**, including
  the row being cascade-deleted by teardown mid-setup, which answers 409
  `project is being deleted`.
- **A re-run that hits the zone index at the final apply repoints** its owned
  catch-all at the winner instead of resetting it, probing the winner before
  and after the PUT; a lookup failure degrades to the plain reset.
- **A non-unique apply failure does not orphan the relay.** The row is
  re-read: relay name and `relay_version` both matching means the apply
  committed; otherwise the deployed state is compensated and the error
  rethrown.
- **Sync, add, remove and revoke all serialize under the project row lock
  (refusing when teardown marked it `deleting`) and then the domain row
  lock**, re-reading the row — credential included — inside the lock. A
  credential replace that lands while another operation waits is acted on as
  the new credential, never the superseded one. Mirror writes ride the same
  transaction; a KV failure rolls the row write back. The add path commits the
  row insert first, then runs the engine in a follow-up serialized section that
  decides sync versus full setup on the locked row; engine writes ride
  savepoints so an expected index violation keeps the transaction committable.
- **A lease-time revocation publishes its mirror under the row lock**,
  conditioned on the row still holding the credential that was revoked, so it
  never overwrites a replace that committed in between.

### Removal and teardown

- **Detach before delete.** The zone catch-all is reset (when the ownership
  read shows it still naming this row's relay) before the relay script is
  deleted; if the read or reset fails the delete is skipped and both steps
  report failed. An enabled catch-all never points at a deleted worker.
- **A failed removal keeps the row.** A destructive step failing marks
  `setup_state.failed_step = 'remove'` and `removal_failed_steps`, and answers
  `200 { ok: false, removed: false, failed_steps }`. The owner retries or
  forces with `?force=1`. Two exceptions delete unconditionally:
  `token_revoked` rows and a `revoke_grant`-only failure. While the mark is
  present the status GET suppresses mirror repair.
- **Project teardown** revokes the KV mirrors first (fail-closed), then runs
  the domain removal for each registered domain with a deployed relay,
  best-effort and never throwing, before the DB cascade.
- **The admin surface follows the same order.** Full removal clears the
  mirror first, runs the same engine removal, then deletes the row; a
  mirror-clear failure keeps the row and runs nothing destructive. The
  operator escape hatch `POST /admin/email/:projectId/domains/:domain/revoke-grant`
  writes the mirror as `token_revoked` first (inbound stops at the proxy),
  then revokes, then flips the row; a failed revoke answers 502 with the row
  still active and the next status GET repairs the mirror.

### Data and the credential

`email_domains`: `project_id`, `domain` (globally unique), `zone_id`,
`account_id`, `mode: 'apex' | 'subdomain'`, `status: 'pending' | 'active' |
'token_revoked' | 'token_expired' | 'failed'`, `credential_kind`,
`relay_worker_name`, `relay_version`, the credential and relay-secret
ciphertext triples, `setup_state` (jsonb: `failed_step`, `remaining_steps`,
`removal_failed_steps`), `attempt_id` (the add attempt that last wrote the
credential), `token_id` and `token_expires_on` from `GET /user/tokens/verify`.
The two partial unique indexes above ride the same table.

The credential is encrypted with `encryptProjectSecret` under the project's
envelope key, per domain; only the api and proxy decrypt it, and it is never
written to a manifest, a log or the relay. The relay carries only its own
domain's secret. AADs are `${projectId}:email-domain-token:<domain>` and
`${projectId}:email-domain-relay:<domain>`.

The proxy never reads the row. The api mirrors what it needs to routing KV as
`email-domain:<domain>` — `{ projectId, status, relaySecretSha256,
relayWorkerName, accountId, zoneId, mode }` — rewritten on every status
transition and rotation, tightened before any revoke, deleted on removal, and
repaired by the status GET under the row lock when it drifts.

Minimum scopes: zone-scoped `Zone Read`, `Email Routing Rules Edit` and `Zone
Settings Edit`; account-scoped `Workers Scripts: Write` and `Email Sending
Edit`. `Workers Scripts: Write` is account-wide — per-script scoping does not
exist — and the token summary page shows that before **Create Token**.

### The OAuth grant on Wrangler's client

The primary credential path is Cloudflare's OAuth consent on **Wrangler's
public OAuth client** (PKCE, no secret; endpoints
`dash.cloudflare.com/oauth2/{auth,token,revoke}`; redirect
`localhost:8976/oauth/callback`). The customer clicks **Allow** and the
platform stores the refresh token. What this costs:

- **Breadth.** A grant is user-wide — every account the user belongs to, every
  zone in them, for the granted scopes. The template-link token remains the
  narrow option for a company with many zones.
- **Refresh.** Access tokens live about an hour; refresh tokens are single-use
  and rotate. The platform runs its own grant chain — it never touches the
  developer's `~/.wrangler` chain, which would race Wrangler's refreshes.
  Refresh is serialized per domain row and the rotated token is persisted
  atomically with it (the credential lease). A revoked grant surfaces as
  `token_revoked`.
- **Scopes.** `zone:read`, `email_routing:write`, `email_sending:write`,
  `workers_scripts:write`, `offline_access`. There is no `zone_settings` OAuth
  scope; the email zone-settings endpoints are reached under
  `email_routing:write`.
- **The consent screen names Wrangler.** The CLI prints one line before
  opening the browser so the customer is not surprised.
- **The client id is not ours.** Cloudflare can rotate or revoke it, so the
  template link + paste is the permanent fallback, not a legacy path.

**Revocation** POSTs the RFC 7009 form to `dash.cloudflare.com/oauth2/revoke`
(`token_type_hint=refresh_token`, no Authorization header — a public client
authenticates with the token itself). It throws on a network failure or
non-2xx, because Cloudflare answers 200 even for a bogus token, and never logs
the token. Rules:

- Removal revokes last, with the rotated chain head; teardown and admin
  removal revoke. Conflict compensation does not — the loser's credential may
  survive on another row.
- Credential replace revokes the old grant after the commit; a re-pasted
  identical grant is kept, since revoking it would brick the just-stored row.
- A rejected add revokes the posted grant first — validation 400,
  cross-project 409, teardown 409, and the project guards' 404/403 — because
  the CLI mints a fresh grant per attempt and drops its only copy on any
  error. The one guard: a grant equal to the conflicting row's stored
  credential is kept.
- A lost answer is not a rejection. Every add attempt carries a random
  `attempt_id`, stamped on the row at insert and at credential replace and
  serialized on the status GET. When the POST's answer never arrives, or is
  ambiguous (a 5xx, or a 401/403/413/426/429 from middleware or the edge —
  only the route's deliberate 400/404/409 prove a server-side revoke), the CLI
  polls the status, 15 tries a second apart. The row carrying this attempt's
  id means the add committed; a different id means this grant was never
  stored and is revoked; a 404 at every poll means nothing persisted and the
  held grant is revoked; no informative read at all is reported as unknown —
  a blind revoke could brick a row that did commit. The CLI claims a
  revocation only on Cloudflare's 200.
- A consent exchange that completes after the flow settled minted a grant only
  the CLI holds; it is revoked fire-and-forget and the browser tab gets a
  cancelled page.

**Rejected credential paths**, so nobody designs them again: minting a scoped
API token from the session (`POST /user/tokens`) needs `API Tokens Write`,
which is not an OAuth scope at all; and the session bearer is no substitute —
it expires in an hour and its refresh chain belongs to Wrangler. Borrowing the
**access** token via `wrangler auth token` is safe; refreshing it outside
Wrangler races the single-use rotation.

### The token fallback — three clicks

For a browserless terminal, a failed consent, or a company that wants a
zone-narrowed token. Cloudflare's dashboard accepts a template URL that
pre-fills the token form; the CLI opens it, the customer clicks **Continue to
summary**, **Create Token**, **Copy**, and the CLI takes the token from the
clipboard.

```
CLI                                   browser                       CLI
 │ MX check → apex or subdomain        │                              │
 │ build the link · snapshot clipboard │                              │
 │ open ─────────────────────────────▶ │ form is pre-filled           │
 │ watch the clipboard (≤ 10 min)      │ 1 Continue to summary        │
 │                                     │ 2 Create Token               │
 │ ◀──────────────────────── clipboard │ 3 Copy                       │
 │ shape ok → GET /user/tokens/verify → clear the clipboard           │
 │ GET /zones?name=… · scope check                                    │
 │ send over TLS → platform stores with encryptProjectSecret          │
 │ drop it from memory · continue with Zone / Routing …               │
```

The clipboard watch reads only between opening the link and getting a token,
ignores the pre-link snapshot, and accepts only a new value shaped like a
Cloudflare token (`cfut_` prefix + 40 characters + checksum, or a legacy
40-character `[A-Za-z0-9_-]` value); other vendor prefixes (`ghp_`,
`github_pat_`, `sk-`, `xox`, `cfk_`) are refused without a network call. Only
a shape-valid value reaches `GET /user/tokens/verify`, and only `status:
active` is accepted. The clipboard is cleared once the token is taken. Enter
at any time switches to the masked paste prompt; no clipboard tool (SSH, CI, a
Wayland session without `wl-paste`) falls back to it silently. Nothing on the
clipboard is printed or logged.

The link:

```
https://dash.cloudflare.com/profile/api-tokens
  ?permissionGroupKeys=<url-encoded JSON below>
  &accountId=*            # required by the form; narrowed in the summary
  &zoneId=all             # required by the form; narrowed in the summary
  &name=Void%20email%20%E2%80%94%20example.com
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

Every key rides every link — `Zone Settings Edit` gates the routing POST on
both paths. The two email keys are community-verified rather than documented,
and unknown keys are silently dropped, so the docs also show the manual
token-creation steps.

The dashboard never hands the token back — no redirect, no callback; the paste
is the transport. On the platform the token lives encrypted per project; on
the developer's machine, nowhere. A TTL the customer set on the form is the
one thing the platform copy cannot solve: sends stop, `status` reads `token
expired`, and `void email domain add` again is the renewal.

### What changes in the shared-sender rules

- **Reply-sender pin** — accepts the receiving slug on the shared domain _or_
  any address on a domain registered to the project.
- **Recipient allowlist** — does not gate custom-domain sends, relayed
  forward/reply included: the customer's own onboarding lifts Cloudflare's
  verified-destination gate, and the reputation at stake is theirs. The burst
  cap, the monthly cap and the kill switch still apply.
- **The 200-destination cap is untouched** — a relay consumes no destination
  address in either account.
- **One worker of ours lives in their account** — readable, editable and
  deletable by the customer; `status` reports drift, it does not fight it.

### Limits

- The customer's account must be on **Workers Paid** to send; routing alone
  works on Free.
- Two steps stay human: the credential grant and the routing-subdomain
  dashboard form.
- The credential asks for account-wide `Workers Scripts: Write`.
- Inbound messages cap at 25 MiB (Cloudflare rejects larger ones before the
  relay runs); a zone holds at most 30 email domains; a domain holds at most
  200 routing rules; the relay name walk caps at 50 names per account.
- A domain that is not on Cloudflare DNS is not covered.

### Provider behavior the design relies on

Established against a live zone with a user API token:

- `POST …/email/routing/dns { name }` enables a subdomain and auto-creates
  three MX records; the apex enable is an empty-body POST. `routing/dns` is
  authorized by Zone Settings Write, rules by Email Routing Rules Write.
- Sending onboarding succeeds with a user API token although the schema
  declares Global-key-only, and also stamps the apex SPF and DKIM. `10103
bad_token_type` is Email Sending's credential-type rejection.
- One zone-scoped catch-all, auto-created disabled on first enable, covers the
  apex and every subdomain; there is no per-email-domain rule.
- Relay script PUT, secret PUT and catch-all PUT all accept an API token.
- `send_raw` takes the JSON envelope `{ from, recipients, mime_message }` (a
  raw `message/rfc822` body earns `10001 invalid_request_schema`) and returns
  `200 queued` with a `message_id`. It accepts user and account tokens.
- The revocation endpoint answers 200 even for a bogus token.
- Cloudflare's cleanup does not remove `_dmarc.<sub>` on subdomain or routing
  deletion; the engine never touches DNS, and the CLI prints the manual
  cleanup list.

Still open: the browser consent run (what the screen says, whether a
non-localhost redirect is accepted, rotation over several cycles, whether the
grant's `email_routing:write` covers the two calls Wrangler never makes), a
message-level inbound end-to-end check, the narrow template-token variants,
and every operation above with an **account-owned** token.

### Where each piece lives

- **Cloudflare calls from the api** follow `cfFetch`
  (`platform/packages/api/src/provisioning/cloudflare-api.ts`); the relay
  deploy is a multipart script PUT plus a non-namespace `putWorkerSecret`.
- **The relay source is an embedded asset in the api worker** — one constant
  module plus `relay_version`; `sync` redeploys it.
- **`/email/relay` in the proxy** is a branch in the global auth middleware:
  size bounds before any crypto, secret → mirror → project, then the second
  half of `routeInbound` keyed by the domain's project. The relayed header
  summary is bounded on two axes — distinct names and total header pieces.
- **Schema:** `email_domains`, with CHECK constraints declared in the schema
  so drizzle-kit does not diff them away.
- **CLI:** `void email domain …` under the email group; `PlatformClient`'s
  `/projects/:id/email/…` methods; owner-guard routes in `routes/email.ts`;
  the admin section in `admin/routes/email.tsx`.

## Administrator-managed domains (planned)

### The scenario

One Cloudflare administrator installs a Void platform inside a company. Staff
who do not write code deploy small applications to it through a coding agent.
They have no Cloudflare account, token or dashboard access; the administrator
has all three and owns the company zones.

`void email domain add` cannot work for these users — its first step is a
consent or a paste. And most of what their applications want is "mail my
colleagues", which the shared sender already provides an address for; the
blocker there is the verified-destination gate, not the lack of a domain.

```
 operator's Cloudflare account · zone example.com

 Lane 1  shared sender               Mode C + the recipient policy above
   operator once:   EMAIL_SENDER_DOMAIN=mail.example.com, routing on, proxy binding
   every project:   <slug>+tag@mail.example.com, in and out, no per-project work

 Lane 2  per-project domain          the administrator runs the engine
   admin per project:  void platform email domain add hr.example.com --project hr-portal
   gives:              hr@hr.example.com-style addresses, the zone's own DKIM
   costs:              one dashboard form per subdomain, 1 domain → 1 project
```

Lane 1 is delivered first. Lane 2 reuses the custom-domain engine unchanged
and adds an operator entry point.

### Decisions

| #   | Decision                                                                                                                                                                     | Reason                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One domain → one project stays; a company uses one subdomain per project.                                                                                                    | Address→project routing would change the relay lane, the mirror key and the trust model.                                                                        |
| 2   | Administrators manage domains through `void platform email domain …` and the admin UI, running the same `setupEmailDomain` / `syncEmailDomain` / `removeEmailDomain` engine. | One engine, two entry points. Owner-guard routes keep their behavior; operator routes act on any project.                                                       |
| 3   | New credential kind **`platform`**: the row holds no credential and the engine uses the runtime token (`CF_API_TOKEN`). A pasted token stays available as the fallback.      | No per-domain token, nothing expires. Valid only when the zone is in the platform's own account (`CF_ACCOUNT_ID`); the zone lookup already returns the account. |
| 4   | The relay worker is kept even when the zone is in the platform's account.                                                                                                    | Engine, probes, mirror and tests assume one; pointing the catch-all at the proxy directly is a second code path to save one hop.                                |
| 5   | Installation setting `email.domains`: `self-serve` (default) or `admin`. In `admin` mode the user CLI prints the administrator's command instead of starting a grant.        | The CLI must know before it opens a browser. The printed command is the whole request flow.                                                                     |
| 6   | A request inbox in the admin UI is not built.                                                                                                                                | A table, a page and a notification for what one printed line does.                                                                                              |
| 7   | Rows carry `managed_by: 'owner' \| 'admin'`. Owners can list and read an admin row; `sync` and `remove` on it are refused with the administrator's command named.            | An admin row runs on the platform's credential; a user must not tear it down or rotate it.                                                                      |
| 8   | No OAuth on the operator path.                                                                                                                                               | A grant is user-wide across the administrator's accounts, and the operator CLI is `--plan` / `--yes` first.                                                     |

### Command surface

Entries in `operatorCommands` (`packages/void/src/cli/operator-args.ts`),
served under `/operator/v1/email/…`, with the group's `--plan`, `--yes` and
`--json`, recorded in `operator_events`:

```
void platform email domain list   [--project <slug|id>]
void platform email domain add    <domain> --project <slug|id> [--subdomain <label|host>] [--token-stdin]
void platform email domain status <domain>
void platform email domain sync   <domain>
void platform email domain remove <domain> [--force]
void platform email settings      show | set --domains self-serve|admin
void platform email policy        show | set <mode> [--domain example.com …]
void platform email limit         <project> [--monthly N] [--burst N]
```

`add` without `--token-stdin` uses the `platform` credential. The admin UI's
email page gains an add form, a domain list with the same actions and the
platform-wide policy section; its `revoke` and `revoke-grant` actions stay.

The owner verbs keep their paths and guard. Both surfaces call one service
module that owns the serialized sections above (row insert under the project
lock, engine run under the row lock, checkpoint, compensation); the
orchestration moves out of `routes/email.ts` into it.

### The `platform` credential

```
 kind          stored on the row              engine / lease resolve to      revoke on remove
 ───────────   ────────────────────────────   ────────────────────────────   ────────────────
 oauth_grant   refresh token, encrypted       refreshed access token         RFC 7009 POST
 api_token     token, encrypted               the token                      nothing
 platform      nothing                        env.CF_API_TOKEN               nothing
```

- Schema: `credential_kind` gains `'platform'`; the `token_*` columns become
  nullable with a CHECK that they are null exactly when the kind is
  `platform`; `managed_by` is added.
- `leaseEmailDomainCredential` and the proxy's
  `/internal/email/domain-credential` return the runtime token for a
  `platform` row. It is never written to the row, a mirror, a manifest or a
  log.
- The engine refuses `platform` when the zone's account is not
  `CF_ACCOUNT_ID`, naming `--token-stdin` for a zone in another account. On
  the managed platform this is always the case, so the platform's own token
  never touches a customer zone.
- A failed credential probe on a `platform` row reads `failed` /
  `verify_credential`, not `token_revoked` / `token_expired` — those describe
  a stored credential's lifecycle. The health check names the missing runtime
  token permission.
- The runtime token needs, beyond the self-hosting guide's table: **Zone
  Read**, **Email Routing Rules Edit** and **Zone Settings Edit** on the mail
  zones; **Email Sending Edit** on the account. The installer's token link and
  the health check learn them; a missing one fails `add` at
  `verify_credential` before anything is written to the zone.

### Relay, limits and the human steps

The relay is deployed into the platform's own account, so its name walk caps
admin-managed domains at 50 per platform account, and Cloudflare caps Email
Routing subdomains per zone; the administration guide states both. The two
human steps are unchanged, now done by the administrator: the Email Routing
**Subdomains** form (the status poll self-clears the row) and the Workers Paid
upgrade for Email Sending, after which `sync` re-attempts the onboarding.

### Ownership

| Actor            | On an `owner` row                                   | On an `admin` row                                                                                |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| project owner    | list · status · sync · remove · add                 | list · status; `sync` / `remove` → 403 naming the admin command; `add` only in `self-serve` mode |
| administrator    | list · status · sync · remove · revoke              | list · status · sync · remove · revoke · add                                                     |
| project teardown | removes relay + catch-all with the row's credential | same, with the runtime token                                                                     |

### The mode switch

`email.domains` lives with the other installation settings in PostgreSQL and
is served to the CLI through the platform's discovery response, so `void email
domain add` reads it before any Cloudflare call. In `admin` mode:

```
$ void email domain add example.com
  Email domains on this platform are managed by its administrator.
  Ask them to run:

    void platform email domain add example.com --project hr-portal

  `void email domain list` and `status` keep working here.
```

Exit 0, nothing contacted, nothing stored. The mode is enforced server-side —
the add route answers 403 with the same text — so the CLI check only spares
the browser round trip. The default policy and mode leave the managed
platform's behavior unchanged: no new probe, binding or account call for a
platform that sets neither.

## Out of scope

Third-party provider wrappers, component templates, typed sender discovery
and persistent delivery logs are not part of this design; users call a
provider SDK directly where appropriate.

Native setup detects email at the feature level rather than onboarding
inbound-only apps separately. Splitting that detection would need to handle
sends from dependencies, dynamic imports and direct binding access; it is not
a safe deletion of the existing binding.
