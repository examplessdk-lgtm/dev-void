// void/email — outbound email via the platform proxy or a direct binding.
//
// On the managed platform, user worker code never holds a `send_email`
// binding directly. The framework builds MIME locally, then POSTs to
// `__VOID_PROXY/email/send`. The proxy worker holds the platform-level
// `send_email` binding and enforces per-project quotas, suspend kill-switch,
// and verified-destinations allowlist (mirrored from `email_destinations`
// into KV by the API on every CRUD).
//
// On the developer's own Cloudflare account (`void deploy --platform
// cloudflare`) there is no proxy: the deploy provisions a `send_email`
// binding named `SEND_EMAIL` on the worker itself and the same MIME goes
// straight through `cloudflare:email`, one `EmailMessage` per recipient.
// Transports are tried in order: dev inbox, `SEND_EMAIL`, `__VOID_PROXY`.
//
// In `void dev` (no `__VOID_PROXY`) sends are captured by the dev inbox;
// pass `sendInDev: true` for a single call to bypass. The dev inbox buffer
// lives in the Vite dev server's NODE process while this code runs in
// workerd, so the capture is an explicit HTTP hop over the dev assets
// binding — see `resolveDevInbox` below and `plugin-email-dev-inbox.ts`.

import {
  captureMessage,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  dispatchToSinks,
  hasActiveSink,
  serializeCapturedMessage,
  type CapturedMessage,
} from './email/dev-inbox.ts';
import { buildMime, MimeError, normalizeEmail } from './email/mime.ts';
import type {
  NormalizedEmail,
  SendEmailDelivery,
  SendEmailErrorCode,
  SendEmailError,
  SendEmailOptions,
  SendEmailRecipientResult,
  SendEmailResult,
} from './email/types.ts';
import { getRawRuntimeEnv } from './env-raw.ts';

export type {
  Address,
  Attachment,
  NormalizedEmail,
  SendEmailDelivery,
  SendEmailError,
  SendEmailErrorCode,
  SendEmailOptions,
  SendEmailRecipientResult,
  SendEmailResult,
} from './email/types.ts';

export {
  createMessageProxy,
  defineEmail,
  enactEmailActions,
  isForwardableEmailMessage,
  parseEmail,
  ParseEmailError,
  replyEmail,
} from './email/inbound.ts';
export type {
  EmailAction,
  EmailEnvelope,
  EmailHandler,
  EmailHandlerInfo,
  MessageProxy,
  ParsedEmail,
  ParseEmailErrorCode,
  ReplyEmailOptions,
} from './email/inbound.ts';

// `createEmail` below throws `MimeError`, and `sendEmail` reports its `code`.
// The barrel is the only supported entry point (`package.json` exposes
// `./email` and `./email/testing`, with no wildcard subpath), so the error
// classes have to ship with the functions that throw them.
export { MimeError } from './email/mime.ts';
export type { MimeErrorCode } from './email/mime.ts';

// Slug shape we'll accept when substituting into the default `from`. The
// platform owns slug allocation and validates at create-time, but we don't
// trust the value blindly — a slug containing `@`, `+`, or whitespace
// would corrupt the resulting address. RFC 5321/2 atom char-class
// restricted further to lowercase + digits + hyphen, matching the typical
// project-slug shape.
//
// Length cap: 56 chars. The default `from` we build is
// `<slug>+noreply@<__VOID_EMAIL_DOMAIN>`; the SMTP local-part limit
// (RFC 5321 § 4.5.3.1.1) is 64 octets, and `+noreply` already eats 8.
// Capping the slug at `64 - 8 = 56` keeps the assembled local-part
// within spec. The cap is domain-independent — only the local-part is
// bounded here.
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;

function makeError(code: SendEmailErrorCode, message: string, cause?: unknown): SendEmailError {
  return cause === undefined ? { code, message } : { code, message, cause };
}

// `getRawRuntimeEnv()` throws outside a worker/SSR context. `sendEmail` needs
// graceful degradation in those settings (local Node tools, tests), so resolve
// once via this helper.
function tryGetRawRuntimeEnv(): Record<string, unknown> | undefined {
  try {
    return getRawRuntimeEnv();
  } catch {
    return undefined;
  }
}

