// void/email — outbound email via the platform proxy or a direct binding.
//
// On the managed platform, user worker code never holds a `send_email`
// binding directly. The framework builds MIME locally, then POSTs to
// `__VOID_PROXY/email/send`. The platform gateway enforces authoritative
// project policy and quotas and records each provider submission's outcome.
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

import { isRecord } from '@void/deploy-core';
import {
  bytesToBase64,
  captureMessage,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  DEV_INBOX_TOKEN_ENV_VAR,
  DEV_INBOX_TOKEN_HEADER,
  dispatchToSinks,
  hasActiveSink,
  serializeCapturedMessage,
  type CapturedMessage,
} from './email/dev-inbox.ts';
import { bytesToReadableStream } from './email/inbound.ts';
import { buildMime, MimeError, normalizeEmail } from './email/mime.ts';
import type {
  EmailDeliveryState,
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
  EmailDeliveryState,
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
// `mail.example.com`, staging its own zone). It is injected per
// deployment rather than baked in, so a staging send is not rejected by
// the proxy's sender check. There is deliberately no built-in default:
// silently falling back to the production zone is the bug this binding
// exists to prevent.
function readEmailDomain(): string | undefined {
  const raw = tryGetRawRuntimeEnv()?.__VOID_EMAIL_DOMAIN;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// The project's own default sender, written into the worker's `vars` by
// `void deploy --platform cloudflare` from `email.from` in void.config.ts. It is a
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
const EMAIL_PROVIDER_DEADLINE_MS = 30_000;
const PLATFORM_SEND_DEADLINE_MS = 60_000;

class EmailBindingTimeoutError extends Error {
  constructor() {
    super('email binding outcome unknown after timeout');
    this.name = 'EmailBindingTimeoutError';
  }
}

function createBindingSendDeadline() {
  const deadline = Date.now() + PLATFORM_SEND_DEADLINE_MS;
  return {
    expired: () => Date.now() >= deadline,
    async run<T>(submit: () => Promise<T>): Promise<T> {
      const remaining = Math.min(EMAIL_PROVIDER_DEADLINE_MS, deadline - Date.now());
      if (remaining <= 0) {
        throw new EmailBindingTimeoutError();
      }
      const work = submit();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EmailBindingTimeoutError()), remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

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
 * `OUTCOME_UNKNOWN` with the original error as `cause`: once `send()` has
 * started, an undocumented rejection does not prove the provider declined
 * the message before accepting it.
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
  return makeError('OUTCOME_UNKNOWN', message, e);
}

// Anchored to Cloudflare's own phrasing ("destination address … not (yet)
// verified"), with bounded runs so a long preamble or a multi-line stack
// cannot drag an unrelated mention of the address into a false positive.
const UNVERIFIED_DESTINATION_RE =
  /^[^\n]{0,200}destination address[^\n]{0,200}not (?:yet )?verified/i;

/**
 * Deliver through the worker's own `SEND_EMAIL` binding. One `EmailMessage`
 * per recipient, within one bounded batch, and the same `deliveries` shape
 * the proxy returns so a caller can inspect each attempted or cancelled
 * outcome in either mode. The stream is rebuilt per send because a
 * `ReadableStream` is one-shot.
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
  const deadline = createBindingSendDeadline();
  for (let index = 0; index < recipients.length; index++) {
    const recipient = recipients[index];
    if (deadline.expired()) {
      for (const unstarted of recipients.slice(index)) {
        deliveries.push({
          recipient: unstarted,
          ok: false,
          state: 'cancelled',
          error: makeError(
            'UPSTREAM_ERROR',
            'email: batch deadline elapsed before provider submission',
          ),
        });
      }
      break;
    }
    try {
      const result = await deadline.run(() =>
        binding.send(new EmailMessage(from, recipient, bytesToReadableStream(raw))),
      );
      const mid = typeof result?.messageId === 'string' ? result.messageId : '';
      deliveries.push({ recipient, ok: true, messageId: mid || fallbackId });
    } catch (e) {
      const error =
        e instanceof EmailBindingTimeoutError
          ? makeError(
              'OUTCOME_UNKNOWN',
              'email: binding submission timed out; inspect provider logs before retrying',
              e,
            )
          : classifyBindingError(e);
      deliveries.push({
        recipient,
        ok: false,
        ...(error.code === 'OUTCOME_UNKNOWN' ? { state: 'outcome_unknown' as const } : {}),
        error,
      });
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
  // void.config.ts names a sender on purpose.
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

interface ProxySendBody {
  projectId: string;
  /** Project HMAC accepted by the shared proxy authentication middleware. */
  aiToken: string;
  from: string;
  recipients: Array<string>;
  mimeBase64: string;
  requestId: string;
  idempotencyKey?: string;
}

type ProxyResponse = { operationId: unknown } & (
  | { ok: true; ids: Array<unknown> }
  | { ok: false; error: { code: unknown; message: unknown } }
  | { ok: false; deliveries: Array<unknown> }
);

function coerceErrorCode(code: unknown): SendEmailErrorCode {
  const known: Array<SendEmailErrorCode> = [
    'BINDING_MISSING',
    'INVALID_FROM',
    'INVALID_TO',
    'UNVERIFIED_DESTINATION',
    'MIME_ERROR',
    'QUOTA_EXCEEDED',
    'IDEMPOTENCY_CONFLICT',
    'OUTCOME_UNKNOWN',
    'UPSTREAM_ERROR',
  ];
  return known.find((knownCode) => knownCode === code) ?? 'UPSTREAM_ERROR';
}

/**
 * The text of a refusal the proxy's middleware sent instead of a send
 * response: `{ error: string, message?: string }`. `message` is the
 * sentence written for a person (the capability gate's "This Void platform
 * does not enable email."); `error` is the short code every such refusal
 * carries. `null` when the body is not that shape.
 */
function readProxyRefusal(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error !== 'string' || error === '') {
    return null;
  }
  return typeof message === 'string' && message !== '' ? message : error;
}

// A malformed response leaves the provider outcome unknown.
function readProxyResponse(value: unknown): ProxyResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const operationId = value.operationId;
  if (value.ok === true && Array.isArray(value.ids)) {
    return { ok: true, ids: value.ids, operationId };
  }
  if (value.ok !== false) {
    return null;
  }
  if (Array.isArray(value.deliveries)) {
    return { ok: false, deliveries: value.deliveries, operationId };
  }
  const error = value.error;
  if (typeof error === 'object' && error !== null) {
    return {
      ok: false,
      error: {
        code: 'code' in error ? error.code : undefined,
        message: 'message' in error ? error.message : undefined,
      },
      operationId,
    };
  }
  return null;
}

