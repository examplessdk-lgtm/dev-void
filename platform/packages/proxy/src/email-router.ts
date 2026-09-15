/**
 * Inbound email router for the platform mail zone.
 *
 * Bound as the catch-all CF Email Routing rule on the zone named by the
 * `EMAIL_SENDER_DOMAIN` var (`mail.void.cloud` in production,
 * `mail.staging.void.cloud` in staging). Every inbound message hits this
 * worker; we parse `<slug>+<tag>` from the
 * recipient local-part, look up the project's worker name in `ROUTING` KV,
 * serialize the message into an `EmailEnvelope` (RPC-safe), and dispatch
 * into the user worker via the WfP namespace stub's `email(envelope)` RPC
 * method. The user worker returns an `EmailAction[]` describing what its
 * handler decided; we enact each action on the real
 * `ForwardableEmailMessage`.
 *
 * Why an envelope/action contract instead of passing the real message?
 * `ForwardableEmailMessage` is not in workerd's RPC `BaseType` allowlist
 * (see types/defines/rpc.d.ts) and isn't `JSG_SERIALIZABLE` (see
 * src/workerd/jsg/ser.c++:241-330). Calling `stub.email(realMessage)`
 * throws `DataCloneError` before any bytes are sent. The envelope shape
 * uses only RPC-safe primitives (string, plain object, ReadableStream
 * <Uint8Array>, number) so marshaling succeeds. Async metering log fires
 * via ctx.waitUntil after the handler returns.
 */

import { isReservedEmailSlug } from '@voidcloud/api/reserved-slugs';
import { EmailMessage } from 'cloudflare:email';
import {
  MAX_MIME_BYTES,
  readMimeFromAddrSpec,
  readSenderDomain,
  recordInboundDelivery,
} from './email.ts';
import type { Env } from './types.ts';

// Built via new RegExp to dodge oxlint no-control-regex rule.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

/**
 * Strip CR/LF/NUL/control chars before logging or sending to remote MTAs.
 *
 * Slice FIRST, then replace. Several inputs here arrive over RPC from the
 * tenant worker (a reject reason, a non-object action, an unknown action
 * type) and are bounded by nothing but the 32 MiB transport cap. A global
 * regex replace materializes one part per match, so a control-heavy string
 * costs far more than one copy: measured, a 30 MB `\0a\0a…` reason is
 * ~1 GB of transient heap and 800+ ms, and a 4 MB one already exhausts a
 * 128 MB heap — the shared proxy isolate's ceiling — before any outbound
 * gate has run. Slicing first bounds the replace to `maxLen` code units.
 *
 * The result is therefore at most `maxLen` chars and may be SHORTER: a run of
 * controls inside the window collapses to one space and the window is not
 * refilled from beyond `maxLen`. Every caller renders a log line or a DSN
 * reason, where a shorter window loses nothing that matters. Slicing at a
 * UTF-16 index can split a surrogate pair either way — the old order sliced
 * at the same kind of boundary after replacing — so this does not change
 * that class of edge.
 */
function sanitize(value: string, maxLen: number): string {
  return value.slice(0, maxLen).replace(CONTROL_CHARS_RE, ' ');
}

/**
 * Render a tenant-supplied value of UNKNOWN type for a log line, without
 * ever coercing its contents.
 *
 * `sanitize(String(value), n)` is bounded only when `value` is already a
 * string. Everything else the RPC transport can carry is an amplifier or a
 * CPU sink that runs to completion before the slice: `String()` of a typed
 * array or an Array joins every element with commas (measured: a 30 MB
 * `Uint8Array` is a 107M-char string, +385 MB of heap, ~580 ms, and an OOM
 * under the 128 MB isolate ceiling; a nested array flattens recursively
 * to the same), and `String()` of a BigInt is a decimal conversion that is
 * superlinear in its size (measured: 4 MiB is 1.9 s, 32 MiB is 20 s of CPU
 * — the whole RPC cap, spent ahead of every outbound gate). Both reach here
 * from any hand-built entrypoint, as an action, an action's `type`, or an
 * address that failed validation.
 *
 * So: a string is sliced then stripped; a number, boolean, `undefined` or
 * `null` renders as itself (all a few chars); and anything else — bigint,
 * function, symbol, any object — renders as its KIND only. The object tag
 * comes from `Object.prototype.toString`, which reads nothing a tenant can
 * set: it consults only `Symbol.toStringTag`, and symbol-keyed properties do
 * not cross RPC (structured clone drops them). `constructor.name` would
 * not be safe — `constructor` is an ordinary string key the tenant can send
 * with any value. The tag is sliced anyway so a local caller cannot make it
 * long either.
 */
function describeUntrusted(value: unknown, maxLen: number): string {
  switch (typeof value) {
    case 'string':
      return sanitize(value, maxLen);
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'object':
      return value === null ? 'null' : sanitize(Object.prototype.toString.call(value), 64);
    default:
      // bigint, function, symbol
      return `[${typeof value}]`;
  }
}

interface RoutingEntry {
  workerName?: string;
  projectId?: string;
  /**
   * Per-project dispatch limits (`{ cpuMs?, subRequests? }`), written by the
   * api worker and applied by `packages/dispatch` on every HTTP request.
   * Inbound mail dispatches into the same tenant worker, so it has to pass
   * the same limits — otherwise anyone who can send mail to a project's
   * address runs that tenant's worker at the namespace default.
   */
  limits?: Record<string, number>;
  /**
   * Platform-wide suspension marker, written by `applyRoutingSuspension` in
   * the api worker and answered with a 429 by `packages/dispatch`. Inbound
   * mail honors it too: running a suspended tenant's code on platform CPU is
   * exactly what suspension exists to stop.
   */
  suspended?: string;
  // Other routing fields exist on this KV value (used by HTTP dispatch);
  // we only care about these here.
}

/**
 * Mirrors `void/email`'s EmailEnvelope. RPC-safe primitives only.
 *
 * `raw` is a `Uint8Array` (not a `ReadableStream`) because we pre-buffer
 * the message body in `buildEnvelope`. The framework-side `EmailEnvelope`
 * type accepts both shapes for forward-compat, but every value we send
 * over the wire today is a Uint8Array. Both forms ARE in workerd's RPC
 * `BaseType` allowlist, so either marshals; the buffered form survives
 * being read more than once on the user worker (parseEmail consumes the
 * stream, and we want the receiving framework to be free to replay).
 */
interface EmailEnvelope {
  from: string;
  to: string;
  headers: Record<string, string>;
  raw: Uint8Array;
  rawSize: number;
}

/** Mirrors `void/email`'s EmailAction. */
type EmailAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Record<string, string> }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

