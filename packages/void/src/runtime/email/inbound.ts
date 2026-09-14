// `ForwardableEmailMessage` is not in workerd's RPC BaseType allowlist, so the
// platform router serializes it into an `EmailEnvelope` and the worker returns
// `EmailAction[]` describing what the handler decided. The router enacts the
// actions on the real message.
//
// On the developer's own Cloudflare account there is no router: Cloudflare
// calls the worker's `email()` with the real message. The same proxy runs the
// handler, and `enactEmailActions` replays the recorded actions on the native
// message, whose return value Cloudflare ignores.

import type { Email as PostalMimeEmail } from 'postal-mime';
import { getRawRuntimeEnv } from '../env-raw.ts';
import { buildMime, MAX_MESSAGE_BYTES, MimeError, normalizeEmail } from './mime.ts';
import type { Address, Attachment } from './types.ts';

// Mirror the slug-validity rule from runtime/email.ts so a malformed
// __VOID_PROJECT_SLUG injection can't smuggle invalid characters into
// the default reply `from` address.
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;

/**
 * Guardrails on what one handler may queue.
 *
 * These are NOT the security boundary. Recording happens inside the tenant's
 * own worker, and on the platform a Workers-for-Platforms tenant can ship any
 * `WorkerEntrypoint` whose `email()` returns any array at all, bypassing this
 * file entirely — so the load-bearing caps are the matching ones in the
 * platform router (`MAX_ACTIONS` / `MAX_ACTION_ADDRESS_LENGTH` in
 * `email-router.ts`). What these buy is a fast, precise failure at the call
 * that went wrong, instead of a whole action list silently dropped at the
 * router with only a platform-side log to show for it.
 */
const MAX_ACTIONS = 100;
const MAX_ACTION_ADDRESS_LENGTH = 320;

/**
 * Cumulative reply-byte budget for ONE dispatch.
 *
 * `MAX_MESSAGE_BYTES` bounds a single `reply()` call, not the queue: N replies
 * at the cap is N x 10 MiB of `Uint8Array` riding one RPC response. workerd
 * caps a serialized RPC payload at 32 MiB, so the queue that clears our
 * per-reply check still fails at the boundary — opaquely. The router cannot
 * tell that failure from any other dispatch error, so the whole message comes
 * back to the sender as a generic "project handler error" reject with nothing
 * in it a handler author could act on. Two full-size replies is already well
 * past any legitimate use, and failing here names the exact call that
 * overran.
 */
const MAX_REPLY_BYTES_TOTAL = 2 * MAX_MESSAGE_BYTES;

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
// (production uses `mail.void.cloud`, staging its own zone). Mirrors
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
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    throw new ParseEmailError(
      'INBOUND_TOO_LARGE',
      `parseEmail: message size ${message.rawSize} bytes exceeds maximum of ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }
  const { default: PostalMime } = await import('postal-mime');
  const cached = proxyRawCache.get(message);
  try {
    // Acquire inside the guard. On an own-account deploy the generated
    // handler wraps Cloudflare's native one-shot `raw`, so a mid-delivery
    // stream failure rejects here — above the `try` it escaped as the bare
    // stream error, past the `ParseEmailError` this function advertises.
    const source = cached ? await cached.read() : message.raw;
    return await PostalMime.parse(source);
  } catch (cause) {
    // postal-mime is lenient — binary garbage, truncated parts and bad
    // header bytes all parse. What it does reject is a nesting bomb (>256
    // levels), and a one-shot `raw` stream can fail on a real CF message.
    // Both used to escape as a bare Error carrying parser internals, which
    // left `PARSE_FAILED` declared in the code union but never constructed.
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

/**
 * Serialized inbound email message — sent from the platform router to the
 * user worker over RPC. Every field is in workerd's RPC `BaseType`
 * allowlist (string, plain object, ReadableStream<Uint8Array>, number).
 */
export interface EmailEnvelope {
  from: string;
  to: string;
  /** Headers serialized as a plain object so they cross RPC. */
  headers: Record<string, string>;
  /**
   * Raw RFC 5322 bytes. Pre-buffered by the router so it's replayable on the
   * receiving side (`parseEmail` consumes the stream once; if the handler
   * also calls `parseEmail` directly, the platform tee'd a fresh stream per
   * delivery).
   */
  raw: ReadableStream<Uint8Array> | Uint8Array;
  rawSize: number;
}

/**
 * What the user handler decided to do with a message. Returned from the
 * worker's `email(envelope)` RPC method as an array (handlers may chain
 * multiple actions, e.g. forward then reply); the router enacts each on the
 * real `ForwardableEmailMessage` in order.
 */
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
 * The platform's shared sender (e.g. `mail.void.cloud`) rewrites every recipient to
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
    `reply: message size ${size} bytes exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
  );
}

