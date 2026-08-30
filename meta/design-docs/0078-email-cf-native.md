---
title: Email — CF-Native (outbound, inbound, shared sender)
status: draft
created: 2026-04-24
updated: 2026-08-30
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
> - Token helper `packages/api/src/auth/confirm-token.ts` —
>   `base64url(JSON) + '.' + base64url(HMAC-SHA256)` carrying
>   `(v, pid, did, addr, iat, exp)` with 24h TTL. Single-use is enforced
>   by DB state (clicking flips status; re-clicks find an
>   already-verified row and return idempotent success).
> - Platform email helper `packages/api/src/email/send-verification.ts`
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
>   doesn't override the platform gate.
> - Per-project rate-limit on `POST /destinations`: 5/minute and
>   50/day in `email-add-rate:<projectId>:*` KV counters, with the
>   same NaN-poison defense as the proxy's send counter. Blocks Mallory
>   from spamming reverify mail.
> - `autoAddOwnerDestination` is unchanged in behavior — by definition
>   the address IS the owner's email, so it threads
>   `verification_source='cf'` explicitly (Option C every time).
>
> Tests cover each path: Option C trust, Option B platform-pending +
> confirmation email dispatch, refresh-skip, confirm-endpoint happy
> path, expired/tampered/unknown-id failure modes, idempotent re-click,
> rate-limit, and the migration default.

# Email — CF-Native (outbound, inbound, shared sender)

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

**Platform (`packages/proxy`, `packages/api`):**

- `mail.void.cloud` shared sender zone (one-time CF Email Routing setup)
- Inbound router worker (`packages/proxy/src/email-router.ts`) — receives all mail at `mail.void.cloud`, parses `<slug>+<tag>`, dispatches into the user worker via WfP RPC
- `/email/check-quota`, `/email/log-send`, `/email/log-recv` proxy endpoints with KV-backed monthly counters, per-minute burst cap, and suspend kill-switch
- `VOID_PROJECT_SLUG` env injection at deploy
- **Verified destinations** — `email_destinations` table per project; `POST /projects/:id/email/destinations` triggers the CF verification email; per-project allowlist injected as `allowed_destination_addresses` on the worker's `send_email` binding at deploy time. Project owner's email is auto-added on project create.
- Admin UI page (`packages/api/src/admin/routes/email.tsx`): per-project usage, suspend toggle, monthly + burst limit overrides, counter reset, destinations list with add/remove
- API routes: `GET /projects/:id/email/{usage,logs}`, `GET|POST|DELETE /projects/:id/email/destinations[/:id]`

## Non-Goals