interface EmailEntrypointStub {
  /**
   * Standard CF handler-named RPC method on the user worker's
   * WorkerEntrypoint subclass. Receives an envelope (RPC-safe primitives)
   * and returns the action queue the framework's dispatcher recorded.
   */
  email?(envelope: EmailEnvelope): Promise<Array<EmailAction> | undefined>;
  fetch?(req: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * Cap inbound bytes well below CF's ~25 MB ceiling. The envelope is buffered
 * here AND copied again across RPC into the user worker, so two of these have
 * to fit in the proxy isolate's heap. 10 MB is generous for normal mail and
 * keeps headroom for everything else the isolate is doing.
 */
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/**
 * Cap the number of DISTINCT header names on an inbound message.
 *
 * `MAX_INBOUND_BYTES` bounds the header bag's BYTES (headers are part of
 * `raw`) but not its COUNT, and count is what `buildEnvelope` pays for:
 * `Object.fromEntries` defines one own property per distinct name on a
 * dictionary-mode object, ~75–110 B of V8 heap each (measured; the range
 * is the table's doubling cycle), against a wire minimum of 7 bytes per
 * line (`abcd:\r\n`). The byte cap therefore admits ~1.5M distinct names,
 * and materializing those is a hard OOM under the 128 MB isolate ceiling
 * (measured: 1.5M keys is 158 MB retained and ~580 ms in Node, ~1.2 s of
 * CPU in workerd; 1.3M still fits, at 82 MB) — in the SHARED proxy isolate,
 * ahead of dispatch, from any remote sender who fills a message with short
 * headers. The same bag is then walked again by the RPC serializer and
 * copied into a `Headers` by the tenant's `createMessageProxy`, so the cap
 * here bounds both of those too.
 *
 * Real mail carries well under 100 distinct names. workerd's `Headers`
 * folds repeated names (`Received`, `DKIM-Signature`, `ARC-*`) into ONE
 * entry each, so hop count does not raise the number. 1024 is 10x that,
 * and the amplified cost at 1024 (~140 KB) is noise next to the raw buffer.
 *
 * Checked by walking `message.headers` and stopping at the cap, BEFORE the
 * body is buffered and before `Object.fromEntries` builds anything. In
 * workerd, `entries()` snapshots the whole bag once into a `kj::Array`
 * (`Headers::getDisplayedHeaders`, C++ memory the V8 heap limit does not
 * see; there is no `size`) — work `fromEntries` was paying anyway. The
 * early stop is what keeps the V8-side cost of an over-cap message to
 * `MAX_INBOUND_HEADERS + 1` pairs.
 */
const MAX_INBOUND_HEADERS = 1024;

/** Cap user-supplied reject reasons — surfaced to remote MTAs and our logs. */
const MAX_REJECT_REASON_LENGTH = 1000;

/**
 * Cap the number of actions one dispatch may return.
 *
 * The list arrives over RPC from a tenant worker and is walked here, in the
 * SHARED proxy isolate, before `checkOutboundGate` has looked at a single
 * entry — so an unbounded list is per-entry validation work (address regex,
 * `new Headers()`, `sanitize()` on every drop log) that is never metered and,
 * because the drop path just `continue`s, endlessly repeatable by anyone who
 * can send mail to the project's address. The framework caps the queue at the
 * same number, but that cap lives inside the tenant's own worker: a
 * Workers-for-Platforms tenant can ship any `WorkerEntrypoint` whose `email()`
 * returns any array at all, so the framework-side cap is a developer-experience
 * guardrail and THIS one is the boundary. Same belt-and-suspenders split as
 * `MAX_RECIPIENTS` on the outbound path in `email.ts`.
 *
 * Checked against the RAW list BEFORE the loop allocates, for the same reason
 * `MAX_RECIPIENTS` is checked before normalization: the loop is what costs.
 *
 * Matches the outbound `MAX_RECIPIENTS` deliberately. An inbound forward or
 * reply IS the outbound fan-out primitive — same per-project allowlist, same
 * burst and monthly counters — so the two paths must not offer different
 * ceilings on the same capability.
 */
const MAX_ACTIONS = 100;

/**
 * Cap a single address inside an action (`forward.to`, `reply.from`,
 * `reply.to`). `MAX_ACTIONS` alone still leaves a 100 x <address length>
 * amplifier: every address is scanned by `VALID_ADDRESS_RE` and, on the drop
 * path, copied twice more by `sanitize()`. Checked BEFORE the regex for
 * exactly that reason. RFC 5321 caps a forward-path at 256 octets, so 320 is
 * generous for anything deliverable — and it is the outbound
 * `MAX_RECIPIENT_LENGTH` value, for the reason given above.
 */
const MAX_ACTION_ADDRESS_LENGTH = 320;

/**
 * Bound a forward's header bag. `new Headers(...)` lowercases and copies
 * every name and validates every value, so an unbounded bag is the same
 * unmetered work as an unbounded address list — and it survives RPC as a
 * plain object, so nothing upstream has looked at its size.
 */
const MAX_FORWARD_HEADERS = 32;
const MAX_FORWARD_HEADER_LENGTH = 1024;

/**
 * Cap one reply's MIME bytes: `MAX_MIME_BYTES`, the `/email/send` bound in
 * `email.ts`, which is itself the twin of the framework's
 * `MAX_MESSAGE_BYTES` in `runtime/email/mime.ts` — the CF ceiling the
 * design doc records as ~10 MB base64-inflated.
 *
 * The framework checks this inside `reply()`, but that runs in the tenant's
 * own worker: a hand-written Workers-for-Platforms entrypoint returns any
 * `Uint8Array` the 32 MiB RPC transport carries, and until this check the
 * router's only bound on `reply.raw` was `instanceof Uint8Array` — it then
 * scanned the whole value for `From:` and streamed it into
 * `message.reply()`, where CF's own limit fails it late and opaquely (the
 * failure is logged here and the reply silently never goes out). Checked
 * BEFORE `readMimeFromAddrSpec`, whose scan is linear in `raw`.
 */
const MAX_REPLY_BYTES = MAX_MIME_BYTES;

/**
 * Cumulative reply-byte budget for ONE delivery. Twin of the framework's
 * `MAX_REPLY_BYTES_TOTAL` in `runtime/email/inbound.ts`, same figure and
 * same rule: a reply that would overrun the budget is refused and NOT
 * charged, so a later, smaller reply that fits the remainder still goes.
 * Only the offending reply is dropped — like every other per-reply refusal
 * here (bad address, sender pin, MIME From) and unlike an invalid forward
 * header bag, which drops the whole list because partially enacting an
 * injection attempt is the worse failure. An oversized reply is a resource
 * bound, and the in-budget replies cost no more than a compliant list.
 */
const MAX_REPLY_BYTES_TOTAL = 2 * MAX_REPLY_BYTES;

// workerd's RPC layer throws TypeError with messages like
// "The RPC receiver does not implement the method 'X'". Match a couple of
// shapes to survive minor wording shifts in workerd. Lessons.md notes this
// is the only signal distinguishing pre-WorkerEntrypoint deploys from
// genuine handler errors.
const RPC_METHOD_MISSING = /does not implement the method|receiver does not.*method/i;

class InboundTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`inbound message exceeds ${MAX_INBOUND_BYTES} bytes (got ${size})`);
    this.name = 'InboundTooLargeError';
  }
}