function readProjectSlug(): string | undefined {
  const raw = tryGetRawRuntimeEnv()?.__VOID_PROJECT_SLUG;
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  // Defense-in-depth: refuse to substitute an obviously malformed slug
  // into the address. Returning undefined causes the caller to surface
  // `INVALID_FROM` rather than build a corrupt envelope.
  return VALID_SLUG.test(raw) ? raw : undefined;
}

// The platform mail domain for this environment (production uses
// `mail.void.cloud`, staging its own zone). It is injected per
// deployment rather than baked in, so a staging send is not rejected by
// the proxy's sender check. There is deliberately no built-in default:
// silently falling back to the production zone is the bug this binding
// exists to prevent.
function readEmailDomain(): string | undefined {
  const raw = tryGetRawRuntimeEnv()?.__VOID_EMAIL_DOMAIN;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// The project's own default sender, written into the worker's `vars` by
// `void deploy --platform cloudflare` from `email.from` in void.json. It is a
// full address on a zone the developer owns, so there is no slug to
// substitute; `normalizeEmail` validates it like any explicit `from`.
function readEmailFrom(): string | undefined {
  const raw = tryGetRawRuntimeEnv()?.__VOID_EMAIL_FROM;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

interface ProxyEnv {
  __VOID_PROXY?: { fetch(req: Request | string, init?: RequestInit): Promise<Response> };
  __VOID_PROXY_TOKEN?: string;
  __PROJECT_ID?: string;
}

// The `send_email` binding `void deploy --platform cloudflare` provisions
// (`cli/email-cloudflare.ts` writes the same name into wrangler.jsonc).
const SEND_EMAIL_BINDING_NAME = 'SEND_EMAIL';

// The legacy `EmailMessage` overload of `SendEmail.send`. Only `messageId`
// is read, and defensively: some builds have returned nothing.
interface SendEmailBinding {
  send(message: EmailMessage): Promise<{ messageId?: unknown } | undefined | void>;
}

function resolveSendEmailBinding(
  env: Record<string, unknown> | undefined,
): SendEmailBinding | undefined {
  const binding = env?.[SEND_EMAIL_BINDING_NAME];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  return typeof (binding as { send?: unknown }).send === 'function'
    ? (binding as SendEmailBinding)
    : undefined;
}

/**
 * Map an error thrown by the `send_email` binding to a framework code.
 *
 * Email Service throws `Error`s carrying a `code` (the `E_*` table in
 * Cloudflare's Workers API reference); the older Email Routing sender
 * throws message-only errors, so the destination-verification phrasing the
 * platform proxy already keys on is kept as a fallback. Anything else is
 * `UPSTREAM_ERROR` with the original error as `cause` — the framework has
 * no way to act on a delivery failure or a service outage beyond
 * reporting it.
 */
function classifyBindingError(e: unknown): SendEmailError {
  const message = e instanceof Error ? e.message : String(e);
  const code =
    typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '';
  switch (code) {
    case 'E_RECIPIENT_NOT_ALLOWED':
      return makeError('UNVERIFIED_DESTINATION', message, e);
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
      return makeError('INVALID_FROM', message, e);
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_DAILY_LIMIT_EXCEEDED':
      return makeError('QUOTA_EXCEEDED', message, e);
    default:
      break;
  }
  if (UNVERIFIED_DESTINATION_RE.test(message)) {
    return makeError('UNVERIFIED_DESTINATION', message, e);
  }
  return makeError('UPSTREAM_ERROR', message, e);
}

// Anchored to Cloudflare's own phrasing ("destination address … not (yet)
// verified"), with bounded runs so a long preamble or a multi-line stack
// cannot drag an unrelated mention of the address into a false positive.
// Mirrors `classifyUpstream` in the platform proxy.
const UNVERIFIED_DESTINATION_RE =
  /^[^\n]{0,200}destination address[^\n]{0,200}not (?:yet )?verified/i;

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Deliver through the worker's own `SEND_EMAIL` binding. One `EmailMessage`
 * per recipient, every recipient attempted, and the same `deliveries` shape
 * the proxy returns so a caller retries the failed ones the same way in both
 * modes. The stream is rebuilt per send because a `ReadableStream` is
 * one-shot.
 */
async function sendViaBinding(
  binding: SendEmailBinding,
  from: string,
  recipients: ReadonlyArray<string>,
  raw: Uint8Array,
  fallbackId: string,
): Promise<SendEmailResult> {
  let EmailMessage: (typeof import('cloudflare:email'))['EmailMessage'];
  try {
    ({ EmailMessage } = await import('cloudflare:email'));
  } catch (e) {
    return err(
      'UPSTREAM_ERROR',
      `email: SEND_EMAIL is bound but cloudflare:email could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
  const deliveries: Array<SendEmailRecipientResult> = [];
  for (const recipient of recipients) {
    try {
      const result = await binding.send(
        new EmailMessage(from, recipient, bytesToReadableStream(raw)),
      );
      const mid = typeof result?.messageId === 'string' ? result.messageId : '';
      deliveries.push({ recipient, ok: true, messageId: mid || fallbackId });
    } catch (e) {
      deliveries.push({ recipient, ok: false, error: classifyBindingError(e) });
    }
  }
  if (deliveries.some((d) => !d.ok)) {
    return { ok: false, deliveries };
  }
  return {
    ok: true,
    ids: deliveries.map((d) => ({
      recipient: d.recipient,
      messageId: (d as { messageId: string }).messageId,
    })),
  };
}

/**
 * Dedup recipients by lowercased email (CF won't collapse duplicate
 * envelopes for us, and double-billing the quota for the same recipient
 * is worse than the rare case where a user actually wanted Cc + Bcc to
 * the same address — which doesn't change delivery semantics anyway).
 */
function uniqueRecipients(normalized: NormalizedEmail): Array<string> {
  const seen = new Set<string>();
  const recipients: Array<string> = [];
  for (const r of [...normalized.to, ...normalized.cc, ...normalized.bcc]) {
    const lower = r.email.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    recipients.push(lower);
  }
  return recipients;
}

function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return `req_${Date.now().toString(36)}${hex}`;
}

function resolveDefaultFrom(opts: SendEmailOptions): SendEmailOptions {
  const supplied = opts.from;
  // Treat literal `null` the same as undefined here. Passing `null`
  // through to `normalizeEmail` makes `parseAddress` throw a TypeError
  // that gets surfaced as the opaque MIME_ERROR code; callers expect
  // INVALID_FROM for "from is missing/empty".
  const isEmpty =
    supplied === undefined ||
    supplied === null ||
    (typeof supplied === 'string' && supplied.trim() === '') ||
    (typeof supplied === 'object' && supplied !== null && !('email' in supplied));
  if (!isEmpty) {
    return opts;
  }
  // `__VOID_EMAIL_FROM` (own-account deploys) wins over the platform's
  // `<slug>+noreply@<domain>`: a project that carries both is one whose
  // void.json names a sender on purpose.
  const configured = readEmailFrom();
  if (configured) {
    return { ...opts, from: configured };
  }
  const slug = readProjectSlug();
  const domain = readEmailDomain();
  if (!slug || !domain) {
    // Strip the empty value so the downstream `from === undefined` check
    // surfaces a clean INVALID_FROM rather than passing `null` along.
    if (supplied === null) {
      const next = { ...opts };
      delete (next as { from?: unknown }).from;
      return next;
    }
    return opts;
  }
  return { ...opts, from: `${slug}+noreply@${domain}` };
}

function err(code: SendEmailErrorCode, message: string, cause?: unknown): SendEmailResult {
  return { ok: false, error: makeError(code, message, cause) };
}

function bytesToBase64(bytes: Uint8Array): string {
  // 8KB chunks keep us well under the typical V8 fromCharCode arg limit.
  const CHUNK = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

interface ProxySendBody {
  projectId: string;
  /**
   * HMAC of `projectId` under the shared `JWT_SECRET`. The proxy currently
   * reads this under the legacy `aiToken` key (auth was originally written
   * for the AI proxy). New `proxyToken` field below ships the same value
   * under the renamed key so the proxy can migrate without a coordinated
   * release; once every deployed proxy reads `proxyToken`, drop `aiToken`.
   */
  aiToken: string;
  proxyToken: string;
  from: string;
  recipients: Array<string>;
  mimeBase64: string;
  byteSize: number;
  requestId: string;
  fromDomain: string;
}

interface ProxyOkResponse {
  ok: true;
  ids: Array<SendEmailDelivery>;
}
interface ProxyPreflightFailure {
  ok: false;
  error: { code: SendEmailErrorCode | string; message: string };
}
interface ProxyMidBatchFailure {
  ok: false;
  deliveries: Array<{
    recipient: string;
    ok: boolean;
    messageId?: string;
    error?: { code: SendEmailErrorCode | string; message: string };
  }>;
}
type ProxyResponse = ProxyOkResponse | ProxyPreflightFailure | ProxyMidBatchFailure;

function coerceErrorCode(code: unknown): SendEmailErrorCode {
  const known: Array<SendEmailErrorCode> = [
    'BINDING_MISSING',
    'INVALID_FROM',
    'INVALID_TO',
    'UNVERIFIED_DESTINATION',
    'MIME_ERROR',
    'QUOTA_EXCEEDED',
    'UPSTREAM_ERROR',
  ];
  return known.includes(code as SendEmailErrorCode)
    ? (code as SendEmailErrorCode)
    : 'UPSTREAM_ERROR';
}

// Discriminator + shape check that runs before we destructure. The proxy
// response shape is well-defined, but treating the parsed body as
// `unknown` here lets us short-circuit to a clean UPSTREAM_ERROR for any
// malformed payload (null, primitive, missing discriminator, wrong
// array types) instead of throwing a TypeError mid-map.
function isValidProxyResponse(b: unknown): b is ProxyResponse {
  if (typeof b !== 'object' || b === null) {
    return false;
  }
  const r = b as Record<string, unknown>;
  if (r.ok === true && Array.isArray(r.ids)) {
    return true;
  }
  if (r.ok === false && typeof r.error === 'object' && r.error !== null) {
    return true;
  }
  if (r.ok === false && Array.isArray(r.deliveries)) {
    return true;
  }
  return false;
}

async function readResponseAsResult(res: Response, fallbackId: string): Promise<SendEmailResult> {
  try {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return err('UPSTREAM_ERROR', `email: proxy returned ${res.status} with non-JSON body`);
    }
    if (!isValidProxyResponse(body)) {
      return err(
        'UPSTREAM_ERROR',
        `email: proxy returned malformed response (status ${res.status})`,
        body,
      );
    }
    if (body.ok === true) {
      // `ids` is `unknown[]` from the typeguard's perspective — validate
      // each entry shape before surfacing it.
      const ids: Array<SendEmailDelivery> = [];
      for (const d of body.ids as Array<unknown>) {
        if (typeof d !== 'object' || d === null) {
          continue;
        }
        const entry = d as { recipient?: unknown; messageId?: unknown };
        const recipient = typeof entry.recipient === 'string' ? entry.recipient : '';
        if (!recipient) {
          continue;
        }
        const mid = typeof entry.messageId === 'string' ? entry.messageId : '';
        ids.push({ recipient, messageId: mid || fallbackId });
      }
      return { ok: true, ids };
    }
    // Treat the body as a flat record from here — the discriminated
    // union narrowing fights the `unknown`-derived branches and adds
    // little value once we've validated the shape via isValidProxyResponse.
    const failure = body as unknown as Record<string, unknown>;
    if ('error' in failure && failure.error) {
      const e = failure.error as { code?: unknown; message?: unknown };
      return err(
        coerceErrorCode(e.code),
        typeof e.message === 'string' ? e.message : 'email: upstream send failed',
      );
    }
    // Mid-batch — surface per-recipient outcomes verbatim, normalizing
    // unknown error codes to UPSTREAM_ERROR. Each delivery entry is
    // independently validated so a single malformed entry can't crash
    // the whole map.
    const deliveries: Array<SendEmailRecipientResult> = [];
    for (const d of failure.deliveries as Array<unknown>) {
      if (typeof d !== 'object' || d === null) {
        continue;
      }
      const entry = d as {
        recipient?: unknown;
        ok?: unknown;
        messageId?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      const recipient = typeof entry.recipient === 'string' ? entry.recipient : '';
      if (!recipient) {
        continue;
      }
      if (entry.ok === true) {
        const mid = typeof entry.messageId === 'string' ? entry.messageId : '';
        deliveries.push({ recipient, ok: true, messageId: mid || fallbackId });
      } else {
        deliveries.push({
          recipient,
          ok: false,
          error: makeError(
            coerceErrorCode(entry.error?.code),
            typeof entry.error?.message === 'string'
              ? entry.error.message
              : 'email: upstream send failed',
          ),
        });
      }
    }
    return { ok: false, deliveries };
  } catch (e) {
    // Defense-in-depth: any unexpected error parsing the proxy response
    // becomes a clean UPSTREAM_ERROR rather than escaping `sendEmail` as
    // an unhandled rejection.
    return err(
      'UPSTREAM_ERROR',
      `email: failed to parse proxy response (status ${res.status}): ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

interface DevInboxFetcher {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * Resolve the loopback into the `void dev` inbox, or `undefined` outside dev.
 *
 * `DEV_INBOX_ENV_VAR` is injected only when `viteCommand === 'serve'` and it
 * names the worker's assets binding. In dev, `@cloudflare/vite-plugin` binds
 * that name to a miniflare service whose implementation is the Vite dev
 * server's Node middleware stack, so a fetch through it lands on the inbox
 * middleware in the dev-server process — the only place the buffer exists.
 * In a production build neither the var nor that wiring is present.
 */
function resolveDevInbox(env: Record<string, unknown> | undefined): DevInboxFetcher | undefined {
  const bindingName = env?.[DEV_INBOX_ENV_VAR];
  if (typeof bindingName !== 'string' || bindingName.length === 0) {
    return undefined;
  }
  const binding = env?.[bindingName];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  return typeof (binding as { fetch?: unknown }).fetch === 'function'
    ? (binding as DevInboxFetcher)
    : undefined;
}

// A local loopback answers immediately; this only exists so a wedged dev
// server degrades into an error instead of hanging the user's request.
const DEV_INBOX_TIMEOUT_MS = 5000;

async function postToDevInbox(
  fetcher: DevInboxFetcher,
  captured: CapturedMessage,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = Promise.resolve(
      fetcher.fetch(`http://localhost${DEV_INBOX_CAPTURE_URL}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializeCapturedMessage(captured),
      }),
    ).then(
      (res) => ({ kind: 'response' as const, res }),
      (cause: unknown) => ({ kind: 'error' as const, cause }),
    );
    const settled = await Promise.race([
      attempt,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), DEV_INBOX_TIMEOUT_MS);
      }),
    ]);
    if (settled.kind === 'timeout') {
      return { ok: false, reason: `no response within ${DEV_INBOX_TIMEOUT_MS}ms` };
    }
    if (settled.kind === 'error') {
      const cause = settled.cause;
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
    const { res } = settled;
    if (!res.ok) {
      return { ok: false, reason: `dev server responded ${res.status}` };
    }
    // A 200 alone is not proof: if the assets binding ever stops being a
    // dev-server loopback, a static/SPA response is also a 200.
    if (res.headers.get(DEV_INBOX_ACK_HEADER) !== DEV_INBOX_ACK_VALUE) {
      return { ok: false, reason: 'response did not come from the dev inbox' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Shared result shape for both capture paths (in-process sink and dev inbox). */
function capturedResult(normalized: NormalizedEmail, captureId: string): SendEmailResult {
  const recipients = [...normalized.to, ...normalized.cc, ...normalized.bcc];
  if (recipients.length === 0) {
    return err('INVALID_TO', "email: 'to' must include at least one recipient.");
  }
  return {
    ok: true,
    ids: recipients.map((r) => ({ recipient: r.email, messageId: captureId })),
  };
}

/**
 * Send an email via the Void platform proxy.
 *
 * During `void dev` the message is captured by the local inbox
 * (`/__void/inbox`) and never reaches the proxy; an in-process sink
 * (`void/email/testing`) takes precedence over it. Pass `sendInDev: true` to
 * override for a single call.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const resolvedOpts = resolveDefaultFrom(opts);
  if (resolvedOpts.from === undefined) {
    return err(
      'INVALID_FROM',
      "email: 'from' is required. Set it explicitly or deploy via Void so the platform-injected __VOID_PROJECT_SLUG and __VOID_EMAIL_DOMAIN can default it to <slug>+noreply@<domain>.",
    );
  }

  // `from` is now guaranteed defined by the check above; the cast keeps
  // normalizeEmail's stricter signature without widening it.
  const optsWithFrom = resolvedOpts as SendEmailOptions & {
    from: NonNullable<SendEmailOptions['from']>;
  };

  let normalized: NormalizedEmail;
  try {
    normalized = await normalizeEmail(optsWithFrom);
  } catch (e) {
    if (e instanceof MimeError) {
      return err(e.code, e.message, e);
    }
    return err('MIME_ERROR', e instanceof Error ? e.message : String(e), e);
  }

  let raw: Uint8Array;
  let messageId: string;
  try {
    const built = buildMime(normalized);
    raw = built.raw;
    messageId = built.messageId;
  } catch (e) {
    if (e instanceof MimeError) {
      return err(e.code, e.message, e);
    }
    return err('MIME_ERROR', e instanceof Error ? e.message : String(e), e);
  }

  const rawEnv = tryGetRawRuntimeEnv();

  // Each sink owns its storage; sendEmail must NOT also push to the dev
  // buffer or every dev send ends up captured twice. This path only fires
  // for a send that runs in the SAME isolate as the sink — the test harness,
  // or a prerender pass inside the dev server's own process.
  if (!opts.sendInDev && hasActiveSink()) {
    const captured = captureMessage(normalized, raw, messageId);
    dispatchToSinks(captured);
    return capturedResult(normalized, captured.id);
  }

  // `void dev`: the inbox buffer lives in the Vite dev server's Node process,
  // which this isolate has no shared memory with. Hand the message over.
  const devInbox = opts.sendInDev ? undefined : resolveDevInbox(rawEnv);
  if (devInbox) {
    const captured = captureMessage(normalized, raw, messageId);
    const delivered = await postToDevInbox(devInbox, captured);
    if (delivered.ok) {
      return capturedResult(normalized, captured.id);
    }
    const message = `email: the void dev inbox at ${DEV_INBOX_CAPTURE_URL} is unreachable (${delivered.reason}), so nothing was captured and nothing was sent.`;
    console.warn(`[void/email] ${message}`);
    return err('UPSTREAM_ERROR', message);
  }

  const recipients = uniqueRecipients(normalized);
  if (recipients.length === 0) {
    return err('INVALID_TO', "email: 'to' must include at least one recipient.");
  }

  // Own-account deploy: the worker holds the binding itself, so there is no
  // proxy hop and no platform quota — Cloudflare's own limits apply.
  const sendBinding = resolveSendEmailBinding(rawEnv);
  if (sendBinding) {
    return sendViaBinding(sendBinding, normalized.from.email, recipients, raw, messageId);
  }

  const env = rawEnv as ProxyEnv | undefined;
  const proxy = env?.__VOID_PROXY;
  const projectId = env?.__PROJECT_ID;
  const proxyToken = env?.__VOID_PROXY_TOKEN;
  if (!proxy || !projectId || !proxyToken) {
    return err(
      'BINDING_MISSING',
      'email: neither SEND_EMAIL nor __VOID_PROXY is available, so nothing was sent. Deploy via Void to bind the platform proxy, ' +
        'or set `email.from` in void.json so `void deploy --platform cloudflare` provisions the SEND_EMAIL binding. ' +
        'Under `void dev` messages are captured by the local inbox at /__void/inbox instead — reaching this error there means ' +
        'that path was bypassed (`sendInDev: true`, which does not deliver: `void dev` binds no send transport at all, so there is ' +
        'nothing to fall through to) or unavailable (the worker has no assets binding to reach the dev server through).',
    );
  }

  const requestId = newRequestId();
  const fromDomain = normalized.from.email.split('@')[1] ?? '';
  const body: ProxySendBody = {
    projectId,
    aiToken: proxyToken,
    proxyToken,
    from: normalized.from.email,
    recipients,
    mimeBase64: bytesToBase64(raw),
    byteSize: raw.byteLength,
    requestId,
    fromDomain,
  };

  let res: Response;
  try {
    res = await proxy.fetch('https://email-proxy/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return err(
      'UPSTREAM_ERROR',
      `email: proxy unreachable: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
  return readResponseAsResult(res, messageId);
}

/**
 * Build a normalized email + raw MIME for advanced callers who want to feed
 * the message into a custom transport. Throws on invalid input.
 */
export async function createEmail(
  opts: SendEmailOptions,
): Promise<{ email: NormalizedEmail; raw: Uint8Array; messageId: string }> {
  if (opts.from === undefined) {
    throw new MimeError(
      'INVALID_FROM',
      "createEmail: 'from' is required (this entrypoint does not apply __VOID_PROJECT_SLUG defaulting).",
    );
  }
  const email = await normalizeEmail(
    opts as SendEmailOptions & { from: NonNullable<SendEmailOptions['from']> },
  );
  const built = buildMime(email);
  return { email, ...built };
}
