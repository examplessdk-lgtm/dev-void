---
title: Email — CF-Native (outbound, inbound, shared sender, lifecycle and UX)
status: draft
created: 2026-04-24
updated: 2026-09-11
supersedes: 0047-email.md
---

> **2026-08-30 re-land.** This document was written as `0067-email.md` on the
> abandoned `feat/email` branch. `0067` was taken by
> `0067-cross-script-do-host-architecture.md` while that branch sat, so the
> design is renumbered here. Three decisions changed during the re-land and
> the body below has NOT been rewritten around them — read these first:
>
> 1. **The platform mail domain is configured per environment.** The original
>    hard-coded `mail.void.cloud` in the framework runtime, the proxy's sender
>    regex and the api's verification sender. That made a staging environment
>    impossible, because a `mail.staging.void.cloud` sender was rejected by our
>    own regex. It is now one var, `EMAIL_SENDER_DOMAIN`, declared on both the
>    api and the proxy worker and injected into user workers as
>    `__VOID_EMAIL_DOMAIN`. Every reader fails closed when it is absent.
> 2. **There is one project-slug binding, `__VOID_PROJECT_SLUG`.** The original
>    added a second, bare `VOID_PROJECT_SLUG`. `main` already injected the
>    underscored name for sandbox projects, so `provisionBindings` now injects
>    it for every project and there is exactly one producer.
> 3. **Inbound routes on the wire recipient.** `createMessageProxy` strips the
>    `<slug>+` prefix so handler authors see the address they wrote; the
>    generated dispatcher used to strip it a second time, leaving an empty tag
>    that no pattern could match. The dispatcher now reads the preserved
>    `__voidPlatformTo`.

> **2026-04-29 update — outbound moved off the user worker.** A multi-agent
> review found that with `SEND_EMAIL` emitted as a per-project worker
> binding, any user handler could call `env.SEND_EMAIL.send(...)` and
> bypass the proxy's quota, suspend kill-switch, and metering. Sealing
> this gap by hiding the binding name didn't change the architectural
> fact that a shared platform resource (the `mail.void.cloud` sender,
> with pooled reputation) was sitting on every user worker.
>
> **Resolution:** outbound now follows the same shape as AI / revalidate.
> The user worker holds only `__VOID_PROXY` (+ token + project id). The
> framework's `sendEmail()` POSTs MIME bytes + recipients to
> `__VOID_PROXY/email/send`; the **proxy** worker holds the
> account-level `send_email` binding and enforces:
>
> - **Per-project verified-destinations allowlist** (mirrored from the
>   `email_destinations` table into `email-allowlist:<projectId>` ROUTING
>   KV by every CRUD op + project delete; ~60s convergence per colo).
> - **Suspend kill-switch** (now also gates inbound).
> - **Burst + monthly quotas.**
>
> User-facing API (`sendEmail`, result types, error codes, dev inbox,
> test harness) is unchanged. The relevant sections below have been
> updated; the original on-worker-binding design is preserved in the git
> history of this doc.

