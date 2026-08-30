// void/email — outbound email via the platform proxy.
//
// User worker code never holds a `send_email` binding directly. The
// framework builds MIME locally, then POSTs to `__VOID_PROXY/email/send`.
// The proxy worker holds the platform-level `send_email` binding and
// enforces per-project quotas, suspend kill-switch, and verified-
// destinations allowlist (mirrored from `email_destinations` into KV by
// the API on every CRUD).
//
// In `void dev` (no `__VOID_PROXY`) sends are captured by the in-memory
// dev inbox; pass `sendInDev: true` for a single call to bypass.

import { captureMessage, dispatchToSinks, hasActiveSink } from './email/dev-inbox.ts';
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

export { createMessageProxy, defineEmail, parseEmail, replyEmail } from './email/inbound.ts';
export type {
  EmailAction,
  EmailEnvelope,
  EmailHandler,
  EmailHandlerInfo,
  MessageProxy,
  ParsedEmail,
  ReplyEmailOptions,
} from './email/inbound.ts';

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

interface ProxyEnv {
  __VOID_PROXY?: { fetch(req: Request | string, init?: RequestInit): Promise<Response> };
  __VOID_PROXY_TOKEN?: string;
  __PROJECT_ID?: string;
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

/**
 * Send an email via the Void platform proxy.
 *
 * During `void dev` (when an email sink is registered) the message is
 * captured locally and never reaches the proxy. Pass `sendInDev: true`
 * to override for a single call.
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

  // Each sink owns its storage; sendEmail must NOT also push to the dev
  // buffer or every dev send ends up captured twice.
  if (!opts.sendInDev && hasActiveSink()) {
    const captured = captureMessage(normalized, raw, messageId);
    dispatchToSinks(captured);
    const recipients = [...normalized.to, ...normalized.cc, ...normalized.bcc];
    if (recipients.length === 0) {
      return err('INVALID_TO', "email: 'to' must include at least one recipient.");
    }
    const ids: Array<SendEmailDelivery> = recipients.map((r) => ({
      recipient: r.email,
      messageId: captured.id,
    }));
    return { ok: true, ids };
  }

  const env = tryGetRawRuntimeEnv() as ProxyEnv | undefined;
  const proxy = env?.__VOID_PROXY;
  const projectId = env?.__PROJECT_ID;
  const proxyToken = env?.__VOID_PROXY_TOKEN;
  if (!proxy || !projectId || !proxyToken) {
    return err(
      'BINDING_MISSING',
      'email: __VOID_PROXY is not available. Deploy via Void so the platform proxy is bound, or run `void dev` for the local dev inbox.',
    );
  }

  // Dedup recipients by lowercased email (CF won't collapse duplicate
  // envelopes for us, and double-billing the quota for the same recipient
  // is worse than the rare case where a user actually wanted Cc + Bcc to
  // the same address — which doesn't change delivery semantics anyway).
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
  if (recipients.length === 0) {
    return err('INVALID_TO', "email: 'to' must include at least one recipient.");
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
