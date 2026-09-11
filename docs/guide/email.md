---
outline: deep
---

# Email

Send transactional email from your app via [Cloudflare's `send_email` binding](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/). Import `sendEmail` from `void/email` and Void handles MIME construction, binding inference, and a local-dev inbox.

```ts
import { sendEmail } from 'void/email';

const result = await sendEmail({
  from: 'Acme <acme+noreply@mail.void.cloud>',
  to: 'user@example.com',
  subject: 'Welcome',
  text: 'Thanks for signing up!',
  // html: '<p>Thanks for signing up!</p>', // optional — sent as multipart/alternative when paired with text
});

if (!result.ok) {
  if ('error' in result) {
    // Nothing was sent — the whole call failed before delivery.
    console.error(result.error.code, result.error.message);
  } else {
    // Some recipients failed. `deliveries` says which.
    for (const d of result.deliveries.filter((d) => !d.ok)) {
      console.error(d.recipient, d.error.code, d.error.message);
    }
  }
}
```

Both branches are real. `result.error` exists only on the first, so reading it
unconditionally throws on the second — and the second is the one a new project
hits first, because a recipient you have not verified yet fails per-recipient.

## Setup

Zero config. Every Void project ships with:

- **Sender** — `<your-slug>+noreply@mail.void.cloud`. Used as the default `from` if you omit it. The platform owns the zone with Email Routing + DKIM + SPF + DMARC set up; you do nothing.
- **No worker binding to add** — outbound mail is sent by the Void proxy, which holds the
  platform `send_email` binding. Your worker never gets one, so there is nothing to configure.

That's it. `sendEmail({ to: '...', subject: '...', text: '...' })` works on first deploy.

::: warning Not on `void deploy --backend cloudflare` yet
Email is a platform feature today. On a deploy to your own Cloudflare account, `sendEmail` returns `BINDING_MISSING`, and `email/` handlers are not wired: the deploy succeeds, but no Email Routing rule points at your worker, and a handler's `setReject` / `forward` / `reply` actions are not applied even if you add a rule yourself. Email setup on your own account is a follow-up — planned as one prompt on the first deploy, driven by your `wrangler login` session. Until then, deploy with `void deploy`.
:::

## Adding recipients

Cloudflare's `send_email` binding only delivers to addresses you've registered as recipients. Add them with the CLI:

```sh
void email allow user@acme.com
```

Cloudflare emails the recipient with a verification link. Once they click it, you can send to that address from your project. List the project's recipients:

```sh
void email destinations
```

The project owner's email (the GitHub address you signed up with) is added automatically when the project is created — so sending from your project to yourself works out of the box.

::: warning When this is the right fit
The shared sender is great for: ops alerts to the team, notifications to the project owner, reply-by-email flows on top of inbound, internal/app-internal mail.

For SaaS sending to arbitrary end-users (every signup gets a welcome email), the per-recipient verification model doesn't fit. Use [Resend](https://resend.com), [Postmark](https://postmarkapp.com), or [SES](https://aws.amazon.com/ses/) directly — install their SDK and call it from your handler. We may formalize this with a provider abstraction later if there is demand; until then, calling the SDK directly is simple enough that the wrapper would not earn its keep.
:::

## Options

| Option        | Type                         | Notes                                                            |
| ------------- | ---------------------------- | ---------------------------------------------------------------- |
| `from`        | `string \| { email, name? }` | Optional. Pinned to the project sender — see below.              |
| `to`          | `Address \| Address[]`       | Required. One or more recipients.                                |
| `subject`     | `string`                     | Required. UTF-8 supported (encoded as RFC 2047).                 |
| `text`        | `string`                     | At least one of `text` / `html` is required.                     |
| `html`        | `string`                     | Sent as `multipart/alternative` if both are provided.            |
| `replyTo`     | `Address`                    | Optional `Reply-To` header.                                      |
| `cc`, `bcc`   | `Address \| Address[]`       | Optional. Each recipient is sent its own message envelope.       |
| `headers`     | `Record<string, string>`     | Custom headers; reserved headers (From, Date, etc.) are ignored. |
| `attachments` | `Attachment[]`               | See [Attachments](#attachments).                                 |

`Address` accepts either a string (`"hello@acme.dev"` or `"Name <hello@acme.dev>"`) or an object (`{ email, name? }`). Display names with non-ASCII characters are RFC 2047 encoded automatically.

The sender is pinned to your project. `from` must be your project's own platform address — `<project-slug>@mail.void.cloud` or `<project-slug>+<tag>@mail.void.cloud`, optionally with a display name (`Acme <acme+noreply@mail.void.cloud>`). Anything else is rejected with `INVALID_FROM`. Omit `from` and Void fills in `<project-slug>+noreply@mail.void.cloud` for you. Sending from your own domain is not supported yet.

## Attachments

```ts
await sendEmail({
  from: 'Acme <acme+noreply@mail.void.cloud>',
  to: 'user@example.com',
  subject: 'Your receipt',
  text: 'Receipt attached.',
  attachments: [
    {
      filename: 'receipt.pdf',
      content: pdfBytes, // string | Uint8Array | ArrayBuffer | Blob
      contentType: 'application/pdf',
    },
  ],
});
```

For inline images (e.g. logos referenced from HTML), set `disposition: 'inline'` and `contentId`:

```ts
await sendEmail({
  from: 'Acme <acme+noreply@mail.void.cloud>',
  to: 'user@example.com',
  subject: 'Hello',
  html: '<img src="cid:logo" alt="Acme">',
  attachments: [
    {
      filename: 'logo.png',
      content: logoBytes,
      contentType: 'image/png',
      contentId: 'logo',
      disposition: 'inline',
    },
  ],
});
```

`contentType` is inferred from the filename extension when omitted. Total message size (after base64 expansion) is capped at 10 MB to match Cloudflare's limit; oversize payloads return `MIME_ERROR` instead of failing upstream.

## Result and errors

`sendEmail` returns a discriminated union — there are no thrown errors:

```ts
interface SendEmailDelivery {
  recipient: string; // the envelope `To` used for this CF send
  messageId: string;
}

type SendEmailRecipientResult =
  | { recipient: string; ok: true; messageId: string }
  | { recipient: string; ok: false; error: SendEmailError };

type SendEmailResult =
  | { ok: true; ids: SendEmailDelivery[] }
  | { ok: false; error: SendEmailError } // pre-flight failure
  | { ok: false; deliveries: SendEmailRecipientResult[] }; // mid-batch failure
```

`ids` carries one entry per envelope send. Because the CF `EmailMessage` envelope is single-recipient, multi-recipient calls (`to`/`cc`/`bcc`) fan out into one CF send per address, each with its own messageId.

There are three discriminated cases:

- **All success** (`ok: true`) — every recipient delivered.
- **Pre-flight failure** (`ok: false`, has `error`) — validation / MIME / missing binding rejected the call before any sends were attempted. Retrying the whole call is safe.
- **Mid-batch failure** (`ok: false`, has `deliveries`) — sends were attempted and some failed. Each recipient has its own per-recipient outcome (`ok: true` with `messageId`, or `ok: false` with `error`). Retry only recipients with `ok: false` — re-sending to ones with `ok: true` will deliver duplicates.

```ts
const result = await sendEmail({ to: ['a@x.dev', 'b@x.dev', 'c@x.dev'], ... });
if (result.ok) {
  // every recipient delivered
} else if ('error' in result) {
  // pre-flight failure — retry the whole call
} else {
  // mid-batch failure — retry only the failed recipients
  const toRetry = result.deliveries.filter((d) => !d.ok).map((d) => d.recipient);
}
```

Error codes:

| Code                     | Meaning                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `BINDING_MISSING`        | No email transport: a `--backend cloudflare` deploy, a Class B/C dev server, or the platform proxy is unavailable. |
| `INVALID_FROM`           | `from` was missing, malformed, or not the project sender.                                                          |
| `INVALID_TO`             | `to` was empty or contained an invalid address.                                                                    |
| `UNVERIFIED_DESTINATION` | Cloudflare rejected the recipient as unverified.                                                                   |
| `MIME_ERROR`             | Failed to build the MIME message (oversize attachments, malformed input).                                          |
| `QUOTA_EXCEEDED`         | Platform quota for outbound email reached. Retry next billing period.                                              |
| `UPSTREAM_ERROR`         | Other binding failure; the original error is attached as `error.cause`.                                            |

Which branch carries the code depends on when the send failed.
`BINDING_MISSING`, `INVALID_FROM`, `INVALID_TO` and `MIME_ERROR` are pre-flight,
so they arrive as a top-level `result.error`. `UNVERIFIED_DESTINATION` is always
per-recipient and therefore only ever appears inside `result.deliveries` —
never as `result.error`. `QUOTA_EXCEEDED` and `UPSTREAM_ERROR` can arrive either
way. Narrow with `'error' in result` rather than assuming.

## Local development

During `void dev`, sends are captured to an in-memory inbox instead of going to Cloudflare. Browse them at:

```
http://localhost:5173/__void/inbox
```

The inbox shows a list view with subject, sender, recipient, and timestamp. Click a message to see headers, attachments, and an HTML preview rendered in a sandboxed iframe. Each message can be downloaded as a `.eml` file.

The buffer holds the most recent 100 messages and survives HMR but not a full server restart. No disk persistence.

Under the hood, your code runs in workerd (a separate process from the Vite dev server), so `sendEmail` hands each captured message to the dev server over the worker's `assets` binding, which Vite wires back into its own middleware. Void apps always have that binding, and so do apps built on a Class A framework (TanStack Start, React Router) once their wrangler config declares one.

The dev inbox is **not** available under a Class B or C framework — SvelteKit, Nuxt, Analog, Astro. Those adapters own their own dev server and worker build, so Void never installs the Cloudflare Vite plugin for them and has nowhere to register the inbox. Declaring an `assets` binding does not help: SvelteKit, Nuxt and Analog do not run your code in a workerd instance fronted by Vite at all, so there is no loopback to bind to. Sends from those apps return `BINDING_MISSING`. Use `createEmailTestHarness` from `void/email/testing` instead, which captures in-process and works everywhere. When the inbox is configured but unreachable, `sendEmail` returns `UPSTREAM_ERROR` — nothing is captured and nothing is sent.

To bypass the inbox for a single send during dev (e.g. to verify real delivery against a verified address), pass `sendInDev: true`:

```ts
await sendEmail({
  from: 'acme+noreply@mail.void.cloud',
  to: 'verified@acme.dev',
  subject: 'Real send during dev',
  text: 'This will hit the binding.',
  sendInDev: true,
});
```

## Testing

Use the test harness to assert on outgoing messages without mocking the binding:

```ts
import { describe, it, expect } from 'vitest';
import { sendEmail } from 'void/email';
import { createEmailTestHarness } from 'void/email/testing';

describe('signup flow', () => {
  it('sends a welcome email', async () => {
    const inbox = createEmailTestHarness();

    await sendEmail({
      from: 'acme+noreply@mail.void.cloud',
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi!',
    });

    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].subject).toBe('Welcome');
    inbox.dispose();
  });
});
```

The harness intercepts every `sendEmail` call until `dispose()` is called. `clear()` empties the captured list without releasing the sink.

## Inbound

Inbound mail is a **Void-app-only** feature. Receive it by dropping handlers in the top-level `email/` directory — alongside `crons/` and `queues/`. Void detects them, generates the worker's `email()` export, and dispatches incoming messages by recipient address.

Under a third-party framework — TanStack Start, React Router, SvelteKit, Nuxt, Analog, Astro — Void wires only crons and queues into the framework's own worker entry, so there is nowhere to attach an `email()` export. An `email/` directory in those projects is a build error, not silently dead code. Outbound is unaffected: `sendEmail` is a binding, and it works in every framework.

```ts
// email/_default.ts — fallback for any unmatched recipient
import { defineEmail, parseEmail } from 'void/email';

export default defineEmail(async (message, env, ctx) => {
  const parsed = await parseEmail(message);

  if (parsed.subject?.startsWith('STOP')) {
    message.setReject('Use the unsubscribe link.');
    return;
  }

  await message.forward('archive@example.com');
});
```

The handler receives Cloudflare's native `ForwardableEmailMessage` plus an optional fourth `info` arg with `params` populated for dynamic / tagged route segments:

| Method                        | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `message.setReject(reason)`   | Reject the message — the sender sees the SMTP error. |
| `message.forward(to, hdrs?)`  | Forward to a verified destination address.           |
| `replyEmail(message, opts)`   | Reply with a threaded `In-Reply-To` / `References`.  |
| `message.reply(EmailMessage)` | CF native — bring your own constructed reply.        |
| Returning without action      | Accept the message silently.                         |

`parseEmail(message)` wraps [`postal-mime`](https://www.npmjs.com/package/postal-mime) and returns a structured object with `from`, `to`, `subject`, `text`, `html`, `attachments`, and full `headers`. Call it at most once per message — the underlying stream can only be read once.

### Per-recipient routing

```
email/
  support.ts                — handles support@<your-domain>
  billing.ts                — handles billing@<your-domain>
  support+[ticket].ts       — handles support+ticket-123@... → info.params.ticket = "ticket-123"
  [user].ts                 — dynamic local-part   → info.params.user
  [user]+[tag].ts           — dynamic + subaddress → info.params.user, info.params.tag
  _default.ts               — fallback when no per-address pattern matches
```

Files are matched against the local-part of the `To` address (the portion before `@`), case-insensitive. **Match precedence (most specific wins):**

1. `support+[ticket].ts` (static + tag)
2. `support.ts` (static)
3. `[user]+[tag].ts` (dynamic + tag)
4. `[user].ts` (dynamic)
5. `_default.ts` (fallback)

If nothing matches and there's no `_default.ts`, control returns to Cloudflare and the sender receives a non-delivery report. Nested folders under `email/` are ignored — the recipient is a flat string, not a path.

### Threaded replies

```ts
// email/support+[ticket].ts
import { defineEmail, parseEmail, replyEmail } from 'void/email';

export default defineEmail(async (message, env, ctx, info) => {
  const parsed = await parseEmail(message);
  await ticketStore.append(info!.params.ticket, parsed.text ?? '');

  await replyEmail(message, {
    text: `Got your message on ticket ${info!.params.ticket}.`,
  });
});
```

`replyEmail` builds the reply MIME with `Subject: Re: <original>` (no double-prefix), `In-Reply-To: <Message-ID>`, and a continued `References` chain, then dispatches through the message's `reply()`. Defaults: `to = message.from`, `subject = "Re: <original>"`.

Everything taken from the inbound message is best-effort, because the remote sender controls it. A `Message-ID` or `References` value too long for a header line is dropped rather than threaded. Control characters in the subject become a space, and an ASCII subject too long to fold falls back to a bare `Re:`. The reply is always sent; pass `subject` to control it exactly.

On the platform the `from` default is **not** `message.to`. A reply is sent from
your project's own slug on the platform mail zone — `<slug>+noreply@<domain>` —
built from the `__VOID_PROJECT_SLUG` and `__VOID_EMAIL_DOMAIN` bindings the
platform injects. `replyEmail` throws when the slug is set but the domain is
absent and you omitted `from`, rather than guessing a sender. With no slug at
all — a worker on your own Cloudflare account — the reply is sent from
`message.to`, the address on your own zone the message was delivered to.

::: warning The platform pins the reply sender
You may override `from`, but only with an address on your own slug. The proxy
accepts a reply sender whose local-part before the first `+` equals the slug the
message was delivered to, on the zone it arrived on. Anything else is **dropped
silently** — `replyEmail` still resolves, and the only trace is in the platform's
log stream, not your project's.

This is what stops one project replying as another project's address. Note that
`message.to` is the _stripped_ address (`<tag>@<domain>`), so `from: message.to`
is exactly the shape the pin rejects.
:::

Note the asymmetry with `sendEmail`: `sendEmail` returns an error result and
never throws, while `replyEmail` throws when it cannot determine a sender.

### Configuring inbound delivery

In production, inbound runs on one shared mail facility. The platform routes `<slug>+anything@<mail domain>` to your worker's `email()` export — **there is nothing to configure in the Cloudflare dashboard and no per-project DNS work**. Your handlers are live as soon as the deploy lands.

There is no local inbound trigger yet — `void dev` serves the outbound dev inbox only, so test inbound handlers with `createInboundTestHarness` below.

### Testing inbound handlers

Use `createInboundTestHarness` to run handlers through the real dispatcher with a synthesized message and capture replies / forwards / rejects.

`deliver({ to })` takes the address **as it arrives on the wire**, which is
`<slug>+<tag>@<domain>` — the same form the platform delivers to your worker.
The harness strips the `<slug>+` prefix before matching, exactly as the
generated dispatcher does, so `acme+support+abc-123@acme.dev` is what matches
`email/support+[ticket].ts`. Pass the user-facing `support+abc-123@acme.dev`
and the harness reads `support` as the slug, leaving `abc-123` to match — which
falls through to `_default`.

```ts
import { describe, it, expect } from 'vitest';
import { createInboundTestHarness } from 'void/email/testing';
import support from './email/support+[ticket]';
import defaultHandler from './email/_default';

describe('email handlers', () => {
  it('routes to support+[ticket] and extracts the tag', async () => {
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': support, _default: defaultHandler },
    });
    const result = await harness.deliver({
      from: 'user@example.com',
      to: 'acme+support+abc-123@acme.dev',
      subject: 'Help',
      text: 'I have a problem',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('rejects STOP messages via _default', async () => {
    const harness = createInboundTestHarness({ routes: { _default: defaultHandler } });
    await harness.deliver({
      from: 'user@example.com',
      to: 'acme+unknown@acme.dev',
      subject: 'STOP',
      text: 'bye',
    });
    expect(harness.rejects).toEqual(['Use the unsubscribe link.']);
  });
});
```

The harness uses the same precedence rules as the production dispatcher. Reserved key `_default` mirrors `email/_default.ts`.
