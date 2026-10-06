// Managed delivery uses bounded HTTP envelopes and recorded action responses.
// Native Cloudflare email events use the same proxy, then enact its actions on
// the original message before returning.

import {
  EMAIL_MAX_ACTIONS,
  EMAIL_MAX_INBOUND_BYTES,
  EMAIL_MAX_INBOUND_HEADERS,
  EMAIL_MAX_METADATA_BYTES,
  EMAIL_MAX_REPLY_BYTES,
  EMAIL_MAX_RESPONSE_BYTES,
} from '@void/platform/email-protocol';
import type { Email as PostalMimeEmail } from 'postal-mime';
import { getRawRuntimeEnv } from '../env-raw.ts';
import { buildMime, MimeError, normalizeEmail, validateAddressParts } from './mime.ts';
import type { Address, Attachment } from './types.ts';

// Mirror the slug-validity rule from runtime/email.ts so a malformed
// __VOID_PROJECT_SLUG injection can't smuggle invalid characters into
// the default reply `from` address.
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;

// SDK limits give handlers early errors. The gateway independently validates
// untrusted tenant responses before admitting any action.
const MAX_ACTIONS = EMAIL_MAX_ACTIONS;
const MAX_ACTION_ADDRESS_LENGTH = 320;
const MAX_ACTION_METADATA_BYTES = EMAIL_MAX_METADATA_BYTES;

/** Bounds on a forward's headers. */
const MAX_FORWARD_HEADERS = 32;
const MAX_FORWARD_HEADER_LENGTH = 1024;

/** Maximum normalized SMTP rejection reason length. */
const MAX_REJECT_REASON_LENGTH = 1000;

/** Inbound admission limits also applied by the handler test harness. */
export const MAX_INBOUND_BYTES: number = EMAIL_MAX_INBOUND_BYTES;
export const MAX_INBOUND_HEADERS: number = EMAIL_MAX_INBOUND_HEADERS;

const MAX_REPLY_BYTES = EMAIL_MAX_REPLY_BYTES;
const EMAIL_STREAM_DEADLINE_MS = 15_000;
const EMAIL_ACTION_TERMINAL_BYTES = 5;
const actionEncoder = new TextEncoder();

function emailActionWireSize(action: EmailAction): number {
  const metadata = actionEncoder.encode(
    JSON.stringify(
      action.type === 'reply' ? { type: action.type, from: action.from, to: action.to } : action,
    ),
  );
  return 5 + metadata.byteLength + (action.type === 'reply' ? 5 + action.raw.byteLength : 0);
}