class InboundTooManyHeadersError extends Error {
  constructor() {
    super(`inbound message carries more than ${MAX_INBOUND_HEADERS} headers`);
    this.name = 'InboundTooManyHeadersError';
  }
}

// Same dodge as CONTROL_CHARS_RE — RegExp constructor avoids the
// no-control-regex rule.
const VALID_ADDRESS_RE = new RegExp(
  '^[^@\\s<>"()[\\]\\\\,;:\\u0000-\\u001f\\u007f]+' +
    '@[^@\\s<>"()[\\]\\\\,;:\\u0000-\\u001f\\u007f]+' +
    '\\.[^@\\s<>"()[\\]\\\\,;:\\u0000-\\u001f\\u007f]+$',
);

function isValidEmailAddress(s: unknown): s is string {
  // Reject quotes, parens, brackets, control chars in addition to the
  // obvious whitespace/angle-bracket cases. CF does strict validation on
  // forward/reply but we want to fail fast and not let address fragments
  // reach `EmailMessage` / SMTP layers downstream.
  //
  // Length FIRST: the regex below scans the whole string, so testing it on an
  // unbounded address is the work `MAX_ACTION_ADDRESS_LENGTH` exists to stop.
  // Guarding here covers `forward.to`, `reply.from` and `reply.to` at every
  // call site.
  return typeof s === 'string' && s.length <= MAX_ACTION_ADDRESS_LENGTH && VALID_ADDRESS_RE.test(s);
}

/**
 * Render a rejected address for a log line. The value is whatever failed
 * `isValidEmailAddress`, so it need not be a string at all — a typed array
 * or an Array as `to` used to be joined whole by `String()` before the
 * slice. `describeUntrusted` renders a string within
 * `MAX_ACTION_ADDRESS_LENGTH` code units and anything else by kind.
 */
function logAddress(value: unknown): string {
  return describeUntrusted(value, MAX_ACTION_ADDRESS_LENGTH);
}

/**
 * True when a forward's header bag is within bounds. Logs and returns false
 * otherwise, which DROPS THE WHOLE LIST at the call site — the same response
 * `new Headers()` throwing already gets, and for the same reason: an
 * over-sized bag on one forward says the handler is hostile, and partially
 * enacting the rest of its list is the worse failure mode.
 *
 * SHAPE FIRST, before anything enumerates. The declared type is a record,
 * but the value crossed RPC from the tenant, so it can be a string, a
 * `String`, an Array or a typed array — each has one indexed own property
 * PER ELEMENT, and `Object.entries` / `Object.keys` / `for…in` all
 * materialize the whole key set before a count can be read (V8 builds the
 * for-in enum cache up front; `break` does not help). Measured ~100 B per
 * element: a 1.5 MiB string is an OOM in a 128 MB isolate, from a payload
 * 20x below the RPC cap. The old `new Headers(<any of these>)` threw in
 * O(1); this keeps that. workerd RPC only delivers `Object.prototype`
 * objects (it refuses to serialize a null-prototype one), so a plain-object
 * test is exact; null is accepted too for callers that never crossed RPC.
 */
function forwardHeadersWithinBounds(headers: unknown): headers is Record<string, string> {
  if (typeof headers !== 'object' || headers === null) {
    console.error('[email-router] action list dropped: forward headers is not a plain object');
    return false;
  }
  const proto = Object.getPrototypeOf(headers);
  if (proto !== Object.prototype && proto !== null) {
    console.error('[email-router] action list dropped: forward headers is not a plain object');
    return false;
  }
  // `Object.keys`, not `Object.entries`: one pointer per key on top of the
  // deserialized object the isolate already holds, versus a fresh 2-tuple
  // per entry. The count is read before any value is touched.
  const names = Object.keys(headers);
  if (names.length > MAX_FORWARD_HEADERS) {
    console.error(
      `[email-router] action list dropped: forward has ${names.length} headers (max ${MAX_FORWARD_HEADERS})`,
    );
    return false;
  }
  for (const name of names) {
    const value = (headers as Record<string, unknown>)[name];
    // The NAME is bounded too: `new Headers()` accepts an arbitrarily long
    // token, so an unbounded name is the same amplifier as an unbounded value.
    if (name.length > MAX_FORWARD_HEADER_LENGTH) {
      console.error(
        `[email-router] action list dropped: forward header name exceeds ${MAX_FORWARD_HEADER_LENGTH} characters`,
      );
      return false;
    }
    // A non-string value evades the length check below, and `new Headers()`
    // does not throw on it: workerd RPC delivers Arrays, typed arrays, and
    // numbers verbatim, and `new Headers({ x: <Array> })` coerces the value
    // with `String()` — an Array joins to one comma-separated string ~30x
    // its wire size (measured: a Date-filled Array OOMs the 128 MB isolate
    // from a ~4 MiB RPC payload). The declared type is `Record<string,
    // string>`; anything else is refused before it reaches `new Headers()`.
    if (typeof value !== 'string') {
      console.error(
        `[email-router] action list dropped: forward header "${sanitize(name, 64)}" value is not a string`,
      );
      return false;
    }
    if (value.length > MAX_FORWARD_HEADER_LENGTH) {
      console.error(
        `[email-router] action list dropped: forward header "${sanitize(name, 64)}" value exceeds ${MAX_FORWARD_HEADER_LENGTH} characters`,
      );
      return false;
    }
  }
  return true;
}

/**
 * Sender pin for `reply` actions — the inbound analogue of the outbound
 * `from` pin in `email.ts` (`strictFromRe` plus the local-part compare
 * against the project's slug).
 *
 * `message.reply()` hands `action.from` straight to `new EmailMessage(...)`,
 * and `action.from` is whatever the tenant's worker returned over RPC — the
 * framework's safe default is not a control point. CF Email Routing's own
 * reply rule is DOMAIN-level only, and every tenant plus the platform's
 * reserved `noreply` slug share one mail zone, so without this pin any
 * project can emit mail as any other project or as the platform. (`noreply`
 * being a reserved slug, this path is the ONLY way to emit it at all.)
 *
 * `domain` is taken from the RECEIVED `message.to`, deliberately NOT from
 * `EMAIL_SENDER_DOMAIN`: the received domain is what CF pinned when it
 * accepted the message, and `routeInbound` treats a missing
 * `EMAIL_SENDER_DOMAIN` as non-fatal (see `label` above). Reading the var
 * here would import the outbound path's fail-closed behavior into a router
 * that must keep routing.
 */
