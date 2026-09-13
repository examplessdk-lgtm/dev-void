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
const MAX_MIME_BYTES = 10 * 1024 * 1024;

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
const MAX_RECIPIENT_LENGTH = 320;

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
 */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');
function sanitizeForLog(value: string, maxLen = 200): string {
  return value.replace(CONTROL_CHARS_RE, ' ').slice(0, maxLen);
}

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
  const suspended = (parsed as { suspended?: unknown }).suspended;
  return typeof suspended === 'string' && suspended.length > 0
    ? { kind: 'suspended', reason: suspended }
    : { kind: 'clear' };
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
  const requestId = asString(body.requestId) ?? 'unknown';
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
