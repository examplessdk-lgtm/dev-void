---
title: Email — Lifecycle and UX across the three hosting modes
status: draft
created: 2026-09-11
updated: 2026-09-11
depends: 0078-email-cf-native.md
---

> **What this document is.** 0078 records the architecture of `void/email` as
> it ships in void#160 / void-platform#117: shared sender, proxy-gated
> outbound, slug-routed inbound. This document records what was established
> after that, on 2026-09-10 and 2026-09-11, about how the feature is
> experienced over its whole life — by a developer, by an operator, and in
> each of the three places a Void project can run. Every claim below that is
> marked _measured_ was verified by reading source or by execution; the
> pointers are in [Evidence](#evidence).
>
> Where this document and 0078 disagree, this one is current. The specific
> corrections to 0078 are listed in [What 0078 got wrong](#what-0078-got-wrong).

## Summary

Void projects run in three places, and email has a different shape in each:

| Mode                                                    | Who owns the Cloudflare account | Mail domain                             | Who does the zone work           |
| ------------------------------------------------------- | ------------------------------- | --------------------------------------- | -------------------------------- |
| **A. Managed platform** — `void deploy`                 | VoidZero                        | `mail.void.cloud` (one per environment) | VoidZero, once                   |
| **B. Own account** — `void deploy --backend cloudflare` | the developer                   | a zone the developer owns               | the developer, helped by the CLI |
| **C. Self-hosted platform**                             | the company                     | `mail.<company>` (one per environment)  | the company's operator, once     |

The design has one rule that holds in all three: **a developer never sees a
Cloudflare object.** No zone, no routing rule, no destination id, no token
scope. A developer sees an address, a list of recipients, a counter, and an
error code. Everything else belongs to whoever owns the account — VoidZero in
A, the developer's own `wrangler login` session in B, the company's operator
in C.

Three findings changed the plan and are worth stating up front:

1. **A `wrangler login` session already carries `email_routing (write)` and
   `email_sending (write)`**, and wrangler 4.107+ ships a full `wrangler email`
   command group. Mode B needs no new token and no direct API client for most
   of the setup. _(measured)_
2. **Verified destinations are capped at 200 per Cloudflare account, shared
   across every domain and every project.** Onboarding the mail domain to
   Email Sending removes that gate; per-project consent stays in our own
   allowlist. _(from Cloudflare's limits page)_
3. **Nothing today tells a developer their own address.** Not the CLI, not
   the dashboard, not the API, and the two bindings are neither typed nor
   injected in `void dev`. _(measured)_ This is the single largest UX gap and
   it is the same gap in all three modes.

## The lifetime

```
              DEVELOP            DEPLOY             CONFIGURE            VERIFY              OPERATE              TEARDOWN
              ───────            ──────             ─────────            ──────              ───────              ────────
developer     void dev           void deploy        add recipient        void email status   void email usage     void project delete
              dev inbox          prints the         (consent link)       send a test         dashboard Email tab   → destinations
              harnesses          address map                                                  error codes            revoked, rows
                                                                                                                     gone
operator      —                  —                  one-time env setup   health checklist    kill switch          delete catch-all
(A, C)                                              (script → admin)     send + receive       caps, suspend         (stops inbound)
                                                                          probe
own account   void dev           void deploy        prompt on the        wrangler tail        CF dashboard         wrangler email
(B)           dev inbox          --backend cf       first deploy         address map                                routing disable
                                 detects state      (wrangler email …)
```

The developer lane is the same in all three modes. That is deliberate: the
address changes, the commands do not.

## Personas

**Developer.** Writes `sendEmail(...)` and `email/*.ts`. Wants to know: what is
my address, who can I send to, did it work. Must never need a Cloudflare
account (A, C) or a Cloudflare concept (B).

**Operator.** Owns the platform account in A or C. Does the zone work once
per environment, watches health, holds the kill switch. Is a human at
VoidZero in A and a platform admin at the company in C.

**Own-account developer (B).** Both roles in one person, but the split still
holds in time: the setup prompt happens once, then they are a developer.

## Mode A — managed platform

### Developer surfaces

The address comes first, on every surface, because it is the thing nobody
can find today.

**`void email status`** — new, and the default subcommand when none is given:

```
Sender       acme+noreply@mail.void.cloud
Inbound      acme+<anything>@mail.void.cloud
             email/support+[ticket].ts   ←  acme+support+<ticket>@…
             email/_default.ts           ←  everything else
Recipients   alice@acme.dev     verified
             ops@acme.dev       pending — resend?  void email allow ops@acme.dev --resend
This month   12 / 200 sent · 3 received
```

Backed by `GET /projects/:id/email/usage` gaining `domain`, `sender`, and
`inbound` fields. `usage`, `destinations`, `allow`, `disallow`, `logs` stay.

**`void deploy`** prints the inbound map at the end whenever `email/` handlers
ship. That is the moment the developer cares:

```
◆  Deployed acme
│  Inbound email
│    acme+support+<ticket>@mail.void.cloud  →  email/support+[ticket].ts
│    acme+*@mail.void.cloud                 →  email/_default.ts
```

**Dashboard → project → Email.** Same data as `void email status`, plus
"Add recipient" and "Resend". 0078 listed user-facing dashboard pages as a
non-goal because dashboard work was paused; this section is small, follows
the existing per-section loader fan-out on the project page, and is the
only place a non-CLI user can add a recipient. It is in scope now.

**`void dev`.** Inject `__VOID_PROJECT_SLUG` and `__VOID_EMAIL_DOMAIN` from the
linked project, and type both in `.void/env.d.ts`. Today `sendEmail` without
`from` returns `INVALID_FROM` in dev before the inbox is consulted, while the
shipped prompt promises that default. _(measured — see Defects)_

### Consent

Adding a recipient sends a verification mail. For every address except the
owner's own, that mail is **ours**: signed with an HMAC link, sent from
`noreply@<mail domain>`, with a resend the developer controls. We keep our
own link rather than Cloudflare's for two reasons that were confirmed: the
address is per-project consent and Cloudflare's verification is per-account,
and Cloudflare has no API to resend its mail. The owner's own address keeps
the Cloudflare path and the reuse-across-projects rule from 0078.

### Operator surfaces

**One-time environment setup, as a script first.** The seven manual steps in
`operations.md` become `vp run email:setup --env <name> --check | --apply`
in the platform repo. `--check` runs the probes below and prints a
checklist; `--apply` runs the idempotent fixes. It exists because VoidZero's
own staging needs it now — the mail domains do not exist yet — and because
the admin page reuses the same module.

**`/admin/email`, environment level.** Today `/admin/email/:projectId` is
per-project. Add the environment page beside it, shaped like
`signup-control.tsx`, and feed its rows into `/admin/health` so the banner
shows email:

| Row                     | Probe                                                                    | Fix                                                                    |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| domain agrees           | api `EMAIL_SENDER_DOMAIN` vs proxy `/health` (make the boolean a string) | edit wrangler vars                                                     |
| routing ready           | `GET /zones/{z}/email/routing` → `status`                                | `POST …/routing/dns`                                                   |
| catch-all → proxy       | `GET …/rules/catch_all` names `void-proxy[-staging]`                     | `PUT …/rules/catch_all`                                                |
| `send_email` bound      | proxy `/health` `sendEmail`                                              | redeploy proxy                                                         |
| Email Sending onboarded | `GET …/sending/subdomains/{id}/dns/status`                               | `POST …/sending/subdomains` (permission group undocumented — see Open) |
| slug mirror             | count of projects lacking `email-slug:`                                  | already self-heals hourly; button runs it now                          |
| token scope             | a 403 on any read above, mapped to the permission's name                 | extend `CF_API_TOKEN`                                                  |

Plus **Send test mail** to the operator's address, and **Suspend all
sending**, which already exists as the `routing.suspended` marker.

### Limits the operator must know

- **200 verified destinations per account, shared.** Without Email Sending
  the whole platform supports 200 distinct recipient addresses. Onboard the
  mail domain to Email Sending; our allowlist keeps consent.
- **Outbound sent via the binding shows as "dropped" in the Email Routing
  summary even on success.** Read Email Sending metrics or the proxy tail.
- **`message.reply()` throws above 100 `References` entries.** `replyEmail`
  bounds header line length, not entry count.

## Mode B — the developer's own Cloudflare account

### What happens today _(measured)_

```
void deploy --backend cloudflare   +   email/ handlers   +   sendEmail()
        │
        ├─ deploy    no warning · no send_email binding · no email vars
        ├─ outbound  sendEmail() → BINDING_MISSING
        └─ inbound   handler runs, then every action is LOST
                       support+T-42@zone → _default.ts       (wrong handler: the
                                                              dispatcher strips after
                                                              the first `+` unconditionally)
                       setReject / forward / reply → returned as RPC data → CF ignores it
                       → message ACCEPTED, then DISCARDED. No bounce. No log.
```

The inbound half is worse than unsupported. Cloudflare delivers, the worker
reports success, and the mail vanishes.

### Runtime changes (framework, ~200–250 lines)

```
sendEmail ──► dev inbox? ──► env.SEND_EMAIL? ──► __VOID_PROXY? ──► BINDING_MISSING
                                  │ NEW
                                  └─ import('cloudflare:email') → one EmailMessage per recipient
```

1. **Direct `SEND_EMAIL` transport** in `runtime/email.ts`, tried after the dev
   inbox and before the proxy. The MIME builder is shared.
2. **Provision the binding.** `computeDesiredCloudflareResources` adds
   `send_email: [{ name: "SEND_EMAIL" }]` to the root `wrangler.jsonc` when
   `needsEmail`. Root entries already pass through the verifier verbatim.
3. **Sender default.** `void.json` gains `email.from`. Replies default to
   `message.to` when there is no slug — in this mode `message.to` is a real
   address on the developer's own zone.
4. **No-prefix inbound.** When `__voidPlatformTo` is absent, the dispatcher
   matches the full local part, so `support+T-42@zone` reaches
   `email/support+[ticket].ts`.
5. **Enact actions on a native message.** When the envelope is a real
   `ForwardableEmailMessage`, apply reject / forward / reply on it instead of
   returning them.
6. **Deploy guidance** — the detection and prompt below.

### Detection on every deploy

Detection needs Read scopes only, so it runs unconditionally and costs a
few subprocess calls:

```
void deploy --backend cloudflare
   │
   ├─ no email/ and no sendEmail() ──▶ skip, nothing printed
   │
   └─ email in use
        ├─ PREFLIGHT (read-only)
        │     zone        email.from → walk up labels → `wrangler email routing settings <zone>`
        │     mx          node:dns resolveMx(zone)        ← needs no Cloudflare access
        │     rules       `wrangler email routing rules list <zone>`
        │     recipients  `wrangler email routing addresses list`
        │     sending     `wrangler email sending settings <domain>`
        │     binding     send_email in the root wrangler.jsonc
        │
        ├─ READY ──▶ print the address map, continue
        │
        └─ NOT READY
              TTY ──▶ checklist, then prompt
                        [1] Configure now     runs the wrangler commands below
                        [2] Deploy anyway     the app works; email stays off with clear error codes
                        [3] Cancel
              CI  ──▶ no prompt; checklist + `void email setup`; deploy anyway
                      (--require-email fails the deploy instead)
```

"Ready" per row:

| Row        | Ready when                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| zone       | a zone in the account matches the mail domain, walking up labels                                                                           |
| routing    | `Status: ready`                                                                                                                            |
| rules      | one literal rule per `email/<name>+[p].ts` pointing at **this** worker; a catch-all pointing at this worker only when `_default.ts` exists |
| recipients | at least one verified address, or Email Sending onboarded                                                                                  |
| sending    | `dns` status ready                                                                                                                         |
| binding    | present in the root config                                                                                                                 |

Rules carry the worker name they route to, so the check distinguishes
"points at me", "points at another worker", and "absent". That is the same
shape as the existing drift check for D1, KV, and R2: compute the desired set
from the `email/` scan, read the actual set, report the diff.

### The fix, through wrangler

Void already drives wrangler through one `runWrangler` choke point in
`provision.ts`. The fix is more calls through the same seam. Void never holds
the token.

```
wrangler email routing enable <zone>                              only when MX is empty or Cloudflare's
wrangler email routing rules create <zone> \
    --match-type literal --match-field to --match-value support@<zone> \
    --action-type worker --action-value <worker-name>                one per email/<name>+[p].ts
wrangler email routing addresses create <email>                   then the human clicks
wrangler email sending enable mail.<zone>                         subdomain-aware
```

Cloudflare's subaddressing means a rule for `support@zone` already captures
`support+anything@zone`, so each handler file is one literal rule. A project
with no `_default.ts` gets no catch-all, and unknown addresses bounce at
Cloudflare — which is correct.

### Three refusals, as code

1. **Never enable routing on an apex that has foreign MX.** `resolveMx`
   first. Foreign records mean the domain carries someone's real mail;
   routing enable locks MX and would take it down. Print the dashboard link
   for the `mail.<zone>` subdomain and stop.
2. **Never replace an existing catch-all.** Per-address rules take priority
   over it, so the named handlers still work; only `_default.ts` stays
   unbound, and the checklist says so.
3. **Never touch a rule that points at another worker.** Report the conflict.

On a dedicated subdomain none of these fire. On a bare apex the prompt says
plainly what a catch-all claims: every address on that domain.

### Residuals — where a human step stays

| Gap                              | Why                                                                                                          | What the CLI does                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| catch-all → worker               | wrangler has no create command; `rules list` only shows one                                                  | print the dashboard link; re-check on the next deploy; use REST when `CLOUDFLARE_API_TOKEN` is set |
| routing on `mail.<zone>`         | `wrangler email routing enable` resolves the zone by exact name; REST does not document a subdomain endpoint | same treatment, or route on the apex when its MX is empty                                          |
| verification click               | no API to verify or resend Cloudflare's mail                                                                 | show `pending`; the human clicks                                                                   |
| `wrangler email` output is prose | no `--json`                                                                                                  | parse per pinned version; on a miss print "unknown — run `void email setup`"                       |

### Token blast radius

`Email Routing Rules Edit` on a zone can redirect every inbound message on
that zone. In this mode the scope lives in the developer's own OAuth session,
which they already trust for `wrangler deploy`, and Void never extracts it.
If Void ever needs the REST endpoint directly, it must use
`CLOUDFLARE_API_TOKEN` only, and the docs must say that token deserves a
short life.

## Mode C — self-hosted platform

### State today _(measured)_

Self-hosting is not a supported story in the repo. Every setup document is
written for VoidZero's own account. On the email path, three code sites pin
VoidZero hosts; everything else already follows `EMAIL_SENDER_DOMAIN`:

| Site                                                     | What it pins                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api/src/email/send-verification.ts:76-84`      | the api host in the confirmation link                                                                                             |
| `packages/api/src/email/send-verification.ts:90-95`      | the proxy origin the api posts verification mail to                                                                               |
| `packages/api/src/email.ts:1` + `api/wrangler.jsonc:152` | the legacy `Void <noreply@void.cloud>` sender for welcome / invite / alert mail, on a different domain from `EMAIL_SENDER_DOMAIN` |

The prose in `getting-started-prompt.txt` and `docs/guide/email.md` also names
`mail.void.cloud` literally, so an Acme developer would read the wrong
address.

### Design

- **Config surface** — `EMAIL_SENDER_DOMAIN` on api and proxy, as today, plus
  `API_ORIGIN` / `PROXY_ORIGIN` (or a service binding) for the two
  hard-coded hosts, and the platform sender derived from
  `EMAIL_SENDER_DOMAIN` so the legacy `noreply@void.cloud` folds into it.
- **Operator surfaces** — identical to Mode A: the setup script and the
  environment-level admin page. The company's mail domain _is_ the platform
  domain; nothing per project changes.
- **Developer surfaces** — identical to Mode A, with the address computed
  from the environment's domain, never from prose.
- **Docs** — every literal `mail.void.cloud` in the guide and the prompts
  becomes `<mail domain>`, and the CLI prints the real one.

Per-project custom domains stay out, for the reason 0078 gives: a company's
apex carries its corporate MX.

## Cross-cutting

### The Class B/C boundary

Inbound handlers compile through `routingPlugin`, which no framework branch
installs; the framework wrapper wires crons and queues only. So under
TanStack Start, React Router, SvelteKit, Nuxt, Analog, and Astro an `email/`
directory is a build error, not silently dead code. Outbound `sendEmail` is a
binding and works in every framework. Wiring inbound into the framework
entries needs the `WorkerEntrypoint` conversion applied to each wrapper and is
a separate piece of work. _(implemented in void#160, round 5)_

### Verified destinations and Email Sending

|                  | routing only               | + Email Sending onboarded |
| ---------------- | -------------------------- | ------------------------- |
| who can receive  | verified destinations only | anyone                    |
| account ceiling  | 200 addresses, shared      | none                      |
| our consent gate | allowlist + HMAC link      | unchanged                 |
| plan             | Free or Paid               | Workers Paid              |

Recommendation for A and C: onboard. Recommendation for B: offer it in the
prompt; without it the developer's project is limited to their verified
addresses, which is often exactly what an app-internal use wants.

### The `email()` export and compatibility dates

Every generated worker is now a `WorkerEntrypoint` subclass, and Void
preserves the user's `compatibility_date` with no floor. That is safe: the
`rpc` flag gates the **caller's** stub, not the callee's class. Measured in
workerd 1.20260701.1: the subclass serves `fetch`, `scheduled`, `queue`, and
RPC `email()` at dates back to 2021-11-03 and under an explicit `no_rpc`. The
only caller is the platform proxy at 2026-02-12.

## Defects found on the way

To fix inside the current PRs, because the claim or the code is ours:

| Where                                               | Defect                                                                                                                                                                                                                 | Category                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `void dev`                                          | `sendEmail` without `from` returns `INVALID_FROM` — the slug and domain bindings are not injected in dev, and the shipped prompt promises the default                                                                  | (b)                            |
| `docs/guide/email.md`, `getting-started-prompt.txt` | name `mail.void.cloud` as if it were the only possible domain                                                                                                                                                          | (b)                            |
| `meta/operations.md`                                | says the mail zone needs its own registration and nameservers; a subdomain of `void.cloud` is enough. Says the slug backfill is a one-time pass; it self-heals hourly. Omits the 200-destination cap and Email Sending | (b) — corrected in this commit |

Follow-ups, tracked but not for these PRs: the Mode B runtime (six items),
the Mode B deploy detection and prompt, `void email status` and the
`usage` fields, the dashboard Email section, dev injection and typing of the
two bindings, the environment-level admin page and setup script, the three
Mode C code sites, and the proxy's bounce text for a framework-type project
(the routing blob already carries `type`; `email-router.ts` never reads it).

## Open decisions

Recommendations are mine; the decision is the owner's.

1. **Mode B setup: inside `void deploy --backend cloudflare` behind detection
   and a prompt (recommended, now that the wrangler session has the scopes),
   or a separate `void email setup` only.** The separate command still exists
   for CI and for re-runs; the question is whether the first deploy offers it.
2. **Mode B apex policy: refuse an apex with foreign MX (recommended), or
   prompt.**
3. **Operator tooling: script first, admin page second (recommended), or the
   reverse.**
4. **Fold the legacy `noreply@void.cloud` platform sender under
   `EMAIL_SENDER_DOMAIN` (recommended — it is the third Mode C blocker and a
   second domain to keep DNS for).**
5. **Fix the `void dev` `INVALID_FROM` gap inside void#160 now (recommended,
   it is small and the prompt already promises it), or track it.**

## Open questions that only a live probe settles

- Whether `POST /zones/{z}/email/routing/dns` with `name: "mail.example.com"`
  enables routing on a subdomain. The REST docs do not say; the dashboard
  does it.
- Which token permission group the Email Sending subdomain endpoints accept.
  The OpenAPI schema lists none. The wrangler OAuth scope
  `email_sending (write)` works for `wrangler email sending enable`, which is
  the path Mode B uses.
- Whether `mail.staging.void.cloud`, two labels deep, is accepted by the
  subdomain form. The docs show one-label examples only.

## Rollout

1. **Now, in void#160 / #117:** the operations.md corrections (this commit);
   the `void dev` injection if decision 5 is yes.
2. **Operator, before any production send:** the setup script, run against
   staging first; Email Sending onboarding; the three checks in the
   operations.md "Before you deploy this the first time" list.
3. **Developer surfaces:** `usage` fields → `void email status` → deploy
   output → dashboard section. Each is independently shippable.
4. **Mode B:** runtime items 1–5, then detection, then the prompt and
   wrangler-driven fix, then the three refusals as tests.
5. **Mode C:** the three code sites and the config surface; the docs pass;
   the environment-level admin page.

## What 0078 got wrong

- _"Cloudflare's Constraints"_ says the binding cannot send to cold
  recipients. That was true before Email Sending; onboarding the domain
  lifts it. The 200-destination cap is the constraint that remains without
  onboarding.
- _"DKIM/SPF/DMARC are set up automatically when Email Routing is enabled."_
  Routing enable adds and locks MX and SPF, and Cloudflare adds a DKIM
  record. DMARC comes from Email Sending onboarding, not routing.
- Rollout step 12, _"Register zone in CF"_ — a subdomain of the existing
  `void.cloud` zone is enough. `void.cloud` already has Email Routing on.
- Non-goal _"Programmatic Email Routing rule creation"_ holds for the
  managed platform and is now the plan for Mode B.
- Non-goal _"User-facing dashboard pages"_ — one small section is in scope,
  for the reason given above.

## Evidence

Framework paths are under `framework/packages/void/src`; platform paths
under `packages/`.

- Wrangler scopes and commands: `wrangler whoami` on 2026-09-11 lists
  `email_routing (write)`, `email_sending (write)`; `wrangler email` exists in
  4.107.0 (the framework pin) and 4.130.0. `rules create` takes
  `--action-type worker`; `routing enable` resolves the zone by exact name
  (`getZoneIdByDomain`); `sending enable` walks up labels (`resolveDomain`).
- Mode B today: `runtime/email.ts:505-516` (`BINDING_MISSING`),
  `router/compile.ts:1603-1611` (strip after first `+`),
  `compile.ts:2856-2862` + `runtime/email/inbound.ts:296-361` (actions
  returned as data), `cli/deploy.ts:2468-2681` (no email in desired
  resources). All executed against a scratch copy of `playground/kitchen-sink`.
- Address discovery gap: `cli/email.ts` prints no sender;
  `packages/dashboard/pages/projects/[id].tsx` has no email section;
  `routes/email.ts:77-84` returns no domain; `codegen/env-types.ts` does not
  type the bindings; `index.ts` / `plugin-*.ts` do not inject them in dev;
  `runtime/email.ts:441-447` returns `INVALID_FROM` before the inbox at `:493`.
- Mode C blockers: `packages/api/src/email/send-verification.ts:76-95`,
  `packages/api/src/email.ts:1`, `packages/api/wrangler.jsonc:152`.
- Slug mirror self-heal: `packages/api/src/index.ts:585-600` inside the hourly
  rollover.
- Admin patterns: `admin/routes/signup-control.tsx`, `admin/routes/system.tsx:140-178`,
  `admin/views/dashboard.tsx:49-86`.
- Cloudflare: Email Routing subdomains (dashboard flow), send-bindings
  ("the sender address must always belong to a domain you have onboarded"),
  limits ("Destination addresses per account: 200 … shared across all
  domains"; "Before you onboard a sending domain, you can send emails only to
  verified destination addresses"), catch-all `PUT …/rules/catch_all` with
  `{ type: "worker", value: ["<name>"] }`, local inbound trigger
  `POST /cdn-cgi/local/email`.
- Compat date: workerd 1.20260701.1 via Miniflare; `WorkerEntrypoint`
  subclass returns 200 at `2021-11-03` and `2024-01-01` with no flags.