> **2026-04-29 follow-up — per-project destination consent.** A review
> finding (I-1) called out that when project A adds an address that
> another project already verified via CF Email Routing, the previous
> code trusted CF's `verified` flag and instantly marked the row
> verified for project A — bypassing the per-project consent the privacy
> story promises (the recipient consented to project B, not A).
>
> **Resolution: Option C + Option B.** A new `verification_source`
> column distinguishes how a row reached `verified`:
>
> - **Option C — owner-relaxed CF reuse** (`verification_source='cf'`).
>   When the address matches the project owner's email and CF already
>   has it verified, we trust CF: same human, same consent. Covers the
>   "I made a second project" workflow.
> - **Option B — platform-side reverify** (`verification_source='platform'`).
>   When CF reports the address verified by anyone _other_ than the
>   project owner, we DO NOT inherit consent. The row inserts as
>   `pending` and we issue our own HMAC-signed confirmation link to the
>   recipient. The row only flips to `verified` when they click; CF's
>   verified flag is irrelevant for the gate.
>
> Implementation pieces:
>
> - Migration `0013_email_verification_source.sql` adds
>   `verification_source TEXT NOT NULL DEFAULT 'cf'` with a check
>   constraint of `('cf' | 'platform')`. Existing rows default to `'cf'`.
> - Token helper `platform/packages/api/src/auth/confirm-token.ts` —
>   `base64url(JSON) + '.' + base64url(HMAC-SHA256)` carrying
>   `(v, pid, did, addr, iat, exp)` with 24h TTL. Single-use is enforced
>   by DB state (clicking flips status; re-clicks find an
>   already-verified row and return idempotent success).
> - Platform email helper `platform/packages/api/src/email/send-verification.ts`
>   POSTs to the proxy's new `/email/internal/send` endpoint, which is
>   gated by HMAC of the sentinel string
>   `void-platform-internal-email-v1` under `JWT_SECRET`. Only the api
>   and proxy hold `JWT_SECRET`, so user workers cannot reach the
>   internal endpoint.
> - Confirm endpoint `GET /email/destinations/confirm?token=...` —
>   public, mounted before the auth middleware, returns a small HTML
>   confirmation page on success.
> - GET `/destinations` refresh now skips
>   `verification_source='platform'` rows so a CF-side `verified=true`
>   doesn't override the platform gate. _(2026-09-15)_ It also promotes a
>   CF-pending row only when Cloudflare's verified destination carries the
>   tag that row registered: when the destination was deleted and another
>   project's add recreated it, CF's click answered that other
>   registration, so a non-owner row stays pending (disallow + allow
>   re-registers it and, the address now being CF-verified, takes the
>   Option B platform link), while the owner's own address adopts the live
>   tag with the inherited-consent audit (Option C). _(2026-09-15)_ A
>   VERIFIED `cf` row keeps its consent and is never re-read against
>   Cloudflare: the human at that address clicked the link mailed for
>   this project's own registration, so an out-of-band deletion of the
>   destination (an operator in the Cloudflare dashboard, or the
>   delete-vs-register window the DELETE route names) is not a platform
>   revocation — the revocation surfaces are `void email disallow`, the
>   admin revoke, and the owner-email change — and until the address is
>   re-verified on the account Cloudflare's `send_email` refuses the send
>   (the proxy reports `UNVERIFIED_DESTINATION`); `disallow` + `allow`
>   re-registers the row at any time (the DELETE 404s harmlessly on the
>   dead tag).
> - Per-project rate-limit on `POST /destinations`: 5/minute and
>   50/day in `email-add-rate:<projectId>:*` KV counters, with the
>   same NaN-poison defense as the proxy's send counter. Blocks Mallory
>   from spamming reverify mail.
> - `autoAddOwnerDestination` is unchanged in behavior — by definition
>   the address IS the owner's email, so it threads
>   `verification_source='cf'` explicitly (Option C every time).
>   _(2026-09-15)_ All three Option C writes (the auto-add, the POST's
>   owner branch, and the listing refresh's owner adopt) decide to
>   inherit from an unlocked read of the owner's email and only write
>   after Cloudflare answers, while the login-side revoke can only demote
>   rows that exist — and are `verified` — when it runs. So the
>   owner-audited insert (`tryCreateEmailDestination`) and promotion
>   (`promoteEmailDestinationWithOwnerAudit`) each run inside one
>   transaction behind `SELECT … FOR SHARE` on the owner's `users` row
>   and write nothing when `users.email` no longer matches the snapshot
>   (the auto-add then releases the tag; the POST answers its existing
>   409, and a retry takes Option B; the listing leaves the row pending).
>
> Tests cover each path: Option C trust, Option B platform-pending +
> confirmation email dispatch, refresh-skip, confirm-endpoint happy
> path, expired/tampered/unknown-id failure modes, idempotent re-click,
> rate-limit, and the migration default.

# Email — CF-Native (outbound, inbound, shared sender)

> **2026-09-11 extension.** Sections [Hosting modes and
> lifecycle](#hosting-modes-and-lifecycle), [Open decisions](#open-decisions)
> and [Open questions](#open-questions) were added from evidence gathered on
> 2026-09-10 and 2026-09-11, after the re-land. Claims elsewhere that the
> evidence contradicted were rewritten in place; each carries a _(corrected
> 2026-09-11)_ mark. Claims marked _(measured)_ were verified by reading
> source or by execution — pointers are in [References](#references).

## Context

[`0047-email.md`](./0047-email.md) designed a full Resend-based integration and was **deferred** because the outbound value over a plain Resend SDK install was too thin, the inbound-via-webhooks path was real platform work but couldn't justify the build on its own, and the Scale plan carried a $90/mo floor regardless of usage.

Since then we've re-scoped around **Cloudflare's native Email Service** (Email Routing + Email Workers + the `send_email` binding):

- **No third-party dependency, no flat fee.** Outbound rides the existing `send_email` binding; cost is whatever Cloudflare charges (currently free within generous limits).
- **Inbound is native.** Email Workers deliver messages straight into the user worker via an `email(message, env, ctx)` handler — no webhook-relay plumbing through `api.void.cloud` → dispatch → `*.void.app`.
- **Already on the stack.** Users are on Workers; this is one more binding, not a new vendor.
- **DX delta is much larger.** Raw CF email requires hand-rolling MIME, editing wrangler config, has no local-dev story, and needs platform plumbing for the multi-tenant case. Void closes all four gaps.

The earlier "just use the SDK" argument that sank 0047 doesn't apply here: the alternative isn't a three-line SDK, it's hand-constructing RFC 5322 messages, editing `wrangler.jsonc`, and (for any multi-tenant deployment) building cross-worker email dispatch from scratch.

## Scope

Single rollout covering outbound, inbound, and the platform infrastructure that makes both work end-to-end for every Void project.

**Framework (`packages/void`):**

- `void/email` outbound: `sendEmail(opts)` with a structured result, MIME construction, attachments, multi-recipient fan-out
- `email/` top-level directory convention for inbound: `defineEmail`, `parseEmail`, `replyEmail`, file-based routing with subaddressing + dynamic params
- Local dev inbox at `/__void/inbox` for outbound; round-trip dispatch back to local handlers (pending) for inbound
- Test harnesses: `createEmailTestHarness` (outbound), `createInboundTestHarness` (inbound)
- `WorkerEntrypoint` codegen so non-fetch handlers are RPC-callable from the platform router
- `from` defaulting to `<slug>+noreply@mail.void.cloud` when omitted
- Pre-flight quota check + async delivery log via `__VOID_PROXY` (fail-open when proxy is unbound)
- Binding inference (drives `manifest.bindings.email` for the dev-inbox plugin and analytics; no on-worker `send_email` binding)
- `void email usage|logs` CLI

**Platform (`platform/packages/proxy`, `platform/packages/api`):**

- `mail.void.cloud` shared sender zone (one-time CF Email Routing setup)
- Inbound router worker (`platform/packages/proxy/src/email-router.ts`) — receives all mail at `mail.void.cloud`, parses `<slug>+<tag>`, dispatches into the user worker via WfP RPC
- `/email/check-quota`, `/email/log-send`, `/email/log-recv` proxy endpoints with KV-backed monthly counters, per-minute burst cap, and suspend kill-switch
- `VOID_PROJECT_SLUG` env injection at deploy
- **Verified destinations** — `email_destinations` table per project; `POST /projects/:id/email/destinations` triggers the CF verification email; per-project allowlist injected as `allowed_destination_addresses` on the worker's `send_email` binding at deploy time. Project owner's email is auto-added on project create.
- Admin UI page (`platform/packages/api/src/admin/routes/email.tsx`): per-project usage, suspend toggle, monthly + burst limit overrides, counter reset, destinations list with add/remove
- API routes: `GET /projects/:id/email/{usage,logs}`, `GET|POST|DELETE /projects/:id/email/destinations[/:id]`

## Non-Goals

- **Custom-domain email for domains NOT on Cloudflare DNS** — a CNAME-only custom hostname cannot carry MX. _(scope change 2026-09-11)_ Domains on a Cloudflare zone are in scope; see [Custom domains on Cloudflare](#custom-domains-on-cloudflare).
- **Provider abstraction (Resend / SES / Postmark) wrapper.** Users can call those SDKs directly today; the wrapper would not earn its keep without concrete demand. See [Future work](#future-work) for the trigger conditions.
- **Templating** (React Email / Vue components / MJML).
- **Typed verified-sender codegen.**
- **User-facing dashboard pages** — _(corrected 2026-09-11)_ one small Email section on the project page is in scope; see [Mode A — developer surfaces](#developer-surfaces). Broader dashboard work stays deferred per `CLAUDE.md`.
- **Bounce handling.** CF doesn't deliver bounces to Email Workers; needs VERP or provider-side webhooks.
- **Cost-passthrough billing for outbound.** CF email is free at our volumes.
- **Programmatic Email Routing _rule_ creation on the managed platform.** The shared catch-all is a one-time setup; per-project routing rules aren't needed there. _(corrected 2026-09-11)_ Rule creation IS the plan for `void deploy --backend cloudflare`, where the developer owns the zone — see [Mode B](#mode-b--the-developers-own-cloudflare-account).

## Cloudflare's Constraints (Be Honest)

_(corrected 2026-09-11 — the original predated Email Sending onboarding.)_

The `send_email` binding has two regimes, and which one an account is in
decides who it can reach:

|                  | Email Routing only                                                          | + mail domain onboarded to **Email Sending** |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| sender           | any address on a routing domain the account owns                            | same                                         |
| who can receive  | **verified destination addresses only**                                     | anyone                                       |
| account ceiling  | **200 verified destinations, shared across every domain and every project** | none                                         |
| DNS added        | MX + SPF + DKIM, added and locked on enable                                 | `cf-bounce` MX, SPF, DKIM, DMARC             |
| plan             | Workers Free or Paid                                                        | Workers Paid                                 |
| our consent gate | allowlist + HMAC link                                                       | unchanged                                    |

- **From-domain:** must be a zone on Cloudflare DNS that the account owns, with Email Routing enabled. A subdomain of an existing zone (`mail.example.com`) is allowed for both routing and sending. There is no email without a zone — `workers.dev` alone cannot send or receive.
- **Binding restrictions:** `destination_address` pins one recipient; `allowed_destination_addresses` pins a list; `allowed_sender_addresses` pins the from side. With none set, the binding reaches whatever the regime above allows.
- **The 200-destination cap is the real constraint.** It is per account, not per domain or per project, so on a shared platform it is a ceiling on the whole platform's distinct recipients until the mail domain is onboarded to Email Sending. Onboarding lifts Cloudflare's gate; per-project consent stays in our own allowlist, which is a product rule rather than a Cloudflare one.
- **Two operational quirks:** outbound sent through the binding shows as _dropped_ in the Email Routing summary even when delivered (read Email Sending metrics or the proxy tail), and `message.reply()` throws when the inbound message carries more than 100 `References` entries.
- **Practical implication:** without onboarding, CF-native outbound fits app-internal use (notifications to the owner, ops alerts, forms piped to a verified inbox, reply-by-email on top of inbound). With onboarding it reaches end users too. Reputation is pooled on the shared domain; a project that needs its own signs with its own domain through [Custom domains on Cloudflare](#custom-domains-on-cloudflare).

## DX Papercuts → What Void Fixes

| Papercut in raw CF Email Workers                                                                | Void fix                                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Hand-rolled RFC 5322 MIME (headers, boundaries, encodings, attachments) required for every send | `sendEmail({ from, to, subject, text, html, attachments, ... })` — MIME built for you                |
| Must manually add `[[send_email]]` to `wrangler.jsonc`                                          | No on-worker binding — the platform proxy holds it; `sendEmail()` POSTs to `__VOID_PROXY/email/send` |
| `wrangler dev` doesn't simulate email — real sends during local dev, or hand-rolled mocks       | Local dev inbox: captured in-memory, browsable at `/__void/inbox`, HTML + raw `.eml`                 |
| No unified error shape — `send_email` throws raw Worker errors                                  | `sendEmail` returns a 3-case discriminated union; typed error codes; per-recipient deliveries        |
| Reply-to / CC / BCC / custom headers require manual header construction                         | First-class options fields; Void handles header encoding (RFC 2047 for non-ASCII names)              |
| Attachments require base64 + multipart/mixed MIME by hand                                       | `attachments: [{ filename, content, contentType }]`; `content` accepts `string`/`Uint8Array`/`Blob`  |
| Hand-write `email(message, env, ctx)` export, manually parse multipart with `postal-mime`       | Drop a file in `email/`, default-export a `defineEmail()` handler — Void generates the export        |
| All inbound flows through a single function — branching by recipient is hand-rolled             | File-based sub-routing: `email/[user].ts`, `email/support+[ticket].ts`, etc.                         |
| `EmailMessage.reply()` requires constructing a fully-formed reply with threading headers        | `replyEmail(message, { text, html })` builds threading-aware reply MIME and dispatches               |
| Subaddressing (`+tag` local-part suffix) requires manual parsing in every handler               | Built into the router; `params.<tag>` populated automatically                                        |
| `postal-mime` import + stream consumption boilerplate in every handler                          | `parseEmail(message)` wraps it; `ParsedEmail` re-exported as the canonical type                      |
| No test fixtures for inbound — users build `EmailMessage` mocks themselves                      | `createInboundTestHarness().deliver({ from, to, subject, text })` invokes the real dispatcher        |
| Multi-tenant inbound dispatch from a shared zone is unsolved                                    | `mail.void.cloud` shared sender + inbound router worker dispatches by `<slug>+<tag>`                 |

## Design

### Outbound: `void/email`

#### API surface — `sendEmail`

```ts
import { sendEmail } from 'void/email';

const result = await sendEmail({
  from: 'Acme <hello@acme.dev>',          // string | { email, name } — optional, defaults to <slug>+noreply@mail.void.cloud
  to: 'user@example.com',                 // string | Address | Array<string | Address>
  subject: 'Welcome',
  text: 'Hi there',                       // at least one of text/html required
  html: '<p>Hi there</p>',
  replyTo: 'support@acme.dev',
  cc: [...],
  bcc: [...],
  headers: { 'X-Campaign': 'welcome' },
  attachments: [
    { filename: 'receipt.pdf', content: pdfBytes, contentType: 'application/pdf' },
  ],
});

if (!result.ok) {
  if ('error' in result) {
    // pre-flight failure — no envelopes attempted
    console.error(result.error.code, result.error.message);
  } else {
    // mid-batch failure — some recipients may have succeeded
    for (const d of result.deliveries) {
      if (!d.ok) console.error(`failed to ${d.recipient}:`, d.error);
    }
  }
}
```

#### Types (exported)

```ts
export type Address = string | { email: string; name?: string };

export interface Attachment {
  filename: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  contentType?: string; // inferred from filename if omitted
  contentId?: string; // for inline images (cid:)
  disposition?: 'attachment' | 'inline';
}

export interface SendEmailOptions {
  from: Address;
  to: Address | Address[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Address;
  cc?: Address | Address[];
  bcc?: Address | Address[];
  headers?: Record<string, string>;
  attachments?: Attachment[];
  ctx?: { waitUntil(p: Promise<unknown>): void }; // for the async log call
}

export interface SendEmailDelivery {
  recipient: string; // the envelope `To` for this CF send
  messageId: string; // CF's returned messageId
}

export type SendEmailRecipientResult =
  | { recipient: string; ok: true; messageId: string }
  | { recipient: string; ok: false; error: SendEmailError };

export type SendEmailResult =
  | { ok: true; ids: SendEmailDelivery[] }
  | { ok: false; error: SendEmailError } // pre-flight only
  | { ok: false; deliveries: SendEmailRecipientResult[] }; // mid-batch failures

export interface SendEmailError {
  code:
    | 'BINDING_MISSING'
    | 'INVALID_FROM'
    | 'INVALID_TO'
    | 'UNVERIFIED_DESTINATION'
    | 'MIME_ERROR'
    | 'QUOTA_EXCEEDED'
    | 'UPSTREAM_ERROR';
  message: string;
  cause?: unknown;
}
```

#### Multi-recipient fan-out + failure semantics

The CF `EmailMessage` envelope is single-recipient, so `sendEmail` iterates `to` ∪ `cc` ∪ `bcc` and calls `binding.send()` once per recipient with the same raw MIME (Cc/Bcc are encoded into the MIME headers for display; the envelope alone drives delivery).

Three discriminated result cases:

- **Pre-flight failure** — validation / MIME / missing binding / quota denied. No envelopes attempted. Result: `{ ok: false, error }`.
- **All-success** — every recipient succeeded. Result: `{ ok: true, ids }`.
- **Mid-batch failure** — sends were attempted; at least one failed. Result: `{ ok: false, deliveries }`. Runtime continues through every recipient regardless of failures and collects per-recipient outcomes. **No** aggregate top-level error — distinct recipients can fail with distinct errors and synthesizing one would mislead callers.

Retry rule: on `deliveries`, retry only recipients with `ok: false`. On pre-flight `error`, retry the whole call. Never retry on the absence of `ok: true` alone — re-sending to recipients with `ok: true` will deliver duplicates.

#### Default sender resolution

When `from` is omitted, the framework reads `env.__VOID_PROJECT_SLUG` and `env.__VOID_EMAIL_DOMAIN` (both injected at deploy by the platform) and substitutes `<slug>+noreply@<domain>`. Explicit `from` values pass through unchanged. If either binding is absent, the call returns `INVALID_FROM` with a clear message — and _(measured 2026-09-11)_ that is what happens under `void dev` today, because neither binding is injected there; see [Known gaps](#known-gaps).

#### Binding inference

Two-tier detection in `packages/void/src/inference/walk.ts`:

1. **Import-source match** — `case "void/email": result.needsEmail = true;`
2. **Regex fallback** for JSX/TSX paths that skip the lexer

The third tier (`env.SEND_EMAIL` AST detection) was removed when outbound
moved to the proxy: the user worker no longer has a `SEND_EMAIL` binding,
so reading `env.SEND_EMAIL` returns undefined regardless of inference.

`needsEmail` drives `manifest.bindings.email` (used by analytics and the
local dev-inbox plugin) and the `email/` directory inclusion in the
default scan dirs. Opt-out via `bindings: { email: false }` in plugin
options. Wrangler sync **does not emit** `[[send_email]]` on user
projects — the proxy worker carries the platform's account-level
binding (see `platform/packages/proxy/wrangler.jsonc`).

#### MIME construction

_(corrected 2026-09-11)_ The re-land ships its own builder in `runtime/email/mime.ts` — `buildMime`, `encodeWord`, `foldHeader` — rather than `mimetext`, because six review rounds ended with rules no small library exposes: RFC 5322 §2.1.1's 998-octet line limit enforced on every rendered line, address lists folded at commas, RFC 2047 words chunked by code point, quoted parameters escaped, and a rejection rather than an illegal encoding when a value cannot be folded. Attachment totals are pre-checked against CF's ~10MB base64-inflated cap; oversize payloads surface as `MIME_ERROR` with measured-vs-allowed bytes rather than a generic upstream failure.

Unicode display-name fixture exercises RFC 2047 encoded-words (e.g. `"Jürgen Müller" <j@x.dev>`, Japanese, emoji) — locks behavior in and guards against regressions if the MIME backend is ever swapped.

### Inbound: top-level `email/` directory

#### Convention

```
crons/                                    # cron handlers       → scheduled() export
queues/                                   # queue handlers      → queue() export
email/                                    # email handlers      → email() export
├── _default.ts                           # fallback when no per-address match
├── support.ts                            # static: support@<any-zone>
├── support+[ticket].ts                   # subaddressing: support+ticket-123@... → params.ticket
├── [user].ts                             # dynamic local-part: anything@... → params.user
└── [user]+[tag].ts                       # dynamic + subaddressing
routes/                                   # HTTP only           → fetch() export
```

`email/` sits at the top level alongside `crons/` and `queues/` — non-HTTP handlers all live at the project root since each is wired into a separate worker export. `routes/` is reserved for HTTP routing.

#### Match precedence (most specific wins)

1. Static + tagged: `support+[ticket].ts` for `support+ticket-123@...`
2. Static: `support.ts` for `support@...`
3. Dynamic + tagged: `[user]+[tag].ts`
4. Dynamic: `[user].ts`
5. `_default.ts` — fallback

If no handler matches (and there's no `_default.ts`), the dispatcher does nothing and returns control to CF, which delivers a non-delivery report to the sender. Nested folders under `email/` are intentionally ignored.

Local-part-only matching — handlers match on the part before `@`, regardless of domain. Multi-domain projects that need per-domain branching can read `message.to` inside the handler. Domain-aware routing is deferred until usage demands it.

#### Handler signature

```ts
import { defineEmail, parseEmail, replyEmail } from 'void/email';

export default defineEmail(async (message, env, ctx, info) => {
  // message: ForwardableEmailMessage-shaped proxy (see "envelope/action contract" below)
  //   message.from, message.to, message.headers, message.raw, message.rawSize
  //   message.setReject(reason), message.forward(to, headers?), message.reply(emailMessage)
  //
  // info?: { params: Record<string, string> }  — populated for dynamic segments
  //
  const parsed = await parseEmail(message);
  console.log(parsed.subject, info?.params.ticket);

  await replyEmail(message, { text: 'Got it, ticket created.' });
});
```

`defineEmail()` is an identity function at runtime — it exists for IDE completion on the handler signature without forcing users to import `EmailHandler` separately. Matches Void's `defineX` family. A bare `export default async (message, env, ctx) => { ... }` works too.

**Why explicit `parseEmail` (vs auto-parsed wrapper).** Inbound parse is destructive: `message.raw` is a `ReadableStream` that can only be consumed once. Auto-parsing on every dispatch wastes work for handlers that only need `setReject` based on the recipient and forces a synchronous-buffer model that fights CF's streaming primitive.

#### Threading-aware replies

`replyEmail(message, opts)`:

1. Reads the original `Message-ID` and `References` from the message headers
2. Builds reply MIME via the outbound MIME builder, with `In-Reply-To` / `References` spliced in and `Subject: Re: <original>` (only adds `Re:` if not already prefixed)
3. Records a reply intent on the message proxy; the platform router enacts it on the real `ForwardableEmailMessage`

Defaults: `from = message.to`, `to = message.from`, `subject = "Re: <original>"`. Override any in opts.

#### Framework boundary — inbound is Void-app-only

_(measured 2026-09-11)_ Inbound handlers compile through `routingPlugin`, which no framework branch of `voidPlugin()` installs; the framework wrapper (`plugin-framework-triggers.ts`) wires crons and queues only. So under TanStack Start, React Router, vinext, SvelteKit, Nuxt, Analog and Astro there is nowhere to attach an `email()` export. Rather than let those projects ship dead handlers and bounce real mail, an `email/` directory under a detected framework is a **build error**, next to the existing auth / sandbox / live guards. The guard keys on the handler directory, not on `bindings.needsEmail`: outbound `sendEmail` is a binding and works in every framework. Wiring inbound into the framework entries needs the `WorkerEntrypoint` conversion below applied to each wrapper and is separate work.

|                           | Void app | Class A (TanStack Start, React Router)         | Class B/C (SvelteKit, Nuxt, Analog, Astro) |
| ------------------------- | -------- | ---------------------------------------------- | ------------------------------------------ |
| `sendEmail` in production | yes      | yes                                            | yes                                        |
| dev inbox                 | yes      | yes, once the app declares an `assets` binding | no — `BINDING_MISSING`; use the harness    |
| `email/` inbound handlers | yes      | build error                                    | build error                                |

#### Codegen

`packages/void/src/router/email.ts` scans `email/*.{ts,mts,js,mjs}` (top-level) and produces an `EmailHandlersScan`:

```ts
interface EmailHandlersScan {
  defaultHandler?: string; // "_default.ts"
  addresses: Array<{
    address: string; // "support" | "support+[ticket]" | "[user]"
    filePath: string; // "support+[ticket].ts"
    pattern: {
      kind: 'static' | 'static-tag' | 'dynamic' | 'dynamic-tag';
      regexSource: string; // anchored, targets the lowercased local-part
      paramNames: string[];
    };
  }>;
}
```

`router/compile.ts` emits an `__emailHandler` virtual export inside `virtual:void-routes`. Patterns are baked as a regex table tried in specificity order:

```ts
// generated by compileRouteTable
const __emailDefault = () => import('/email/_default.ts');
const __emailAddr0 = () => import('/email/support+[ticket].ts');
const __emailAddr1 = () => import('/email/support.ts');
const __emailAddr2 = () => import('/email/[user].ts');
const __emailPatterns = [
  { re: /^support\+([^+@]+)$/, params: ['ticket'], load: __emailAddr0 },
  { re: /^support$/, params: [], load: __emailAddr1 },
  { re: /^([^+@]+)$/, params: ['user'], load: __emailAddr2 },
];

export async function __emailHandler(message, env, ctx) {
  const local =
    String(message?.to ?? '')
      .toLowerCase()
      .split('@')[0] ?? '';
  for (const p of __emailPatterns) {
    const m = p.re.exec(local);
    if (!m) continue;
    const params = {};
    for (let i = 0; i < p.params.length; i++) params[p.params[i]] = m[i + 1];
    const mod = await p.load();
    if (typeof mod.default === 'function') return mod.default(message, env, ctx, { params });
    return;
  }
  const dmod = await __emailDefault();
  if (typeof dmod.default === 'function') return dmod.default(message, env, ctx, { params: {} });
}
```

The worker entry (`compileWorkerEntry`) imports `__emailHandler`, builds the message proxy, runs the dispatcher, and returns the action queue — see [Cross-worker dispatch](#cross-worker-dispatch).

### Cross-worker dispatch

#### Why the user worker must be a `WorkerEntrypoint`

WfP dispatch namespace stubs are typed as `Fetcher` — `.fetch()` and `.connect()` only. A plain default-export object like `export default { fetch, email, queue }` exposes **only `.fetch()`** through the namespace stub. The user worker extends `WorkerEntrypoint` from `cloudflare:workers` so its class methods become `Rpc.Provider<T>` entries on `Fetcher<EntrypointBranded>`, making `.email()` / `.queue()` / `.scheduled()` callable from the router.

`compileWorkerEntry` emits this shape for every WfP-deployed worker, not just email-handling ones. Cron and queue handlers also become RPC-callable from the platform side as a bonus, useful for future platform features.

**Compatibility dates.** Void preserves the user's `compatibility_date` with no floor, and a review asked whether the class shape breaks workers pinned before the 2024-04-03 RPC date. It does not: the `rpc` flag gates the **caller's** `Fetcher` stub, not the callee's class. _(measured)_ In workerd 1.20260701.1 a `WorkerEntrypoint` subclass serves `fetch`, `scheduled`, `queue` and RPC `email()` at dates back to 2021-11-03 and under an explicit `no_rpc`. The only caller is the platform proxy, at 2026-02-12.

#### Why the user worker can't receive a real `ForwardableEmailMessage`

Even with `WorkerEntrypoint`, the platform router cannot call `dispatch.get(name).email(realMessage)` and expect it to work. `ForwardableEmailMessage` is **not in workerd's RPC `BaseType` allowlist**, and `EmailMessage` is not `JSG_SERIALIZABLE`. RPC marshaling fails with `DataCloneError` before any bytes are sent. The receiver's `email()` method is never invoked.

Sources verifying this:

- `BaseType` allowlist: workerd `types/defines/rpc.d.ts` lines 64–83 — eleven types, no email
- Wire `SerializationTag` enum: `src/workerd/io/worker-interface.capnp` lines 424–469 — same 11 tags
- Serialization rejection path: `src/workerd/jsg/ser.c++:241–330` (`Serializer::WriteHostObject`); throws via `throwDataCloneErrorForObject` for any unregistered JSG type
- RPC argument marshaling: `src/workerd/api/worker-rpc.c++:176–188` (`serializeJsValue`) — zero email-specific handling
- Test fixture asserting the failure mode: `src/workerd/api/tests/js-rpc-test.js:852–858`
- `ForwardableEmailMessage` declaration: `types/defines/email.d.ts:28` — plain interface, no `RpcTarget` brand

The `email?(message: ForwardableEmailMessage)` declaration on `WorkerEntrypoint` (PR #5538, commit `862cb02c0`, type-only diff with no C++ runtime support) is intended for the CF email runtime calling the user worker directly — not for cross-worker RPC dispatch.

#### Envelope / Action contract

The router serializes the inbound message into an `EmailEnvelope` (only fields in the RPC `BaseType` allowlist), invokes `dispatch.get(name).email(envelope)`, and awaits an `EmailAction[]` describing what the user handler decided.

```ts
// from "void/email"
interface EmailEnvelope {
  from: string;
  to: string;
  headers: Record<string, string>; // plain object, not Headers
  raw: ReadableStream<Uint8Array> | Uint8Array;
  rawSize: number;
}

type EmailAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Record<string, string> }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };
```

Inside the user worker's `email(envelope)` method, the framework builds a _proxy_ `ForwardableEmailMessage` via `createMessageProxy(envelope)`. The proxy exposes all standard properties (`from`, `to`, `headers`, `raw`, `rawSize`) and methods (`setReject`, `forward`, `reply`), but each method **records an intent into an action queue** instead of acting directly. After the user handler returns, the codegen returns the action queue as the RPC result. The router enacts each action on the real `ForwardableEmailMessage` (with `setReject` honored as terminal per CF's runtime semantics).

`replyEmail(message, opts)` keeps its existing public API; internally it builds the reply MIME (same threading-aware logic) and calls `proxy.reply({ from, to, raw })`. The router constructs a real `cloudflare:email` `EmailMessage` from the action and calls the original `message.reply(...)` on its side.

User-handler ergonomics are unchanged from a single-tenant native CF Email Worker — authors still write `defineEmail(async (message, env, ctx, info) => { … })` and call imperatively. The framework hides the RPC round-trip.

#### Cross-worker pre-buffering

The router pre-buffers `message.raw` to a `Uint8Array` before serializing the envelope:

1. **Stream consumer rule:** `parseEmail` reads the stream once and exhausts it. Buffering on the router side makes the body replayable across the RPC boundary if the receiving framework dispatcher needs it more than once.
2. **RPC stream lifetime:** a `ReadableStream<Uint8Array>` IS in `BaseType` and survives RPC, but it's still a one-shot transferable. Buffering avoids subtle timing failures.

#### Outbound flow

```
user code → sendEmail()
  ├─ 1. Build MIME locally (mime.ts, hardened: comma-quoting, foldHeader
  │      quote-aware, In-Reply-To/References reserved against user input,
  │      bare addr-spec rejects comma/semicolon/quotes)
  ├─ 2. Default `from` to <VOID_PROJECT_SLUG>+noreply@mail.void.cloud if
  │      omitted (slug shape validated; reject @/+/whitespace)
  ├─ 3. POST __VOID_PROXY /email/send
  │       body: {
  │         projectId, aiToken,           // HMAC-authenticated by middleware
  │         from, recipients,             // dedup'd, lowercased
  │         mimeBase64, byteSize,
  │         requestId, fromDomain
  │       }
  │
  │     The proxy:
  │       a. Decode + size-check (≤ 10 MB)
  │       b. Suspend kill-switch (email-suspended:<projectId>)
  │       c. Read email-allowlist:<projectId> KV; partition recipients
  │          into allowed / unverified
  │       d. Burst + monthly counter against allowed.length only
  │          (denied-by-allowlist sends don't burn quota)
  │       e. EmailMessage.send() per allowed recipient via the proxy's
  │          account-level send_email binding
  │       f. Inline log + return SendEmailResult-shaped JSON
  └─ 4. Pass response through unchanged — the framework just maps
        unknown error codes to UPSTREAM_ERROR for forward-compat.
```

The user worker no longer has a `send_email` binding. Direct
`env.SEND_EMAIL.send()` returns undefined-of-undefined and faults — no
quota bypass surface.

#### Inbound flow

```
external sender → mail.void.cloud MX
  → CF Email Routing catch-all rule on mail.void.cloud
  → email-router worker (platform/packages/proxy/src/email-router.ts)
      ├─ 1. Parse local-part: <slug>+<tag>
      ├─ 2. Look up project by slug (ROUTING KV)
      ├─ 3. Pre-buffer raw to Uint8Array; serialize envelope
      ├─ 4. await dispatch.get(workerName).email(envelope)  → EmailAction[]
      ├─ 5. Enact each action on real ForwardableEmailMessage
      │       (setReject is terminal; otherwise forward/reply in order)
      └─ 6. ctx.waitUntil(log-recv → __VOID_PROXY)
```

#### `<slug>+<tag>` mechanics

Outbound: framework reads `env.VOID_PROJECT_SLUG` (injected at deploy) and rewrites `from` if omitted.

Inbound: the router parses the local-part. `<slug>` is everything before the first `+`; `<tag>` is everything after. The full original `to` address (`<slug>+<tag>@mail.void.cloud`) is preserved in the envelope, so the framework dispatcher matches against `email/<tag>.ts` handlers (or `_default.ts`) — the slug part is invisible to user handlers.

Trade-off: the user's `email/support.ts` handler is reached via `<slug>+support@mail.void.cloud`, which is awkward UX-wise compared to `support@<their-domain>`. Documented as the shared-sender reality; custom domains (future work) give clean apex addresses.

### Local development

#### Dev inbox (outbound capture)

A dev-only Vite plugin (`plugin-email-dev-inbox.ts`) registers `/__void/inbox` routes. When `sendEmail` is called under `void dev`, it doesn't touch the binding — instead:

1. Builds the MIME as normal (so MIME bugs surface locally)
2. Stores the message in an in-memory ring buffer (cap: 100 messages, FIFO eviction)
3. Returns `{ ok: true, ids: [{ recipient, messageId: "dev_<ulid>" }, ...] }`

Routes:

- `GET /__void/inbox` — HTML list view, newest first
- `GET /__void/inbox/:id` — rendered HTML body in a sandboxed iframe + headers + attachments
- `GET /__void/inbox/:id/raw` — raw `.eml` download
- `DELETE /__void/inbox` — clear the buffer

The buffer survives HMR but not full dev-server restart. **Production safety:** the middleware is registered behind `import.meta.env.DEV` (tree-shakes out of production) AND handlers re-check a runtime dev flag.

**Per-call opt-out:** `sendEmail({ ..., __sendInDev: true })` bypasses the inbox and sends for real. Per-call rather than env-var-gated so a single "test the real thing" send doesn't require restarting the dev server.

**Round-trip dispatch (pending).** The inbox UI will grow two affordances: a "Deliver to local handler" button on each captured message (when the recipient's local-part matches a local `email/...` handler) and a "Paste / upload `.eml`" form that runs raw messages through the dispatcher.

#### Test harnesses — `void/email/testing`

```ts
import { createEmailTestHarness, createInboundTestHarness } from 'void/email/testing';

// Outbound
const outbound = createEmailTestHarness();
await sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'hi', text: 'yo' });
expect(outbound.messages[0].subject).toBe('hi');

// Inbound
const inbound = createInboundTestHarness({
  routes: { 'support+[ticket]': supportHandler, _default: defaultHandler },
});
const result = await inbound.deliver({
  from: 'user@example.com',
  to: 'support+ticket-7@app.dev',
  subject: 'help',
  text: 'I have a problem',
});
expect(result.handler).toBe('support+[ticket]');
expect(result.params).toEqual({ ticket: '7' });
expect(inbound.replies).toHaveLength(1);
```

Both work in Vitest without any worker-runtime mocking. The inbound harness uses the same precedence rules + envelope/action contract as production.

### Platform infrastructure

#### Default sender setup (`mail.void.cloud`)

One-time platform infrastructure, per environment (see [`meta/operations.md`](../operations.md#email) for the runbook). _(corrected 2026-09-11)_

- The mail domain is a **subdomain of the existing `void.cloud` zone** — `mail.void.cloud`, `mail.staging.void.cloud` — added through Email Routing's subdomain setting. `void.cloud` already has Email Routing on. No zone registration, no nameserver change. As of 2026-09-11 neither subdomain has any DNS record.
- Cloudflare adds and locks MX, SPF and DKIM on the subdomain.
- The same name is onboarded to **Email Sending**, which adds the `cf-bounce` MX, SPF, DKIM and DMARC records and lifts the 200-destination account cap.
- Catch-all routing rule on the subdomain → `void-proxy` worker (the proxy's `email()` export is bound by the `email-router.ts` module). Wrangler has no catch-all command; it is the dashboard or `PUT /zones/{z}/email/routing/rules/catch_all`.
- Standard `pnpm run deploy` ships the proxy with the new code.

Per-project setup: nothing. Every project deployed with the new framework codegen is automatically reachable, and the hourly rollover rewrites every project's `email-slug:` mirror so older projects are covered within an hour of the api deploy. Existing pre-`WorkerEntrypoint` deployments will hit the "no email handler" reject path; they need to redeploy.

**Reputation pooling.** All `*.void.app` projects share `mail.void.cloud`'s sender reputation. Mitigations:

- Conservative default outbound quotas
- Burst-rate cap per project (sliding-window in proxy)
- Manual suspend kill-switch in the admin UI

Per-project DKIM signing isn't possible on the shared domain, so reputation pooling is unavoidable there. _(scope change 2026-09-11)_ A project with reputation-sensitive sending brings its own Cloudflare zone — [Custom domains on Cloudflare](#custom-domains-on-cloudflare) — and signs with its own domain.

#### Inbound router worker (`platform/packages/proxy/src/email-router.ts`)

Bound as the proxy worker's `email()` export. Receives all inbound mail at `mail.void.cloud`:

1. Parses `<slug>+<tag>` from `message.to`
2. Looks up the project's worker name in `ROUTING` KV (same KV the HTTP dispatcher uses)
3. Pre-buffers `message.raw` to bytes, serializes the envelope
4. Calls `dispatch.get(workerName).email(envelope)` — RPC into the user worker
5. Awaits `EmailAction[]`, enacts each on the real `ForwardableEmailMessage`
6. Async logs to `__VOID_PROXY` `/email/log-recv` via `ctx.waitUntil`

Distinct error shapes for clarity in tail logs:

- `setReject('mail.void.cloud: missing project slug')` — empty slug
- `setReject('no project found for slug "X"')` — KV miss
- `setReject('project "X" has no worker (static deploy)')` — static-only deploy
- `setReject('project has no email handler')` — pre-`WorkerEntrypoint` deploy needs redeploy
- `setReject('project handler error')` — generic dispatch failure

#### `__VOID_PROXY` metering

Reuses the unified service binding pattern the AI proxy + revalidation already use (`__VOID_PROXY` + `__VOID_PROXY_TOKEN` + `__PROJECT_ID`). The same proxy worker also handles `/ai/*`, `/d1/*`, `/kv/*`, `/r2/*`, `/revalidate`, and now `/email/*`.

Auth pattern: caller sends `{ projectId, aiToken, ... }` JSON body; the proxy's middleware verifies `aiToken` is HMAC of `projectId` with the shared `JWT_SECRET`. Same auth as every other proxy route — no email-specific token plumbing.

Three endpoints in `platform/packages/proxy/src/email.ts`:

- `POST /email/check-quota` — pre-flight outbound quota check. Returns 429 if denied; suspend kill-switch denied first
- `POST /email/log-send` — async per-recipient delivery log
- `POST /email/log-recv` — async inbound delivery log (called by router worker, not user code)

#### Quotas + suspend

Counters live in `ROUTING` KV under monthly buckets:

| Key                                       | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `email-sent:<projectId>:<YYYY-MM>`        | Monthly outbound counter                                 |
| `email-recv:<projectId>:<YYYY-MM>`        | Monthly inbound counter                                  |
| `email-burst:<projectId>:<YYYYMMDDThhmm>` | Per-minute outbound counter (TTL 5m)                     |
| `email-limit:<projectId>`                 | Per-project monthly outbound override (default 200)      |
| `email-burst-limit:<projectId>`           | Per-project per-minute burst override (default 10)       |
| `email-suspended:<projectId>`             | Suspend kill-switch — non-null value blocks all outbound |

Default plan limits (placeholders pending product input):

| Plan  | Outbound / month | Inbound / month | Burst / minute |
| ----- | ---------------- | --------------- | -------------- |
| Free  | 200              | 1,000           | 10             |
| Hobby | 10,000           | 50,000          | 60             |
| Pro   | 100,000          | 500,000         | 600            |

The shape is what matters; the numbers will move with real usage data. Inbound is metered separately (users don't trigger it; attackers do; reasonable inbound volumes are higher than outbound) and overage logs but doesn't reject — hard inbound rejection requires CF rule changes that risk silent drops.

**Both quota counters are best-effort, and the monthly cap is not a backstop for the burst cap.** Every counter here is a KV read-modify-write. Concurrent isolates read the same value and overshoot by `(parallel_isolates × per_request_recipients)`, and the wider monthly window does not make that safer: KV accepts at most one write per second per key, so above ~1 send/second the month counter stops advancing for the rest of that second and every request in that window charges against the same stale read. KV answers the rejected write with a 429, which the proxy's `.catch()` swallows. The overshoot therefore scales with request rate and degrades the monthly cap by the same factor as the burst cap.

What the caps do buy is a bound on accidental floods and a cheap reject for the ordinary case. The actual abuse control is the suspend kill-switch — `email-suspended:<projectId>` plus the platform-wide `routing.suspended` marker — which is read uncached on every send so a suspend converges immediately. Making either cap strict means moving the counter into a Durable Object (or fronting it with CF rate limiting); that is a platform architecture decision and is deliberately out of scope for this design.

CF caps message size at ~25MB raw / ~10MB base64-inflated for `send_email`. The framework enforces that ceiling client-side and reports as `MIME_ERROR` before contacting the proxy.

#### Verified destinations

CF's `send_email` only delivers to addresses verified as destinations on the sender account, so the platform manages a per-project allowlist on top of CF's account-wide list:

- **Schema** — `email_destinations` table (`id`, `project_id`, `address`, `status: 'pending' | 'verified' | 'failed'`, `cf_destination_id`, `verified_at`).
- **CF API client** — `platform/packages/api/src/provisioning/email-routing.ts` wraps `POST/GET/DELETE /accounts/:id/email/routing/addresses`.
- **API routes** — `GET|POST|DELETE /projects/:id/email/destinations[/:id]`. POST triggers CF to email the recipient with a verification link; GET refreshes status from CF for any rows still `pending`.
- **Auto-verify project owner** — `platform/packages/api/src/routes/projects.ts` calls `addDestination(user.email)` when a project is created (via `ctx.waitUntil`, non-blocking). The owner gets the verification email in their GitHub-OAuth-linked inbox; one click and their project can send to itself out of the box.
- **Per-project allowlist enforcement in the proxy** — _(re-land)_ the user worker carries no `send_email` binding. The api mirrors each project's verified rows into `email-allowlist:<projectId>` in `ROUTING` KV (`provisioning/email-allowlist.ts`), and the proxy checks every send and every inbound reply against that mirror. Both revoke paths tighten the mirror before deleting the row. Destinations are account-wide on CF's side; the mirror is what makes consent per project. _(2026-09-15)_ Project teardown fails closed (503, row kept, retry) on the `email-slug:` / `email-allowlist:` deletes, slug first, before any best-effort cleanup: `__VOID_PROXY_TOKEN` never expires and the proxy reads a missing routing blob as "not suspended", so after the cascade those two keys are all that stops a retained token from sending.
- **Cross-project safety on delete** — destinations are CF account-wide; before calling `deleteDestination` we check `countProjectsUsingDestination` and only remove from CF if no other project references the same `cf_destination_id`.

The platform/team never opens the CF dashboard. The recipient (the person receiving the verification email) is the only human in the loop, and they only click a link in their own inbox. For every address except the owner's own, that mail is **ours** — HMAC-signed link, sent from `noreply@<mail domain>`, resendable — because Cloudflare's verification is per account rather than per project, and Cloudflare has no API to resend its mail.

#### Admin UI — `platform/packages/api/src/admin/routes/email.tsx`

Per-project page at `/admin/email/:projectId`:

- Usage summary (sent / received / limit / burst cap / status) for the current month
- Suspend toggle (`email-suspended:<projectId>`)
- "Set monthly limit" + "Set burst limit" forms (`email-limit:*` / `email-burst-limit:*` overrides)
- "Reset counter" button for the current month
- Verified-destinations table with add / remove

Mirrors the existing admin route patterns (e.g. `platform/packages/api/src/admin/routes/deployments.tsx`). Direct KV/DB reads + writes; no API layer between admin and storage. An environment-level page beside it is designed in [Operator surfaces](#operator-surfaces).

#### CLI — `void email`

```
void email usage                      # monthly outbound/inbound counts + quota
void email logs [--limit N]           # recent email delivery activity
void email destinations               # list verified recipients
void email allow <address>            # add recipient + trigger CF verification
void email disallow <address>         # remove recipient
```

Hits the API routes above. Output formatted for the terminal — useful for power users debugging "did my mail go out?" or wiring a new recipient without an admin trip. _(measured 2026-09-11)_ None of these print the project's own address; `void email status` in [Developer surfaces](#developer-surfaces) is the fix.

## Hosting modes and lifecycle

_(added 2026-09-11)_

Void projects run in three places, and email has a different shape in each:

| Mode                                                    | Who owns the Cloudflare account | Mail domain                             | Who does the zone work           |
| ------------------------------------------------------- | ------------------------------- | --------------------------------------- | -------------------------------- |
| **A. Managed platform** — `void deploy`                 | VoidZero                        | `mail.void.cloud` (one per environment) | VoidZero, once                   |
| **B. Own account** — `void deploy --backend cloudflare` | the developer                   | a zone the developer owns               | the developer, helped by the CLI |
| **C. Self-hosted platform**                             | the company                     | `mail.<company>` (one per environment)  | the company's operator, once     |

One rule holds in all three: **a developer never sees a Cloudflare object.**
No zone, no routing rule, no destination id, no token scope. A developer sees
an address, a list of recipients, a counter, and an error code. Everything
else belongs to whoever owns the account — VoidZero in A, the developer's own
`wrangler login` session in B, the company's operator in C.

Three findings changed the plan and are worth stating up front:

1. **A `wrangler login` session already carries `email_routing (write)` and
   `email_sending (write)`**, and wrangler 4.107+ ships a full `wrangler email`
   command group. Mode B needs no new token and no direct API client for most
   of the setup. _(measured)_
2. **Verified destinations are capped at 200 per Cloudflare account, shared
   across every domain and every project.** Onboarding the mail domain to
   Email Sending removes that gate; per-project consent stays in our own
   allowlist.
3. **Nothing today tells a developer their own address.** Not the CLI, not
   the dashboard, not the API, and the two bindings are neither typed nor
   injected in `void dev`. _(measured)_ This is the single largest UX gap and
   it is the same gap in all three modes.

### The lifetime

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

### Personas

**Developer.** Writes `sendEmail(...)` and `email/*.ts`. Wants to know: what is
my address, who can I send to, did it work. Must never need a Cloudflare
account (A, C) or a Cloudflare concept (B).

**Operator.** Owns the platform account in A or C. Does the zone work once
per environment, watches health, holds the kill switch. Is a human at
VoidZero in A and a platform admin at the company in C.

**Own-account developer (B).** Both roles in one person, but the split still
holds in time: the setup prompt happens once, then they are a developer.

### Mode A — managed platform

#### Developer surfaces

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
A project with a custom domain gets a second block per domain — sender,
inbound map, and the domain's status — and `void email domain add | status |
list | remove` beside them.

**`void deploy`** prints the inbound map at the end whenever `email/` handlers
ship. That is the moment the developer cares:

```
◆  Deployed acme
│  Inbound email
│    acme+support+<ticket>@mail.void.cloud  →  email/support+[ticket].ts
│    acme+*@mail.void.cloud                 →  email/_default.ts
```

**Dashboard → project → Email.** Same data as `void email status`, plus
"Add recipient" and "Resend". This section is small, follows the existing
per-section loader fan-out on the project page, and is the only place a
non-CLI user can add a recipient.

**`void dev`.** Inject `__VOID_PROJECT_SLUG` and `__VOID_EMAIL_DOMAIN` from the
linked project, and type both in `.void/env.d.ts`. See [Known gaps](#known-gaps).

#### Operator surfaces

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

| Row                     | Probe                                                                    | Fix                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| domain agrees           | api `EMAIL_SENDER_DOMAIN` vs proxy `/health` (make the boolean a string) | edit wrangler vars                                                                                  |
| routing ready           | `GET /zones/{z}/email/routing` → `status`                                | `POST …/routing/dns`                                                                                |
| catch-all → proxy       | `GET …/rules/catch_all` names `void-proxy[-staging]`                     | `PUT …/rules/catch_all`                                                                             |
| `send_email` bound      | proxy `/health` `sendEmail`                                              | redeploy proxy                                                                                      |
| Email Sending onboarded | `GET …/sending/subdomains/{id}/dns/status`                               | `POST …/sending/subdomains` (permission group undocumented — see [Open questions](#open-questions)) |
| slug mirror             | count of projects lacking `email-slug:`                                  | already self-heals hourly; button runs it now                                                       |
| token scope             | a 403 on any read above, mapped to the permission's name                 | extend `CF_API_TOKEN`                                                                               |

Plus **Send test mail** to the operator's address, and **Suspend all
sending**, which already exists as the `routing.suspended` marker.

### Mode B — the developer's own Cloudflare account

#### What happens today _(measured)_

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

#### Runtime changes (framework, ~200–250 lines)

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
4. **No-prefix inbound.** When no `__VOID_PROJECT_SLUG` is configured (an
   own-account worker), the dispatcher matches the full local part, so
   `support+T-42@zone` reaches `email/support+[ticket].ts` — once the zone's
   subaddressing setting is on; see below, it is off by default.
5. **Enact actions on a native message.** When the envelope is a real
   `ForwardableEmailMessage`, apply reject / forward / reply on it instead of
   returning them.
6. **Deploy guidance** — the detection and prompt below.

#### One keystroke, measured _(rewritten 2026-09-11 after the deep research)_

Three facts, all read from wrangler's source and Cloudflare's OpenAPI schema
this day, change the shape of Mode B from "prompt, then a dashboard visit"
to **one Enter on the first deploy, zero on the next**:

| Fact                                                                                                                                                                                                           | Where it was read                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler auth token --json` is a stable, documented command "for use with other tools and scripts" (since 4.57.0). It prints the session's OAuth bearer, refreshed if expired.                                | wrangler 4.107/4.130 `cli.js` `authTokenCommand` (`status: "stable"`); docs `workers/wrangler/commands/general` "auth token". Measured: `{type:"oauth",token:"cfoa…"}`                        |
| That bearer works against `api.cloudflare.com` like any token. Keyring storage (`default.enc`) is **opt-in**; the default is plaintext `default.toml`.                                                         | measured `GET /zones`, `GET /zones/{z}/email/routing/*` with it; `cli.js` `wantsKeyring = envOverride ?? isKeyringEnabled() ?? false`; CHANGELOG 4.107.0 (#14156)                             |
| wrangler ≥ 4.113 makes `wrangler deploy` **reconcile Email Routing rules** from a top-level `addresses` array: literal → this worker, `*@apex` → catch-all, via `POST /accounts/{a}/email/routing/rules/plan`. | CHANGELOG 4.112.0 (#14470) + 4.113.0 (#14471); 4.130 `cli.js` `applyEmailRoutingAddresses`; OpenAPI operation `email-routing-routing-rules-plan-account-routing-rules` (GA, `x-forge-hidden`) |

And one fact that breaks an assumption this document made:
**subaddressing is a per-zone setting, OFF by default.** `GET
/zones/{z}/email/routing` reads `support_subaddress: false` on `void.cloud`,
`void.app` and a third zone. A literal rule for `support@zone` does **not**
match `support+T-42@zone` until the zone's setting is on (`PATCH
/zones/{z}/email/routing { support_subaddress: true }`, `Zone Settings
Write`; no wrangler command). Mode A is unaffected — its catch-all takes
everything — but Mode B's flagship `email/support+[ticket].ts` needs the
setting flipped, and the one-Enter flow does that.

```
$ void deploy --backend cloudflare

  Email in use   email/support+[ticket].ts · email/_default.ts · sendEmail() in 2 files
    domain    mail.acme.com          (void.json email.from)
    zone      acme.com               account Acme (f721b8e5…) · session dev@acme.com
    apex MX   aspmx.l.google.com     left alone — mail lives on the subdomain
    routing   mail.acme.com  not enabled · subaddressing off
    sending   mail.acme.com  not onboarded
    rules     support@mail.acme.com → acme-support   (absent)
    binding   SEND_EMAIL             (absent)

  This changes YOUR Cloudflare account. acme.com itself is not touched.
    + enable Email Routing on mail.acme.com      Cloudflare writes and locks 3 MX + 1 SPF record there
    + turn on subaddressing for acme.com         support+anything@ reaches support@
    + onboard mail.acme.com for Email Sending    MX/SPF/DKIM on cf-bounce.mail.acme.com, _dmarc.mail.acme.com (p=reject)
    + wrangler.jsonc                              send_email: [{ name: "SEND_EMAIL" }], addresses: ["support@mail.acme.com"]
    + routing rule (applied by wrangler deploy)   support@mail.acme.com → acme-support
    ! email/_default.ts                           a catch-all exists only on an apex; other @mail.acme.com mail bounces

◆  Set up email on mail.acme.com?  ● Yes / ○ No          ⏎      ← the one keystroke

  ✔ routing   mail.acme.com enabled · subaddressing on
  ✔ sending   mail.acme.com onboarded
  ✔ config    wrangler.jsonc updated
  …
  Email Routing plan:                                            ← wrangler's own output
    mail.acme.com
      + support@mail.acme.com -> worker (acme-support)
  Email Routing addresses applied.

  ✔ deployed  acme-support
    inbound   support@mail.acme.com  →  email/support+[ticket].ts
    outbound  sendEmail() from support@mail.acme.com
```

Second deploy, nothing changed: every row reads ready, no prompt, no
writes, `Email Routing rules are up to date.` Zero keystrokes.

#### The flow, by lane

```
developer   void CLI (deploy.ts, step 3b-ii — before any project code runs)   void's pinned wrangler          Cloudflare API                           dashboard
─────────   ────────────────────────────────────────────────────────────────   ─────────────────────          ──────────────                           ─────────
deploy ───▶ needsEmail · scanEmailHandlersSync · domain = host(email.from)
            PREFLIGHT, read-only
              resolveMx(domain), resolveMx(apex), resolveTxt(_dmarc.*)  ── public DNS
              whoami --json ──────────────────────────────────────────▶ tokenPermissions has email_routing:write + email_sending:write?
              email routing settings <apex> ────────────────────────▶ GET /zones?name= · GET …/email/routing ──▶ Status · support_subaddress
              email routing rules list <apex> ──────────────────────▶ GET …/rules · …/rules/catch_all   ──▶ mine · foreign · absent
              email sending settings <domain> ──────────────────────▶ GET …/email/sending/subdomains    ──▶ Enabled · not found
            checklist
[Enter] ◀── confirm(default Yes)        CI/non-TTY: checklist + "run `void email setup`", deploy without email
            APPLY, only rows not ready
              [apex]  email routing enable <apex> ───────────────────▶ POST …/email/routing/enable {}       ──▶ MX ×3 + SPF, locked
              [sub]   auth token --json  (env WRANGLER_WRITE_LOGS=false) ─▶ {type,token}   held in a closure, seconds
                      fetch POST /zones/{z}/email/routing/dns {name:"mail.<apex>"} ─────────────────────────▶ MX ×3 + SPF on the subdomain   [UNVERIFIED]
                      fetch PATCH /zones/{z}/email/routing {support_subaddress:true} ───────────────────────▶ subaddressing on            [UNVERIFIED]
                      non-2xx → print the Settings → Subdomains line; withhold `addresses` this run ─────────────────────────────────────▶ (fallback only)
              [send]  email sending enable <domain> ─────────────────▶ POST …/email/sending/subdomains {name} ──▶ cf-bounce MX/SPF/DKIM + _dmarc
              write wrangler.jsonc: send_email [{name:"SEND_EMAIL"}] · addresses [...]; re-parse rootConfig
            build (send_email + addresses pass through to dist/ssr/wrangler.json; verifier pins `addresses` whole-object)
            wrangler deploy ─────────────────────────────────────────▶ PUT script (send_email in metadata)
                                                                        POST /accounts/{a}/email/routing/rules/plan {owner_worker_tag, rules, catch_all_rules}
                                                                        POST …/rules (literal → worker, source:wrangler) · PUT …/rules/catch_all (*@apex)
            print the address map                                                                                                          (never visited on the happy path)
```

Rules that hold the whole thing together:

- **Void never refreshes, stores or forwards a token.** Everything with a
  wrangler command goes through void's own pinned wrangler (the deploy
  runner, `createDeployWranglerRunner`, `assertUploaderStillPinned`). The
  session bearer is borrowed through `wrangler auth token --json` for the
  two calls that have no command — subdomain routing enable and the
  subaddressing PATCH — inside one closure, and dropped. The child gets
  `WRANGLER_WRITE_LOGS=false`: without it, wrangler appends the token to
  `~/.wrangler/logs/wrangler-*.log`, mode `-rw-r--r--` (read in
  `shouldLogToDisk`). This reverses the earlier "REST from Void must use
  `CLOUDFLARE_API_TOKEN` only" rule, on purpose.
- **Slot 3b-ii**: after the bundle hash, before the env-schema probe, so no
  project code has run when a credentialed call is made, and `rootConfig`
  is re-parsed after the write so the laundering guard needs no exception.
- **Rules and catch-all are wrangler's job.** Void derives `addresses` from
  the `email/` scan and writes the root `wrangler.jsonc`; the existing
  `wrangler deploy` applies the plan. Added and updated changes apply
  silently; deleted and conflict changes get one default-No prompt in a
  TTY and a `UserError` in CI — after the upload. Void prunes foreign
  addresses at preflight so the plan is never destructive on its account.
- **`addresses` is written only when routing is ready for every listed
  domain, and rewritten every run** — deleted (never `[]`, which deletes
  every owned rule) when a later preflight finds routing off, with the
  reason printed. Otherwise the plan 400s with `2062` after the upload on
  every deploy.
- **Derivation.** `email/<literal>.ts` and `email/<literal>+[tag].ts` →
  `<literal>@<domain>`. `email/_default.ts` → `*@<apex>`, apex path only.
  `email/[name].ts` (dynamic local part) needs a catch-all, so it is
  **refused on a subdomain** with a message.
- **`send_email: [{ name: "SEND_EMAIL" }]`** is written only when routing is
  ready or sending is onboarded — a bare account never carries the binding,
  because what `wrangler deploy` does with it there is unmeasured. Under
  `void dev`, `mergeBindings` strips it so the dev inbox stays the only
  sink.
- **`addresses` joins `DEPLOY_WHOLE_OBJECT_PINNED_FIELDS`.** Today it fails
  open: the plugin's config customizer passes unknown keys through
  (reproduced), so a build could redirect the account's inbound mail via
  `dist/ssr/wrangler.json`.
- **The interactivity gate must match wrangler's**: `ci-info.isCI ||
!(stdin.isTTY && stdout.isTTY)`. Void's `isCI` (stdin only, or
  `VOID_TOKEN`) disagrees when stdout is piped or `CI=1` is exported, and
  the two halves of one deploy would then call the same run interactive and
  not.

#### Refusals and degraded branches

| Branch                                                     | What the developer sees                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no `email.from`                                            | `add "email": { "from": "you@mail.acme.com" } to void.json` — deploying without email                                                                                                                                                                                                                                           |
| apex has foreign MX, `email.from` on the apex              | `acme.com already receives mail (aspmx.l.google.com). Void never enables routing over live mail. Use something@mail.acme.com.` stop                                                                                                                                                                                             |
| session predates 4.81 (no email scopes)                    | `wrangler login` (one browser Allow) — stop                                                                                                                                                                                                                                                                                     |
| routing status `unlocked` / `misconfigured*`               | print the status, stop — never re-lock records a developer unlocked                                                                                                                                                                                                                                                             |
| `_dmarc.<name>` / `cf-bounce.<name>` TXT exists            | refuse sending onboarding; onboarding writes its own `_dmarc` `p=reject` and the API 409s (`dmarc.multiple`, `dkim.conflict`…)                                                                                                                                                                                                  |
| sending enable fails (Free)                                | `Workers Paid needed for arbitrary recipients. Inbound works; sendEmail() to verified destinations only.` continue without it. 2026-09-14: the `send_email` binding written alongside remembers the refusal — settled on later deploys, for `--require-email` and `void email status`; only `void email setup` offers the retry |
| subdomain POST refused                                     | one-time dashboard step printed (`Email → Settings → Subdomains → add mail.acme.com`); `addresses` withheld this run                                                                                                                                                                                                            |
| rule on my address owned elsewhere                         | address pruned from `addresses`, reported; wrangler's plan stays non-destructive                                                                                                                                                                                                                                                |
| existing `send_email` entry not named `SEND_EMAIL`         | refuse with the rename — a second binding would be silent                                                                                                                                                                                                                                                                       |
| zone in another account / not on Cloudflare / partial zone | distinguished via `GET /zones?name=` without `account.id`; `partial`/`secondary` refused                                                                                                                                                                                                                                        |
| CI / non-TTY, not ready                                    | checklist + `run void email setup once, commit wrangler.jsonc, redeploy`; `--require-email` fails instead. `--provision` is NOT an escape: it fails closed in CI                                                                                                                                                                |

#### Human steps that remain, and why

1. One Enter on the first deploy — it changes their account and locks DNS.
2. `wrangler login` once, ≥ 4.81 — the session is the credential.
3. `email.from` typed once — wrangler cannot enumerate zones (`email
routing list` shows routing-enabled zones only); auto-pick is decision 9.
4. Workers Paid for `sendEmail()` to arbitrary recipients — billing is
   dashboard-only.
5. A verification click only when a handler `forward()`s to a destination.
6. The Subdomains form only if the subdomain POST is refused.
7. A y/n on destructive rule changes — wrangler's own semantics.

#### Build list

Land first, own PR: bump `wrangler` (`pnpm-workspace.yaml:30`,
`^4.107.0` → ≥ 4.113, recommend the `@cloudflare/vite-plugin` 1.54.7 /
wrangler 4.131 pair so one wrangler exists in the tree; minimum pair
1.46.0 / 4.113.0). Re-fixture the `--json` parsers and deploy flags; add a
bundled-`cli.js` grep test for `Email Routing plan:` and `authTokenCommand`.

Feature PR, `packages/void/src`:

| File                                    | Change                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/email-cloudflare.ts` _(new)_       | preflight (DNS probes, prose parsers pinned to the shipped wrangler with fixtures), `addresses` derivation, conflict pruning, checklist + address-map renderers, apply steps, `fetchWithSessionBearer` — the only function that ever sees the token; error map (2062, 2040, 2036/10105) |
| `cli/deploy.ts`                         | `computeDesiredCloudflareResources` returns `needsEmail` + handlers; step 3b-ii; `addresses` in `DEPLOY_WHOLE_OBJECT_PINNED_FIELDS` and `verifyGeneratedDeployConfig`; `--require-email`; address map after deploy; wrangler-compatible interactivity gate                              |
| `cli/wrangler.ts`                       | `ProvisionedWranglerPatch` gains `sendEmail` (name-keyed upsert) and `addresses` (whole-array); comment-preserving jsonc writes; registry entry `addresses: whole-object`                                                                                                               |
| `cli/deploy.ts` runner                  | `runWranglerAuthToken()` — capture, `WRANGLER_WRITE_LOGS=false`, stdout never logged, never placed in env                                                                                                                                                                               |
| `cli/email.ts`                          | `void email setup [--backend cloudflare]`; Mode B block in `void email status`                                                                                                                                                                                                          |
| `config.ts`, `schema.json`              | `email.from`                                                                                                                                                                                                                                                                            |
| `index.ts` `mergeBindings`              | strip `send_email` under serve                                                                                                                                                                                                                                                          |
| `runtime/email.ts`, `router/compile.ts` | the runtime items 1, 4, 5 above                                                                                                                                                                                                                                                         |
| tests                                   | derivation table; prose fixtures per wrangler version; 3b-ii ordering; `addresses` pin; token never in env/stdout; CI branches; 2040/2036; argv per branch                                                                                                                              |

Upstream, in parallel: a workers-sdk PR adding `--subdomain` to `wrangler
email routing enable` and a `--subaddressing` switch; when the pinned
wrangler carries them, delete `fetchWithSessionBearer`.

#### Still unverified — one staging session settles most of it

1. `POST /zones/{z}/email/routing/dns { name: "mail.<zone>" }` enables
   routing on the subdomain, with the OAuth session, and what a repeat
   POST does. The code issues it only when the apex zone already has
   routing enabled; a disabled zone plus a subdomain `name` is a case the
   code never sends and the probe should still record. Attested by the OpenAPI body field (`name`, not deprecated)
   and a Support quote in `terraform-provider-cloudflare#5890`; never
   executed. wrangler's own `routing enable` calls the **deprecated**
   `POST …/routing/enable`; `…/routing/dns` is the current one.
2. `PATCH /zones/{z}/email/routing { support_subaddress: true }` with the
   session (same permission group as 1).
3. The other writes on the session (`sending enable`, rules, catch-all) —
   inferred from wrangler's own commands, never run here.
4. End-to-end `wrangler deploy --env= …` applying `addresses` from the
   redirected `dist/ssr/wrangler.json`; only `--dry-run` on 4.107 was run.
5. How to READ "is `mail.<zone>` a routing subdomain": `dig MX` is empty
   on `mail.void.cloud` today, `GET …/routing/dns?subdomain=` is now
   formally deprecated, and the plan endpoint accepted a literal on an
   unregistered subdomain as `added` — so the plan is not a readiness check.
6. Workers Free: what `sending enable`, `sending settings`, and a deploy
   with a bare `send_email` binding do. `401 / 2036` on
   `GET /accounts/{a}/email/sending/zones` was seen on one account with no
   onboarded domain and an unread plan; the documented not-entitled code
   is `403 / 10105`. Used as a hint line only. 2026-09-14: `sending settings`
   answers not-found on Free and on Paid-never-onboarded alike, so no read
   can tell them apart; the committed `send_email` binding — written only by
   a run that already attempted `enable` — is the memory of a refusal
   (binding present + sending pending = settled), the deploy never retries,
   and `void email setup` offers the retry on its own prompt.
7. The API-token permission set for the plan endpoint (`x-api-token-group:
null`) — the CI story runs on `CLOUDFLARE_API_TOKEN`.
8. Two-label subdomains; what the plan reports after a dashboard edit of a
   wrangler-owned rule; a worker rename (rules stay with the old tag →
   `conflict`).

#### Decisions handed back

- **9. Domain input**: require `email.from` (recommended, zero writes to
  `void.json`) vs. pick the zone through the bearer and write
  `email.from = noreply@<domain>` back.
- **10. Apex path**: allow with the one Enter when apex MX is empty
  (recommended; the checklist names the catch-all claim and `_dmarc`
  `p=reject`) vs. require `--apex`.
- **11. Ship the session-bearer bridge now** behind the live-POST
  verification, file the upstream wrangler PR in parallel, retire the
  bridge when the pin carries it (recommended) vs. wait.
- **12. Two projects on one zone** (`addresses` is top-level only, one
  catch-all per apex): per-environment `email.from`, or a hard refusal
  when a desired address is already routed elsewhere instead of a prune.
- **13. Ownership of a hand-written `addresses` array**: Void owns the whole
  array in Mode B (recommended; refuse when it holds entries Void did not
  derive) vs. record managed entries and merge.

### Mode C — self-hosted platform

#### State today _(measured)_

Self-hosting is not a supported story in the repo. Every setup document is
written for VoidZero's own account. On the email path, three code sites pin
VoidZero hosts; everything else already follows `EMAIL_SENDER_DOMAIN`:

| Site                                                              | What it pins                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `platform/packages/api/src/email/send-verification.ts:76-84`      | the api host in the confirmation link                                                                                             |
| `platform/packages/api/src/email/send-verification.ts:90-95`      | the proxy origin the api posts verification mail to                                                                               |
| `platform/packages/api/src/email.ts:1` + `api/wrangler.jsonc:152` | the legacy `Void <noreply@void.cloud>` sender for welcome / invite / alert mail, on a different domain from `EMAIL_SENDER_DOMAIN` |

The prose in `getting-started-prompt.txt` and `docs/guide/email.md` also names
`mail.void.cloud` literally, so an Acme developer would read the wrong
address.

#### Design

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

Per-project custom domains follow [Custom domains on Cloudflare](#custom-domains-on-cloudflare)
unchanged: the customer's zone, the customer's token, a subdomain when the
apex carries corporate MX. The company's mail domain remains the platform
domain for every project that brings no zone of its own.

## Custom domains on Cloudflare

_(scope change 2026-09-11 — this section replaces "Why custom domains aren't
included". The reasons that section gave still hold for the models it
rejected; a third model, which it dismissed on a premise this design no
longer keeps, is the one adopted here.)_

A project can send as and receive at its own domain — `support@acme.com`,
`noreply@mail.acme.com` — when that domain's DNS zone is on Cloudflare. The
zone stays in the customer's own Cloudflare account. The customer grants the
platform a scoped API token once; the platform configures the zone and runs
both directions on the customer's behalf.

"On Cloudflare" means a zone under Cloudflare DNS in an account the customer
controls. A domain that only CNAMEs to Void through Cloudflare for SaaS is
**not** on Cloudflare in this sense and stays out of scope: Email Routing
needs MX records on a Cloudflare zone, and RFC 2181 forbids MX beside a
CNAME. Those customers keep the provider path in [Future Work](#future-work).

### Why this model

| Model                                            | What it needs from the customer                                                       | Why it is or is not the one                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bring your zone — a scoped token** _(adopted)_ | create one API token, click one verification mail, one dashboard step for a subdomain | zone stays theirs; apex MX untouched; works on Free for routing, Paid for sending; the domain signs its own DKIM, so reputation is per customer |
| NS delegation of the whole domain to our account | move all of their DNS to us                                                           | we would own and have to manage every record they have; greenfield DNS UI                                                                       |
| `mail.acme.com` as its own zone in our account   | delegate one subdomain                                                                | Cloudflare's subdomain setup is **Enterprise-only**                                                                                             |
| Self-hosted SMTP relay                           | nothing                                                                               | reinvents what Email Routing gives for free                                                                                                     |

0078 rejected the token model for violating "users never touch Cloudflare".
That premise is kept for the **managed platform's shared sender** and
dropped for a customer's **own domain**: the customer already touches
Cloudflare to own the zone, and the token is the same act of trust they give
`wrangler login`. The rule that survives is the one from [Hosting modes and
lifecycle](#hosting-modes-and-lifecycle): after the one-time grant, a
developer sees an address, recipients, a counter and an error code — never a
zone, a rule or a token scope.

### The two paths

A routing rule can only name a worker in its own account — the rule's action
value is a bare worker name, and worker names are unique per account — so
inbound from a customer zone cannot reach `void-proxy` directly. It crosses
accounts as a **forward** to an address we own, and outbound crosses back as
a **REST send** with the customer's token.

```
INBOUND   support+T-42@acme.com
            │   MX in the customer's account (mail.acme.com, or the apex when its MX is empty)
            ▼
          catch-all rule: forward → acme+inbound@mail.void.cloud
            │   one verified destination address in the customer's account, per project domain
            │   SRS rewrites the envelope sender · ARC seal · `From:` kept · `To:` kept (probe)
            ▼
          mail.void.cloud MX (our account) → catch-all → void-proxy router
            │   recognises the bridge address, reads the original recipient from `To:`
            ▼
          project worker  email()   to = support+T-42@acme.com   viaDomain = acme.com
                                    dispatcher runs in no-prefix mode (Mode B item 4)

OUTBOUND  sendEmail({ from: "noreply@acme.com", … })
            │   proxy: from-domain is registered to this project → use that domain's token
            ▼
          POST /accounts/{customer}/email/sending/send_raw   { from, recipients, mime_message }
                DKIM = acme.com (or mail.acme.com) · quota = the customer's · message_id returned
```

**Inbound identity.** The bridge is one address per project domain,
`<slug>+inbound@<shared domain>` — one verification click per domain rather
than one per handler. The router recovers the recipient the sender wrote from
the `To:` header; when no address on a registered domain is there (a BCC),
the message goes to `_default.ts` with the bridge address as `to`. That is
the one loss in the design, and it is documented rather than papered over.
`replyEmail` on a bridged message defaults `from` to the address that
received it, on the customer domain, and goes out over the REST path.

**Trust.** The router asserts `viaDomain` only when the inbound
`Authentication-Results` shows the forwarder's DKIM pass; a message sent
straight to the bridge address is handled as ordinary shared-domain mail. The
reply-sender pin gains a second accepted shape: any address on a domain
registered to the receiving project.

### The flow — `void email domain add acme.com`

Mirrors `void domain add`: a row that goes `pending → active`, printed
instructions for the steps only a human can do, and `status` to poll.

```
$ void email domain add acme.com
  MX        acme.com carries MX for google.com → apex is off limits
            using mail.acme.com  [change with --subdomain]
  Token     opening the Cloudflare token form, pre-filled for this domain…
            https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=…&name=Void%20email%20%E2%80%94%20acme.com
            in the browser: Continue to summary → Create Token → Copy
            (a TTL is fine — the platform reports when it expires)
  Clipboard watching for the token — or press Enter to paste it instead
            got it · clipboard cleared
  Verify    token active · zone acme.com found in account …f721 · scopes ok
  Stored    on the platform, encrypted for this project · nothing kept on this machine
  Routing   mail.acme.com is not on Email Routing yet
            → add it: Email Routing → acme.com → Settings → Subdomains  (dashboard only)
  Sending   mail.acme.com onboarded — cf-bounce MX, SPF, DKIM, DMARC added
  Bridge    acme+inbound@mail.void.cloud added as a destination — waiting for the verification click
  Status    pending · run `void email domain status acme.com`
```

Who does what:

| Step                     | Who                  | How                                                                                                                                                                     |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token                    | customer, once       | three clicks: the CLI opens the dashboard form pre-filled with name and scopes; the customer clicks through and pastes — [details](#creating-the-token-in-three-clicks) |
| zone lookup, MX check    | platform             | `GET /zones?name=`, public DNS — no token needed for MX                                                                                                                 |
| routing on the apex      | platform             | `POST /zones/{z}/email/routing/dns`, only when MX is empty                                                                                                              |
| routing on a subdomain   | customer, once       | dashboard — no API exists; the CLI prints the exact path and polls                                                                                                      |
| Email Sending onboarding | platform             | `POST /zones/{z}/email/sending/subdomains { name }` (token auth undocumented — probe)                                                                                   |
| bridge destination       | platform + one click | `POST /accounts/{c}/email/routing/addresses`; the verification mail lands in our router, which surfaces the link in `status` — auto-completing it is decision 7         |
| catch-all → bridge       | platform             | `PUT /zones/{z}/email/routing/rules/catch_all` once the bridge is verified                                                                                              |
| status → active          | platform             | every probe green; the map printed                                                                                                                                      |

`void email domain status`, `list`, `remove`. `remove` deletes the rule and
the bridge destination in the customer's account best-effort, then the row
and the token. The customer can also revoke the token at Cloudflare at any
time; the next probe sees the 403 and the row reads `token revoked`, with
inbound continuing until they delete the rule themselves.

### Data and the token

- `email_domains` — `project_id`, `domain` (the address domain, apex or
  subdomain), `zone_id`, `account_id`, `mode: 'apex' | 'subdomain'`, `status:
'pending' | 'active' | 'token_revoked' | 'token_expired' | 'failed'`, `bridge_address`,
  `bridge_destination_id`, `verification_data` (which steps remain, and the
  verification link once captured), `token_id` and `token_expires_on` from
  `GET /user/tokens/verify` (so `status` can name the token to revoke and
  warn before a TTL runs out), timestamps.
- The token is stored with `encryptProjectSecret` under the project's
  envelope key, per domain, and only the api and proxy ever decrypt it. It
  is never written to a worker, a manifest or a log.
- Scopes, minimum: zone-scoped `Zone Read` (to find the zone id) and
  `Email Routing Rules Edit`; account-scoped `Email Routing Addresses Edit`
  and `Email Sending Edit`; `Zone Settings Edit` only for the apex path.
  `DNS Read` is not needed — MX is read over public DNS. Account-level
  scopes are necessarily account-wide; the token summary page shows that
  before the customer clicks **Create Token**.

### Creating the token in three clicks

_(added 2026-09-11)_ The token is the one step that only the customer can
do, so it is the step to make short. Cloudflare's dashboard accepts a
[template URL](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)
that pre-fills the token form — name, permission groups, resources. The CLI
opens it; the customer clicks **Continue to summary**, **Create Token**,
**Copy** — and the CLI takes the token from the clipboard. Three clicks,
nothing typed (plus a login if the browser has none). The link is the
pattern Cloudflare's own `deploy.workers.cloudflare.com` and several
third-party CLIs already use; those CLIs stop at a paste prompt, which stays
here as the fallback.

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

**The whole grant, with its branches.** Five parties; the developer
clicks three times and types nothing.

```
developer      void CLI                       Cloudflare dashboard        Cloudflare API                Void platform
─────────      ────────                       ────────────────────        ──────────────                ─────────────
add acme.com ▶ MX lookup (public DNS)
               apex or mail.acme.com
               build the link (keys fit the path)
               snapshot the clipboard
               open ───────────────────────▶ login if needed ¹
                                             form pre-filled
click 1 ───────────────────────────────────▶ Continue to summary
                                             (narrow account / zone here)
click 2 ───────────────────────────────────▶ Create Token ────────────▶ user-owned token created
click 3 ───────────────────────────────────▶ Copy → clipboard
               poll the clipboard ≤ 10 min
               new value · 40 chars · no vendor prefix
               ──────────────────────────────────────────────────────▶ GET /user/tokens/verify
               ◀────────────────────────────────────────────────────── status active · id · expires_on
               clear the clipboard
               POST /projects/:id/email-domains { domain, token } ─────────────────────────────────▶ encryptProjectSecret
               drop the token from memory                                                            row pending · token_id · expires_on
                                                                      ◀────────────────────────────── GET /zones?name=acme.com   (zone:read)
                                                                      ◀────────────────────────────── one read per needed endpoint ²
                                                                                                     all green → setup steps with the stored token
◀───────────── pending · the next human step ◀───────────────────────────────────────────────────────┘
                                                                      ◀────────────────────────────── runtime: proxy decrypts, send_raw
```

¹ Whether the pre-fill survives a login redirect is unverified.
² Rules, addresses, sending, and zone settings on the apex path. A 403
names the missing group; the CLI re-runs the link with that key added.

| Branch                                | What the developer sees                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| clipboard unchanged, or wrong shape   | nothing; still waiting. Enter switches to the paste prompt                                   |
| verify says not active                | "that is not an active Cloudflare token — still waiting"                                     |
| 10 minutes, nothing                   | the paste prompt; Esc cancels with nothing stored anywhere                                   |
| zone not found with this token        | `failed · acme.com is not in an account this token can see` → re-run `add`                   |
| 403 on a scope probe                  | `failed · missing Email Routing Addresses Edit` → re-run `add`; the link carries the key     |
| `expires_on` passed, or revoked at CF | `status` reads `token expired` / `token revoked`; `add` again replaces the token, rules stay |
| `remove`                              | rule and bridge destination deleted with the token, best effort; then the row and ciphertext |

**The clipboard watch.** The write side already exists — `void auth token`
runs `pbcopy` / `clip` / `xclip -selection clipboard`
(`cli/auth-cmd.ts:38-51`); the read side is the mirror: `pbpaste`,
`powershell -NoProfile -Command Get-Clipboard`, `xclip -o -selection
clipboard` or `wl-paste`. The rules that keep it from being creepy:

- The CLI reads only between opening the link and getting a token, never
  otherwise, and says so on screen.
- It ignores whatever was on the clipboard before the link opened
  (the snapshot), and accepts only a _new_ value shaped like a Cloudflare
  token: 40 characters of `[A-Za-z0-9_-]`, no vendor prefix (`ghp_`,
  `github_pat_`, `sk-`, `xox` are the same length or longer and are refused
  without a network call). Only a value that passes the shape check is sent
  to `GET /user/tokens/verify`, and only `status: active` is accepted.
- It clears the clipboard once it has the token (`pbcopy </dev/null` and
  the platform equivalents), so the token does not sit there for the next
  paste. A clipboard manager's history is outside our reach; the CLI says
  so once.
- Enter at any time switches to the masked paste prompt; no clipboard tool
  (SSH, CI, a Wayland session without `wl-paste`) falls back to it
  silently. Nothing on the clipboard is ever printed or logged.

**Where the token lives.** On the platform, encrypted per project with
`encryptProjectSecret` — the proxy sends with it at runtime and the api
re-probes with it, so that copy is the one that must exist. On the
developer's machine: nowhere. The CLI holds it in memory, hands it to the
platform over TLS as its first call, and drops it; every later step
(`status`, `remove`, repair) goes through the platform. The CLI already
keeps its own login in the OS keychain (`@napi-rs/keyring`, service
`dev.void.cli`, `cli/auth.ts:13`), so a local keychain copy is one line —
but nothing on the machine would ever read it, and a second copy is a
second place to leak from. Not stored. The one thing the platform copy
does not solve is a **TTL** the customer set on the form: sends stop when it
expires, `status` reads `token expired`, and `void email domain add` again
is the renewal.

The link:

```
https://dash.cloudflare.com/profile/api-tokens
  ?permissionGroupKeys=<url-encoded JSON below>
  &accountId=*            # required by the form; "all accounts" — the customer narrows it in the summary if they like
  &zoneId=all             # required by the form; narrow to acme.com in the summary (probe 7 asks whether a zone id here is honoured)
  &name=Void%20email%20%E2%80%94%20acme.com
```

```json
[
  { "key": "zone", "type": "read" },
  { "key": "email_routing_rule", "type": "edit" },
  { "key": "email_routing_address", "type": "edit" },
  { "key": "email_sending", "type": "edit" },
  { "key": "zone_settings", "type": "edit" }
]
```

`zone_settings` is added only on the apex path — the MX check runs over
public DNS before the link is built, so the CLI already knows which path it
is on. `zone: read` is what `GET /zones?name=` needs to find the zone id;
the earlier scope list forgot it.

Where the keys come from, because the documented key table stops at
`workers_*`, `d1`, `queues`, `dns`, `zone`, `zone_settings`:

| Key                     | Permission group (dashboard label)                      | Evidence                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_routing_rule`    | Email Routing Rules Read/Write (`email_routing_rule_*`) | dashboard permission-group dump in `Cloudflare-Mining/Cloudflare-Datamining` (`data/account/token_permission_groups_dash.json`, 2024-12-29): every group's `label` is `<key>_read` / `<key>_write`; used in the wild by GhostMail iOS and erxes |
| `email_routing_address` | Email Routing Addresses Read/Write                      | same dump; GhostMail iOS                                                                                                                                                                                                                        |
| `email_sending`         | Email Sending                                           | **one source only** — erxes `MailConfigUpdate.tsx` (2026-09-01); the product launched after the dump. Probe 5                                                                                                                                   |
| `zone`, `zone_settings` | Zone Read, Zone Settings Read/Write                     | documented; same dump                                                                                                                                                                                                                           |

What this does not do, so nobody expects it:

- The dashboard never hands the token back. There is no redirect, no
  callback, no local listener to receive it — the paste is the transport.
  Cloudflare's own docs: "Template URLs only pre-fill the token creation
  form. Users must still complete the token creation process in the
  dashboard."
- A two-click **Allow** page (OAuth, the way `wrangler login` works) needs
  an OAuth client registered by Cloudflare. No self-service registration is
  documented; wrangler's client id is a partner arrangement. If VoidZero can
  get one, this whole subsection collapses to "click Allow" — decision 8.
- Creating the token by API (`POST /accounts/{id}/tokens`) needs a token
  with `API Tokens: Edit` first — the same chicken, one egg earlier.
- The developer's local `wrangler login` session cannot replace the
  platform's token, but not for the reason first written here. `wrangler
auth token --json` hands the session bearer to other tools by design
  (keyring storage is opt-in; see Mode B), so the CLI _could_ do the
  one-time setup from the developer's machine — the catch-all → bridge
  forward via REST, the destination via `wrangler email routing addresses
create`. What it cannot do is send at runtime: the platform's proxy needs
  a credential of its own for `send_raw`, and the OAuth bearer expires in
  an hour with the refresh token staying wrangler's. Option for later:
  setup through the session, and a pasted token narrowed to `Email
Sending: Edit` only.

### If Void had a Cloudflare OAuth client

_(added 2026-09-11)_ "A Cloudflare app" can mean four things. One of them
removes the token step entirely; Void cannot self-serve it.

| What                                        | What it is                                                                 | Can Void get it?                                        | Helps here?                                                |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Cloudflare Apps marketplace                 | JS widgets injected into sites; installs ended 2024-01, sunset 2024-08-31  | no — gone                                               | no                                                         |
| **OAuth client** (what `wrangler login` is) | the customer clicks **Allow**; Void receives an access + refresh token     | not self-service; a partner arrangement with Cloudflare | **yes** — the token step becomes one click                 |
| Tenant API                                  | Channel/Alliance partners create and own Cloudflare accounts for customers | partner agreement                                       | only for accounts Void creates — not a customer's own zone |
| Access / OIDC                               | identity for humans                                                        | yes                                                     | no — not API access                                        |

With the client, the grant collapses to this, and every step after "stored"
is unchanged:

```
$ void email domain add acme.com
  Cloudflare  opening the consent page…   [Allow]   (one click; pick the account if you have several)
              ◀ access token + refresh token · scopes zone:read · email_routing:write · email_sending:write
  Stored      refresh token encrypted for this project · the platform refreshes it; nothing on this machine
  Zone        acme.com found in account …f721
  …
```

The web variant is better still: a **Connect Cloudflare** button in the
dashboard's Email section, with the callback on `api.void.cloud`, so the
grant never passes through the developer's machine at all. The CLI variant
uses a `localhost` callback, as wrangler does (`http://localhost:8976/oauth/callback`).

What it costs, so the owner can weigh the ask:

- **Breadth.** An OAuth grant is user-wide — every account the user belongs
  to, every zone in them, for the granted scopes. `wrangler whoami` shows
  this today. A template-link token can be narrowed to one zone; a grant
  cannot. Keep the token path as the narrow option for a company with many
  zones; OAuth is the default for everyone else.
- **Refresh.** The access token is short-lived; the platform stores the
  refresh token (`encryptProjectSecret`, same envelope) and refreshes at
  `POST /oauth2/token`. A revoked grant is the existing `token_revoked`
  path. `POST /oauth2/revoke` on `remove`.
- **Scopes exist already.** Cloudflare's consent catalogue has
  `email_routing:write` ("settings, rules, and destination addresses"),
  `email_sending:write` and `zone:read` — they are what wrangler asks for.
  Nothing new has to be built on Cloudflare's side except the client.

Why not reuse wrangler's client id: the OAuth endpoints are public and the
client is a public PKCE client, so it works, and PartyKit (before its
acquisition), `every-app` (2026-08), `orangeshell`, `corral`, `BPB-Wizard`
and others do exactly that. The consent screen is Cloudflare's for wrangler,
the scope set is wrangler's, and Cloudflare can cut it off any day. Not a
basis for a product. NuxtHub, Orange, Prowler and erxes chose the template
link instead — the same choice as this document until the client exists.

The ask, in one line: an OAuth client for Void with scopes `zone:read`,
`email_routing:write`, `email_sending:write` and two redirect URIs —
`https://api.void.cloud/cloudflare/callback` and `http://localhost:<port>/oauth/callback`.

The same link and paste field belong in the dashboard's Email section
(Mode A) as a **Create token at Cloudflare** button next to a paste box;
the CLI and the dashboard share the link builder. The account-token form
(`/?to=/:account/api-tokens&…`) is the better home for a company, because
the token survives the employee — but it needs an Administrator, and the
send endpoint documents a `10103 bad_token_type` error without saying which
type it rejects. User token is the default until probe 6 answers that.

### What changes in the existing rules

- **Reply-sender pin** — accepts the receiving slug on the shared domain
  _or_ any address on a domain registered to the project.
- **Recipient allowlist** — Cloudflare's verified-destination gate does not
  apply once the customer's domain is onboarded for sending, and the
  reputation at stake is the customer's own. Whether our allowlist still
  gates custom-domain sends is decision 6.
- **Quotas and kill switch** — the platform's burst cap and suspend switch
  keep applying to every send that passes through the proxy, custom domain
  or not; the daily quota is the customer's account's.
- **The 200-destination cap** — the bridge consumes one destination in the
  _customer's_ account per project domain, not one in ours.

### Limits, stated plainly

- The customer's account must be on **Workers Paid** to send; routing alone
  works on Free.
- Three steps stay human: the token (three clicks and a paste), the
  routing-subdomain dashboard form, and the verification click (until
  decision 7 automates it).
- A BCC'd message cannot be routed to a named handler; it reaches
  `_default.ts`.
- A domain that is not on Cloudflare DNS is not covered.

### Mode B

The developer's own zone needs none of this. Their worker holds the
`send_email` binding, the rules target their worker directly, and there is
no bridge and no stored token — [Mode B](#mode-b--the-developers-own-cloudflare-account)
already covers it.

### Probes before building

1. Whether `+` is accepted in a destination address (`acme+inbound@…`).
2. The verification mail's sender and link shape, so the router can
   recognise it and, if decision 7 says so, fetch it against a pinned host.
3. Whether the original `To:` header survives a plain forward.
4. Whether an API token with `Email Sending: Edit` can call
   `POST /zones/{z}/email/sending/subdomains`.
5. Whether `{ "key": "email_sending", "type": "edit" }` pre-fills the
   Email Sending permission in the dashboard form (one third-party source
   only; the routing keys have two plus the dashboard dump).
6. Whether `POST /accounts/{id}/email/sending/send_raw` accepts an
   account-owned token, or only a user-owned one (`10103 bad_token_type`).
7. Whether `zoneId=<zone id>` in the template URL narrows the form to that
   zone, or only `all` is honoured.
8. Whether the dashboard's **Copy** button places the bare token on the
   clipboard (no label, no trailing newline) on macOS, Windows and Linux.

## Backwards Compat

Pre-launch — clean cutover. Notes for context:

- `sendEmail` user-facing API is unchanged. Result shape, error codes,
  multi-recipient fan-out, dev inbox, test harness all behave the same.
- `from` defaulting only applies when omitted; explicit `from` passes through.
- Pre-`WorkerEntrypoint` user deployments: outbound now routes through
  `__VOID_PROXY` (which they already have) so it works without a redeploy.
  Inbound still hits the router's "no email handler" reject path until
  they redeploy.
- User wrangler.jsonc files that previously had `[[send_email]] { name = "SEND_EMAIL" }`
  emitted by `void dev` are no longer rewritten. Stale blocks are
  harmless (no production code references them) and can be deleted by
  the user; the framework neither emits nor strips them.
- `manifest.bindings.email` field was removed from the deploy manifest
  shape. The platform doesn't use it anymore.

## File Layout

```
packages/void/                            (framework, in ../void)
├── package.json                          # ./email + ./email/testing exports
├── src/
│   ├── runtime/
│   │   ├── email.ts                      # sendEmail, createEmail, default-from resolution, proxy hooks
│   │   └── email/
│   │       ├── mime.ts                   # MIME builder (mimetext wrapper)
│   │       ├── inbound.ts                # defineEmail, parseEmail, replyEmail, createMessageProxy
│   │       ├── dev-inbox.ts              # in-memory ring buffer + sink registry
│   │       ├── testing.ts                # createEmailTestHarness, createInboundTestHarness
│   │       └── types.ts                  # SendEmailOptions, SendEmailResult, EmailEnvelope, EmailAction
│   ├── router/
│   │   ├── email.ts                      # scanEmailHandlers + compileEmailPattern
│   │   └── compile.ts                    # __emailHandler dispatcher emit; WorkerEntrypoint subclass
│   ├── inference/walk.ts                 # needsEmail (3-tier import / regex / env detection)
│   ├── plugin-inference.ts               # bindings.email opt-out
│   ├── plugin-routing.ts                 # passes emailDir; watches email/
│   ├── plugin-email-dev-inbox.ts         # /__void/inbox Vite plugin
│   ├── cli/
│   │   ├── wrangler.ts                   # no on-worker [[send_email]] emit (proxy holds the binding)
│   │   ├── email.ts                      # `void email usage|logs` subcommands
│   │   └── email-args.ts                 # subcommand parser
│   └── index.ts                          # mergeBindings for send_email
└── test/unit/
    ├── email-mime.test.ts
    ├── email-send.test.ts                # send + default-from + proxy quota + partial failures
    └── email-inbound.test.ts             # scanner, compile emit, defineEmail, parseEmail,
                                          #   buildReplyMessage, createInboundTestHarness

platform/packages/api/src/                         (platform)
├── schema.ts                             # MODIFIED — add email_destinations table
├── drizzle/0011_add_email_destinations.sql
├── db.ts                                 # MODIFIED — destination CRUD helpers
├── routes/
│   ├── email.ts                          # GET usage, GET logs, GET|POST|DELETE destinations
│   └── projects.ts                       # MODIFIED — auto-add owner email on project create
├── admin/routes/
│   └── email.tsx                         # admin page: usage, suspend, limits, destinations
├── provisioning/
│   ├── email-routing.ts                  # NEW — CF Email Routing addresses API client
│   └── provision.ts                      # MODIFIED — inject VOID_PROJECT_SLUG plain_text binding
└── routes/deploy.ts                      # MODIFIED — emit send_email with allowed_destination_addresses

platform/packages/proxy/src/                       (platform)
├── email.ts                              # /email/check-quota, /email/log-send, /email/log-recv
├── email-router.ts                       # email() export — slug+tag parse, dispatch, enact actions
├── body.ts                               # MODIFIED — asNumber helper
└── index.ts                              # MODIFIED — wire /email routes; export email() handler

User project layout:

my-app/
├── crons/                                # → scheduled() export
├── queues/                               # → queue() export
├── email/                                # → email() export   (NEW)
└── routes/                               # → fetch() export
```

## Rollout

Single ordered sequence. Each step is independently testable; later steps depend on earlier ones.

1. **Framework: outbound runtime + types + dev inbox + tests.** `sendEmail`, MIME builder, dev-inbox plugin, `createEmailTestHarness`. Standalone — no platform dep.
2. **Framework: inbound runtime + scanner + dispatcher emit + tests.** `defineEmail`, `parseEmail`, `replyEmail`, `email/` scanner, `__emailHandler` codegen, `createInboundTestHarness`.
3. **Framework: `WorkerEntrypoint` codegen migration.** `compileWorkerEntry` emits the class form with `email(envelope)` returning actions. Affects all WfP-deployed workers.
4. **Framework: default-from + `__VOID_PROXY` integration.** `from` defaults to `<slug>+noreply@mail.void.cloud`; pre-flight quota + async log via the unified proxy. Fail-open when proxy is unbound.
5. **Framework: `bindings.email` flag in deploy manifest.** `packageBuild` / `packageFrameworkBuild` set `manifest.bindings.email = true` when `needsEmail` is detected, so the platform knows to emit `send_email` on the worker.
6. **Platform: `VOID_PROJECT_SLUG` injection.** `platform/packages/api/src/provisioning/provision.ts` adds the plain-text binding alongside the existing proxy bindings.
7. **Platform: proxy email handlers + router worker.** `/email/check-quota`, `/log-send`, `/log-recv` in `platform/packages/proxy/src/email.ts` (with monthly + per-minute burst caps + suspend kill-switch); `email-router.ts` wired as the proxy's `email()` export.
8. **Platform: destinations schema + CF API client + API routes.** `email_destinations` table; `provisioning/email-routing.ts`; `GET|POST|DELETE /projects/:id/email/destinations[/:id]`. Auto-add project owner's email on project create.
9. **Platform: `send_email` binding emit at deploy.** `routes/deploy.ts` reads verified destinations and emits `{ type: 'send_email', allowed_destination_addresses: [...] }` per project.
10. **Platform: API + admin UI.** `GET /projects/:id/email/{usage,logs}` + `admin/routes/email.tsx` (usage, suspend, limits, destinations).
11. **Framework: `void email usage|logs|destinations|allow|disallow` CLI.**
12. **Ops: mail subdomain setup.** _(corrected 2026-09-11)_ Add `mail.void.cloud` as an Email Routing subdomain of the existing `void.cloud` zone, onboard it to Email Sending, add the catch-all rule pointing at the proxy worker. No zone registration, no nameserver change. One-time human action per environment — see [`meta/operations.md`](../operations.md#email).
13. **Deploy.** `pnpm run deploy:staging` first to validate the dispatch path against real WfP runtime; then production.
14. **Tag release.**

Steps 1–5 + 11 ship in the framework via the normal release. Steps 6–10 are platform changes. Step 12 is the only ops gate before production sending works.

### After the re-land merges _(added 2026-09-11)_

15. **Operator, before any production send:** the setup script, run against
    staging first; Email Sending onboarding; the three checks in the
    operations.md "Before you deploy this the first time" list.
16. **Developer surfaces:** `usage` fields → `void email status` → deploy
    output → dashboard section. Each is independently shippable.
17. **Mode B:** (a) the wrangler catalog bump to ≥ 4.113 as its own PR;
    (b) one staging session for the two unexecuted writes (subdomain
    routing POST, subaddressing PATCH) with the session bearer; (c) the
    feature PR — runtime items 1–5, `cli/email-cloudflare.ts`, the 3b-ii
    step, the `addresses` pin, the refusals as tests — per the build list
    under "One keystroke, measured".
18. **Mode C:** the three code sites and the config surface; the docs pass;
    the environment-level admin page.
19. **Custom domains on Cloudflare:** the four probes on a test zone first;
    then `email_domains` + token storage, the REST send path in the proxy,
    the bridge recognition in the router and the no-prefix dispatch (shared
    with Mode B item 4), the `void email domain` commands, the dashboard
    rows. Ships after 16 and 17, since it reuses both.

## Known gaps

_(added 2026-09-11)_ Defects found while designing the lifecycle. The first
group is ours to fix inside the current PRs, because the claim or the code is
ours; the second is tracked follow-up work.

| Where                                               | Defect                                                                                                                                                | Fix in                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `void dev`                                          | `sendEmail` without `from` returns `INVALID_FROM` — the slug and domain bindings are not injected in dev, and the shipped prompt promises the default | void#160 (decision 5) |
| `docs/guide/email.md`, `getting-started-prompt.txt` | name `mail.void.cloud` as if it were the only possible domain                                                                                         | void#160              |
| `meta/operations.md`                                | said the mail zone needs registration and nameservers; said the slug backfill is a one-time pass; omitted the 200-destination cap and Email Sending   | done, `814423a0`      |

Follow-ups: the Mode B runtime (six items), Mode B detection and prompt,
`void email status` and the `usage` fields, the dashboard Email section, dev
injection and typing of the two bindings, the environment-level admin page
and setup script, the three Mode C code sites, and the proxy's bounce text
for a framework-type project (the routing blob already carries `type`;
`email-router.ts` never reads it, so the bounce says "needs redeploy" to a
user for whom redeploying cannot help).

## Open decisions

_(added 2026-09-11)_ Recommendations are the author's; the decision is the
owner's.

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
6. **Custom domains: does our recipient allowlist still gate sends from a
   customer's own domain?** Recommended: no — Cloudflare's gate is lifted by
   their onboarding and the reputation is theirs; keep the burst cap and the
   kill switch, which protect us.
7. **Custom domains: auto-complete the bridge verification** by fetching the
   link Cloudflare mails to our router, against a pinned sender and link
   host (recommended once probe 2 pins the format), **or surface the link**
   in `void email domain status` for the developer to click (the safe first
   version).
8. **Ask Cloudflare for an OAuth client** (the mechanism behind
   `wrangler login`), so a custom domain is one **Allow** click with no
   token to paste — see [If Void had a Cloudflare OAuth client](#if-void-had-a-cloudflare-oauth-client).
   Not self-service; a partner ask. Recommended to ask, not to wait — the
   three-click template link ships first either way, and stays as the
   narrow-scope option.
9. – 13. **Mode B one-keystroke flow** — domain input, apex path, the
   session-bearer bridge, two projects on one zone, ownership of a
   hand-written `addresses` array. Listed with recommendations under
   [Decisions handed back](#decisions-handed-back).

## Open questions

_(added 2026-09-11)_ Only a live probe settles these.

- Whether `POST /zones/{z}/email/routing/dns` with `name: "mail.example.com"`
  enables routing on a subdomain. The OpenAPI body has the `name` field
  ("Domain of your zone", not deprecated) and a Support quote in
  `terraform-provider-cloudflare#5890` says it does; nobody has executed it.
  `wrangler email routing enable` calls the deprecated `…/routing/enable`.
- Which token permission group the Email Sending subdomain endpoints accept.
  The OpenAPI schema lists none. The wrangler OAuth scope
  `email_sending (write)` is what `wrangler email sending enable` uses;
  the enable itself was not run here. `GET /accounts/{a}/email/sending/zones`
  answered `401 / 2036 Unauthorized` on an account with no onboarded
  sending domain (plan unread) and `200` on two accounts with one — the
  endpoint and the code are in neither the schema nor the docs.
- Whether `mail.staging.void.cloud`, two labels deep, is accepted by the
  subdomain form. The docs show one-label examples only.
- The eight custom-domain probes listed under
  [Probes before building](#probes-before-building).

## Future Work

Things we deliberately did not build. Listed for context, not as a roadmap commitment — each will only get built if real usage shows the demand.

### Provider abstraction for domains not on Cloudflare

_(narrowed 2026-09-11 — domains on a Cloudflare zone are covered by [Custom domains on Cloudflare](#custom-domains-on-cloudflare).)_ If sending from a domain whose DNS is elsewhere becomes a frequent ask, the cleanest path is a thin wrapper over Resend / SES / Postmark. Providers sign with DKIM, so verification is just TXT records on the user's existing DNS — no NS delegation, no CF zone ownership, no second `void domain add`-shaped flow. Sender stays at the apex.

Until then: users install the provider's SDK directly in their handler. Three lines. No platform involvement, no wrapper that has to track API changes.

```ts
// void.config.ts
export default defineConfig({
  email: {
    provider: 'resend', // | "ses" | "postmark" | "cloudflare" (default — shared mail.void.cloud)
  },
});
```

Per-domain setup flow:

1. User runs `void email add-sender noreply@acme.com`
2. Platform calls the provider's API to register the domain; provider returns DKIM/SPF/DMARC TXT records
3. CLI prints the records for the user to add to their DNS
4. `void email status noreply@acme.com` polls for verification
5. Once verified, the address joins the project's `email_senders` table — typed-sender codegen surfaces it

Runtime: `sendEmail` dispatches to the configured provider; CF native (`mail.void.cloud` shared sender) remains the default. Dev inbox works identically regardless of backend. Phase-3 metering and logs continue to work — the proxy is provider-agnostic. Cost passthrough (e.g. Resend at $20/50k) needs a billing model; product decision when this scopes.

### Component templating

- Convention: `emails/<name>.{tsx,vue,svelte,solid}` — adapter-aware, mirrors how pages work
- Build: render at request time to inlined HTML + plain-text via a lightweight HTML-to-text pass; cache rendered output keyed by props hash
- API: `await sendEmail({ template: WelcomeEmail, props: { name } })` — props typed from the template's component signature
- `void email preview` CLI: dev server at `http://localhost:5174/__emails__/` — lists templates, prop-form input, hot reload
- React Email / `@react-email/components` is the leading prior art

### Typed verified senders

Codegen queries the platform API for the project's verified senders + Email Routing zones, generates `.void/email.d.ts`:

```ts
declare module 'void/email' {
  type VerifiedSender = 'noreply@acme.dev' | 'support@acme.dev' | '<slug>+noreply@mail.void.cloud';

  interface SendEmailOptions {
    from: VerifiedSender | { email: VerifiedSender; name?: string };
  }
}
```

Surfaces "you can't send from this address yet" as a TypeScript error at edit time, not a runtime `INVALID_FROM`.

### Bounce handling

- Hard bounces from CF aren't delivered to Email Workers today (CF returns to the sending MTA)
- For provider-backed sending, bounces arrive via webhooks — wire them into a `email/_bounce.ts` convention for handler-side suppression list management
- For CF-native sending, bounces remain a gap — documented honestly

### Other follow-ups

- Analytics Engine wiring for persistent delivery logs (currently `void email logs` returns `pending: true`; tail-only)
- Auto abuse detection / reputation alerting (currently only manual suspend toggle)
- Dev-inbox round-trip UI (deliver-to-local-handler button, paste-`.eml` form)

## References

- [`0047-email.md`](./0047-email.md) — the deferred Resend design, preserved for context
- Cloudflare Email Workers docs: `send_email` binding, Email Routing, `EmailMessage`, `email()` export
- workerd RPC types: `types/defines/rpc.d.ts` (BaseType allowlist), `types/defines/wfp.d.ts` (DispatchNamespace), `types/defines/email.d.ts` (ForwardableEmailMessage)
- workerd RPC implementation: `src/workerd/api/worker-rpc.c++`, `src/workerd/jsg/ser.c++`, `src/workerd/io/worker-interface.capnp`
- `postal-mime` — inbound parser
- `runtime/email/mime.ts` — outbound MIME builder (own implementation; `mimetext` was the original plan)
- `react-email` / `@react-email/components` — templating prior art (future work)
- `packages/void/src/runtime/env.ts:70` — `requireRuntimeBinding` shared helper
- `packages/void/src/inference/walk.ts:6-103` — existing binding inference pattern
- `packages/void/src/cli/wrangler.ts:179-244` — existing wrangler-sync pattern
- `platform/packages/proxy/src/*` — AI proxy + unified `__VOID_PROXY` pattern that this design extends
- `platform/packages/api/src/admin/routes/deployments.tsx` — admin page pattern this design follows

Evidence for the 2026-09-11 sections (framework paths under
`packages/void/src`; platform paths under `platform/packages/`):

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
  `platform/packages/dashboard/pages/projects/[id].tsx` has no email section;
  `routes/email.ts:77-84` returns no domain; `codegen/env-types.ts` does not
  type the bindings; `index.ts` / `plugin-*.ts` do not inject them in dev;
  `runtime/email.ts:441-447` returns `INVALID_FROM` before the inbox at `:493`.
- Mode C blockers: `platform/packages/api/src/email/send-verification.ts:76-95`,
  `platform/packages/api/src/email.ts:1`, `platform/packages/api/wrangler.jsonc:152`.
- Slug mirror self-heal: `platform/packages/api/src/index.ts:585-600` inside the hourly
  rollover.
- Admin patterns: `admin/routes/signup-control.tsx`, `admin/routes/system.tsx:140-178`,
  `admin/views/dashboard.tsx:49-86`.
- Cloudflare docs: Email Routing subdomains (dashboard flow); send bindings
  ("the sender address must always belong to a domain you have onboarded");
  limits ("Destination addresses per account: 200 … shared across all
  domains"; "Before you onboard a sending domain, you can send emails only to
  verified destination addresses"); catch-all `PUT …/rules/catch_all` with
  `{ type: "worker", value: ["<name>"] }`; local inbound trigger
  `POST /cdn-cgi/local/email`.
- Token template link: Cloudflare docs "API token template URLs"
  (`fundamentals/api/how-to/account-owned-token-template/`) — user and
  account URL formats, `[{ key, type }]` encoding, "only pre-fill the token
  creation form". Key names beyond the documented table:
  `Cloudflare-Mining/Cloudflare-Datamining`
  `data/account/token_permission_groups_dash.json` (labels
  `email_routing_rule_write`, `email_routing_address_write`,
  `zone_settings_write`, …), `sendmebits/ghostmail-ios` README
  (`email_routing_address`, `email_routing_rule`), `erxes/erxes`
  `MailConfigUpdate.tsx` (`email_sending`, `email_routing_rule`),
  `Cloudflare-Mining/Cloudflare-Datamining` `data/types/src/api/apiToken.ts`
  (`ApiTokensAdhocTemplate { permissionGroupKeys, accountId?, mode?, zoneId? }`).
  Mode B deep research (2026-09-11, 16 agents, read-only): wrangler 4.107 /
  4.125 / 4.130 `wrangler-dist/cli.js` (`authTokenCommand` stable since 4.57.0
  #11682; keyring opt-in `wantsKeyring = envOverride ?? isKeyringEnabled() ?? false`;
  `shouldLogToDisk` + `WRANGLER_WRITE_LOGS`; `applyEmailRoutingAddresses`,
  `fetchEmailRoutingPlan`, `isNonInteractiveOrCI`), workers-sdk
  `packages/wrangler/CHANGELOG.md` 4.112.0 #14470 / 4.113.0 #14471,
  `packages/wrangler/src/email-routing/{client,enable,dns-get}.ts`, docs PR
  cloudflare-docs#31772 (unpublished `addresses` page: "Catch-all entries
  support apex domains only"), `cloudflare/api-schemas` `openapi.json`
  (`email_email_setting_dns_request_body.name`; GET `?subdomain=` deprecated
  2026-09; plan operation `x-forge-hidden`; `email_email_setting_status`
  enum; sending 409 codes), measured reads with the session bearer on
  three accounts (`support_subaddress: false` on every zone; `401 / 2036`
  on `…/email/sending/zones`), `@cloudflare/vite-plugin` 1.43.0 `dist/index.mjs`
  (config customizer passes unknown keys through — reproduced with a scratch
  build), framework `cli/deploy.ts:3729-3865` (slot 3b-ii, `--provision` CI
  gate), `cli/preset.ts:238` (`resolveWranglerArgv`).
  Paste-back pattern: `orange-framework/orange-js` `packages/cli/src/cf-auth.ts`,
  `cloudflare/deploy.workers.cloudflare.com` `configure-account.js`.
  Email Sending REST errors: `email-service/api/send-emails/rest-api/`
  (`10103 bad_token_type`). OAuth: wrangler 4.125 `wrangler-dist/cli.js`
  (client `54d11594-…`, `dash.cloudflare.com/oauth2/{auth,token,revoke}`,
  redirect `localhost:8976/oauth/callback`, scope catalogue incl.
  `email_routing:write`, `email_sending:write`); third-party reuse found by
  code search for that client id (`partykit/partykit`
  `cf-auth/auth-variables.ts`, `every-app/every-app`
  `cli/src/lib/cloudflare/auth.ts`); Cloudflare Apps discontinuation notice
  (2024-08-31); Tenant docs `tenant/get-started/` ("after you sign your
  partner agreement"). `GET /user/tokens/permission_groups` needs
  `API Tokens: Read`; none of our stored tokens has it, so the dump stands in.
- Compatibility date: workerd 1.20260701.1 via Miniflare; a
  `WorkerEntrypoint` subclass returns 200 at `2021-11-03` and `2024-01-01`
  with no flags.
- Custom domains: rule action `value` is a bare worker name (`maxItems: 1`,
  no account field) — no cross-account path; "Forward actions require
  exactly one verified destination address"; forwarding applies SRS and an
  ARC seal and "The `From:` header of the message is not modified" (`To:`
  not stated); `POST /accounts/{id}/email/sending/send_raw` takes `from`,
  `recipients`, `mime_message` and accepts an API token with "Email Sending:
  Edit"; `POST /zones/{z}/email/sending/subdomains` gives a subdomain its
  own `dkim_selector` and `return_path_domain`; Cloudflare subdomain setup is
  Enterprise-only; API tokens can be zone-scoped and carry `expires_on`.