type RecipientListRead<T> = { ok: true; entries: Array<T> } | { ok: false; reason: string };

/**
 * Require exactly one valid outcome per requested recipient in either list
 * shape. A missing, duplicate, or foreign entry makes the whole result unknown;
 * trimming it could hide a submission. Order is not part of the contract.
 * Diagnostics identify entries by index rather than echoing corrupt addresses.
 */
function readRecipientList<T>(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  shape: string,
  readEntry: (entry: Record<string, unknown>, recipient: string) => T | undefined,
): RecipientListRead<T> {
  if (raw.length !== recipients.length) {
    return { ok: false, reason: `expected ${recipients.length} deliveries, got ${raw.length}` };
  }
  const requested = new Set(recipients);
  const seen = new Set<string>();
  const entries: Array<T> = [];
  for (const [i, d] of raw.entries()) {
    const entry = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : null;
    const recipient = entry?.recipient;
    if (entry === null || typeof recipient !== 'string') {
      return { ok: false, reason: `entry ${i} is not ${shape}` };
    }
    const value = readEntry(entry, recipient);
    if (value === undefined) {
      return { ok: false, reason: `entry ${i} is not ${shape}` };
    }
    if (!requested.has(recipient)) {
      return { ok: false, reason: `entry ${i} names a recipient that was not requested` };
    }
    if (seen.has(recipient)) {
      return { ok: false, reason: `entry ${i} repeats a recipient` };
    }
    seen.add(recipient);
    entries.push(value);
  }
  return { ok: true, entries };
}