function replyBudgetExhausted(size: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `reply: cumulative reply size ${size} bytes exceeds this delivery's budget of ` +
      `${MAX_REPLY_BYTES_TOTAL} bytes.`,
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
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      // Stop pulling: the producer would otherwise keep filling memory.
      await reader.cancel().catch(() => {});
      throw onOverflow(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
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
 * could carry them over RPC to the platform router. The reply MIME bytes are
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

  // Strip the platform-injected `<slug>+` prefix from message.to so handler
  // authors see the same address shape they wrote in `email/<addr>.ts`. The
  // dispatcher strips the same prefix for routing; mirroring it here keeps
  // the user-visible envelope consistent with the routing surface.
  const userVisibleTo = stripSlugFromAddress(envelope.to, opts.slug);

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
  let replyBytesUsed = 0;

  // `actions` only ever grows through forward/reply, and `setReject` purges
  // both, so length IS the queue depth.
  function assertQueueHasRoom(): void {
    if (actions.length >= MAX_ACTIONS) {
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
      // Deliberately NOT bounded by MAX_ACTIONS. The purge below makes this
      // the one call that SHRINKS the queue, so it can never be what overruns
      // it — and throwing out of "refuse this mail" would cost the handler its
      // reject and hand the message back to the sender as a dispatch error,
      // which is strictly worse than whatever the oversized queue was.
      // Walk back through the queue and drop any prior forward/reply: CF
      // (and the platform router) treats setReject as terminal — preceding
      // actions in this dispatch never execute. Without this purge the
      // action queue lies (records a forward the router never enacts),
      // which corrupts the audit trail. Warn so handler authors notice
      // the misuse.
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
      actions.push({ type: 'reject', reason });
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
      // Accept both `Headers` (matches CF's runtime signature) and a plain
      // `Record<string, string>`. `Headers.entries()` lowercases keys per
      // spec; users who care about preserving header casing in the wire
      // form (e.g. for diagnostic headers like `X-Void-Trace`) can pass
      // the record form instead.
      let headersObj: Record<string, string> | undefined;
      if (fwdHeaders instanceof Headers) {
        headersObj = Object.fromEntries(fwdHeaders.entries());
      } else if (fwdHeaders) {
        headersObj = { ...fwdHeaders };
      }
      actions.push({ type: 'forward', to, ...(headersObj ? { headers: headersObj } : {}) });
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
      // `replyEmail()` is bounded by `buildMime`; a hand-built reply is not, so
      // bound it here before the bytes travel to the proxy (or to native reply).
      const remaining = MAX_REPLY_BYTES_TOTAL - replyBytesUsed;
      let rawBytes: Uint8Array;
      if (reply.raw instanceof Uint8Array) {
        if (reply.raw.byteLength > MAX_MESSAGE_BYTES) {
          throw replyTooLarge(reply.raw.byteLength);
        }
        if (reply.raw.byteLength > remaining) {
          throw replyBudgetExhausted(replyBytesUsed + reply.raw.byteLength);
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
        const limit = Math.min(MAX_MESSAGE_BYTES, remaining);
        rawBytes = await readStreamToBytes(reply.raw, limit, (total) =>
          limit === MAX_MESSAGE_BYTES
            ? replyTooLarge(total)
            : replyBudgetExhausted(replyBytesUsed + total),
        );
      }
      replyBytesUsed += rawBytes.byteLength;
      actions.push({ type: 'reply', from: reply.from, to: reply.to, raw: rawBytes });
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
  // two-character ids (3.5M tokens, inside MAX_MESSAGE_BYTES) measured 134 MB
  // and terminates a 128 MB isolate before the predicate can answer. This
  // guard exists to stop a hostile header making the app's reply throw, so it
  // must be neither the thing that throws nor the thing that runs out of
  // memory.
  //
  // A run ends only at SP or HTAB. That is the whitespace `foldHeader` folds
  // at (§3.2.2 FWS), and a threading value is emitted verbatim, so treating
  // the rest of `\s` (NBSP, FF, VT …) as a break passed a value the folder
  // then could not break, and `buildMime` rejected the over-long line — the
  // throw this predicate exists to prevent. Counting through them is the
  // strict direction: it can only refuse a value, never pass one that fails.
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
   * characters become a space, and an ASCII subject too long to fold falls
   * back to a bare `Re:`. Pass `subject` to control it exactly.
   */
  subject?: string;
  text?: string;
  html?: string;
  /** Custom headers; threading headers (`In-Reply-To`, `References`) are added automatically. */
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
}

function prefixReplySubject(original: string): string {
  // Decode RFC 2047 encoded-words first so we (a) detect existing
  // `Re:` prefixes inside encoded subjects (avoids `Re: =?UTF-8?B?...?=`
  // becoming `Re: Re: foo` after the recipient's mailer decodes), and
  // (b) re-encode cleanly via buildMime's encodeWord on the prefixed
  // string instead of stacking encoded-words.
  //
  // The inbound subject is remote-sender controlled, and two things
  // downstream throw on it: `normalizeEmail` rejects CR, LF and NUL, and
  // `buildMime` rejects a header line over 998 octets. A throw here is
  // not the app's fault, and in production it rejects the whole delivery
  // — the reply AND any forward the handler queued. So, as with the
  // threading headers below, the subject is best-effort: C0 controls
  // (a decoded `=00`, `=0A`, or a B-encoded NUL) become a single space,
  // and a subject no line can carry falls back to a bare `Re:`.
  const decoded = decodeRfc2047(original)
    // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!decoded) {
    return 'Re:';
  }
  const prefixed = /^re:/i.test(decoded) ? decoded : `Re: ${decoded}`;
  // Only a pure-ASCII subject can fail to fold: anything else goes through
  // `encodeWord`, which splits it into 75-character encoded-words joined
  // by spaces, and those fold. An ASCII token wider than a line cannot.
  if (/^[\x20-\x7e]*$/.test(prefixed) && !fitsHeaderLine('Subject', prefixed)) {
    return 'Re:';
  }
  return prefixed;
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
    // MAX_MESSAGE_BYTES) needed 138 MB on the reply path and terminated a
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
  const bytes: Array<number> = [];
  for (let i = 0; i < qp.length; i++) {
    const ch = qp.charCodeAt(i);
    if (ch === 0x5f /* _ */) {
      bytes.push(0x20);
    } else if (ch === 0x3d /* = */ && i + 2 < qp.length) {
      // Both characters must be hex. `parseInt('0G', 16)` is 0, not NaN,
      // so a finiteness check accepted any pair that merely STARTED with
      // a hex digit and synthesised a single-nibble byte from it — `=0G`
      // became NUL. A malformed escape stays literal, which is what
      // RFC 2045 §6.7 asks of a robust decoder and what postal-mime does.
      const hex = qp.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(ch);
      }
    } else {
      bytes.push(ch);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure helper: build the reply MIME from an inbound message + reply opts,
 * with `Subject: Re: …` (no double-prefix), `In-Reply-To`, and `References`
 * threaded from the original. Exposed separately so the dispatch step
 * (`message.reply`) can be tested without `cloudflare:email`.
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
  let fromAddr: Address;
  if (opts.from !== undefined) {
    fromAddr = opts.from;
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
  // that cannot be represented and still send the reply.
  const threading: { inReplyTo?: string; references?: string } = {};
  const messageId = fitsHeaderLine('In-Reply-To', originalMessageId) ? originalMessageId : '';
  if (messageId) {
    threading.inReplyTo = messageId;
    const chain = originalReferences ? `${originalReferences} ${messageId}`.trim() : messageId;
    // A `References` chain folds at its spaces, so a long one is usually
    // fine; it is a single oversized id in the chain that is not.
    threading.references = fitsHeaderLine('References', chain) ? chain : messageId;
  } else if (originalReferences && fitsHeaderLine('References', originalReferences)) {
    threading.references = originalReferences;
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
 * reply intent on the message proxy. The platform router enacts the reply
 * via the real `ForwardableEmailMessage.reply()` once the handler returns.
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
 * Whether `value` is a real `ForwardableEmailMessage` — one Cloudflare
 * delivered to this worker's `email()` directly — rather than an
 * `EmailEnvelope` from the platform router. Functions do not survive RPC,
 * so their presence is the discriminator.
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

/**
 * Replay recorded `EmailAction`s on a real `ForwardableEmailMessage`, in
 * order. The proxy already made `setReject` terminal (earlier forward/reply
 * entries are purged, later ones dropped), so a reject is never followed by
 * anything. `reply` needs a genuine `EmailMessage` — Cloudflare rejects a
 * duck-typed object — so `cloudflare:email` is loaded here, and only when
 * a reply was recorded.
 */
export async function enactEmailActions(
  message: ForwardableEmailMessage,
  actions: ReadonlyArray<EmailAction>,
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case 'reject':
        message.setReject(action.reason);
        break;
      case 'forward':
        await message.forward(action.to, action.headers ? new Headers(action.headers) : undefined);
        break;
      case 'reply': {
        const { EmailMessage } = await import('cloudflare:email');
        await message.reply(
          new EmailMessage(action.from, action.to, bytesToReadableStream(action.raw)),
        );
        break;
      }
    }
  }
}