interface ReplySenderPin {
  /** Routed project slug, already lowercased by `routeInbound`. */
  slug: string;
  /** Domain of the received recipient, already lowercased. */
  domain: string;
}

/**
 * True when `from` is a sender this project is allowed to speak as:
 * `<slug>@<domain>` or `<slug>+<tag>@<domain>`, case-insensitively.
 *
 * A BARE `<tag>@<domain>` is refused. The framework strips the `<slug>+`
 * prefix from `message.to` before a handler sees it, so a handler that
 * hand-rolls `from: message.to` produces that shape and CF accepts it
 * today — refusing it is a deliberate, breaking narrowing. It has to be:
 * a bare local-part is indistinguishable from another tenant's slug and
 * from the reserved `noreply`, so permitting the shape would re-open the
 * impersonation this pin closes. `replyEmail`'s default
 * (`<slug>+noreply@<domain>`) and the wire form `<slug>+<tag>@<domain>`
 * both keep working, and the un-stripped recipient stays available to
 * handlers on `message.__voidPlatformTo`.
 */
function isPermittedReplySender(from: string, pin: ReplySenderPin): boolean {
  // The address is forwarded VERBATIM to `EmailMessage`, so the comparison
  // has to run on bytes that cannot change under case folding. U+212A
  // KELVIN SIGN lowercases to 'k' and U+0130 to 'i', so a non-ASCII
  // local-part can satisfy a lowercased compare and still reach the shared
  // envelope sender intact. Same guard, same reason, as `email.ts`.
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return false;
  }
  const lower = from.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0) {
    return false;
  }
  if (lower.slice(at + 1) !== pin.domain) {
    return false;
  }
  // Split on the first '+' exactly as the recipient is split in
  // `routeInbound`, so the sender's slug is read the same way the routed
  // slug was.
  const localPrefix = lower.slice(0, at).split('+')[0] ?? '';
  return localPrefix.length > 0 && localPrefix === pin.slug;
}