/**
 * The `ids` list of an `ok: true` response. The proxy answers `ok: true` only
 * after every requested recipient has an accepted provider outcome. Each entry
 * is `{ recipient, messageId }`; the framework's own Message-ID stands in for
 * an empty provider reference. A missing delivery would leave no safe retry
 * decision, so the whole response is rejected as malformed.
 */
function readDeliveryList(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
): RecipientListRead<SendEmailDelivery> {
  return readRecipientList(
    raw,
    recipients,
    '{ recipient: string, messageId: string }',
    (entry, recipient) =>
      typeof entry.messageId === 'string'
        ? {
            recipient,
            messageId: entry.messageId || fallbackId,
            ...(entry.state === 'provider_accepted' ? { state: 'provider_accepted' as const } : {}),
          }
        : undefined,
  );
}

/**
 * Preserve each recipient's acceptance or error and recorded state. `ok: false`
 * alone does not establish that retrying is safe: submission may be unresolved.
 */
function readFailureDeliveries(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
): RecipientListRead<SendEmailRecipientResult> {
  return readRecipientList(
    raw,
    recipients,
    '{ recipient: string, ok: true, messageId: string } | { recipient: string, ok: false, error: { message: string } }',
    (entry, recipient) => {
      if (entry.ok === true) {
        return typeof entry.messageId === 'string'
          ? {
              recipient,
              ok: true,
              messageId: entry.messageId || fallbackId,
              ...(entry.state === 'provider_accepted'
                ? { state: 'provider_accepted' as const }
                : {}),
            }
          : undefined;
      }
      if (entry.ok === false) {
        const state = readDeliveryState(entry.state);
        const error = entry.error as { code?: unknown; message?: unknown } | null | undefined;
        return typeof error === 'object' && error !== null && typeof error.message === 'string'
          ? {
              recipient,
              ok: false,
              error: makeError(coerceErrorCode(error.code), error.message),
              ...(state ? { state } : {}),
            }
          : undefined;
      }
      return undefined;
    },
  );
}

function readDeliveryState(value: unknown): EmailDeliveryState | undefined {
  const states: ReadonlyArray<EmailDeliveryState> = [
    'rejected',
    'reserved',
    'attempt_started',
    'provider_accepted',
    'failed',
    'outcome_unknown',
    'cancelled',
  ];
  return states.find((state) => state === value);
}

const MAX_PROXY_RESPONSE_BYTES = 64 * 1024;

function createPlatformSendDeadline(): {
  signal: AbortSignal;
  beforeDeadline: <T>(run: () => Promise<T>) => Promise<T>;
} {
  const controller = new AbortController();
  const deadline = Date.now() + PLATFORM_SEND_DEADLINE_MS;
  return {
    signal: controller.signal,
    async beforeDeadline<T>(run: () => Promise<T>): Promise<T> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        controller.abort();
        throw new Error('email platform send timed out');
      }
      const promise = run();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('email platform send timed out'));
            }, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

async function readBoundedProxyJson(
  response: Response,
  beforeDeadline: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_PROXY_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error('email proxy response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('email proxy response is empty');
  }
  const bytes = new Uint8Array(MAX_PROXY_RESPONSE_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(() => reader.read());
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > bytes.byteLength) {
        throw new Error('email proxy response too large');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (declared !== null && size !== Number(declared)) {
      throw new Error('email proxy response length mismatch');
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)),
    ) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