function readRawProjectSlug(): string | undefined {
  let raw: unknown;
  try {
    raw = getRawRuntimeEnv()?.__VOID_PROJECT_SLUG;
  } catch {
    return undefined;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function tryReadProjectSlug(): string | undefined {
  const raw = readRawProjectSlug();
  return raw !== undefined && VALID_SLUG.test(raw) ? raw : undefined;
}

// The platform mail domain for this environment, injected per deployment
// (production uses `mail.example.com`, staging its own zone). Mirrors
// `readEmailDomain` in runtime/email.ts — no baked-in default, so a
// staging reply is never built against the production zone.
function tryReadEmailDomain(): string | undefined {
  let raw: unknown;
  try {
    raw = getRawRuntimeEnv()?.__VOID_EMAIL_DOMAIN;
  } catch {
    return undefined;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// The relay-lane marker `createMessageProxy` sets from `envelope.viaDomain`
// — the registered custom domain the message arrived on. Undefined for a
// platform-lane or own-account message, and for a hand-built message in a
// test that never went through the proxy.
function readRelayDomain(message: ForwardableEmailMessage): string | undefined {
  const raw: unknown = (message as { __voidRelayDomain?: unknown }).__voidRelayDomain;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export interface EmailHandlerInfo {
  /**
   * Captured params from dynamic / tagged route segments. For example, a
   * handler at `email/support+[ticket].ts` invoked for `support+abc-123@…`
   * receives `{ ticket: "abc-123" }`. Empty `{}` for static handlers and
   * `_default`.
   */
  params: Record<string, string>;
}

export type EmailHandler = (
  message: ForwardableEmailMessage,
  env: unknown,
  ctx: ExecutionContext,
  info?: EmailHandlerInfo,
) => void | Promise<void>;

/**
 * Identity helper that types the inbound email handler. Use as the default
 * export of `email/<address>.ts` or `email/_default.ts`.
 */
export function defineEmail(handler: EmailHandler): EmailHandler {
  return handler;
}

export type ParsedEmail = PostalMimeEmail;

export type ParseEmailErrorCode = 'INBOUND_TOO_LARGE' | 'PARSE_FAILED';

/**
 * Typed error thrown by `parseEmail`. Lets handler authors distinguish
 * "too big" from "malformed body" without string-matching error messages.
 */
export class ParseEmailError extends Error {
  readonly code: ParseEmailErrorCode;
  constructor(code: ParseEmailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParseEmailError';
    this.code = code;
  }
}

/**
 * Parse a `ForwardableEmailMessage` into structured fields. postal-mime is
 * loaded lazily so workers that never call this don't bundle it.
 *
 * For proxy messages (built via `createMessageProxy`) the raw bytes are
 * cached on first read so subsequent `parseEmail`/`message.raw` accesses
 * still work. For real CF `ForwardableEmailMessage`s the raw stream is
 * one-shot.
 */
export async function parseEmail(message: ForwardableEmailMessage): Promise<ParsedEmail> {
  if (message.rawSize > MAX_INBOUND_BYTES) {
    throw new ParseEmailError(
      'INBOUND_TOO_LARGE',
      `parseEmail: message size ${message.rawSize} bytes exceeds maximum of ${MAX_INBOUND_BYTES} bytes.`,
    );
  }
  const { default: PostalMime } = await import('postal-mime');
  const cached = proxyRawCache.get(message);
  try {
    // Acquire inside the guard: on an own-account deploy the generated
    // handler wraps Cloudflare's native one-shot `raw`, so a mid-delivery
    // stream failure must also surface as `ParseEmailError`.
    const source = cached ? await cached.read() : message.raw;
    return await PostalMime.parse(source);
  } catch (cause) {
    // postal-mime is lenient — binary garbage, truncated parts and bad
    // header bytes all parse. What it does reject is a nesting bomb (>256
    // levels), and a one-shot `raw` stream can fail on a real CF message.
    throw new ParseEmailError(
      'PARSE_FAILED',
      `parseEmail: could not parse the message body. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Per-proxy raw-bytes cache. Keyed by the proxy `ForwardableEmailMessage`
 * so `parseEmail()` (and any other reader) can replay the bytes without
 * consuming the underlying ReadableStream. Real CF messages are not in
 * the map, so they fall through to the one-shot stream behaviour.
 */
interface RawCache {
  read(): Promise<Uint8Array>;
}
const proxyRawCache = new WeakMap<ForwardableEmailMessage, RawCache>();

/** Inbound message decoded from the authenticated gateway request. */
export interface EmailEnvelope {
  from: string;
  to: string;
  /** Decoded header metadata. */
  headers: Record<string, string>;
  /**
   * Raw RFC 5322 bytes. The message proxy caches them for repeated reads.
   */
  raw: ReadableStream<Uint8Array> | Uint8Array;
  rawSize: number;
  /**
   * Exact custom domain selected by the gateway. Custom-domain recipients
   * have no project-slug prefix; replies default to the received address.
   */
  viaDomain?: string;
}

/** Handler intents, validated and admitted by the gateway before delivery. */
export type EmailAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Record<string, string> }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

export interface MessageProxy {
  message: ForwardableEmailMessage;
  getActions(): Array<EmailAction>;
}

export interface CreateMessageProxyOptions {
  /**
   * Project slug stripped from the `<slug>+<tag>` recipient by the
   * dispatcher. When set, `message.to` is rewritten to the bare
   * `<tag>@<domain>` form so user handlers see clean addresses (the slug
   * is platform-internal). The original `<slug>+<tag>@<domain>` is
   * preserved on a non-enumerable `__voidPlatformTo` property for
   * diagnostics.
   */
  slug?: string;
}

/**
 * Remove the platform-injected `<slug>+` prefix from a recipient address.
 * The platform's shared sender (e.g. `mail.example.com`) rewrites every recipient to
 * `<slug>+<tag>@<domain>`; user handlers expect `<tag>@<domain>`. If the
 * slug is unknown, missing, or doesn't match the local-part prefix, the
 * address is returned unchanged so callers without slug context (e.g. the
 * test harness when no slug is set) don't accidentally mangle the address.
 */
function stripSlugFromAddress(address: string, slug: string | undefined): string {
  if (!slug) {
    return address;
  }
  const atIdx = address.indexOf('@');
  if (atIdx <= 0) {
    return address;
  }
  const localPart = address.slice(0, atIdx);
  const domain = address.slice(atIdx);
  // Match `<slug>+...` case-insensitively. If the local-part starts with
  // the slug followed by `+`, drop the `<slug>+` segment.
  const slugLower = slug.toLowerCase();
  const prefix = `${slugLower}+`;
  if (localPart.toLowerCase().startsWith(prefix)) {
    return localPart.slice(prefix.length) + domain;
  }
  return address;
}

function replyTooLarge(size: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `reply: message size ${size} bytes exceeds Void's sending limit of ${MAX_REPLY_BYTES} bytes.`,
  );
}

function replyBudgetExhausted(size: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `reply: serialized actions would use ${size} bytes, over this delivery's ` +
      `${EMAIL_MAX_RESPONSE_BYTES}-byte response budget.`,
  );
}

function queueFull(): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `email: handler queued more than ${MAX_ACTIONS} actions for one message.`,
  );
}

function addressTooLong(field: 'from' | 'to', length: number): MimeError {
  return new MimeError(
    field === 'from' ? 'INVALID_FROM' : 'INVALID_TO',
    `${field} address is ${length} characters, over the ${MAX_ACTION_ADDRESS_LENGTH}-character limit.`,
  );
}

function invalidForwardHeaders(cause: unknown): MimeError {
  // The runtime's own message names the offending name or value. A handler
  // may have built that value from the inbound message, so it is bounded.
  const detail = cause instanceof Error ? cause.message.slice(0, 320) : 'not a valid header set';
  return new MimeError('MIME_ERROR', `forward: invalid header — ${detail}`);
}

/**
 * The router's `forwardHeadersWithinBounds`, as a throw. It runs on the
 * record about to be recorded — the very object the router receives, so the
 * count is the router's count: a `Headers` folded its duplicate names before
 * it got here, and a record keeps `X-A` and `x-a` as two, both there and
 * here. Runs after the `new Headers()` validity check, so every name is a
 * token and every value is header-safe; what is left is size. The router
 * drops the WHOLE list on any of these — a handler that passed here and
 * failed there deployed as one whose managed delivery performed no actions.
 */
function assertForwardHeadersWithinBounds(headers: Record<string, string>): void {
  const names = Object.keys(headers);
  if (names.length > MAX_FORWARD_HEADERS) {
    throw new MimeError(
      'MIME_ERROR',
      `forward: ${names.length} headers, over the ${MAX_FORWARD_HEADERS}-header limit.`,
    );
  }
  for (const name of names) {
    if (name.length > MAX_FORWARD_HEADER_LENGTH) {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header name is ${name.length} characters, over the ${MAX_FORWARD_HEADER_LENGTH}-character limit.`,
      );
    }
    // The declared value type is `string`, and the router refuses anything
    // else: `new Headers()` coerces an Array with `String()`, so a non-string
    // value has no `length` the bound below could measure.
    const value: unknown = headers[name];
    if (typeof value !== 'string') {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header "${name.slice(0, 64)}" value is not a string.`,
      );
    }
    if (value.length > MAX_FORWARD_HEADER_LENGTH) {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header "${name.slice(0, 64)}" value is ${value.length} characters, over the ${MAX_FORWARD_HEADER_LENGTH}-character limit.`,
      );
    }
  }
}

/**
 * The router's rule for a reject reason (`validateActions` in
 * `email-router.ts`: `sanitize(raw, MAX_REJECT_REASON_LENGTH)`, and
 * `'rejected by handler'` for an empty one), applied when the reason is
 * RECORDED so the native replay carries the string the managed one does.
 *
 * The reason goes into the SMTP reply to the connecting client, and a
 * handler may build it from the inbound message: a remote sender's CRLF is
 * then a line injected into that reply, and a multi-megabyte reason is a
 * transient-heap amplifier. The router already refuses both; normalizing at
 * record time covers the native `setReject()` replay on your own account
 * too. NORMALIZED rather than refused, unlike the forward bounds
 * above: a reject is the handler's terminal decision, and throwing out of
 * it would drop that decision and bounce the message as a dispatch error
 * (see the `MAX_ACTIONS` note in `setReject`). Slice FIRST, then replace: a
 * global replace materializes ~66 bytes per match, so the slice is what
 * bounds the work (see `prefixReplySubject`). The result can be SHORTER
 * than the cap: a run of controls inside the window collapses to one space
 * and the window is not refilled from beyond it — the router's own trade,
 * and it is DSN text.
 */
function normalizeRejectReason(reason: string): string {
  // A JS handler can pass anything; the router treats a non-string as empty.
  const raw = typeof reason === 'string' ? reason : '';
  if (raw.length === 0) {
    return 'rejected by handler';
  }
  return (
    raw
      .slice(0, MAX_REJECT_REASON_LENGTH)
      // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
  );
}

async function readStreamToBytes(
  stream: ReadableStream<Uint8Array>,
  limit = Infinity,
  // The caller decides what crossing `limit` MEANS: a single reply over
  // `MAX_MESSAGE_BYTES`, or the cumulative budget running out mid-stream.
  // Without this the second case would be reported as the first, naming a
  // limit the reply never reached.
  onOverflow: (total: number) => MimeError = replyTooLarge,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const deadline = Date.now() + EMAIL_STREAM_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MimeError('MIME_ERROR', 'email stream timed out');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new MimeError('MIME_ERROR', 'email stream timed out')),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        throw onOverflow(total);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation is cleanup, not part of the stream deadline. A custom
    // handler stream may never settle its underlying cancel algorithm.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build a proxy `ForwardableEmailMessage` from an envelope. The proxy's
 * `setReject` / `forward` / `reply` methods don't dispatch directly — they
 * record `EmailAction` entries that the router (which holds the real
 * message) enacts after the handler returns.
 *
 * `reply()` accepts a duck-typed `{ from, to, raw }` with `raw` a
 * `Uint8Array` or `ReadableStream` — what `replyEmail()` passes. It does NOT
 * accept a native `EmailMessage` from `cloudflare:email`: that class exposes
 * only `from` and `to` (workers-types declares nothing else, and the body
 * has no public accessor), so its bytes cannot be recorded here, and nothing
 * could encode them for the gateway. The reply MIME bytes are
 * buffered before being recorded so the action is fully self-contained.
 *
 * When `opts.slug` is provided, `message.to` is rewritten to remove the
 * platform-injected `<slug>+` prefix so handlers see `<tag>@<domain>`
 * instead of `<slug>+<tag>@<domain>`. The original wire-form recipient is
 * preserved on a non-enumerable `__voidPlatformTo` property.
 */
export function createMessageProxy(
  envelope: EmailEnvelope,
  opts: CreateMessageProxyOptions = {},
): MessageProxy {
  const actions: Array<EmailAction> = [];
  const headers = new Headers(envelope.headers);

  // A relayed recipient carries no `<slug>+` prefix (the relay lane is
  // authenticated by the domain's relay secret, and `viaDomain` names that
  // domain), so the slug is inert here even if a caller passed one — the
  // generated `handleEmail` already suppresses it, and this keeps a
  // coincidental `<slug>+` local-part prefix from being stripped off a
  // customer-domain address.
  const slug =
    envelope.viaDomain === undefined || envelope.viaDomain === '' ? opts.slug : undefined;

  // Strip the platform-injected `<slug>+` prefix from message.to so handler
  // authors see the same address shape they wrote in `email/<addr>.ts`. The
  // dispatcher strips the same prefix for routing; mirroring it here keeps
  // the user-visible envelope consistent with the routing surface.
  const userVisibleTo = stripSlugFromAddress(envelope.to, slug);

  // Cache raw bytes lazily so repeated reads (e.g. parseEmail() followed by
  // anything touching message.raw) work. Real CF messages are one-shot, but
  // the proxy is what user handlers see in tests + the platform router, and
  // they reasonably expect raw to be replayable since the envelope is
  // already pre-buffered by the router.
  let cachedRaw: Uint8Array | undefined;
  let bufferingPromise: Promise<Uint8Array> | undefined;
  function readRawOnce(): Promise<Uint8Array> {
    if (cachedRaw) {
      return Promise.resolve(cachedRaw);
    }
    if (bufferingPromise) {
      return bufferingPromise;
    }
    const source = envelope.raw;
    if (source instanceof Uint8Array) {
      cachedRaw = source;
      return Promise.resolve(cachedRaw);
    }
    bufferingPromise = readStreamToBytes(source).then((bytes) => {
      cachedRaw = bytes;
      return bytes;
    });
    return bufferingPromise;
  }

  // If the envelope already gave us bytes, expose them eagerly via the cache
  // so the WeakMap lookup in parseEmail short-circuits to a sync resolve.
  if (envelope.raw instanceof Uint8Array) {
    cachedRaw = envelope.raw;
  }

  let rejected = false;
  // The gateway counts every metadata/raw frame and the terminal frame, so
  // reserve that terminal here and reject an action before recording it.
  let actionWireBytesUsed = EMAIL_ACTION_TERMINAL_BYTES;
  let pendingReplies = 0;
  let replyRecordingTail: Promise<void> = Promise.resolve();

  function recordAction(action: EmailAction): boolean {
    if (rejected) {
      return false;
    }
    if (actions.length >= MAX_ACTIONS) {
      throw queueFull();
    }
    const nextSize = actionWireBytesUsed + emailActionWireSize(action);
    if (nextSize > EMAIL_MAX_RESPONSE_BYTES) {
      throw replyBudgetExhausted(nextSize);
    }
    actions.push(action);
    actionWireBytesUsed = nextSize;
    return true;
  }

  // `actions` only ever grows through forward/reply, and `setReject` purges
  // both, so length IS the queue depth.
  function assertQueueHasRoom(): void {
    if (actions.length + pendingReplies >= MAX_ACTIONS) {
      throw queueFull();
    }
  }

  const message = {
    from: envelope.from,
    to: userVisibleTo,
    headers,
    // `raw` is accessed as a property by user code and postal-mime. Return a
    // fresh ReadableStream each access, backed by the cached bytes (or
    // buffering on first read for stream envelopes).
    get raw(): ReadableStream<Uint8Array> {
      if (cachedRaw) {
        return bytesToReadableStream(cachedRaw);
      }
      // Stream envelope, not yet buffered. Tee-style: kick off buffering
      // and return a stream that pulls from the eventual bytes. This keeps
      // synchronous getter semantics while ensuring later accesses replay.
      const pending = readRawOnce();
      return new ReadableStream({
        async start(controller) {
          const bytes = await pending;
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    rawSize: envelope.rawSize,
    setReject(reason: string) {
      if (rejected) {
        return; // already rejected; ignore second reject
      }
      rejected = true;
      // Reject is terminal and replaces queued deliveries, so it must remain
      // available even when the action queue is full.
      let dropped = 0;
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        if (a.type === 'forward' || a.type === 'reply') {
          actions.splice(i, 1);
          dropped++;
        }
      }
      if (dropped > 0) {
        console.warn(
          `[void/email] setReject() after ${dropped} forward/reply call(s) — those actions were dropped. ` +
            'CF rejects are terminal: anything queued before setReject() never runs. ' +
            'Move the reject earlier in the handler.',
        );
      }
      const action = { type: 'reject' as const, reason: normalizeRejectReason(reason) };
      actions.push(action);
      actionWireBytesUsed = EMAIL_ACTION_TERMINAL_BYTES + emailActionWireSize(action);
    },
    async forward(to: string, fwdHeaders?: Headers | Record<string, string>) {
      if (rejected) {
        console.warn(
          '[void/email] forward() called after setReject() — ignored. ' +
            'CF rejects are terminal: nothing else runs once setReject fires.',
        );
        return;
      }
      assertQueueHasRoom();
      if (to.length > MAX_ACTION_ADDRESS_LENGTH) {
        throw addressTooLong('to', to.length);
      }
      // Validate the bare address before recording any delivery intent.
      validateAddressParts('to', to);
      // Accept both `Headers` (matches CF's runtime signature) and a plain
      // `Record<string, string>`. `Headers.entries()` lowercases keys per
      // spec; users who care about preserving header casing in the wire
      // form (e.g. for diagnostic headers like `X-Void-Trace`) can pass
      // the record form instead.
      let headersObj: Record<string, string> | undefined;
      if (fwdHeaders instanceof Headers) {
        headersObj = Object.fromEntries(fwdHeaders.entries());
      } else if (fwdHeaders) {
        // Validate now to avoid partial delivery during native replay. Keep
        // the record itself so caller-provided header casing is preserved.
        try {
          void new Headers(fwdHeaders);
        } catch (e) {
          throw invalidForwardHeaders(e);
        }
        headersObj = { ...fwdHeaders };
      }
      // Size, after validity, on the record that is stored — for both forms.
      // The router applies these bounds to that record and drops the whole
      // list; here they fail the handler's own call, recording nothing.
      if (headersObj) {
        assertForwardHeadersWithinBounds(headersObj);
      }
      const action = {
        type: 'forward' as const,
        to,
        ...(headersObj ? { headers: headersObj } : {}),
      };
      if (new TextEncoder().encode(JSON.stringify(action)).byteLength > MAX_ACTION_METADATA_BYTES) {
        throw new MimeError(
          'MIME_ERROR',
          `forward: action metadata exceeds ${MAX_ACTION_METADATA_BYTES} bytes.`,
        );
      }
      void recordAction(action);
    },
    async reply(reply: { from: string; to: string; raw: ReadableStream<Uint8Array> | Uint8Array }) {
      if (rejected) {
        console.warn(
          '[void/email] reply() called after setReject() — ignored. ' +
            'CF rejects are terminal: nothing else runs once setReject fires.',
        );
        return;
      }
      // Everything cheap first, so a doomed reply never buffers its stream.
      assertQueueHasRoom();
      if (reply.from.length > MAX_ACTION_ADDRESS_LENGTH) {
        throw addressTooLong('from', reply.from.length);
      }
      if (reply.to.length > MAX_ACTION_ADDRESS_LENGTH) {
        throw addressTooLong('to', reply.to.length);
      }
      // Same rule as `forward(to)` above, for the hand-built reply form:
      // `replyEmail()` already goes through `normalizeEmail`, but a caller
      // who passes `{ from, to, raw }` bypasses it, and otherwise only
      // Cloudflare's native `reply()` would refuse a malformed address —
      // after every earlier action had fired. Both are bare addresses.
      validateAddressParts('from', reply.from);
      validateAddressParts('to', reply.to);
      pendingReplies++;
      const previousReply = replyRecordingTail;
      let releaseReply!: () => void;
      replyRecordingTail = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      await previousReply;
      try {
        if (rejected) {
          console.warn(
            '[void/email] reply() completed after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
          return;
        }
        // `replyEmail()` is bounded by `buildMime`; a hand-built reply is not, so
        // bound it here before the bytes travel to the proxy (or to native reply).
        const metadataOnlyAction = {
          type: 'reply' as const,
          from: reply.from,
          to: reply.to,
          raw: new Uint8Array(),
        };
        const replyFrameBytes = emailActionWireSize(metadataOnlyAction);
        const remaining = EMAIL_MAX_RESPONSE_BYTES - actionWireBytesUsed - replyFrameBytes;
        if (remaining < 0) {
          throw replyBudgetExhausted(EMAIL_MAX_RESPONSE_BYTES - remaining);
        }
        let rawBytes: Uint8Array;
        if (reply.raw instanceof Uint8Array) {
          if (reply.raw.byteLength > MAX_REPLY_BYTES) {
            throw replyTooLarge(reply.raw.byteLength);
          }
          if (reply.raw.byteLength > remaining) {
            throw replyBudgetExhausted(
              actionWireBytesUsed + replyFrameBytes + reply.raw.byteLength,
            );
          }
          rawBytes = reply.raw;
        } else {
          // A native `EmailMessage` lands here: `from` and `to` only, no `raw`.
          // Name the problem instead of failing on `undefined.getReader()`,
          // which in platform mode is a generic "project handler error" bounce
          // with nothing a handler author could act on.
          const raw: unknown = reply.raw;
          if (
            typeof raw !== 'object' ||
            raw === null ||
            typeof (raw as ReadableStream<Uint8Array>).getReader !== 'function'
          ) {
            throw new MimeError(
              'MIME_ERROR',
              'reply: expected { from, to, raw } with raw as a Uint8Array or ReadableStream. ' +
                'A native EmailMessage cannot be replayed from a Void handler — its body has ' +
                'no public accessor. Use replyEmail() from void/email, or pass the MIME bytes as raw.',
            );
          }
          // The REMAINING budget, not the per-reply cap — an earlier reply has
          // already spent part of it, and the stream must stop where the budget
          // does. Whichever bound is lower is the one that fires, so the
          // callback names the one that actually bound this read.
          const limit = Math.min(MAX_REPLY_BYTES, remaining);
          rawBytes = await readStreamToBytes(reply.raw, limit, (total) =>
            limit === MAX_REPLY_BYTES
              ? replyTooLarge(total)
              : replyBudgetExhausted(actionWireBytesUsed + replyFrameBytes + total),
          );
        }
        if (!recordAction({ type: 'reply', from: reply.from, to: reply.to, raw: rawBytes })) {
          console.warn(
            '[void/email] reply() completed after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
        }
      } finally {
        pendingReplies--;
        releaseReply();
      }
    },
  } as unknown as ForwardableEmailMessage;

  // Preserve the original wire-form `<slug>+<tag>@<domain>` recipient for
  // platform-side diagnostics without surfacing it to user handlers (most
  // handlers should never need this — they read `message.to` and expect the
  // clean form they wrote in `email/<addr>.ts`). Non-enumerable so JSON
  // serialization, structured-clone, and `Object.entries` don't leak it.
  if (envelope.to !== userVisibleTo) {
    Object.defineProperty(message, '__voidPlatformTo', {
      value: envelope.to,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  // Mark the relay lane: the platform proved the domain's relay secret, so
  // `viaDomain` names the one registered domain this message arrived on.
  // `buildReplyMessage` reads the marker to default `from` to the address
  // that received the message (on the customer domain) instead of the
  // shared-sender `<slug>+noreply@<platform domain>` default — the platform
  // pins a relayed reply to the receiving project's registered domains.
  // Non-enumerable for the same reason as `__voidPlatformTo` above.
  if (typeof envelope.viaDomain === 'string' && envelope.viaDomain.length > 0) {
    Object.defineProperty(message, '__voidRelayDomain', {
      value: envelope.viaDomain,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  // Register cache entry so parseEmail() can replay bytes without consuming
  // the proxy's `raw` getter (which would otherwise hand out a fresh stream
  // per access — fine for correctness but wasteful for large messages).
  proxyRawCache.set(message, { read: readRawOnce });

  return { message, getActions: () => [...actions] };
}

/**
 * Whether `Name: value` can be emitted without breaking RFC 5322 §2.1.1.
 *
 * Folding only happens at whitespace (§3.2.2), so the widest unbreakable run
 * is what decides it — a `References` chain of ordinary ids folds fine however
 * long, while one oversized id inside it does not.
 */
function fitsHeaderLine(name: string, value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  // A predicate, not a maximum, in one pass that allocates nothing. Spreading
  // the token list into `Math.max` throws `RangeError` past ~123k arguments
  // (measured on workerd), and `split(/\s+/)` materializes every token before
  // `.some()` looks at the first — over 30 bytes of heap each, so 10 MiB of
  // two-character ids (3.5M tokens, inside MAX_INBOUND_BYTES) measured 134 MB
  // and terminates a 128 MB isolate before the predicate can answer. This
  // guard exists to stop a hostile header making the app's reply throw, so it
  // must be neither the thing that throws nor the thing that runs out of
  // memory.
  //
  // A run ends only at SP or HTAB. That is the whitespace `foldHeader` folds
  // at (§3.2.2 FWS), and a threading value is emitted verbatim, so treating
  // the rest of `\s` (NBSP, FF, VT …) as a break would pass a value the
  // folder cannot break. Counting through them is the strict direction: it
  // can only refuse a value, never pass one that fails.
  const budget = 998 - (name.length + 2);
  let run = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x20 || c === 0x09) {
      run = 0;
      continue;
    }
    // UTF-8 octets, as `TextEncoder` would count them: a surrogate pair is one
    // 4-octet code point, and a lone surrogate encodes as U+FFFD (3 octets).
    if (c < 0x80) {
      run += 1;
    } else if (c < 0x800) {
      run += 2;
    } else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < value.length &&
      (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      run += 4;
      i++;
    } else {
      run += 3;
    }
    if (run > budget) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `value` carries a C0 control other than HTAB, or DEL. The
 * sibling of `fitsHeaderLine` for the other way a remote-controlled id can
 * be unrepresentable: a threading value is emitted verbatim, so a control
 * inside it would reach the reply's `In-Reply-To` / `References` line raw —
 * `\x01` and DEL pass a WHATWG `Headers`, which refuses only CR, LF and
 * NUL — and an RFC 5322 §3.6.4 `msg-id` is `dot-atom-text`, which admits no
 * control at all. HTAB is not one here: it is the whitespace that separates
 * ids (§3.2.2 FWS), the same break `fitsHeaderLine` and `replyReferences`
 * cut at. One pass, no allocation, so it costs nothing a hostile header can
 * multiply; never a throw, for the same reason as the line guard.
 */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * `chain` without any id that `hasControl` refuses, the rest in their order
 * and joined by single spaces; the chain itself when there is nothing to
 * drop, without allocating. Only ONE id is lost — the others still thread —
 * whereas an id no line can carry drops the whole chain for the parent's id
 * (`replyReferences`), because that guard is about the rendered line and
 * this one is about one token. Called only on a chain already cut to
 * `MAX_REPLY_REFERENCES_CHARS`, so the per-id slices in the rare bad case
 * are bounded by that budget, not by the header a remote sender delivered.
 */
function dropControlIds(chain: string): string {
  if (!hasControl(chain)) {
    return chain;
  }
  const kept: Array<string> = [];
  let start = -1;
  let tainted = false;
  for (let i = 0; i <= chain.length; i++) {
    const c = i < chain.length ? chain.charCodeAt(i) : 0x20;
    if (c === 0x20 || c === 0x09) {
      if (start >= 0 && !tainted) {
        kept.push(chain.slice(start, i));
      }
      start = -1;
      tainted = false;
    } else {
      if (start < 0) {
        start = i;
      }
      if (c < 0x20 || c === 0x7f) {
        tainted = true;
      }
    }
  }
  return kept.join(' ');
}

export interface ReplyEmailOptions {
  /**
   * On the managed platform (a `__VOID_PROJECT_SLUG` is injected) defaults
   * to `<__VOID_PROJECT_SLUG>+noreply@<__VOID_EMAIL_DOMAIN>`, and THROWS
   * when the domain binding is absent — a reply sender is never guessed.
   *
   * There, an override must stay on your own slug. The platform accepts a
   * reply sender whose local-part before the first `+` equals the slug the
   * message was delivered to; anything else is dropped silently. In
   * particular `message.to` is the STRIPPED address (`<tag>@<domain>`), so
   * passing it here is exactly the shape the platform rejects.
   *
   * Without a slug (your own Cloudflare account, local harnesses) the
   * default is the address the message was delivered to, `message.to` —
   * a real address on your own zone.
   */
  from?: Address;
  /**
   * Defaults to the original `message.from` envelope address. A reply is a
   * single-recipient message — for fan-out, build a fresh `sendEmail()` call.
   */
  to?: Address;
  /**
   * Defaults to `Re: <original-subject>` (no double-prefix). The original is
   * remote-sender controlled, so the default is best-effort: control
   * characters become a space, and a subject over 4096 characters, or an
   * ASCII one too long to fold, falls back to a bare `Re:`. Pass `subject`
   * to control it exactly.
   */
  subject?: string;
  text?: string;
  html?: string;
  /**
   * Custom headers; threading headers (`In-Reply-To`, `References`) are
   * added automatically, best-effort: an inbound id too long for a header
   * line is dropped, and a `References` chain over 8 KiB keeps only its
   * newest ids.
   */
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
}

/**
 * Longest decoded inbound `Subject` the default reply subject is built from;
 * anything longer falls back to a bare `Re:`.
 *
 * RFC 5322 §2.1.1 caps a header LINE at 998 octets, and only folding lets a
 * header run past it — so a subject is something that fits on a line or
 * two. Real ones are tens to hundreds of characters; the longest automated
 * ones (a ticket title under a stack of list tags) reach a few hundred, and
 * Exchange rejects past 255. Four thousand keeps every one of those with an
 * order of magnitude to spare and refuses the shape that is only a subject
 * in name. What the bound buys is proportional cost: the control-character
 * replacements below cost 66 bytes of heap per match, so at this size they
 * cost at most 135 KB, and the reply's own `Subject` line is at most ~20 KB
 * — 4096 code units x 3 UTF-8 octets, base64'd in 45-octet encoded-words
 * with their framing — against a `MAX_MESSAGE_BYTES` of 5 MiB, so the
 * subject alone can never push the reply over the limit.
 */
const MAX_REPLY_SUBJECT_CHARS = 4096;

function prefixReplySubject(original: string): string {
  // Decode RFC 2047 encoded-words first so we (a) detect existing
  // `Re:` prefixes inside encoded subjects (avoids `Re: =?UTF-8?B?...?=`
  // becoming `Re: Re: foo` after the recipient's mailer decodes), and
  // (b) re-encode cleanly via buildMime's encodeWord on the prefixed
  // string instead of stacking encoded-words.
  //
  // The inbound subject is remote-sender controlled, and two things
  // downstream throw on it: `normalizeEmail` rejects CR, LF and NUL, and
  // `buildMime` rejects a header line over 998 octets or a message over
  // `MAX_MESSAGE_BYTES`. A throw here is not the app's fault, and in
  // production it rejects the whole delivery — the reply AND any forward
  // the handler queued. So, as with the threading headers below, the
  // subject is best-effort: C0 controls (a decoded `=00`, `=0A`, or a
  // B-encoded NUL) become a single space, and three shapes fall back to a
  // bare `Re:` — an empty subject, one over `MAX_REPLY_SUBJECT_CHARS`, and
  // an ASCII one no line can carry.
  //
  // The bound is checked BEFORE the replacements, on the decoded string.
  // A global `replace` materializes one part per match before it builds the
  // result — about 66 bytes each — and the inbound header can be the whole
  // 10 MiB message: 5 MiB of alternating tab and letter measured 165 MB on
  // the first replacement alone and terminated a 128 MB isolate, which is
  // the tenant's. It is the DECODED length that is bounded, not the raw
  // header's: an encoded-word is always at least as long as what it decodes
  // to (base64 is 4/3 of its bytes plus `=?UTF-8?B?…?=` per 45 of them, and
  // a Q-encoded 3-octet character is nine characters), so a raw bound would
  // refuse a CJK subject of under a thousand characters whose decoded form
  // fits. The decode is one linear pass that holds only its output, already
  // made to survive the 10 MiB case (see `quotedPrintableDecode` below) —
  // accuracy for a pass that is paid either way.
  const decoded = decodeRfc2047(original);
  if (decoded.length > MAX_REPLY_SUBJECT_CHARS) {
    return 'Re:';
  }
  const cleaned = decoded
    // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!cleaned) {
    return 'Re:';
  }
  const prefixed = /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
  // Only a pure-ASCII subject can fail to fold: anything else goes through
  // `encodeWord`, which splits it into 75-character encoded-words joined
  // by spaces, and those fold. An ASCII token wider than a line cannot.
  if (/^[\x20-\x7e]*$/.test(prefixed) && !fitsHeaderLine('Subject', prefixed)) {
    return 'Re:';
  }
  return prefixed;
}

/**
 * Longest `References` value a reply carries, in UTF-16 code units — the
 * measure `MAX_REPLY_SUBJECT_CHARS` uses. It is checked on `length` alone,
 * so a chain the size of the inbound message costs one property read before
 * anything is scanned or sliced.
 *
 * RFC 5322 puts no limit on the field, but everything downstream does. RFC
 * 5537 §3.4.4 has a followup agent trim it to 998 characters, and Postfix's
 * `header_size_limit` discards header bytes past 100 KiB. A message-id is
 * tens of characters, so 8 KiB carries a chain over a hundred replies deep
 * with every id intact — an order of magnitude past any conversation — and
 * a value this size, folded and encoded, is at most ~25 KB of a 5 MiB
 * reply, so the chain alone can never push the reply over the limit.
 * Unbounded, it could: the inbound header can be the whole 10 MiB message,
 * and short ids pass the line guard — every id folds — yet `foldHeader`'s
 * continuations would put the rendered reply over `MAX_MESSAGE_BYTES`.
 *
 * Past the bound the NEWEST ids are kept, whole, and the parent's id still
 * ends the chain. That is what a mail client threads on: it links the reply
 * under any id it recognises, and the parent is also `In-Reply-To`. The
 * root id RFC 5537 keeps is a Netnews convention (a newsreader identifies a
 * thread by it); in mail it would spend the budget on an id older than
 * every client in the conversation.
 */
const MAX_REPLY_REFERENCES_CHARS = 8192;

/**
 * The `References` value a reply carries, or `''` when nothing can be
 * threaded. In order: the whole inbound chain continued by the parent's
 * `messageId` when it fits `MAX_REPLY_REFERENCES_CHARS`; otherwise the
 * newest ids of the chain that fit, none of them split; and the parent's id
 * alone (which may be empty) when even those hold an id no line can carry.
 */
function replyReferences(originalReferences: string, messageId: string): string {
  const parent = messageId ? ` ${messageId}` : '';
  let chain = originalReferences;
  const budget = MAX_REPLY_REFERENCES_CHARS - parent.length;
  if (chain.length > budget) {
    // Keep the tail, from the first SP or HTAB at or after the cut so no id
    // is split — the breaks `foldHeader` folds at, as in `fitsHeaderLine`.
    // The scan and the slice are bounded by the budget, not by the header.
    let cut = chain.length - budget;
    while (cut < chain.length) {
      const c = chain.charCodeAt(cut);
      if (c === 0x20 || c === 0x09) {
        break;
      }
      cut++;
    }
    chain = chain.slice(cut);
  }
  // After the cut, so the only chain this ever walks is one the budget
  // already bounds. `parent` was checked by the caller and is never dropped.
  chain = dropControlIds(chain);
  chain = `${chain}${parent}`.trim();
  // A chain folds at its spaces, so one this long is fine; it is a single
  // oversized id inside it that is not.
  return fitsHeaderLine('References', chain) ? chain : messageId;
}

/**
 * Minimal RFC 2047 encoded-word decoder. Handles `=?charset?B?base64?=`
 * and `=?charset?Q?quoted-printable?=` segments separated by optional
 * whitespace. Unknown charsets pass through (best-effort UTF-8 decode);
 * malformed inputs return the original.
 *
 * Scope is intentionally narrow — used only for cosmetic subject
 * normalization in `prefixReplySubject`. Anything that needs robust
 * decoding (e.g. searching subject text) should use postal-mime's
 * parsed view via `parseEmail`.
 */
function decodeRfc2047(value: string): string {
  if (!value.includes('=?')) {
    return value;
  }
  try {
    // One encoded-word at a time. `replace` with a callback collects every
    // match — result array, captures and all — before the callback runs
    // once, so a 10 MiB subject of tiny encoded-words (750k of them, inside
    // MAX_INBOUND_BYTES) needed 138 MB on the reply path and terminated a
    // 128 MB isolate. `matchAll` is lazy: the same path needs 35 MB, and what
    // is kept is the decoded output.
    const parts: Array<string> = [];
    let last = 0;
    for (const m of value.matchAll(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=(?:\s+(?==\?))?/g)) {
      const [match, charset, enc, payload] = m;
      const bytes =
        enc.toUpperCase() === 'B' ? base64Decode(payload) : quotedPrintableDecode(payload);
      // Honor the charset declared in the encoded-word. Q-encoded
      // ISO-8859-1 / Windows-1252 subjects are still common in mail
      // from older systems; decoding them as UTF-8 mojibakes any
      // byte ≥ 0x80. TextDecoder rejects unknown labels by throwing,
      // so fall back to UTF-8 only when the requested charset isn't
      // supported (better than leaving the raw encoded-word in place).
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(charset || 'utf-8', { fatal: false });
      } catch {
        decoder = new TextDecoder('utf-8', { fatal: false });
      }
      parts.push(value.slice(last, m.index), decoder.decode(bytes));
      last = m.index + match.length;
    }
    parts.push(value.slice(last));
    return parts.join('');
  } catch {
    return value;
  }
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function quotedPrintableDecode(qp: string): Uint8Array {
  // RFC 2047 Q-encoding: `_` = space, `=XX` = hex byte, otherwise literal.
  //
  // Decode straight into a typed array. The payload regex in `decodeRfc2047`
  // accepts whitespace, so an unfolded 10 MiB `Subject` is ONE encoded-word
  // and this loop sees every character of it. An `Array<number>` would hold
  // one boxed element per character (about 200 MB for 10 MiB of Q text). Every
  // input character yields at most one output byte, so `qp.length` is the
  // exact upper bound and the decode holds nothing but the output.
  const out = new Uint8Array(qp.length);
  let kept = 0;
  for (let i = 0; i < qp.length; i++) {
    const ch = qp.charCodeAt(i);
    if (ch === 0x5f /* _ */) {
      out[kept++] = 0x20;
    } else if (ch === 0x3d /* = */ && i + 2 < qp.length) {
      // Both characters must be hex: `parseInt('0G', 16)` is 0, not NaN. A
      // malformed escape stays literal, which is what RFC 2045 §6.7 asks of a
      // robust decoder and what postal-mime does.
      const hex = qp.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[kept++] = parseInt(hex, 16);
        i += 2;
      } else {
        out[kept++] = ch;
      }
    } else {
      out[kept++] = ch;
    }
  }
  return out.subarray(0, kept);
}

/**
 * Pure helper: build the reply MIME from an inbound message + reply opts,
 * with `Subject: Re: …` (no double-prefix), `In-Reply-To`, and `References`
 * threaded from the original. Threading is best-effort (the inbound values
 * are remote-sender controlled): an id no header line can carry is dropped,
 * and a `References` chain over `MAX_REPLY_REFERENCES_CHARS` is trimmed to
 * its newest ids. Exposed separately so the dispatch step (`message.reply`)
 * can be tested without `cloudflare:email`.
 */
export async function buildReplyMessage(
  message: ForwardableEmailMessage,
  opts: ReplyEmailOptions,
): Promise<{ from: string; to: string; raw: Uint8Array; subject: string }> {
  const headers = message.headers;
  const originalSubject = headers.get('Subject') ?? '';
  const originalMessageId = headers.get('Message-ID') ?? '';
  const originalReferences = headers.get('References') ?? '';

  // Default `from` for the reply. On the platform (a slug is injected),
  // build `<slug>+noreply@<domain>` from the slug and mail domain. Falling
  // back to `message.to` there would reply from the user-visible
  // (slug-stripped) address, which the platform's slug-pin rejects — every
  // outbound on the shared sender must carry `<slug>+...@<domain>`. If the
  // domain binding is missing and the caller didn't provide an explicit
  // `from`, surface a clear error rather than building an invalid
  // envelope. There is deliberately no baked-in domain default: guessing
  // the production zone is exactly the bug the binding exists to prevent.
  //
  // With no slug there is no shared sender to pin to: the message was
  // delivered to a real address on the developer's own zone, and replying
  // from that address is what a reply means.
  //
  // A relayed message (a custom domain on the customer's own Cloudflare
  // zone — the `__voidRelayDomain` marker from `createMessageProxy`) is the
  // same shape as the own-account case even though a slug IS injected:
  // `message.to` is a real address on the customer's domain, the platform
  // pins relayed replies to the receiving project's registered domains, and
  // the send leaves through the customer account's REST send. The shared
  // `<slug>+noreply@<platform domain>` default would fail that pin.
  let fromAddr: Address;
  if (opts.from !== undefined) {
    fromAddr = opts.from;
  } else if (readRelayDomain(message) !== undefined) {
    fromAddr = message.to;
  } else {
    const slug = tryReadProjectSlug();
    if (slug) {
      const domain = tryReadEmailDomain();
      if (!domain) {
        throw new Error(
          "replyEmail: 'from' is required when __VOID_PROJECT_SLUG is set " +
            'but __VOID_EMAIL_DOMAIN is not. Set `from` explicitly, or deploy ' +
            'via Void so the platform-injected __VOID_PROJECT_SLUG and ' +
            '__VOID_EMAIL_DOMAIN can default it to <slug>+noreply@<domain>.',
        );
      }
      fromAddr = `${slug}+noreply@${domain}`;
    } else if (readRawProjectSlug() !== undefined) {
      // A slug IS injected, so this is a platform deployment — it just
      // cannot be a sender, because `<slug>+noreply@` must stay inside RFC
      // 5321's 64-octet local part, which caps the slug at 56 characters.
      // Falling through to `message.to` would build the slug-stripped
      // `<tag>@<domain>` shape that the platform's reply pin drops, with no
      // error reaching the handler.
      throw new Error(
        "replyEmail: 'from' is required — this project's slug cannot build a " +
          'default reply sender (`<slug>+noreply@<domain>` must stay within the ' +
          '64-octet local part, so the slug must be at most 56 characters). ' +
          'Set `from` explicitly.',
      );
    } else {
      fromAddr = message.to;
    }
  }
  const toAddr: Address = opts.to ?? message.from;
  const subject = opts.subject ?? prefixReplySubject(originalSubject);

  // User-supplied `headers` go through the normal (reserved-header
  // filtered) channel; threading headers ride the dedicated `threading`
  // field that buildMime emits unconditionally. This keeps the
  // RESERVED_HEADERS guard against `In-Reply-To`/`References` spoofing
  // from user input intact while letting the trusted reply path emit
  // them.
  //
  // Both values come off the INBOUND message, so a remote sender controls
  // them. `buildMime` rejects any header line over RFC 5322's 998-octet
  // limit, and a message-id has no whitespace to fold at — so threading a
  // hostile one verbatim would let anyone make this app's reply throw, with
  // the app at fault for nothing. Threading is best-effort: drop a value
  // that cannot be represented and still send the reply. A control
  // character is the other way an id is unrepresentable (`hasControl`), and
  // it is dropped the same way rather than refused by `normalizeEmail`.
  const threading: { inReplyTo?: string; references?: string } = {};
  const messageId =
    fitsHeaderLine('In-Reply-To', originalMessageId) && !hasControl(originalMessageId)
      ? originalMessageId
      : '';
  if (messageId) {
    threading.inReplyTo = messageId;
  }
  const references = replyReferences(originalReferences, messageId);
  if (references) {
    threading.references = references;
  }

  const normalized = await normalizeEmail({
    from: fromAddr,
    to: toAddr,
    subject,
    text: opts.text,
    html: opts.html,
    headers: opts.headers,
    attachments: opts.attachments,
    threading: threading.inReplyTo || threading.references ? threading : undefined,
  });
  const { raw } = buildMime(normalized);
  return {
    from: normalized.from.email,
    to: normalized.to[0].email,
    raw,
    subject,
  };
}

/**
 * Send a threading-aware reply to an inbound message. Builds the reply MIME
 * (correct `In-Reply-To` / `References` / `Subject: Re: …`) and records a
 * reply intent on the message proxy. Delivery follows handler completion and,
 * on the platform, authoritative admission.
 *
 * The threading headers are best-effort, since the inbound values they are
 * built from are remote-sender controlled: an id no header line can carry
 * is dropped, and a `References` chain over 8 KiB keeps only its newest
 * ids. The reply is sent either way.
 */
export async function replyEmail(
  message: ForwardableEmailMessage,
  opts: ReplyEmailOptions,
): Promise<void> {
  const { from, to, raw } = await buildReplyMessage(message, opts);
  await (
    message as unknown as {
      reply(arg: { from: string; to: string; raw: Uint8Array }): Promise<void>;
    }
  ).reply({ from, to, raw });
}

/**
 * Recognize native email operations. This structural check is not an
 * authentication boundary; managed entrypoints require receipt authentication.
 */
export function isForwardableEmailMessage(value: unknown): value is ForwardableEmailMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const m = value as { setReject?: unknown; forward?: unknown; reply?: unknown };
  return (
    typeof m.setReject === 'function' &&
    typeof m.forward === 'function' &&
    typeof m.reply === 'function'
  );
}

const INBOUND_PROVIDER_DEADLINE_MS = 30_000;
const INBOUND_ACTION_BATCH_DEADLINE_MS = 60_000;

function createInboundProviderDeadline() {
  const deadline = Date.now() + INBOUND_ACTION_BATCH_DEADLINE_MS;
  return {
    async run<T>(submit: () => Promise<T>): Promise<T> {
      const remaining = Math.min(INBOUND_PROVIDER_DEADLINE_MS, deadline - Date.now());
      if (remaining <= 0) {
        throw new Error('email action batch deadline elapsed before provider submission');
      }
      const work = submit();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'email action provider timed out; outcome unknown, do not retry automatically',
                  ),
                ),
              remaining,
            );
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

/**
 * Replay recorded `EmailAction`s on a real `ForwardableEmailMessage`, in
 * order. The proxy already made `setReject` terminal (earlier forward/reply
 * entries are purged, later ones dropped), so a reject is never followed by
 * anything. `reply` needs a genuine `EmailMessage` — Cloudflare rejects a
 * duck-typed object — so `cloudflare:email` is loaded here, and only when
 * a reply was recorded.
 *
 * The proxy already validated forward headers and normalized reject reasons.
 * Provider refusals still propagate to the native event caller.
 */
export async function enactEmailActions(
  message: ForwardableEmailMessage,
  actions: ReadonlyArray<EmailAction>,
): Promise<void> {
  const providerDeadline = createInboundProviderDeadline();
  for (const action of actions) {
    switch (action.type) {
      case 'reject':
        message.setReject(action.reason);
        break;
      case 'forward':
        await providerDeadline.run(() =>
          message.forward(action.to, action.headers ? new Headers(action.headers) : undefined),
        );
        break;
      case 'reply': {
        const { EmailMessage } = await import('cloudflare:email');
        await providerDeadline.run(() =>
          message.reply(
            new EmailMessage(action.from, action.to, bytesToReadableStream(action.raw)),
          ),
        );
        break;
      }
    }
  }
}