function readCounter(raw: string | null): number {
  // Mirror packages/proxy/src/email.ts. NaN-poison defense.
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function monthBucket(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function minuteBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes(),
  ).padStart(2, '0')}`;
}

function monthTtlSeconds(now: Date): number {
  const endOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  const seconds = Math.ceil((endOfMonth - now.getTime()) / 1000) + 60 * 60;
  return Math.max(60, seconds);
}

async function readAllowlist(kv: KVNamespace, projectId: string): Promise<Set<string>> {
  const raw = await kv.get(`email-allowlist:${projectId}`, { cacheTtl: 60 });
  if (!raw) {
    return new Set();
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      return new Set();
    }
    const out = new Set<string>();
    for (const v of arr) {
      if (typeof v === 'string') {
        out.add(v.toLowerCase());
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

async function getBurstLimit(kv: KVNamespace, projectId: string): Promise<number> {
  const raw = await kv.get(`email-burst-limit:${projectId}`, { cacheTtl: 60 });
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 10;
}

async function getMonthlyLimit(kv: KVNamespace, projectId: string): Promise<number> {
  const raw = await kv.get(`email-limit:${projectId}`, { cacheTtl: 60 });
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 200;
}

/**
 * Per-message context derived ONCE in `routeInbound` and threaded through
 * `enactActions` so each forward/reply gets the same project guards as
 * `/email/send` (allowlist, suspend kill-switch, burst, monthly quotas).
 *
 * The counters are mutated as actions are enacted so a message that
 * forwards to two addresses charges quota for two — matching the
 * outbound semantics.
 */
interface OutboundGate {
  /** undefined when routing has no projectId; gate is then closed. */
  projectId: string | undefined;
  allowlist: Set<string>;
  burstKey: string;
  burstLimit: number;
  burstCurrent: number;
  monthKey: string;
  monthLimit: number;
  monthCurrent: number;
  /** Once true, we've hit a quota and refuse any further forward/reply. */
  quotaExhausted: boolean;
}

export async function routeInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Every reject reason is prefixed with the zone this router serves, so a
  // bounce tells the remote MTA which platform environment refused it. The
  // zone is configuration (`EMAIL_SENDER_DOMAIN`), not a constant — see
  // `readSenderDomain`. Unlike the outbound send path, a missing value is
  // NOT fatal here: nothing about inbound routing depends on the domain, so
  // failing closed would drop legitimate mail over a cosmetic var. Fall back
  // to a neutral label instead.
  const label = readSenderDomain(env) ?? 'void email';

  const to = String(message.to ?? '').toLowerCase();
  const local = to.split('@')[0] ?? '';
  // <slug>+<tag> — split on the first '+'. If there's no '+', the whole
  // local-part is the slug and the user worker sees the tag-less address.
  const plus = local.indexOf('+');
  const slug = plus === -1 ? local : local.slice(0, plus);
  // Domain CF pinned when it accepted this message. It is the expected
  // domain for any `reply` sender — see `ReplySenderPin`.
  const atIdx = to.indexOf('@');
  const receivedDomain = atIdx === -1 ? '' : to.slice(atIdx + 1);

  if (!slug) {
    message.setReject(`${label}: missing project slug in recipient`);
    return;
  }

  // `noreply@`, `postmaster@`, `abuse@`, … are the domain's own addresses,
  // not a tenant's: the bounces and replies to the platform's verification
  // mail come back to `noreply@<domain>`. `RESERVED_SLUGS` keeps a NEW
  // project from claiming one, but the routing blob below is keyed by slug
  // and a project registered before those were reserved still has one — it
  // would receive that mail. Refused before the KV read so no routing
  // entry, whatever its origin, can hand a reserved mailbox to a worker.
  // The reject matches what an unclaimed slug gets today: there is no
  // platform mailbox behind these addresses either.
  if (isReservedEmailSlug(slug)) {
    message.setReject(`${label}: "${sanitize(slug, 64)}" is a reserved platform address`);
    return;
  }

  // Look up project routing — same KV the HTTP dispatcher uses.
  const routingJson = await env.ROUTING.get(slug);
  if (!routingJson) {
    message.setReject(`${label}: no project found for slug "${sanitize(slug, 64)}"`);
    return;
  }

  let parsedRouting: unknown;
  try {
    parsedRouting = JSON.parse(routingJson);
  } catch {
    message.setReject(`${label}: routing data corrupt`);
    return;
  }
  // `JSON.parse` also succeeds on `null`, on a bare number and on a string,
  // none of which carry a suspension marker to read. Every producer of this
  // value writes a `JSON.stringify`d object, so there is no legitimate writer
  // of a non-object entry — treat one as corrupt rather than reaching for
  // `.suspended` on it. Reading it as "not suspended" would disable the
  // platform-wide gate for exactly the project whose entry got corrupted,
  // which is the same reason the outbound path fails closed on `corrupt`.
  if (typeof parsedRouting !== 'object' || parsedRouting === null) {
    message.setReject(`${label}: routing data corrupt`);
    return;
  }
  const routing = parsedRouting as RoutingEntry;

  // Platform-wide suspension — the marker `packages/dispatch` answers with a
  // 429. Checked BEFORE dispatch (and before the email-only kill-switch) so
  // a suspended tenant's code never runs on platform CPU, and so a project
  // suspended for abuse loses inbound and outbound mail at the same moment
  // it loses HTTP.
  if (routing.suspended) {
    // The marker is declared `string`, but it arrives from KV — a non-string
    // value would crash `sanitize`, which turns a suspended project into an
    // unhandled handler error instead of a clean refusal.
    const reason = typeof routing.suspended === 'string' ? routing.suspended : 'suspended';
    message.setReject(
      `${label}: project "${sanitize(slug, 64)}" is suspended (${sanitize(reason, 64)})`,
    );
    return;
  }

  const workerName = routing.workerName;
  if (!workerName) {
    // Static-only deploys (KV/R2 path) don't have a worker — nothing to
    // dispatch inbound mail to.
    message.setReject(`${label}: project "${sanitize(slug, 64)}" has no worker (static deploy)`);
    return;
  }

  // Email-only suspend kill-switch — the narrower control, set by the admin
  // UI to stop mail without taking the whole project offline. Gates inbound
  // as well as outbound so a suspended project doesn't keep accepting +
  // dispatching mail (which costs CPU and storage on the user worker).
  // No cacheTtl: this is an abuse-response control; we eat the extra KV
  // get per inbound message so a suspend takes effect immediately
  // (subject only to KV's ~near-instant per-colo consistency).
  if (routing.projectId) {
    if (await env.ROUTING.get(`email-suspended:${routing.projectId}`)) {
      message.setReject(`${label}: project "${sanitize(slug, 64)}" inbound is suspended`);
      return;
    }
  }

  let stub: EmailEntrypointStub;
  try {
    // Pass the project's dispatch limits, exactly as the HTTP router does in
    // `packages/dispatch`. Without them, anyone who can send mail to a
    // project's address runs that tenant's worker at the namespace default
    // instead of the CPU/sub-request ceiling the project is configured for.
    stub = (routing.limits
      ? env.DISPATCH.get(workerName, {}, { limits: routing.limits })
      : env.DISPATCH.get(workerName)) as unknown as EmailEntrypointStub;
  } catch (e) {
    console.error(`[email-router] DISPATCH.get(${sanitize(workerName, 320)}) failed:`, e);
    message.setReject(`${label}: project worker unavailable`);
    return;
  }

  // Note: we can't pre-check `typeof stub.email === 'function'` — RPC stub
  // proxies report 'function' for every property access. The actual
  // existence check happens at call time, where workerd throws
  // `TypeError: The RPC receiver does not implement the method "..."` if
  // the user worker doesn't expose it. We catch that below.

  // Early size guard — `rawSize` is set by CF before the body streams.
  // Reject before buffering so a flood of oversized messages can't OOM the
  // isolate. We still enforce the cap during streaming below in case
  // `rawSize` ever lies.
  if (typeof message.rawSize === 'number' && message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
    return;
  }

  // Serialize to an envelope. Headers go as a plain object (RPC-safe);
  // raw is pre-buffered to a Uint8Array so the user worker can re-read it
  // (parseEmail consumes the stream — buffering also lets us replay if
  // multiple downstream consumers need it).
  let envelope: EmailEnvelope;
  try {
    envelope = await buildEnvelope(message);
  } catch (e) {
    if (e instanceof InboundTooLargeError) {
      message.setReject(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
      return;
    }
    if (e instanceof InboundTooManyHeadersError) {
      message.setReject(`${label}: too many headers (max ${MAX_INBOUND_HEADERS})`);
      return;
    }
    console.error(`[email-router] failed to read message body for ${sanitize(slug, 64)}:`, e);
    message.setReject(`${label}: could not read inbound message body`);
    return;
  }

  // Build the outbound gate context BEFORE dispatch so every forward/reply
  // recorded by the user handler runs through the same per-project guards
  // as `/email/send` (HIGH H1). CF Email Routing destinations are
  // account-wide, so without a per-project allowlist any tenant could
  // weaponize inbound mail to fan out to addresses verified by another
  // project — nullifying the architectural premise that the platform's
  // per-project allowlist is the security boundary.
  let gate: OutboundGate;
  try {
    gate = await loadOutboundGate(env, routing.projectId);
  } catch (e) {
    console.error(
      `[email-router] failed to load outbound gate for ${sanitize(routing.projectId ?? '', 64)}:`,
      e,
    );
    // Closing the gate (no allowlist, exhausted quota) means forward/reply
    // actions get dropped with a logged error — the user message is still
    // accepted by CF (we don't reject), matching the documented behavior
    // that quota exhaustion never breaks message acceptance.
    gate = {
      projectId: routing.projectId,
      allowlist: new Set(),
      burstKey: '',
      burstLimit: 0,
      burstCurrent: 0,
      monthKey: '',
      monthLimit: 0,
      monthCurrent: 0,
      quotaExhausted: true,
    };
  }

  let actions: Array<EmailAction>;
  try {
    // This await materializes the tenant's WHOLE return value in this isolate
    // before any bound below can look at it. workerd deserializes an RPC
    // result eagerly, in one call, with no size hook; the only transport
    // bound is the callee-side 32 MiB cap on SERIALIZED bytes, and a dense
    // array turns 32 MiB of nulls into 128 MiB of caller heap, or of `{}`
    // into ~500 MiB (measured, workerd 1.20260701.1, pointer-compressed V8).
    // No proxy-side code can bound that; a contract change binds only
    // cooperative tenants. Accepted limit — design doc 0078, "RPC result
    // materialization", records the numbers and the architectural options.
    const result = await stub.email!(envelope);
    if (result === undefined || result === null) {
      actions = [];
    } else if (Array.isArray(result)) {
      actions = result;
    } else {
      // Handler authors who return e.g. `{ actions: [...] }` instead of
      // the bare array would otherwise see a silent no-op. Warn so the
      // mistake is debuggable.
      console.warn(
        `[email-router] ${sanitize(workerName, 320)} email handler returned non-array; treating as no-op`,
      );
      actions = [];
    }
  } catch (e) {
    // The thrown value is the tenant's: a handler can throw an Error with any
    // message, or any value that crosses RPC. Only a bounded prefix is
    // inspected — workerd's own "does not implement" text is well under 320
    // characters — because `receiver does not.*method` backtracks
    // quadratically on a long message (measured: 1 MB = 21 s of CPU), and a
    // non-Error throw is described by kind, never coerced whole.
    const msg = e instanceof Error ? e.message.slice(0, 320) : describeUntrusted(e, 320);
    if (RPC_METHOD_MISSING.test(msg)) {
      console.error(
        `[email-router] ${sanitize(workerName, 320)} has no .email() (needs redeploy):`,
        sanitize(msg, 320),
      );
      message.setReject(`${label}: project has no email handler`);
      // We log the dispatch attempt asynchronously even on rejects.
      ctx.waitUntil(
        logRecv(env, routing.projectId, message, [{ type: 'reject', reason: 'no-handler' }]),
      );
      return;
    }
    console.error(`[email-router] dispatch to ${sanitize(workerName, 320)} failed:`, msg);
    message.setReject(`${label}: project handler error`);
    ctx.waitUntil(
      logRecv(env, routing.projectId, message, [{ type: 'reject', reason: 'dispatch-error' }]),
    );
    return;
  }

  await enactActions(env, message, actions, gate, { slug, domain: receivedDomain });

  // Async log to the metering pipeline. Best-effort. Logged after every
  // dispatch — including reject-only outcomes — so operators have a
  // complete audit trail.
  ctx.waitUntil(logRecv(env, routing.projectId, message, actions));
}

/**
 * Read the per-project allowlist + burst/monthly counters once, up-front,
 * so `enactActions` can apply the same gates `/email/send` uses without
 * reissuing KV reads inside the loop. The counter values mutate as
 * actions enact; we write the totals back at the end via
 * `commitGateCounters`.
 */
async function loadOutboundGate(env: Env, projectId: string | undefined): Promise<OutboundGate> {
  if (!projectId) {
    // No projectId on the routing entry → can't authorize anything.
    return {
      projectId: undefined,
      allowlist: new Set(),
      burstKey: '',
      burstLimit: 0,
      burstCurrent: 0,
      monthKey: '',
      monthLimit: 0,
      monthCurrent: 0,
      quotaExhausted: true,
    };
  }
  const allowlist = await readAllowlist(env.ROUTING, projectId);
  const now = new Date();
  const burstKey = `email-burst:${projectId}:${minuteBucket(now)}`;
  const monthKey = `email-sent:${projectId}:${monthBucket(now)}`;
  const [burstLimit, monthLimit, burstRaw, monthRaw] = await Promise.all([
    getBurstLimit(env.ROUTING, projectId),
    getMonthlyLimit(env.ROUTING, projectId),
    env.ROUTING.get(burstKey),
    env.ROUTING.get(monthKey),
  ]);
  return {
    projectId,
    allowlist,
    burstKey,
    burstLimit,
    burstCurrent: readCounter(burstRaw),
    monthKey,
    monthLimit,
    monthCurrent: readCounter(monthRaw),
    quotaExhausted: false,
  };
}

/**
 * Persist the post-mutation counters back to KV. Wrapped in per-key
 * try/catch — a failed put logs and continues; the design accepts
 * overshoot when KV is flaky (mirrors `/email/send`).
 */
async function commitGateCounters(env: Env, gate: OutboundGate): Promise<void> {
  if (!gate.projectId) {
    return;
  }
  const now = new Date();
  await Promise.all([
    env.ROUTING.put(gate.monthKey, String(gate.monthCurrent), {
      expirationTtl: monthTtlSeconds(now),
    }).catch((e) => {
      console.error(
        `[email-router] monthly counter put failed for ${sanitize(gate.projectId ?? '', 64)}:`,
        e,
      );
    }),
    env.ROUTING.put(gate.burstKey, String(gate.burstCurrent), {
      expirationTtl: 5 * 60,
    }).catch((e) => {
      console.error(
        `[email-router] burst counter put failed for ${sanitize(gate.projectId ?? '', 64)}:`,
        e,
      );
    }),
  ]);
}

async function logRecv(
  env: Env,
  projectId: string | undefined,
  message: ForwardableEmailMessage,
  actions: Array<EmailAction>,
): Promise<void> {
  if (!projectId) {
    console.error(
      `[email-router] cannot log inbound delivery: routing entry has no projectId (to=${sanitize(String(message.to ?? ''), 320)})`,
    );
    return;
  }
  // Guard the RAW list the same way `validateActions` does. A user worker can
  // return anything, this runs OUTSIDE the try below, and it is scheduled on
  // `ctx.waitUntil` — so a null entry used to escape as an unhandled rejection
  // and silently cost the delivery its recv counter and its audit line.
  const status = actions.some((a) => a && typeof a === 'object' && a.type === 'reject')
    ? 'rejected'
    : actions.length === 0
      ? 'accepted'
      : 'handled';
  try {
    await recordInboundDelivery(env, projectId, {
      from: String(message.from ?? ''),
      to: String(message.to ?? ''),
      // sanitize() in email.ts handles control-char stripping before logging;
      // don't pre-truncate here so the full subject is available if logging
      // ever moves to structured storage.
      subject: message.headers.get('Subject') ?? '',
      byteSize: message.rawSize ?? 0,
      status,
    });
  } catch (e) {
    console.error('[email-router] log-recv failed:', e);
  }
}

async function buildEnvelope(message: ForwardableEmailMessage): Promise<EmailEnvelope> {
  // Header COUNT first, before the body is buffered and before any property
  // is defined: the bag is walked once, stops at the cap, and the collected
  // pairs feed `fromEntries` below. See `MAX_INBOUND_HEADERS`.
  const entries: Array<[string, string]> = [];
  for (const entry of message.headers) {
    if (entries.length >= MAX_INBOUND_HEADERS) {
      throw new InboundTooManyHeadersError();
    }
    entries.push(entry);
  }
  const raw = await readStreamToBytes(message.raw);
  // `Object.fromEntries`, NOT `Object.create(null)`: workerd's RPC
  // serializer refuses any object whose prototype is not `Object.prototype`
  // ("Could not serialize object of type \"Object\""), so a null-prototype
  // bag made every `stub.email(envelope)` throw. `fromEntries` defines each
  // key as an OWN data property (`CreateDataProperty`), so a remote header
  // named `__proto__` becomes a plain key on both sides of the RPC and never
  // touches the prototype chain — verified over a real workerd RPC hop.
  const headers: Record<string, string> = Object.fromEntries(entries);
  return {
    from: String(message.from ?? ''),
    to: String(message.to ?? ''),
    headers,
    raw,
    rawSize: message.rawSize ?? raw.byteLength,
  };
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_INBOUND_BYTES) {
      // Cancel the stream so CF stops sending; throw a typed error the
      // caller can recognize and turn into a clean SMTP reject.
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort.
      }
      throw new InboundTooLargeError(total);
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

/**
 * Sanitized + validated action ready for enaction.
 *
 * `forward` / `reply` carry pre-constructed `Headers` objects so the
 * enaction loop can't throw on header construction after another
 * forward/reply already fired. See `validateActions` below for why
 * validation is split from enaction (HIGH H2).
 */
type SanitizedAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Headers }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

/**
 * Two-phase action enaction.
 *
 * **Phase A — validation (this fn).** Walk the action array, validate
 * each action shape end-to-end, including header construction (via
 * `new Headers(...)`, which throws on CRLF / NUL / unsafe chars).
 * Build a sanitized list. Drop INVALID actions, but if header
 * construction throws on any forward/reply we DROP THE ENTIRE LIST
 * (return `null`) — the message is still accepted by CF, but no
 * side effects fire. Rationale: header validation throwing implies
 * the user handler tried to inject SMTP headers; partially enacting
 * the rest of the list (e.g. firing a reply) is a worse failure mode
 * than dropping it all and logging.
 *
 * **Phase B — enaction (`enactSanitized`).** Walks the validated list,
 * performs side effects. Each forward/reply still has its own
 * runtime try/catch for transient CF errors, but no sync throws
 * happen between sanitized actions, so an early forward/reply
 * succeeding can't leak side effects on a downstream throw.
 *
 * Stops walking at the first `reject` (terminal in CF's runtime).
 */
function validateActions(
  actions: Array<EmailAction>,
  replySender: ReplySenderPin,
): Array<SanitizedAction> | null {
  // Before the loop allocates anything. `out` is not even built yet: the
  // per-entry work below (address regex, `new Headers()`, `sanitize()` on
  // every drop log) is what an over-long list is buying, and it is bought in
  // the shared proxy isolate ahead of any quota gate.
  if (actions.length > MAX_ACTIONS) {
    console.error(
      `[email-router] action list dropped: ${actions.length} actions returned (max ${MAX_ACTIONS})`,
    );
    return null;
  }
  const out: Array<SanitizedAction> = [];
  // Bytes of the replies accepted so far, against `MAX_REPLY_BYTES_TOTAL`.
  let replyBytesUsed = 0;
  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      // Never `String(action)` here: a string is bounded by `sanitize`, but a
      // BigInt's decimal conversion is not — see `describeUntrusted`.
      console.error(`[email-router] dropping non-object action: ${describeUntrusted(action, 320)}`);
      continue;
    }
    if (action.type === 'reject') {
      // CRLF / control chars in the reason would inject into the SMTP DSN
      // we hand back to the remote MTA. `sanitize` truncates, then strips,
      // so a multi-megabyte control-heavy reason never gets a full pass.
      const raw = typeof action.reason === 'string' ? action.reason : '';
      const reason =
        raw.length > 0 ? sanitize(raw, MAX_REJECT_REASON_LENGTH) : 'rejected by handler';
      out.push({ type: 'reject', reason });
      // Reject is terminal — stop validating subsequent actions so they
      // don't appear in tail logs as if they could have fired.
      return out;
    }
    if (action.type === 'forward') {
      if (!isValidEmailAddress(action.to)) {
        console.error(
          `[email-router] forward dropped: invalid "to" address ${logAddress(action.to)}`,
        );
        continue;
      }
      let headers: Headers | undefined;
      if (action.headers) {
        if (!forwardHeadersWithinBounds(action.headers)) {
          return null;
        }
        try {
          headers = new Headers(action.headers);
        } catch (e) {
          // Header construction throws on CRLF / NUL / unsafe chars. We
          // can't safely partial-enact: a forward earlier in the list
          // may already have fired by the time we reach the bad headers
          // (under the old single-pass impl). Pre-validate the entire
          // list and drop everything if any header construction throws.
          console.error(
            `[email-router] action list dropped: forward headers invalid:`,
            e instanceof Error ? sanitize(e.message, 320) : sanitize(String(e), 320),
          );
          return null;
        }
      }
      out.push({ type: 'forward', to: action.to, headers });
    } else if (action.type === 'reply') {
      if (!isValidEmailAddress(action.from) || !isValidEmailAddress(action.to)) {
        console.error(
          `[email-router] reply dropped: invalid address (from=${logAddress(action.from)} to=${logAddress(action.to)})`,
        );
        continue;
      }
      // Sender pin (F1). The recipient is gated later by
      // `checkOutboundGate`; this gates who we are allowed to BE. Dropped
      // here rather than at enaction so an impersonating reply never
      // reaches the quota counters.
      if (!isPermittedReplySender(action.from, replySender)) {
        console.error(
          `[email-router] reply dropped: sender not owned by project "${sanitize(replySender.slug, 64)}" (from=${logAddress(action.from)})`,
        );
        continue;
      }
      // The envelope is pinned; now pin what the recipient will SEE. The
      // bytes are the tenant's, and `new EmailMessage(from, to, raw)` never
      // compares them with `from`, so a `From:` header naming a sibling
      // project would pass the sender pin above. Same check, same reason,
      // as `/email/send` in `email.ts`; `replyEmail()` always renders the
      // header from the address it records, so only a hand-built reply
      // can fail here.
      if (!(action.raw instanceof Uint8Array)) {
        console.error(
          `[email-router] reply dropped: raw is not a Uint8Array (from=${logAddress(action.from)})`,
        );
        continue;
      }
      // Size before the scan below, which is linear in `raw`. Both bounds
      // mirror the framework's `reply()`; see the constants for why the
      // proxy re-checks them and why an overrun drops only this reply.
      const replyBytes = action.raw.byteLength;
      if (replyBytes > MAX_REPLY_BYTES) {
        console.error(
          `[email-router] reply dropped: raw is ${replyBytes} bytes (max ${MAX_REPLY_BYTES}) (from=${logAddress(action.from)})`,
        );
        continue;
      }
      if (replyBytesUsed + replyBytes > MAX_REPLY_BYTES_TOTAL) {
        console.error(
          `[email-router] reply dropped: cumulative reply bytes ${replyBytesUsed + replyBytes} exceed this delivery's budget of ${MAX_REPLY_BYTES_TOTAL} (from=${logAddress(action.from)})`,
        );
        continue;
      }
      const mimeFrom = readMimeFromAddrSpec(action.raw);
      if (!mimeFrom.ok || mimeFrom.addrSpec.toLowerCase() !== action.from.toLowerCase()) {
        console.error(
          `[email-router] reply dropped: MIME From is not the envelope sender (from=${logAddress(action.from)}, ${mimeFrom.ok ? 'header names another address' : mimeFrom.reason})`,
        );
        continue;
      }
      replyBytesUsed += replyBytes;
      out.push({ type: 'reply', from: action.from, to: action.to, raw: action.raw });
    } else {
      // Unknown action type — log so handler authors notice rather than
      // silently doing nothing. The `type` is whatever the tenant put there;
      // `describeUntrusted` renders a string within 320 chars and a typed
      // array, Array, or BigInt by kind, never by contents.
      console.warn(
        `[email-router] dropping unknown action type: ${describeUntrusted((action as { type?: unknown }).type, 320)}`,
      );
    }
  }
  return out;
}