- **Custom-domain email** — see [Why custom domains aren't included](#why-custom-domains-arent-included).
- **Provider abstraction (Resend / SES / Postmark) wrapper.** Users can call those SDKs directly today; the wrapper would not earn its keep without concrete demand. See [Future work](#future-work) for the trigger conditions.
- **Templating** (React Email / Vue components / MJML).
- **Typed verified-sender codegen.**
- **User-facing dashboard pages.** Dashboard work is currently deferred per `CLAUDE.md`; the admin UI covers operational observability. User-facing pages land when dashboard work resumes.
- **Bounce handling.** CF doesn't deliver bounces to Email Workers; needs VERP or provider-side webhooks.
- **Cost-passthrough billing for outbound.** CF email is free at our volumes.
- **Programmatic Email Routing _rule_ creation.** The shared `mail.void.cloud` catch-all is a one-time setup; per-project routing rules aren't needed.

## Cloudflare's Constraints (Be Honest)

The `send_email` binding is **not a general transactional-email sender**:

- **From-domain:** must be a zone the user owns, with Email Routing enabled. DKIM/SPF/DMARC are set up automatically when Email Routing is enabled.
- **To-address restrictions:**
  - `destination_address: "x@example.com"` — can only send to that one verified address
  - `allowed_destination_addresses: [...]` — can only send to those verified addresses
  - **Neither set** — can send to any address that has been verified as a destination in the sender's Email Routing account, or to addresses on domains that accept mail via CF Email Routing. You cannot yet spray arbitrary transactional mail to cold recipients the way Resend/SES allows.
- **Practical implication:** CF-native outbound fits "app-internal" use cases well (notifications to the account owner, ops alerts, forms piped to a verified inbox, reply-by-email flows on top of inbound). It does **not** yet fit "SaaS sending receipts to every end-user" without additional work — that's the future-work provider abstraction.

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

When `from` is omitted, the framework reads `env.VOID_PROJECT_SLUG` (injected at deploy by the platform) and substitutes `<slug>+noreply@mail.void.cloud`. Explicit `from` values pass through unchanged. If the slug isn't injected (local dev without the platform, tests), the call returns `INVALID_FROM` with a clear message.

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
binding (see `packages/proxy/wrangler.jsonc`).

#### MIME construction

Uses [`mimetext`](https://www.npmjs.com/package/mimetext) — small, edge-friendly, popular in the CF Email Workers ecosystem. Wrapped internally in `runtime/email/mime.ts` so we can swap later without breaking the public API. Attachment totals are pre-checked against CF's ~10MB base64-inflated cap; oversize payloads surface as `MIME_ERROR` with measured-vs-allowed bytes rather than a generic upstream failure.

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
  → email-router worker (packages/proxy/src/email-router.ts)
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

One-time platform infrastructure (see [`meta/operations.md`](../operations.md#email-mailvoidcloud) for the runbook):

- `mail.void.cloud` registered as a CF zone in the platform account, Email Routing enabled
- DKIM/SPF/DMARC auto-configured by CF on enable
- Catch-all routing rule on the zone → `void-proxy` worker (the proxy's `email()` export is bound by the `email-router.ts` module)
- Standard `pnpm run deploy` ships the proxy with the new code

Per-project setup: nothing. Every project deployed with the new framework codegen is automatically reachable. Existing pre-`WorkerEntrypoint` deployments will hit the "no email handler" reject path; they need to redeploy.

**Reputation pooling.** All `*.void.app` projects share `mail.void.cloud`'s sender reputation. Mitigations:

- Conservative default outbound quotas
- Burst-rate cap per project (sliding-window in proxy)
- Manual suspend kill-switch in the admin UI

Per-project DKIM signing isn't possible without per-project zones, so reputation pooling is unavoidable here. Custom-domain email (future work) gives projects with reputation-sensitive sending a clean path off shared.

#### Inbound router worker (`packages/proxy/src/email-router.ts`)

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

Three endpoints in `packages/proxy/src/email.ts`:

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
- **CF API client** — `packages/api/src/provisioning/email-routing.ts` wraps `POST/GET/DELETE /accounts/:id/email/routing/addresses`.
- **API routes** — `GET|POST|DELETE /projects/:id/email/destinations[/:id]`. POST triggers CF to email the recipient with a verification link; GET refreshes status from CF for any rows still `pending`.
- **Auto-verify project owner** — `packages/api/src/routes/projects.ts` calls `addDestination(user.email)` when a project is created (via `ctx.waitUntil`, non-blocking). The owner gets the verification email in their GitHub-OAuth-linked inbox; one click and their project can send to itself out of the box.
- **Per-project allowlist enforcement at deploy** — `packages/api/src/routes/deploy.ts` reads `email_destinations` where `status='verified'` and emits `{ type: 'send_email', name: 'SEND_EMAIL', allowed_destination_addresses: [...] }` on the worker upload. CF enforces at the binding level — even though destinations are account-wide on CF's side, projects can only send to their own declared addresses.
- **Cross-project safety on delete** — destinations are CF account-wide; before calling `deleteDestination` we check `countProjectsUsingDestination` and only remove from CF if no other project references the same `cf_destination_id`.

The platform/team never opens the CF dashboard. The recipient (the person receiving the verification email) is the only human in the loop, and they only click a link in their own inbox.

#### Admin UI — `packages/api/src/admin/routes/email.tsx`

Per-project page at `/admin/email/:projectId`:

- Usage summary (sent / received / limit / burst cap / status) for the current month
- Suspend toggle (`email-suspended:<projectId>`)
- "Set monthly limit" + "Set burst limit" forms (`email-limit:*` / `email-burst-limit:*` overrides)
- "Reset counter" button for the current month
- Verified-destinations table with add / remove

Mirrors the existing admin route patterns (e.g. `packages/api/src/admin/routes/deployments.tsx`). Direct KV/DB reads + writes; no API layer between admin and storage. User-facing dashboard pages are deferred to whenever broader dashboard work resumes.

#### CLI — `void email`

```
void email usage                      # monthly outbound/inbound counts + quota
void email logs [--limit N]           # recent email delivery activity
void email destinations               # list verified recipients
void email allow <address>            # add recipient + trigger CF verification
void email disallow <address>         # remove recipient
```

Hits the API routes above. Output formatted for the terminal — useful for power users debugging "did my mail go out?" or wiring a new recipient without an admin trip.

## Why custom domains aren't included

The current `void domain add` flow uses CF for SaaS / Custom Hostnames — CNAME-based, with the user's DNS staying at their existing provider. That model **cannot support Email Routing** because:

- Email Routing requires MX records on the receiving domain pointing at CF's MTA
- For those MX records to deliver into a CF Email Worker, the domain must be a CF-hosted zone with Email Routing enabled
- The user's domain isn't a CF zone — they only CNAMEd it
- RFC 2181 also forbids CNAME and MX coexisting at the same name

Adding custom-domain email here would mean building one of:

- **NS delegation flow** (full or subdomain) — entirely greenfield infrastructure. No NS handling exists in `packages/api` today; only `createCustomHostname` for CF for SaaS. Adds a second `void domain add`-shaped flow with status polling, zone creation, etc.
- **BYO CF account** — user creates a scoped CF API token, pastes it in. Violates the "users never touch CF" premise.
- **Self-hosted SMTP relay** — huge work; reinvents what CF Email Routing already gives us for free.

For now: users who need apex-domain sending (`noreply@acme.com` not `<slug>+noreply@mail.void.cloud`) install a third-party SDK directly in their handler — Resend, SES, Postmark, etc. ~3 lines of code. No platform involvement.

If usage shows enough demand for a first-class apex-domain story, the cleanest implementation is a thin provider wrapper that signs outbound with DKIM (TXT records on the user's existing DNS, no NS delegation, no CF zone ownership). See [Future work](#future-work).

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

packages/api/src/                         (platform)
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

packages/proxy/src/                       (platform)
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
6. **Platform: `VOID_PROJECT_SLUG` injection.** `packages/api/src/provisioning/provision.ts` adds the plain-text binding alongside the existing proxy bindings.
7. **Platform: proxy email handlers + router worker.** `/email/check-quota`, `/log-send`, `/log-recv` in `packages/proxy/src/email.ts` (with monthly + per-minute burst caps + suspend kill-switch); `email-router.ts` wired as the proxy's `email()` export.
8. **Platform: destinations schema + CF API client + API routes.** `email_destinations` table; `provisioning/email-routing.ts`; `GET|POST|DELETE /projects/:id/email/destinations[/:id]`. Auto-add project owner's email on project create.
9. **Platform: `send_email` binding emit at deploy.** `routes/deploy.ts` reads verified destinations and emits `{ type: 'send_email', allowed_destination_addresses: [...] }` per project.
10. **Platform: API + admin UI.** `GET /projects/:id/email/{usage,logs}` + `admin/routes/email.tsx` (usage, suspend, limits, destinations).
11. **Framework: `void email usage|logs|destinations|allow|disallow` CLI.**
12. **Ops: `mail.void.cloud` zone setup.** Register zone in CF, enable Email Routing, add catch-all rule pointing at the proxy worker. One-time human action — see [`meta/operations.md`](../operations.md#email-mailvoidcloud).
13. **Deploy.** `pnpm run deploy:staging` first to validate the dispatch path against real WfP runtime; then production.
14. **Tag release.**

Steps 1–5 + 11 ship in the framework via the normal release. Steps 6–10 are platform changes. Step 12 is the only ops gate before production sending works.

## Future Work

Things we deliberately did not build. Listed for context, not as a roadmap commitment — each will only get built if real usage shows the demand.

### Provider abstraction + custom-domain email

If apex-domain sending (`noreply@acme.com`) becomes a frequent ask, the cleanest path is a thin wrapper over Resend / SES / Postmark. Providers sign with DKIM, so verification is just TXT records on the user's existing DNS — no NS delegation, no CF zone ownership, no second `void domain add`-shaped flow. Sender stays at the apex.

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
- `mimetext` — outbound MIME builder
- `react-email` / `@react-email/components` — templating prior art (future work)
- `packages/void/src/runtime/env.ts:70` — `requireRuntimeBinding` shared helper
- `packages/void/src/inference/walk.ts:6-103` — existing binding inference pattern
- `packages/void/src/cli/wrangler.ts:179-244` — existing wrangler-sync pattern
- `packages/proxy/src/*` — AI proxy + unified `__VOID_PROXY` pattern that this design extends
- `packages/api/src/admin/routes/deployments.tsx` — admin page pattern this design follows