async function readResponseAsResult(
  res: Response,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
  beforeDeadline: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<SendEmailResult> {
  try {
    let body: unknown;
    try {
      body = await readBoundedProxyJson(res, beforeDeadline);
    } catch {
      return err(
        'OUTCOME_UNKNOWN',
        `email: could not establish the send outcome (status ${res.status}); check email logs or repeat the same idempotency key`,
      );
    }
    const response = readProxyResponse(body);
    if (response === null) {
      // The proxy's own middleware — auth, platform lifecycle, capability
      // gates — answers ahead of the email handler with a flat
      // `{ error: string, message?: string }` and a non-2xx status. That
      // is a well-formed refusal, not a malformed send response, so carry
      // its text through the way the handler's `{ ok: false, error }` is
      // carried above; a platform without the email module otherwise reads
      // as "malformed response (status 501)" with the reason buried in
      // `cause`.
      const refusal = readProxyRefusal(body);
      if (!res.ok && refusal !== null) {
        return err('UPSTREAM_ERROR', `email: proxy returned ${res.status}: ${refusal}`, body);
      }
      return err(
        'OUTCOME_UNKNOWN',
        `email: proxy returned malformed response (status ${res.status})`,
        body,
      );
    }
    // Both list-bearing shapes are validated as a whole against the
    // recipients this send asked for; their entries remain unknown until
    // the whole list passes validation.
    const malformedList = (reason: string): SendEmailResult =>
      err(
        'OUTCOME_UNKNOWN',
        `email: proxy returned a malformed delivery list (${reason}); do not retry with a new idempotency key`,
        body,
      );
    const operation =
      typeof response.operationId === 'string' && response.operationId.length <= 128
        ? { operationId: response.operationId }
        : {};
    if (response.ok === true) {
      const list = readDeliveryList(response.ids, recipients, fallbackId);
      return list.ok ? { ok: true, ids: list.entries, ...operation } : malformedList(list.reason);
    }
    if ('deliveries' in response) {
      const list = readFailureDeliveries(response.deliveries, recipients, fallbackId);
      return list.ok
        ? { ok: false, deliveries: list.entries, ...operation }
        : malformedList(list.reason);
    }
    const e = response.error;
    return {
      ...err(
        coerceErrorCode(e.code),
        typeof e.message === 'string' ? e.message : 'email: upstream send failed',
      ),
      ...operation,
    };
  } catch (e) {
    // Parsing failures must not imply that no provider submission occurred.
    return err(
      'OUTCOME_UNKNOWN',
      `email: failed to parse proxy response (status ${res.status}): ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

interface DevInboxFetcher {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}

interface DevInbox {
  fetcher: DevInboxFetcher;
  /**
   * The dev-trigger token the inbox middleware requires. Injected under the
   * same gate as the binding var; when it is somehow absent the POST still
   * goes out and the dev server's 401 is reported verbatim — the inbox is
   * never skipped in favour of a real send transport.
   */
  token: string | undefined;
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
function resolveDevInbox(env: Record<string, unknown> | undefined): DevInbox | undefined {
  const bindingName = env?.[DEV_INBOX_ENV_VAR];
  if (typeof bindingName !== 'string' || bindingName.length === 0) {
    return undefined;
  }
  const binding = env?.[bindingName];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  if (typeof (binding as { fetch?: unknown }).fetch !== 'function') {
    return undefined;
  }
  const token = env?.[DEV_INBOX_TOKEN_ENV_VAR];
  return {
    fetcher: binding as DevInboxFetcher,
    token: typeof token === 'string' && token.length > 0 ? token : undefined,
  };
}

// A local loopback answers immediately; this only exists so a wedged dev
// server degrades into an error instead of hanging the user's request.
const DEV_INBOX_TIMEOUT_MS = 5000;

/** Bound on the error text a failed capture echoes from the dev server. */
const DEV_INBOX_ERROR_EXCERPT_CHARS = 200;
const DEV_INBOX_ERROR_EXCERPT_TIMEOUT_MS = 1000;

/**
 * First line of a refusal, so a 401 names the header it wanted. Reads ONE
 * chunk under its own deadline: the main 5s race has already settled by the
 * time the status is known, and a body that never arrives must not turn a
 * clean error into a hung `sendEmail`.
 */
async function readErrorExcerpt(res: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      return '';
    }
    const first = await Promise.race([
      reader.read().then(({ value }) => value),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), DEV_INBOX_ERROR_EXCERPT_TIMEOUT_MS);
      }),
    ]);
    void reader.cancel().catch(() => {});
    if (!first) {
      return '';
    }
    return new TextDecoder()
      .decode(first)
      .trim()
      .split('\n')[0]
      .slice(0, DEV_INBOX_ERROR_EXCERPT_CHARS);
  } catch {
    return '';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function postToDevInbox(
  inbox: DevInbox,
  captured: CapturedMessage,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = Promise.resolve(
      inbox.fetcher.fetch(`http://localhost${DEV_INBOX_CAPTURE_URL}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(inbox.token !== undefined && { [DEV_INBOX_TOKEN_HEADER]: inbox.token }),
        },
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
      // A 401 names the header it wanted; surface that instead of a bare
      // status so a missing token is diagnosable from the worker's console.
      const excerpt = await readErrorExcerpt(res);
      return {
        ok: false,
        reason: `dev server responded ${res.status}${excerpt ? `: ${excerpt}` : ''}`,
      };
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

/**
 * Shared result shape for both capture paths (in-process sink and dev inbox).
 *
 * `ids` is built from the same deduplicated, lowercased list the two
 * production transports send to, so code written against a captured result
 * sees exactly what a deploy returns: one entry per unique address, keyed the
 * way `sendViaBinding` and the proxy report it. The captured message itself
 * keeps the original fields; the inbox displays what was asked for, the
 * result reports what would be sent.
 */
function capturedResult(normalized: NormalizedEmail, captureId: string): SendEmailResult {
  const recipients = uniqueRecipients(normalized);
  if (recipients.length === 0) {
    return err('INVALID_TO', "email: 'to' must include at least one recipient.");
  }
  return {
    ok: true,
    ids: recipients.map((recipient) => ({ recipient, messageId: captureId })),
  };
}

/**
 * Send an email via the worker's own `SEND_EMAIL` binding or the Void
 * platform proxy.
 *
 * During `void dev` the message is captured by the local inbox
 * (`/__void/inbox`) and never reaches the proxy; an in-process sink
 * (`void/email/testing`) takes precedence over it. Pass `sendInDev: true` to
 * override for a single call.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (
    opts.idempotencyKey !== undefined &&
    (typeof opts.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(opts.idempotencyKey))
  ) {
    return err(
      'MIME_ERROR',
      'email: idempotencyKey must contain 1–128 printable non-space ASCII characters.',
    );
  }
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
    if (opts.idempotencyKey !== undefined) {
      return err(
        'MIME_ERROR',
        'email: idempotencyKey requires a Void platform; the native Cloudflare binding cannot deduplicate sends.',
      );
    }
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
  const body: ProxySendBody = {
    projectId,
    aiToken: proxyToken,
    from: normalized.from.email,
    recipients,
    mimeBase64: bytesToBase64(raw),
    requestId,
    ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
  };

  const requestBody = JSON.stringify(body);
  const deadline = createPlatformSendDeadline();
  let res: Response;
  try {
    res = await deadline.beforeDeadline(() =>
      proxy.fetch('https://email-proxy/email/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
        signal: deadline.signal,
      }),
    );
  } catch (e) {
    return err(
      'OUTCOME_UNKNOWN',
      `email: send outcome is unknown: ${e instanceof Error ? e.message : String(e)}. Check email logs or repeat the same idempotency key; do not create a new send.`,
      e,
    );
  }
  return readResponseAsResult(res, recipients, messageId, deadline.beforeDeadline);
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