/**
 * Enact each sanitized action on the real ForwardableEmailMessage.
 *
 * Contract for forward/reply (HIGH H1 — per-project gating):
 * Every forward/reply MUST go through the same per-project guards as
 * `/email/send`:
 *   - `gate.allowlist` — recipient lowercased must be in the project's
 *     verified-destinations allowlist.
 *   - Burst counter: `gate.burstCurrent + 1 > gate.burstLimit` blocks.
 *   - Monthly counter: `gate.monthCurrent + 1 > gate.monthLimit` blocks.
 *
 * CF Email Routing destinations are account-wide. Without these gates,
 * inbound mail becomes a fan-out primitive against any tenant's verified
 * addresses (not just the receiving project's). The platform's
 * per-project allowlist is the security boundary; CF's account-wide
 * verified flag is NOT a substitute. See lessons.md
 * "Per-project consent on shared third-party verification flags".
 *
 * Those gates cover the RECIPIENT. The `reply` SENDER is pinned one phase
 * earlier, in `validateActions` via `isPermittedReplySender`, so a reply
 * impersonating another tenant (or the platform's reserved `noreply`) is
 * dropped before it can reach these counters.
 *
 * Suspend kill-switch is enforced upstream (in `routeInbound` before
 * dispatch); a suspended project's inbound mail never reaches this fn,
 * so the suspend check happens once and not per-action.
 *
 * Quota exhaustion DOES NOT change message acceptance. The inbound
 * message stays accepted by CF; we just stop firing further forward/reply
 * actions and log. Hard rejecting on quota would silently drop legitimate
 * inbound mail under a noisy outbound-action handler — worse than letting
 * the action drop on the floor with a logged warning.
 */
