/**
 * POST /email/relay — the inbound hop for custom sender domains (design doc
 * 0078, "Custom domains on Cloudflare").
 *
 * A relay worker deployed into the CUSTOMER's Cloudflare account (one per
 * registered domain) receives the zone's catch-all mail and streams the raw
 * MIME here, with the envelope in headers:
 *
 *   POST /email/relay
 *   Authorization: Bearer <relay secret>
 *   X-Void-Email-Domain / X-Void-Email-From / X-Void-Email-To
 *   <raw MIME body — no base64, no JSON envelope>
 *
 * Auth happens in the global auth middleware in `index.ts` (header and
 * content-length bounds BEFORE any crypto, then the mirror lookup, the
 * constant-time secret compare, the `active` status check, and
 * `context.set('projectId', …)`). This handler reads the body, builds the
 * `EmailEnvelope` from the header envelope + body, and runs the second half
 * of `routeInbound` — `routeRelayed` in `email-router.ts` — for the
 * mirror's project.
 *
 * The relay worker answers any non-2xx with `message.setReject` and a
 * generic reason, so this endpoint's response is one bit: 200 accepted,
 * anything else rejected. Failure detail stays in proxy logs; the response
 * body never carries it.
 */

import { Hono } from 'hono';
import { MAX_INBOUND_HEADERS, routeRelayed } from './email-router.ts';
import type { EmailEnvelope } from './email-router.ts';
import { MAX_MIME_BYTES } from './email.ts';
import type { ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

app.post('/relay', async (context) => {
  // Set by the auth branch; the envelope headers were presence- and
  // length-checked there. Read them here rather than trusting the body —
  // the relay derives them from the CF envelope, and the MIME's own From:/
  // To: headers are the sender's bytes.
  const projectId = context.get('projectId');
  const from = context.req.header('X-Void-Email-From') ?? '';
  const to = context.req.header('X-Void-Email-To') ?? '';
  // The auth branch proved the declared domain header equals the envelope
  // recipient's domain; attribute on the envelope, never on the claim.
  const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();

  const body = context.req.raw.body;
  if (!body) {
    return context.json({ error: 'mime body required' }, 400);
  }
  // The middleware checked the DECLARED content-length; a declared length
  // can lie, so the read is bounded again here.
  const raw = await readMimeBody(body);
  if (raw === null) {
    return context.json({ error: 'mime too large' }, 413);
  }
  const headers = parseRelayedHeaders(raw);
  if (headers === null) {
    return context.json({ error: 'too many headers' }, 413);
  }

  const envelope: EmailEnvelope = {
    from,
    to,
    headers,
    raw,
    rawSize: raw.byteLength,
    viaDomain: domain,
  };

  // Hono's `context.executionCtx` throws when the worker was invoked
  // without one (unit tests call `app.fetch(request, env)`). Fall back to a
  // collector whose promises are flushed before the response, so tests
  // observe the same log-recv effects production defers.
  const pending: Array<Promise<unknown>> = [];
  let ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  try {
    ctx = context.executionCtx as unknown as ExecutionContext;
  } catch {
    // No ExecutionContext on this invocation — keep the collector.
  }

  const outcome = await routeRelayed(context.env, ctx, { projectId, domain, envelope });
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  if (outcome.reject) {
    return context.json({ error: 'message rejected' }, 403);
  }
  return context.json({ ok: true });
});

/**
 * Bounded read of the request body — the same accumulation pattern as
 * `readStreamToBytes` in `email-router.ts`, against the outbound MIME cap
 * (the contract's "existing MIME size cap"), returning null instead of
 * throwing so the caller answers a plain 413.
 */
async function readMimeBody(stream: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_MIME_BYTES) {
      // Cancel so the peer stops sending; the size refusal is already
      // decided.
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort.
      }
      return null;
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

const LF = 0x0a;
const CR = 0x0d;

/**
 * RFC 7230 tchar — the only names `new Headers()` accepts. A line whose
 * name fails this is skipped WITH its continuations.
 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Rebuild the envelope's header bag from the raw MIME header block — the
 * relay carries no parsed headers, and the platform lane's `buildEnvelope`
 * equivalent for this lane has to read the same bytes the tenant will.
 *
 * The block ends at the first empty line. Continuation lines (leading WSP)
 * unfold onto the header they extend; a name repeated folds with `", "`,
 * matching how workerd's `Headers` presents a duplicated header on the
 * platform lane. `Object.fromEntries` defines each name as an OWN data
 * property for the same reason `buildEnvelope` uses it: a `__proto__`
 * header must never touch the prototype chain.
 *
 * The tenant worker rebuilds a `Headers` from this record inside
 * `createMessageProxy`, and a throw there fails dispatch — so any name that
 * is not a tchar token, and any value `new Headers()` would refuse (NUL,
 * CR, LF, DEL and the other C0/C1 controls, or a code point above the
 * ByteString ceiling), is SKIPPED rather than passed through. The raw MIME
 * stays authoritative: `parseEmail` in the tenant sees everything.
 *
 * Returns null when the block holds more DISTINCT names than
 * `MAX_INBOUND_HEADERS` — the same refusal the platform lane makes.
 */
function parseRelayedHeaders(raw: Uint8Array): Record<string, string> | null {
  const block = new TextDecoder().decode(raw.subarray(0, headerBlockEnd(raw)));
  const folded = new Map<string, string>();
  // The name the current continuation line extends, or null when the
  // previous line was skipped.
  let current: string | null = null;
  let pos = 0;
  while (pos < block.length) {
    let nl = block.indexOf('\n', pos);
    if (nl === -1) {
      nl = block.length;
    }
    let line = block.slice(pos, nl);
    pos = nl + 1;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line === '') {
      break;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (current !== null && headerValueSafe(line)) {
        folded.set(current, `${folded.get(current) ?? ''} ${line.trim()}`);
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      current = null;
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME_RE.test(name) || !headerValueSafe(value)) {
      current = null;
      continue;
    }
    const existing = folded.get(name);
    if (existing !== undefined) {
      folded.set(name, `${existing}, ${value}`);
    } else {
      if (folded.size >= MAX_INBOUND_HEADERS) {
        return null;
      }
      folded.set(name, value);
    }
    current = name;
  }
  return Object.fromEntries(folded);
}

/** Byte offset where the header block ends (the first empty line). */
function headerBlockEnd(raw: Uint8Array): number {
  let lineStart = 0;
  while (lineStart < raw.length) {
    const lf = raw.indexOf(LF, lineStart);
    const lineEnd = lf === -1 ? raw.length : lf;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && raw[contentEnd - 1] === CR) {
      contentEnd--;
    }
    if (contentEnd === lineStart) {
      return lineStart;
    }
    lineStart = lf === -1 ? raw.length : lf + 1;
  }
  return raw.length;
}

/**
 * True when `new Headers()` accepts the value: HTAB, visible ASCII, and
 * Latin-1 (the ByteString range) are legal; every other control and any
 * code point above 0xff is not.
 */
function headerValueSafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09) {
      continue;
    }
    if (code < 0x20 || code === 0x7f || code > 0xff) {
      return false;
    }
  }
  return true;
}

export { app as emailRelay };
