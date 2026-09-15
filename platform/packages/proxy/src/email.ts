import { isReservedEmailSlug } from '@voidcloud/api/reserved-slugs';
import { EmailMessage } from 'cloudflare:email';
import { Hono } from 'hono';
import { asString } from './body.ts';
import type { Env, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

/**
 * Cap inbound MIME bytes well below CF's ~10 MB base64-inflated ceiling. The
 * framework enforces the same cap client-side; this is the proxy-side belt to
 * the framework's suspenders.
 */
export const MAX_MIME_BYTES = 10 * 1024 * 1024;

/**
 * Cap the recipient list. Every entry costs a trimmed+lowercased copy, a
 * `seen` Set entry, and — for an address this project's allowlist rejects —
 * one delivery object whose message interpolates the address, all of which
 * is then serialized into the response. That is ~360 bytes of isolate heap
 * per recipient, so an uncapped list reaches the 128 MB per-isolate ceiling
 * from a ~2.5 MB request body. A tenant worker holds a valid project HMAC,
 * so it can POST that body to the public proxy hostname, and the
 * all-rejected path returns ABOVE the burst and monthly gates — the work is
 * never metered and the request is endlessly repeatable. The proxy isolate
 * is shared with every other tenant's in-flight AI/D1/KV/R2 traffic, so the
 * kill is cross-tenant. The MIME cap does not bound this: `bcc` recipients
 * are deliberately kept out of the rendered headers, so a huge bcc list
 * costs nothing against `MAX_MIME_BYTES`.
 *
 * Checked against the RAW array BEFORE the normalization loop below. The
 * loop is what allocates, so deduping first would already have paid the
 * per-entry cost for a list of duplicates.
 */
const MAX_RECIPIENTS = 100;

/**
 * Cap a single recipient string. `MAX_RECIPIENTS` alone still leaves a
 * 100 x <address length> amplifier, because `.trim().toLowerCase()` copies
 * the entry — and the allowlist-rejection message interpolates it a second
 * time — before anything has looked at its size. Checked BEFORE that
 * normalization for exactly that reason. RFC 5321 caps a forward-path at
 * 256 octets, so 320 is generous for any address that could be delivered.
 */
export const MAX_RECIPIENT_LENGTH = 320;

/**
 * Cap the envelope sender for the same reason. It is one string, so there
 * is no list amplifier, but `from.toLowerCase()` below copies it whole
 * (measured: V8 returns a fresh full-size string even when nothing
 * changed), and a sender the strict regex accepts — an unbounded `+tag`
 * is one — is then echoed verbatim into the MIME `From:` refusal and
 * serialized into the response, three more copies of it. All of that runs
 * above the allowlist and quota gates, so it is never metered. Checked
 * with the other raw-input size gates, before any configuration or KV
 * read. Same figure as `MAX_RECIPIENT_LENGTH`, for the same RFC 5321
 * reason.
 *
 * Both are exported for the platform-token gate in `index.ts`, which
 * applies them to `/email/internal/send`'s `from` and `to` BEFORE hashing
 * the pair into the content binding — the same reason and the same
 * figures, on the one path that runs ahead of any credential check.
 */
export const MAX_SENDER_LENGTH = 320;

/**
 * The platform mail domain for this environment — `mail.void.cloud` in
 * production, `mail.staging.void.cloud` in staging. Configured as the
 * `EMAIL_SENDER_DOMAIN` var on both the proxy and api workers, and mirrored
 * into deployed user workers as the `__VOID_EMAIL_DOMAIN` plain-text binding
 * so the framework builds its default `from` against the same zone.
 *
 * There is deliberately NO baked-in default. A staging proxy that fell back
 * to `mail.void.cloud` would accept a `from` on the production zone, and the
 * production sender regex would reject every legitimate staging sender — the
 * exact reason the domain stopped being a constant. Missing configuration
 * fails the send CLOSED.
 */
export function readSenderDomain(env: Pick<Env, 'EMAIL_SENDER_DOMAIN'>): string | null {
  const raw = env.EMAIL_SENDER_DOMAIN;
  if (typeof raw !== 'string') {
    return null;
  }
  const domain = raw.trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/** Regex metacharacters, escaped before a config value is interpolated. */
const RE_METACHARS_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(RE_METACHARS_RE, '\\$&');
}

/**
 * Memoized per-domain sender regexes. Keyed by the configured
 * `EMAIL_SENDER_DOMAIN`, which is worker configuration and not user input,
 * so the map holds exactly one entry per isolate in practice.
 */
const strictFromCache = new Map<string, RegExp>();

/**
 * Strict shape for the outbound `from` envelope address. The slug+domain
 * pinning logic below splits on `+` and the first `@`, but those splits do
 * NOT reject CR/LF, quotes, angle brackets, or display-name forms. Without
 * this regex, a `from` like `slug+x\r\nX-Header: y@<domain>` would pass slug
 * pinning and then reach `new EmailMessage(from, ...)`, opening an SMTP
 * header injection primitive against the shared sender. The regex pins the
 * entire string to: lowercase ASCII local-part, optional `+<safe-tag>`
 * (constrained to RFC-5321 dot-atom-text + `=` and `/`), then exactly
 * `@<EMAIL_SENDER_DOMAIN>`. Display names, encoded-words, and angle brackets
 * are intentionally not supported — the framework doesn't emit them for a
 * default `from`, and explicit user-supplied names are already disallowed by
 * the slug pin.
 *
 * The `+tag` class is a positive class rather than `[^@\s]+` so even
 * non-printable ASCII (NUL, BEL, DEL, …) can't ride into `EmailMessage`.
 *
 * The domain is escaped before interpolation so a misconfigured value can
 * never widen the pattern (an unescaped `.` would match any character).
 */
export function strictFromRe(domain: string): RegExp {
  const cached = strictFromCache.get(domain);
  if (cached) {
    return cached;
  }
  const re = new RegExp(`^[a-z0-9._-]+(?:\\+[a-z0-9._=/-]+)?@${escapeRegExp(domain)}$`);
  strictFromCache.set(domain, re);
  return re;
}

/**
 * Valid project slug shape. The api worker writes `email-slug:<projectId>`
 * KV mirror entries; we read them and pin the `from` local-part against
 * the value. A poisoned KV (corrupted write, attacker-controlled bypass
 * of the api worker) returning e.g. `BADSLUG!` would then be accepted as
 * the source-of-truth slug and let `from: badslug!@<domain>` through — and
 * crucially, the strict-from regex above doesn't allow `!` in the
 * local-part, so the comparison would silently fail every future request
 * for that project without anyone noticing the bad data. Validate the slug
 * shape on read so a bad value surfaces as UPSTREAM_ERROR with a clear
 * message instead.
 */
const SLUG_RE = /^[a-z0-9._-]+$/;

/**
 * Strip CR/LF/NUL/control chars before logging or surfacing to remote MTAs.
 *
 * Built via new RegExp so oxlint's no-control-regex rule (which fires
 * on even Unicode-escaped control refs in regex literals) does not
 * reject the pattern. Behavior is identical to a literal regex.
 *
 * Slice FIRST, then replace — the same order as `sanitize` in
 * `email-router.ts`, for the same reason: a global replace materializes one
 * part per match, so a control-heavy input costs far more than one copy
 * (measured: a 5 MB `\na\na…` value is +170 MB of transient heap through the
 * old replace-then-slice order, past the 128 MB isolate ceiling; slice-first
 * is 0 ms). Most callers already pass bounded values; `requestId` at intake
 * and the inbound `Subject:` header did not. The result is at most `maxLen`
 * chars and may be shorter — a control run inside the window collapses to
 * one space and nothing is refilled from beyond it — which loses nothing on
 * a log line.
 */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');
function sanitizeForLog(value: string, maxLen = 200): string {
  return value.slice(0, maxLen).replace(CONTROL_CHARS_RE, ' ');
}

/**
 * Cap the caller-supplied log correlation id. The framework sends 16 hex
 * chars (`newRequestId` in `void/email`), but a hand-built tenant worker can
 * send any string the request body carries, and the only consumer is the
 * `[email-log]` line — one per delivery, so up to `MAX_RECIPIENTS` copies of
 * it per request — in the shared proxy log stream. It is diagnostic, so it
 * is bounded and sanitized ONCE at intake rather than refused with a 400:
 * a missing or non-string id already logs as `unknown` instead of failing
 * the send, and a truncated id is no less useful to correlate on. The
 * control-char strip is what stops a `\n` in the id from forging a second
 * `[email-log]` line under another project's id. 128 leaves room for a
 * UUID or a prefixed id without inviting anything longer.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Wrap a Uint8Array as a single-chunk ReadableStream. CF's EmailMessage
 * constructor accepts `string | ReadableStream`; passing a Uint8Array
 * directly is a TS error. Streaming a single chunk avoids decoding to
 * UTF-8 (which would corrupt non-text MIME parts that happen to be
 * stored in their decoded form).
 */
function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The addr-spec named by the message-level `From:` header, or why there is
 * no single one to name.
 *
 * `/send` pins the ENVELOPE sender (`from`) to the calling project's slug,
 * but the bytes a recipient's mail client shows as the sender are the MIME
 * `From:` header inside `mimeBase64`, and a tenant worker holding its own
 * project HMAC can post any bytes it likes there. Cloudflare's local
 * `send_email` simulator (miniflare `send_email.worker.ts`) throws
 * `From: header does not match mail from` for exactly this, and its author
 * says the messages mirror production — but nothing in the public docs
 * promises it, the same simulator takes the LAST of several `From:` headers
 * and the FIRST mailbox of a list, and the proxy is the platform's tenancy
 * boundary. So the proxy checks itself: exactly one `From:` header, holding
 * exactly one mailbox, whose addr-spec is the authorized envelope sender.
 *
 * Scope is deliberately narrow. The display name (a quoted-string or RFC
 * 2047 encoded-words before `<…>`) is NOT inspected — closing display-name
 * spoofing would need a real RFC 5322 scanner tracking `buildMime` forever,
 * and stays handed back. The structural specials outside quotes
 * (`, ; : ( ) [ ] \` and a bare `@` before `<`) are refused only because
 * each one would make "which mailbox is this" ambiguous — a list, a group,
 * a comment or a phrase that reads as an address — and `buildMime` never
 * emits any of them unquoted. `Sender:`, `Reply-To:` and `Resent-From:` are
 * not pinned: no client presents them as the author, and a reply sent to a
 * sibling project's inbound address is something anyone can do without the
 * proxy.
 *
 * Every line of the header block is visited so a `From:` cannot hide
 * behind an unrelated header, and continuation lines (leading WSP) are
 * unfolded onto the header they extend. The scan stops at the first empty
 * line — a `From:` inside a MIME part's own headers is that part's, not the
 * message's — or at the end of `raw`, which `MAX_MIME_BYTES` already
 * bounds. The work is one linear pass over bytes that are already in
 * memory; only the `From:` value is ever decoded to a string, and the
 * tokenizer below is a single pass with no backtracking, so a display
 * name of any length (which `buildMime` allows) costs what it weighs.
 *
 * "What it weighs" has to mean BYTES, not lines. The scan keeps nothing
 * per line — only the byte offsets of the one `From:` it found — because
 * `MAX_MIME_BYTES` bounds bytes and a folded header can hold one line per
 * three of them (` \r\n`): 3.5 million continuations fit in 10 MiB, and an
 * earlier shape that retained one `subarray` view per continuation held
 * ~125 bytes of heap each — 437 MB, measured, in an isolate of 128 MB that
 * every tenant's AI/D1/KV/R2 traffic shares. The same message with no
 * `From:` cost 1 MB, so the amplifier was the `From:` itself. The value is
 * unfolded with ONE copy of the header's byte range, and no copy at all
 * when it did not fold.
 *
 * Header names are matched the way lenient parsers (postal-mime, which
 * miniflare uses) match them — bytes before the first `:` with trailing
 * WSP trimmed, case-insensitively — so `From :` counts as a second `From:`
 * rather than slipping past as an unknown header. A bare CR inside a line
 * fails the scan: `buildMime` rejects CR/LF in every value, and a parser
 * that splits on LF alone would read the bytes after it as part of the
 * same header.
 */
export type MimeFrom =
  | { ok: true; addrSpec: string }
  | { ok: false; reason: 'missing' | 'multiple' | 'malformed' };

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HTAB = 0x09;
const COLON = 0x3a;
const FROM_NAME = [0x66, 0x72, 0x6f, 0x6d]; // "from"

/**
 * Where the value of the header line `raw[start, end)` begins if the line
 * is named `From` — the byte after its first `:` — or -1 if it is not.
 * The name is the bytes before that colon with trailing WSP trimmed,
 * compared case-insensitively; since it has to be exactly `from`, the
 * colon is looked for only across the WSP run that may follow those four
 * bytes, so the check reads at most the name and never searches the line.
 */
function fromValueStart(raw: Uint8Array, start: number, end: number): number {
  if (end - start <= FROM_NAME.length) {
    return -1;
  }
  for (let i = 0; i < FROM_NAME.length; i++) {
    // ASCII case fold: `A`..`Z` → `a`..`z`. Non-letters fold to themselves.
    if ((raw[start + i] | 0x20) !== FROM_NAME[i]) {
      return -1;
    }
  }
  let colon = start + FROM_NAME.length;
  while (colon < end && (raw[colon] === SP || raw[colon] === HTAB)) {
    colon++;
  }
  return colon < end && raw[colon] === COLON ? colon + 1 : -1;
}

/** Operator-readable detail for each way the pin can fail to find a sender. */
const MIME_FROM_REFUSALS: Record<Extract<MimeFrom, { ok: false }>['reason'], string> = {
  missing: 'the message has no From header',
  multiple: 'the message has more than one From header',
  malformed: 'the From header must hold a single mailbox',
};

export function readMimeFromAddrSpec(raw: Uint8Array): MimeFrom {
  const n = raw.byteLength;
  // The `From:` header as offsets into `raw`: its value starts after the
  // colon and ends where the content of its last line ends. `folded` says
  // whether a continuation line extended it, `inFrom` whether the line
  // being visited may.
  let fromCount = 0;
  let valueStart = -1;
  let valueEnd = -1;
  let folded = false;
  let inFrom = false;
  // The next CR at or after `lineStart`. Searched for lazily, each search
  // starting past the previous hit, so finding the bare CR that fails the
  // scan stays linear across a block of CR-less lines.
  let nextCr = raw.indexOf(CR);
  let lineStart = 0;
  while (lineStart < n) {
    const lf = raw.indexOf(LF, lineStart);
    const lineEnd = lf === -1 ? n : lf;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && raw[contentEnd - 1] === CR) {
      contentEnd--;
    }
    if (contentEnd === lineStart) {
      break; // empty line: end of the header block
    }
    if (nextCr !== -1 && nextCr < lineStart) {
      nextCr = raw.indexOf(CR, lineStart);
    }
    if (nextCr !== -1 && nextCr < contentEnd) {
      return { ok: false, reason: 'malformed' };
    }
    if (raw[lineStart] === SP || raw[lineStart] === HTAB) {
      if (inFrom) {
        valueEnd = contentEnd;
        folded = true;
      }
    } else {
      const start = fromValueStart(raw, lineStart, contentEnd);
      inFrom = start !== -1;
      if (inFrom) {
        fromCount++;
        valueStart = start;
        valueEnd = contentEnd;
        folded = false;
      }
    }
    lineStart = lf === -1 ? n : lf + 1;
  }
  if (fromCount === 0) {
    return { ok: false, reason: 'missing' };
  }
  if (fromCount > 1) {
    return { ok: false, reason: 'multiple' };
  }
  // Unfold (RFC 5322 §2.2.3): the value is the header's byte range with
  // its line breaks removed, each continuation keeping its leading WSP.
  // Every CR still inside the range ends a line — the scan refused any
  // other — so dropping CR and LF is the whole job, done in place on one
  // copy of the range. A header that did not fold needs no copy.
  let value = raw.subarray(valueStart, valueEnd);
  if (folded) {
    value = raw.slice(valueStart, valueEnd);
    let kept = 0;
    for (let i = 0; i < value.length; i++) {
      const byte = value[i];
      if (byte !== CR && byte !== LF) {
        value[kept++] = byte;
      }
    }
    value = value.subarray(0, kept);
  }
  const addrSpec = singleMailboxAddrSpec(new TextDecoder().decode(value));
  return addrSpec === null ? { ok: false, reason: 'malformed' } : { ok: true, addrSpec };
}

/**
 * The addr-spec of a header value that holds exactly one mailbox — either a
 * bare `addr-spec` or `[phrase] <addr-spec>` — or `null` when the value is
 * anything else. One pass; quoted-strings (with `\` escapes) are skipped
 * whole, and their contents are never interpreted.
 */
function singleMailboxAddrSpec(value: string): string | null {
  let inQuotes = false;
  let escaped = false;
  let lt = -1;
  let gt = -1;
  let firstAt = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    switch (ch) {
      case '"':
        // A quoted-string belongs to the phrase, which ends at `<`.
        if (lt !== -1) {
          return null;
        }
        inQuotes = true;
        break;
      case '<':
        if (lt !== -1) {
          return null;
        }
        lt = i;
        break;
      case '>':
        if (lt === -1 || gt !== -1) {
          return null;
        }
        gt = i;
        break;
      case '@':
        if (firstAt === -1) {
          firstAt = i;
        }
        break;
      case ',':
      case ';':
      case ':':
      case '(':
      case ')':
      case '[':
      case ']':
      case '\\':
        return null;
      default:
        break;
    }
  }
  if (inQuotes) {
    return null;
  }
  let addrSpec: string;
  if (lt === -1) {
    addrSpec = value.trim();
  } else {
    // `<` present: it needs its `>`, nothing but WSP may follow, and the
    // phrase before it must not read as an address of its own.
    if (gt === -1 || value.slice(gt + 1).trim().length !== 0) {
      return null;
    }
    if (firstAt !== -1 && firstAt < lt) {
      return null;
    }
    addrSpec = value.slice(lt + 1, gt);
  }
  // One printable-ASCII token. Rules out an empty `<>`, WSP inside the
  // brackets, and a code point that only LOOKS like the sender before the
  // caller lower-cases it for the compare.
  return /^[\x21-\x7e]+$/.test(addrSpec) ? addrSpec : null;
}

/**
 * Platform-wide suspension marker.
 *
 * `routing.suspended` is written into a project's routing blob by
 * `applyRoutingSuspension` / `setProjectsRoutingSuspension` in the api
 * worker and enforced with a 429 by `packages/dispatch`. Email is the other
 * tenant-facing egress path, so it has to honor the same marker: without
 * this check a project suspended for abuse keeps sending through the
 * platform's own account-level `send_email` binding. The narrower
 * `email-suspended:<projectId>` switch below stays as the email-only
 * kill-switch.
 *
 * No `cacheTtl`, for the same reason as `email-suspended:` — this is an
 * abuse-response control where convergence latency is the whole point.
 *
 * A MISSING routing blob is NOT read as a suspension. The marker is only
 * ever written INTO an existing entry, so a project with no routing entry
 * has nothing suspended; failing closed on absence would instead break every
 * send made before the first routing write.
 *
 * An UNPARSEABLE blob is a different case and is reported as `corrupt` so
 * the caller can fail closed. Every producer of this value
 * (`api/src/routing.ts`, `api/src/routes/deploy.ts`, `api/src/index.ts`)
 * writes a `JSON.stringify`d object, so there is no legitimate writer of a
 * malformed entry and therefore no false positive to trade against. Reading a parse
 * failure as "not suspended" would silently disable the platform-wide
 * suspension gate for exactly the project whose entry got corrupted.
 */
type RoutingSuspension =
  | { kind: 'absent' }
  | { kind: 'clear' }
  | { kind: 'suspended'; reason: string }
  | { kind: 'corrupt' };

async function readRoutingSuspension(kv: KVNamespace, slug: string): Promise<RoutingSuspension> {
  const raw = await kv.get(slug);
  if (!raw) {
    return { kind: 'absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  // `JSON.parse('null')` and friends parse cleanly but carry no marker to
  // read, and no producer emits them either — treat them as corrupt rather
  // than reaching for `.suspended` on a non-object.
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'corrupt' };
  }
  // The marker is read by TRUTHINESS, the same test the two sibling readers
  // apply — `packages/dispatch` (`if (routing.suspended)` → 429) and the
  // inbound router in `email-router.ts` (truthy → reject). A falsy present
  // value (`null`, `false`, `''`, `0`) is "not suspended" to both of them, so
  // it is `clear` here too: no writer emits one today (an unsuspend DELETES
  // the key), but a future clear that stamps `suspended: null` must not
  // brick every send. A TRUTHY value that is not a string has no writer
  // either — every producer stamps a non-empty reason string — yet both
  // siblings refuse on it, so it is `corrupt` rather than `clear`: the send
  // path must not be the one gate that reads a marker the edge and inbound
  // paths are blocking on as an open door.
  const suspended = (parsed as { suspended?: unknown }).suspended;
  if (!suspended) {
    return { kind: 'clear' };
  }
  if (typeof suspended !== 'string') {
    return { kind: 'corrupt' };
  }
  return { kind: 'suspended', reason: suspended };
}

/**
 * Outbound email send. The framework runtime POSTs:
 *
 *   {
 *     projectId, aiToken,           // auth (validated by middleware)
 *     from,                          // envelope sender (must be on an Email-Routing-enabled zone)
 *     recipients: string[],          // unique normalized recipient addresses
 *     mimeBase64,                    // raw MIME, base64-encoded
 *     byteSize,                      // declared raw byte count
 *     requestId, fromDomain?         // for logs
 *   }
 *
 * The proxy:
 *   1. Validates structure + size
 *   2. Checks platform suspension (`routing.suspended`) and the per-project
 *      email suspend kill-switch
 *   3. Checks the per-project verified-destinations allowlist
 *      (mirrored from `email_destinations` into `email-allowlist:<id>` KV)
 *   4. Runs burst + monthly outbound quota gates against the *allowed*
 *      recipient count (denied-by-allowlist sends don't burn quota)
 *   5. Calls `env.SEND_EMAIL.send()` per allowed recipient
 *   6. Returns a `SendEmailResult`-shaped JSON the framework passes through
 *
 * Quotas + allowlists live exclusively in the proxy. The user worker does
 * not have a `send_email` binding.
 */
app.post('/send', async (context) => {
  const projectId = context.get('projectId');
  const body = context.get('body');

  const from = asString(body.from);
  const mimeBase64 = asString(body.mimeBase64);
  // Bounded and sanitized here, once, so `logSend` never interpolates the
  // raw value; see `MAX_REQUEST_ID_LENGTH`.
  const requestIdRaw = asString(body.requestId);
  const requestId =
    requestIdRaw === null ? 'unknown' : sanitizeForLog(requestIdRaw, MAX_REQUEST_ID_LENGTH);
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : null;

  if (!from || !mimeBase64 || !recipientsRaw) {
    return context.json(
      { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'invalid body' } },
      400,
    );
  }

  // Bound the list before the normalization loop below allocates per entry.
  // Answered with the same 413 the MIME size guard uses — the framework
  // dispatches on `error.code`, not the status, and INVALID_TO is already
  // its code for an unusable recipient set.
  if (recipientsRaw.length > MAX_RECIPIENTS) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_TO',
          message: `too many recipients (max ${MAX_RECIPIENTS}, got ${recipientsRaw.length})`,
        },
      },
      413,
    );
  }

  // Bound the sender before anything copies it — the lowercase, the strict
  // regex and the refusal that echoes it all sit below. Same 413 as the
  // recipient bound; INVALID_FROM is the framework's code for an unusable
  // sender. The address is deliberately not echoed back.
  if (from.length > MAX_SENDER_LENGTH) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `sender exceeds ${MAX_SENDER_LENGTH} characters`,
        },
      },
      413,
    );
  }

  // Fail closed on missing sender configuration — never fall back to a
  // baked-in domain (see readSenderDomain). Resolved before any KV work so a
  // misconfigured environment can't burn quota counters on a send that can't
  // possibly be authorized.
  const senderDomain = readSenderDomain(context.env);
  if (!senderDomain) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'email sender domain is not configured',
        },
      },
      502,
    );
  }

  // Same reasoning for the send binding itself. Wrangler does not inherit
  // `send_email` into a named env, so a binding missing from one env block
  // would otherwise surface as a throw AFTER both counters were incremented.
  const sendBinding = context.env.SEND_EMAIL;
  if (typeof sendBinding?.send !== 'function') {
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'email sending is not configured',
        },
      },
      502,
    );
  }

  // Recipients must be unique strings; the framework already dedups but we
  // re-validate so a buggy client can't double-charge quota or pollute logs.
  const recipients: Array<string> = [];
  const seen = new Set<string>();
  for (const r of recipientsRaw) {
    if (typeof r !== 'string') {
      continue;
    }
    // Before `.trim().toLowerCase()` — that call is the allocation.
    // The address is deliberately not echoed back.
    if (r.length > MAX_RECIPIENT_LENGTH) {
      return context.json(
        {
          ok: false,
          error: {
            code: 'INVALID_TO',
            message: `recipient exceeds ${MAX_RECIPIENT_LENGTH} characters`,
          },
        },
        413,
      );
    }
    const lower = r.trim().toLowerCase();
    if (!lower || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    recipients.push(lower);
  }
  if (recipients.length === 0) {
    return context.json(
      { ok: false, error: { code: 'INVALID_TO', message: 'no recipients' } },
      200,
    );
  }

  // Pre-decode size guard — base64 expands ~4/3, so a base64 string longer
  // than `MAX_MIME_BYTES * 4 / 3 + 4` (the +4 absorbs padding rounding)
  // can't possibly decode to anything within the limit. Reject before
  // allocating a 75 MB Uint8Array for what we'd reject anyway. Defends
  // against adversarial OOM via outsized payloads.
  if (mimeBase64.length > Math.ceil((MAX_MIME_BYTES * 4) / 3) + 4) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'MIME_ERROR',
          message: `mime exceeds ${MAX_MIME_BYTES} bytes (base64 length ${mimeBase64.length})`,
        },
      },
      413,
    );
  }

  let raw: Uint8Array;
  try {
    raw = base64Decode(mimeBase64);
  } catch {
    return context.json(
      { ok: false, error: { code: 'MIME_ERROR', message: 'invalid base64 mime' } },
      400,
    );
  }
  // Defense-in-depth: the pre-decode check is conservative (uses base64
  // length), so a small over-by-one slip past it would still trip here.
  if (raw.byteLength > MAX_MIME_BYTES) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'MIME_ERROR',
          message: `mime exceeds ${MAX_MIME_BYTES} bytes (got ${raw.byteLength})`,
        },
      },
      413,
    );
  }

  // Resolve the project's slug via the `email-slug:<projectId>` mirror
  // the API writes on project create. We use this to enforce that the
  // `from` address belongs to the calling project — without this check,
  // project A could submit `from: <slug-of-B>+...@<domain>` and
  // impersonate B (the account-level send_email binding accepts any
  // sender on the zone).
  //
  // No cacheTtl: slug↔projectId is permanent, so KV's edge cache (60s
  // free-tier window) gives us locality without us pinning it.
  const expectedSlug = await context.env.ROUTING.get(`email-slug:${projectId}`);
  if (!expectedSlug) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'project slug unknown — refusing to send',
        },
      },
      502,
    );
  }
  // Defense-in-depth: reject malformed slugs from KV so a poisoned mirror
  // can't smuggle a bad `from` past the strict regex below or DoS future
  // sends with mismatched comparisons.
  if (!SLUG_RE.test(expectedSlug)) {
    console.error(
      `[email-send] project ${projectId} slug malformed in KV: ${sanitizeForLog(expectedSlug, 64)}`,
    );
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'project slug malformed in routing',
        },
      },
      502,
    );
  }
  // A slug that is an email identity of the domain itself (`noreply`, the
  // platform's own verification sender; `postmaster`, `abuse`, …) may not
  // send at all. `RESERVED_SLUGS` stops NEW projects from claiming one, but
  // a project registered before those were reserved still holds its slug,
  // and the mirror alone would let it send as `noreply@<domain>` —
  // indistinguishable from the platform. The api's backfill withholds and
  // removes the mirror for such a project; this refusal covers the mirror
  // that already exists until that pass runs, and any write that bypasses
  // the backfill. Refused as a bad `from` rather than a 502: nothing
  // upstream is missing, the identity is simply not the project's to use.
  if (isReservedEmailSlug(expectedSlug)) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `project slug "${expectedSlug}" is a reserved email identity on ${senderDomain} — refusing to send`,
        },
      },
      403,
    );
  }
  // Lowercase once for the strict regex + slug compare; the regex anchors
  // the whole string and intentionally rejects CR/LF, quotes, brackets,
  // and display-name forms before we touch EmailMessage.
  // The envelope is forwarded verbatim, so validation has to run on bytes that
  // cannot change under case folding. U+212A KELVIN SIGN lowercases to 'k' and
  // U+0130 to 'i', so a non-ASCII `from` can satisfy a lowercased regex and
  // still reach the shared envelope sender intact. Refuse it before that.
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return context.json(
      {
        ok: false,
        error: { code: 'INVALID_FROM', message: 'from address must be printable ASCII' },
      },
      403,
    );
  }
  const fromLower = from.toLowerCase();
  if (!strictFromRe(senderDomain).test(fromLower)) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `from address must be <${expectedSlug}>[+tag]@${senderDomain}`,
        },
      },
      200,
    );
  }
  const fromLocal = fromLower.slice(0, fromLower.indexOf('@'));
  const localPrefix = fromLocal.split('+')[0] ?? '';
  if (localPrefix !== expectedSlug.toLowerCase()) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `from address must be <${expectedSlug}>[+tag]@${senderDomain}`,
        },
      },
      200,
    );
  }

  // The envelope is pinned; now pin what the recipient will actually SEE.
  // A mismatch here is a request the framework never produces — `buildMime`
  // renders `From:` from the same `from.email` it posts as the envelope — so
  // it is refused outright rather than reported per recipient. Runs before
  // the suspension and allowlist reads for the same reason as the slug pin:
  // no KV work for a request that can never be authorized. The refusal may
  // echo `from`: it is at most `MAX_SENDER_LENGTH` printable-ASCII bytes by
  // now.
  const mimeFrom = readMimeFromAddrSpec(raw);
  if (!mimeFrom.ok || mimeFrom.addrSpec.toLowerCase() !== fromLower) {
    const detail = mimeFrom.ok
      ? 'the From header address does not match the envelope sender'
      : MIME_FROM_REFUSALS[mimeFrom.reason];
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `mime From must be the envelope sender ${from}: ${detail}`,
        },
      },
      403,
    );
  }

  // Platform-wide suspension — the same marker dispatch answers with a 429.
  // Checked before the email-only kill-switch so an account suspended for
  // abuse loses every egress path at once.
  const platformSuspension = await readRoutingSuspension(context.env.ROUTING, expectedSlug);
  // A blob we cannot parse leaves the marker's state unknown, so it fails
  // closed exactly like a poisoned slug mirror above: operator-visible 502,
  // no send, no quota burned.
  if (platformSuspension.kind === 'corrupt') {
    console.error(
      `[email-send] project ${projectId} routing blob malformed in KV for slug ${sanitizeForLog(expectedSlug, 64)}`,
    );
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'project routing entry malformed',
        },
      },
      502,
    );
  }
  if (platformSuspension.kind === 'suspended') {
    return context.json(
      {
        ok: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `project is suspended (${sanitizeForLog(platformSuspension.reason, 64)})`,
        },
      },
      200,
    );
  }

  // Suspend kill-switch — set by admin UI for abuse response. Also gates
  // inbound (see email-router.ts). No cacheTtl: this is an abuse-response
  // control where convergence latency is the whole point — we want to
  // pay for the extra KV get on every send so a suspend takes effect
  // immediately (subject only to KV's ~near-instant per-colo consistency).
  if (await context.env.ROUTING.get(`email-suspended:${projectId}`)) {
    return context.json(
      { ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'project email is suspended' } },
      200,
    );
  }

  // Per-project verified-destinations allowlist. KV mirror of the
  // email_destinations table maintained by the API on every CRUD; cacheTtl
  // bounds convergence at ~60s per colo. A cache miss (allowlist key
  // missing entirely) reads as empty, so a brand-new project with no
  // verified destinations gets every recipient rejected — matches the
  // design intent.
  const allowlist = await readAllowlist(context.env.ROUTING, projectId);

  const allowed: Array<string> = [];
  const deliveries: Array<RecipientResult> = [];
  for (const r of recipients) {
    if (allowlist.has(r)) {
      allowed.push(r);
    } else {
      deliveries.push({
        recipient: r,
        ok: false,
        error: {
          code: 'UNVERIFIED_DESTINATION',
          message: `recipient '${r}' is not a verified destination for this project`,
        },
      });
    }
  }
  if (allowed.length === 0) {
    return context.json({ ok: false, deliveries }, 200);
  }

  // Burst cap — fixed-window per-minute counter. Caps the spike before it
  // reaches CF's MTA so a noisy project can't trip the per-zone rate limit
  // for the shared platform sender.
  const now = new Date();
  const burstKey = `email-burst:${projectId}:${minuteBucket(now)}`;
  const burstCurrent = readCounter(await context.env.ROUTING.get(burstKey));
  const burstLimit = await getBurstLimit(context.env.ROUTING, projectId);
  if (burstCurrent + allowed.length > burstLimit) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `outbound burst limit ${burstLimit}/min exceeded`,
        },
      },
      429,
    );
  }

  // Monthly counter. YYYY-MM bucket auto-rolls.
  const counterKey = `email-sent:${projectId}:${monthBucket(now)}`;
  const monthCurrent = readCounter(await context.env.ROUTING.get(counterKey));
  const monthLimit = await getMonthlyLimit(context.env.ROUTING, projectId);
  if (monthCurrent + allowed.length > monthLimit) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `monthly outbound limit ${monthLimit} exceeded`,
        },
      },
      429,
    );
  }

  // Optimistic increment of both counters.
  //
  // **Both caps are best-effort, and the monthly one is NOT a backstop for
  // the burst one.** Each counter is a KV read-modify-write, so concurrent
  // isolates read the same value and overshoot by
  // `(parallel_isolates × per_request_recipients)`. A wider window does not
  // fix that: KV accepts at most one write per second per key, so once the
  // send rate passes ~1 request/second the month counter stops advancing for
  // the rest of that second and every request inside it charges against the
  // same stale read. KV answers those rejected writes with a 429, which the
  // `.catch()` below swallows. The bypass scales with request rate and
  // degrades the monthly cap by the same factor as the burst cap. It does
  // not round to nothing.
  //
  // What these gates buy is a bound on accidental floods and a cheap reject
  // for the ordinary case. The real abuse control is the suspend
  // kill-switch (`email-suspended:` and the platform-wide
  // `routing.suspended` marker), which is why both are read uncached on
  // every send. Making either cap strict means moving the counter into a
  // Durable Object (or fronting it with CF rate limiting) — a platform
  // architecture decision, deliberately not taken here.
  //
  // Each put is wrapped independently so one failed write cannot drop the
  // other. A failed put means the next request reads a stale count and the
  // overshoot widens, which is accepted for the same reason as above.
  await Promise.all([
    context.env.ROUTING.put(counterKey, String(monthCurrent + allowed.length), {
      expirationTtl: monthTtlSeconds(now),
    }).catch((e) => {
      console.error(`[email-send] monthly counter put failed for ${projectId}:`, e);
    }),
    context.env.ROUTING.put(burstKey, String(burstCurrent + allowed.length), {
      expirationTtl: 5 * 60,
    }).catch((e) => {
      console.error(`[email-send] burst counter put failed for ${projectId}:`, e);
    }),
  ]);

  // Send fan-out. CF's `send_email` binding takes one recipient per
  // EmailMessage — we already split by recipient above.
  for (const r of allowed) {
    try {
      // EmailMessage accepts string | ReadableStream — wrap our buffered
      // bytes as a single-chunk stream. We can't reuse one stream across
      // recipients because streams are one-shot, so build per send.
      const msg = new EmailMessage(from, r, bytesToStream(raw));
      // Some CF builds don't return the messageId; we surface "" rather
      // than crash and let the framework decide whether to fall back.
      const result = await sendBinding.send(msg);
      deliveries.push({
        recipient: r,
        ok: true,
        messageId: typeof result?.messageId === 'string' ? result.messageId : '',
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deliveries.push({
        recipient: r,
        ok: false,
        error: {
          code: classifyUpstream(message),
          message,
        },
      });
    }
  }

  // Inline log (analytics-engine wiring TODO).
  logSend(projectId, requestId, deliveries);

  // If any recipient failed (allowlist miss OR upstream error), surface as
  // a mid-batch failure so callers can retry per-recipient.
  const anyFailed = deliveries.some((d) => !d.ok);
  if (anyFailed) {
    return context.json({ ok: false, deliveries }, 200);
  }
  return context.json({
    ok: true,
    ids: deliveries.map((d) => ({
      recipient: d.recipient,
      messageId: (d as { messageId: string }).messageId,
    })),
  });
});

// -----------------------------------------------------------------------------
// Inbound delivery log — kept here because it's invoked from email-router.ts
// inside the same worker (bypasses HTTP/auth).
// -----------------------------------------------------------------------------

/**
 * Inbound delivery log. Inlined here rather than via service binding because
 * the email-router lives in this same worker; routing through env.API would
 * 404 (and earlier did so silently).
 */
export async function recordInboundDelivery(
  env: { ROUTING: KVNamespace },
  projectId: string,
  info: { from: string; to: string; subject: string; byteSize: number; status: string },
): Promise<void> {
  const now = new Date();
  const counterKey = `email-recv:${projectId}:${monthBucket(now)}`;
  const current = readCounter(await env.ROUTING.get(counterKey));
  await env.ROUTING.put(counterKey, String(current + 1), {
    expirationTtl: monthTtlSeconds(now),
  });
  console.log(
    `[email-recv] ${projectId} ${sanitizeForLog(info.from, 320)} -> ${sanitizeForLog(info.to, 320)} ${info.status} (${info.byteSize}B) @${Date.now()} subject="${sanitizeForLog(info.subject)}"`,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface RecipientResult {
  recipient: string;
  ok: boolean;
  messageId?: string;
  error?: { code: string; message: string };
}

/**
 * Map a CF send_email error message to a framework-facing error code.
 *
 * UNVERIFIED_DESTINATION is special — the framework treats it as
 * "don't retry; the user has to verify the address first." A false
 * positive here turns retryable transient errors into permanent
 * non-retries, so the match is intentionally narrow.
 *
 * Anchored to the literal CF phrasing ("destination address … not
 * (yet) verified"), bounded character classes to keep `.*` from
 * jumping across log lines / multi-error stack traces, and a leading
 * `^[^\n]{0,200}` cap so a long preamble can't drag a tail-of-line
 * "destination address foo not verified" into a false positive on a
 * transient upstream error message that happens to mention the same
 * domain or address. Any other error falls through to UPSTREAM_ERROR
 * which the framework retries.
 */
const UNVERIFIED_DESTINATION_RE =
  /^[^\n]{0,200}destination address[^\n]{0,200}not (?:yet )?verified/i;

function classifyUpstream(msg: string): string {
  if (UNVERIFIED_DESTINATION_RE.test(msg)) {
    return 'UNVERIFIED_DESTINATION';
  }
  return 'UPSTREAM_ERROR';
}

function logSend(projectId: string, requestId: string, deliveries: Array<RecipientResult>): void {
  for (const d of deliveries) {
    const status = d.ok ? 'sent' : (d.error?.code ?? 'unknown_error');
    const id = d.messageId ?? '';
    console.log(
      `[email-log] ${projectId} ${requestId} ${sanitizeForLog(d.recipient, 320)} ${status} ${id} @${Date.now()}`,
    );
  }
}

/**
 * Reads `email-allowlist:<projectId>` from ROUTING KV. The API writes a JSON
 * array of lowercased verified addresses on every destination CRUD, on the
 * platform confirmation click, and — as the repair for a write it swallowed —
 * on a destinations listing that finds the key stale. Never on deploy.
 * cacheTtl bounds per-colo convergence at ~60s.
 */
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

/**
 * Defends against poisoned KV values: `parseInt('NaN'|'abc',10)` returns
 * NaN, which would (a) make `NaN > limit` false → bypass and (b) write
 * literal `"NaN"` back if used in arithmetic. Always coerces to a finite
 * non-negative integer, falling back to 0.
 */
function readCounter(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function base64Decode(b64: string): Uint8Array {
  // workerd `atob` is fast for body-sized payloads; fall back to manual
  // decode only when needed.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
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

/**
 * Seconds until shortly after the end of the current UTC month (1 hour
 * buffer absorbs late writes around the boundary). KV requires
 * `expirationTtl >= 60`.
 */
function monthTtlSeconds(now: Date): number {
  const endOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  const seconds = Math.ceil((endOfMonth - now.getTime()) / 1000) + 60 * 60;
  return Math.max(60, seconds);
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
 * Platform-internal send endpoint. Used by the api worker to dispatch
 * destination-verification emails: when project A adds an address that
 * a different project already verified via CF, we issue our own
 * confirmation email to the recipient instead of inheriting CF's
 * verification flag.
 *
 * Auth: HMAC of a fixed sentinel string + timestamp + sha256 of
 * (from|to|mimeBase64) under JWT_SECRET. The auth middleware in
 * `index.ts` validates the sentinel + timestamp window; this handler
 * additionally verifies the content-binding hash matches the body
 * fields it actually intends to act on. Without the content binding,
 * a captured platformToken inside the 5-minute skew window could be
 * replayed against a different (from, to, mime) tuple — the timestamp
 * alone has no relation to what the request asks the proxy to do.
 *
 * Token contract — the api worker MUST sign:
 *   `<sentinel>.<unixSeconds>.<sha256(from|to|mimeBase64) hex>`
 * with HMAC-SHA-256 under `JWT_SECRET`, where `mimeBase64` is the
 * EXACT string sent in the body and the three fields are joined by a
 * literal `|`. The proxy reconstructs and verifies. Mirroring this
 * format is required in `packages/api/src/email/send-verification.ts`.
 * Bumping the contract requires a coordinated proxy + api deploy.
 *
 * Only the proxy and api hold JWT_SECRET — user workers do not, so this
 * endpoint cannot be reached from a user worker.
 *
 * The `from` address is locked to a single allow-listed sender:
 * `noreply@<EMAIL_SENDER_DOMAIN>`. Earlier revisions trusted the body's
 * `from` and would have let a compromised api worker (or
 * misuse-via-coordinated-bug) send arbitrary platform-branded mail.
 * The verification-email use case is the only legitimate caller and it
 * always sends from `noreply@`; harden by allow-list rather than
 * relying on downstream filters.
 *
 * Body shape (validated below):
 *   { platformToken, platformTimestamp, from, to, mimeBase64 }.
 *
 * Quotas, allowlists, and the suspend kill-switch DO NOT apply here:
 * those are per-project guards, and platform verification mail is
 * account-level. Volume is bounded by the api worker's per-project KV
 * rate limit on `POST /destinations`, applied before tokens are issued.
 */

/** The single allowed platform-internal `from` local-part. */
const INTERNAL_FROM_LOCAL_PART = 'noreply';

app.post('/internal/send', async (context) => {
  const body = context.get('body');

  // Fail closed on missing sender configuration, exactly as `/send` does —
  // otherwise the allow-list below would have no domain to pin against.
  const senderDomain = readSenderDomain(context.env);
  if (!senderDomain) {
    return context.json({ ok: false, error: 'email sender domain is not configured' }, 502);
  }

  const from = asString(body.from);
  const to = asString(body.to);
  const mimeBase64 = asString(body.mimeBase64);
  if (!from || !to || !mimeBase64) {
    return context.json({ ok: false, error: 'invalid body' }, 400);
  }

  // Pin the platform-internal `from` to a single allow-listed envelope on
  // the configured zone: `noreply@<EMAIL_SENDER_DOMAIN>`.
  // The envelope is forwarded verbatim, so validation has to run on bytes that
  // cannot change under case folding. U+212A KELVIN SIGN lowercases to 'k' and
  // U+0130 to 'i', so a non-ASCII `from` can satisfy a lowercased regex and
  // still reach the shared envelope sender intact. Refuse it before that.
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return context.json({ ok: false, error: 'from not allowed for internal send' }, 403);
  }
  if (from.toLowerCase() !== `${INTERNAL_FROM_LOCAL_PART}@${senderDomain}`) {
    return context.json({ ok: false, error: 'from not allowed for internal send' }, 403);
  }

  const sendBinding = context.env.SEND_EMAIL;
  if (typeof sendBinding?.send !== 'function') {
    return context.json({ ok: false, error: 'email sending is not configured' }, 502);
  }

  let raw: Uint8Array;
  try {
    raw = base64Decode(mimeBase64);
  } catch {
    return context.json({ ok: false, error: 'invalid base64 mime' }, 400);
  }
  if (raw.byteLength > MAX_MIME_BYTES) {
    return context.json({ ok: false, error: 'too large' }, 413);
  }

  try {
    const msg = new EmailMessage(from, to, bytesToStream(raw));
    await sendBinding.send(msg);
    return context.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[email-internal] send failed from=${sanitizeForLog(from, 320)} to=${sanitizeForLog(to, 320)}: ${sanitizeForLog(message, 320)}`,
    );
    return context.json({ ok: false, error: 'upstream error' }, 502);
  }
});

export { app as email };