async function enactActions(
  env: Env,
  message: ForwardableEmailMessage,
  actions: Array<EmailAction>,
  gate: OutboundGate,
  replySender: ReplySenderPin,
): Promise<void> {
  const sanitized = validateActions(actions, replySender);
  if (sanitized === null) {
    // Header construction failed mid-validation — drop the whole list
    // (already logged in validateActions). Don't even attempt to commit
    // counters since no side effects fired.
    return;
  }
  await enactSanitized(env, message, sanitized, gate);
}

async function enactSanitized(
  env: Env,
  message: ForwardableEmailMessage,
  actions: Array<SanitizedAction>,
  gate: OutboundGate,
): Promise<void> {
  let counterDirty = false;
  for (const action of actions) {
    if (action.type === 'reject') {
      message.setReject(action.reason);
      // Reject is terminal — flush any counters we already incremented
      // before exiting so the burst window reflects forward/reply work
      // that already fired ahead of the reject.
      if (counterDirty) {
        await commitGateCounters(env, gate);
      }
      return;
    }
    if (action.type === 'forward') {
      if (!checkOutboundGate(gate, action.to, 'forward')) {
        continue;
      }
      try {
        await message.forward(action.to, action.headers);
        gate.burstCurrent += 1;
        gate.monthCurrent += 1;
        counterDirty = true;
      } catch (e) {
        console.error(
          `[email-router] forward to ${sanitize(action.to, 320)} failed:`,
          e instanceof Error ? sanitize(e.message, 320) : sanitize(String(e), 320),
        );
      }
    } else if (action.type === 'reply') {
      if (!checkOutboundGate(gate, action.to, 'reply')) {
        continue;
      }
      try {
        // EmailMessage's `raw` parameter is `string | ReadableStream`;
        // wrap the action's bytes as a one-shot stream rather than
        // decoding to UTF-8 (which would corrupt non-text MIME parts).
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(action.raw);
            controller.close();
          },
        });
        const reply = new EmailMessage(action.from, action.to, stream);
        await message.reply(reply as never);
        gate.burstCurrent += 1;
        gate.monthCurrent += 1;
        counterDirty = true;
      } catch (e) {
        console.error(
          `[email-router] reply ${sanitize(action.from, 320)}->${sanitize(action.to, 320)} failed:`,
          e instanceof Error ? sanitize(e.message, 320) : sanitize(String(e), 320),
        );
      }
    }
  }
  if (counterDirty) {
    await commitGateCounters(env, gate);
  }
}

/**
 * Allowlist + quota check for a single forward/reply target. Mutates
 * `gate.quotaExhausted` once a quota is hit so we don't keep
 * re-evaluating cap math for the rest of the action list.
 *
 * Returns `false` (and logs) when the action should be dropped.
 */
function checkOutboundGate(gate: OutboundGate, target: string, kind: 'forward' | 'reply'): boolean {
  if (gate.quotaExhausted) {
    console.error(
      `[email-router] ${kind} dropped: project quota exhausted (target=${sanitize(target, 320)})`,
    );
    return false;
  }
  if (!gate.projectId) {
    // No projectId on routing → no per-project guard available. Refuse
    // rather than fall back to "trust CF's account-wide flag", which is
    // exactly the security boundary HIGH H1 closes.
    console.error(
      `[email-router] ${kind} dropped: no projectId on routing entry (target=${sanitize(target, 320)})`,
    );
    return false;
  }
  const lowered = target.toLowerCase();
  if (!gate.allowlist.has(lowered)) {
    console.error(
      `[email-router] ${kind} dropped: recipient not in project allowlist (target=${sanitize(target, 320)})`,
    );
    return false;
  }
  if (gate.burstCurrent + 1 > gate.burstLimit) {
    console.error(`[email-router] ${kind} dropped: burst limit ${gate.burstLimit}/min exceeded`);
    gate.quotaExhausted = true;
    return false;
  }
  if (gate.monthCurrent + 1 > gate.monthLimit) {
    console.error(`[email-router] ${kind} dropped: monthly limit ${gate.monthLimit} exceeded`);
    gate.quotaExhausted = true;
    return false;
  }
  return true;
}
