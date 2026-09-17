import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ai } from './ai.ts';
import { asNumber, asString, isProxyBody } from './body.ts';
import { d1 } from './d1.ts';
import { emailRelay } from './email-relay.ts';
import { routeInbound } from './email-router.ts';
import {
  email,
  MAX_MIME_BYTES,
  MAX_RECIPIENT_LENGTH,
  MAX_SENDER_LENGTH,
  readEmailDomainMirror,
} from './email.ts';
import { kv } from './kv.ts';
import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from './platform-lifecycle.ts';
import { r2 } from './r2.ts';
import { verifyPrerenderBuild, verifyProjectOwner } from './resolve.ts';
import { revalidate } from './revalidate.ts';
import { sandbox } from './sandbox.ts';
import type { Env, JwtPayload, ProxyBody, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

app.use('/*', async (context, next) => {
  const healthProbeToken = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  const installerProbe =
    healthProbeToken !== undefined &&
    healthProbeToken !== '' &&
    context.req.path === '/health' &&
    context.req.header('X-Void-Platform-Probe') === healthProbeToken;
  if (
    !installerProbe &&
    (context.env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      (context.env.PLATFORM_INSTALLATION_ID &&
        (await context.env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE))
  ) {
    return context.json({ error: 'Platform disabled' }, 503);
  }
  await next();
});

// CORS
app.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
  }),
);

// Health check
app.get('/health', (context) =>
  context.json({
    ok: true,
    bindings: {
      ai: !!context.env.AI,
      kv: !!context.env.ROUTING,
      jwt: !!context.env.JWT_SECRET,
      api: !!context.env.API,
      sendEmail: !!context.env.SEND_EMAIL,
      emailDomain: !!context.env.EMAIL_SENDER_DOMAIN,
    },
  }),
);

// Reject non-POST for all other routes
app.all('/*', async (context, next) => {
  if (context.req.method !== 'POST') {
    return context.json({ error: 'method not allowed' }, 405);
  }
  await next();
});

// Sentinel string the api worker signs with JWT_SECRET for platform-internal
// calls (e.g. POST /email/internal/send). Only the proxy and api hold
// JWT_SECRET — user workers do not — so this gate keeps user code from
// reaching internal endpoints. Mirrors the same value in
// `packages/api/src/email/send-verification.ts`; bumping requires a
// coordinated proxy + api deploy.
const PLATFORM_INTERNAL_EMAIL_SENTINEL = 'void-platform-internal-email-v1';

/**
 * Largest base64 payload the platform-internal auth path will hash. Mirrors
 * `MAX_MIME_BYTES` in `email.ts` (10 MiB), expressed as its base64 length with
 * `+4` for padding rounding.
 */
const MAX_PLATFORM_MIME_BASE64_LENGTH = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4;

// Bind a fresh timestamp into the HMAC and require the request to land
// within this many seconds of "now" — without it, a single observed
// platformToken would replay forever (the sentinel never changes). Five
// minutes covers normal clock skew without giving an attacker who
// observed a token a meaningful replay window.
const PLATFORM_TOKEN_MAX_SKEW_SECONDS = 5 * 60;

/**
 * Exact length of a well-formed `platformToken`. The only signer
 * (`signSentinelAtBound` in `packages/api/src/email/send-verification.ts`)
 * emits an HMAC-SHA256 tag — 32 bytes — as unpadded base64url, and
 * ceil(32 * 4 / 3) = 43 characters is the only length that encodes to. Any
 * other length can never verify, so it is refused before `verifyHmac` runs:
 * `base64urlDecode` copies the token twice through global `replace` (V8
 * materializes one part per match) and then `Uint8Array.from` iterates
 * `atob`'s output one character at a time — measured, a 30 MB token is
 * ~1.5 GB of transient heap and ~2 s, and a 4 MB one kills a 128 MB heap,
 * the shared proxy isolate's ceiling. This gate runs ahead of any
 * credential check, so without the bound an unauthenticated caller chose
 * that cost.
 */
const PLATFORM_TOKEN_LENGTH = 43;

// Auth middleware — parses body, authenticates, sets projectId
app.post('/*', async (context, next) => {
  const path = new URL(context.req.url).pathname;

  // /email/relay — the custom-domain inbound hop (design doc 0078, "Custom
  // domains on Cloudflare"). A relay worker in the CUSTOMER's account POSTs
  // the raw MIME as the request body — not JSON — with the envelope in
  // headers:
  //
  //   Authorization: Bearer <relay secret>
  //   X-Void-Email-Domain / X-Void-Email-From / X-Void-Email-To
  //
  // so this branch MUST run ahead of the JSON parse below. Modelled on the
  // /email/internal/ branch: every size bound runs BEFORE any crypto, so an
  // unauthenticated caller cannot choose how much hashing or KV work a
  // malformed request buys.
  if (path === '/email/relay') {
    const relayDomain = context.req.header('X-Void-Email-Domain');
    const relayFrom = context.req.header('X-Void-Email-From');
    const relayTo = context.req.header('X-Void-Email-To');
    const relayAuth = context.req.header('Authorization');
    if (!relayDomain || !relayFrom || !relayTo || !relayAuth) {
      return context.json({ error: 'relay envelope required' }, 400);
    }
    // Each header is bounded before it is used. 256 is generous: the
    // bearer is a 43-char secret and RFC 5321 caps an address at 254.
    if (
      relayDomain.length > 256 ||
      relayFrom.length > 256 ||
      relayTo.length > 256 ||
      relayAuth.length > 256
    ) {
      return context.json({ error: 'relay envelope required' }, 400);
    }
    // The MIME cap is checked against the DECLARED length before the body
    // is touched; the handler re-bounds while streaming, since a declared
    // length can lie. A missing length is refused outright — the relay
    // knows rawSize and always sets it.
    const contentLengthRaw = context.req.header('content-length');
    if (!contentLengthRaw) {
      return context.json({ error: 'content-length required' }, 400);
    }
    const contentLength = Number(contentLengthRaw);
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      return context.json({ error: 'content-length required' }, 400);
    }
    if (contentLength > MAX_MIME_BYTES) {
      return context.json({ error: 'mime too large' }, 413);
    }
    const relaySecret = relayAuth.startsWith('Bearer ') ? relayAuth.slice(7) : null;
    if (!relaySecret) {
      return context.json({ error: 'invalid relay credentials' }, 403);
    }
    // Attribution binds to the envelope RECIPIENT's domain, never to the
    // relay's declared domain header: a catch-all rule can be zone-wide, so
    // a relay can receive mail addressed to a different domain on the same
    // zone — and its secret must not author that mail. The declared header
    // must equal the recipient's domain; a mismatch means the relay or its
    // wiring is wrong, and the cheap string check runs before any KV work.
    const recipientDomain = relayTo.slice(relayTo.lastIndexOf('@') + 1).toLowerCase();
    if (recipientDomain.length === 0 || recipientDomain !== relayDomain.toLowerCase()) {
      return context.json({ error: 'relay domain mismatch' }, 403);
    }
    // secret → domain → project. The mirror carries only the sha256 of the
    // relay secret, so knowledge is proved without KV holding anything
    // reusable; the compare is constant-time against that hash. Read
    // uncached: a revoked or rotated secret must stop working at KV speed.
    const mirror = await readEmailDomainMirror(context.env.ROUTING, recipientDomain);
    if (!mirror) {
      return context.json({ error: 'invalid relay credentials' }, 403);
    }
    const presented = await sha256Hex(relaySecret);
    if (!constantTimeEqual(presented, mirror.relaySecretSha256)) {
      return context.json({ error: 'invalid relay credentials' }, 403);
    }
    if (mirror.status !== 'active') {
      return context.json({ error: 'email domain is not active' }, 403);
    }
    context.set('projectId', mirror.projectId);
    await next();
    return;
  }

  let body: ProxyBody;
  try {
    const json = await context.req.json<unknown>();
    if (!isProxyBody(json)) {
      return context.json({ error: 'invalid JSON body' }, 400);
    }
    body = json;
  } catch {
    return context.json({ error: 'invalid JSON body' }, 400);
  }
  context.set('body', body);

  // Platform-internal endpoints (e.g. /email/internal/send) authenticate
  // via an HMAC of `<sentinel>.<unixSeconds>.<sha256(from|to|mimeBase64)>`
  // under JWT_SECRET. They have no projectId — they exist for api → proxy
  // calls that don't belong to a user project (verification mail, etc.).
  // User-token requests can never reach this path because the sentinel is
  // not a projectId.
  //
  // **Content binding.** The hash binds the token to the (from, to,
  // mimeBase64) tuple it authorizes. Without it, a captured platformToken
  // inside the 5-minute skew window could be replayed against a different
  // recipient or arbitrary MIME bytes — the timestamp alone has no relation
  // to what the request actually asks the proxy to do. With it, an attacker
  // who observes one verification email's token can only ever resend that
  // exact email; recipient, content, and quota are all locked.
  //
  // The api worker MUST sign:
  //   `<sentinel>.<unixSeconds>.<hex sha256 of from|to|mimeBase64>`
  // see `packages/api/src/email/send-verification.ts` for the reference
  // signer. The fields are joined with a literal `|` so a tampering attempt
  // can't slide bytes between them.
  //
  // The prefix is pinned to `/email/internal/` only. A bare `/internal/`
  // prefix would be a footgun: any future handler mounted at root
  // `/internal` would silently inherit sentinel-only auth with no projectId
  // set. Today no such handler exists; if one ever does, it should be
  // mounted under its own feature-prefixed namespace.
  if (path.startsWith('/email/internal/')) {
    const platformToken = asString(body.platformToken);
    const platformTimestamp = asNumber(body.platformTimestamp);
    if (!platformToken || platformTimestamp === null) {
      return context.json({ error: 'platform token required' }, 403);
    }
    // A token of the wrong length is present but can never be valid, so it
    // takes the same opaque refusal as the skew and size gates below —
    // `required` is reserved for an absent token. Checked before anything
    // else touches the token; see `PLATFORM_TOKEN_LENGTH`.
    if (platformToken.length !== PLATFORM_TOKEN_LENGTH) {
      return context.json({ error: 'invalid platform token' }, 403);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - platformTimestamp) > PLATFORM_TOKEN_MAX_SKEW_SECONDS) {
      // Stale or future-dated token. Don't distinguish for the caller —
      // both look like an invalid token from outside.
      return context.json({ error: 'invalid platform token' }, 403);
    }
    // Bind the token to the body's (from|to|mimeBase64). Pull the raw
    // strings here (asString returns null for non-strings) and compute the
    // same sha256 the api worker computes when signing.
    const bindingFrom = asString(body.from);
    const bindingTo = asString(body.to);
    const bindingMime = asString(body.mimeBase64);
    if (!bindingFrom || !bindingTo || !bindingMime) {
      // No fields to bind — the request body is malformed for any
      // /email/internal/* handler we expose today. Reject at the auth
      // boundary so the handler doesn't have to re-decide what to do with a
      // partially-authed request.
      return context.json({ error: 'invalid platform token' }, 403);
    }
    // Bound the input BEFORE hashing it. This runs before the token is
    // verified, so an unauthenticated caller would otherwise choose how much
    // sha256 work we do. The bound is the base64 length of the same
    // MAX_MIME_BYTES the handlers enforce; the handler still re-checks the
    // decoded size, this only refuses to hash what can never be valid.
    if (bindingMime.length > MAX_PLATFORM_MIME_BASE64_LENGTH) {
      return context.json({ error: 'invalid platform token' }, 403);
    }
    // The two addresses are hashed alongside the MIME and were the only
    // part of the input left unbounded. The template below flattens
    // `from|to|mime` into one full-size string and `TextEncoder` copies it
    // again (measured: +1x on the heap and +1x external for the pair), so
    // without this an unauthenticated caller with a small MIME still chose
    // two more full-size copies plus the sha256 over them. The bounds are
    // the ones `/email/send` applies to its sender and recipients, and they
    // refuse nothing the only signer sends: `/email/internal/send` accepts
    // exactly `noreply@<EMAIL_SENDER_DOMAIN>` as `from`, and `to` is one
    // address the api worker already bounded at the same 320 when it was
    // registered (`api/src/routes/email.ts`) — RFC 5321 caps a path at 256
    // octets anyway. Same opaque refusal: from outside, a body that cannot
    // be signed and a body that was not are one case.
    if (bindingFrom.length > MAX_SENDER_LENGTH || bindingTo.length > MAX_RECIPIENT_LENGTH) {
      return context.json({ error: 'invalid platform token' }, 403);
    }
    const contentHash = await sha256Hex(`${bindingFrom}|${bindingTo}|${bindingMime}`);
    const signed = `${PLATFORM_INTERNAL_EMAIL_SENTINEL}.${platformTimestamp}.${contentHash}`;
    if (!(await verifyHmac(signed, platformToken, context.env.JWT_SECRET))) {
      return context.json({ error: 'invalid platform token' }, 403);
    }
    // Internal endpoints don't operate on a project — leave projectId unset.
    // Downstream handlers must not call context.get('projectId').
    await next();
    return;
  }

  const authHeader = context.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // HTTPS path (local dev) — validate JWT
    const token = authHeader.slice(7);
    const payload = await verifyJwt(token, context.env.JWT_SECRET);
    if (!payload) {
      return context.json({ error: 'invalid or expired token' }, 401);
    }
    const projectId = asString(body.projectId);
    if (!projectId) {
      return context.json({ error: 'projectId required' }, 400);
    }
    if (payload.aud === 'prerender') {
      // Prerender credentials are short-lived and already pinned to one
      // project by the API that minted them. Never turn one into a general
      // owner token by accepting a caller-selected projectId.
      if (!payload.project || payload.project !== projectId) {
        return context.json({ error: 'forbidden' }, 403);
      }
      if (
        payload.build &&
        !(await verifyPrerenderBuild(
          context.env.API,
          context.env.JWT_SECRET,
          projectId,
          payload.build,
        ))
      ) {
        return context.json({ error: 'prerender token build is no longer active' }, 403);
      }
    } else {
      // Full API tokens retain the local-development ownership lookup.
      const owns = await verifyProjectOwner(
        context.env.API,
        context.env.JWT_SECRET,
        projectId,
        payload.sub,
      );
      if (!owns) {
        return context.json({ error: 'forbidden' }, 403);
      }
    }
    context.set('projectId', projectId);
  } else {
    // Service binding path (production) — verify HMAC-signed project token
    const projectId = asString(body.projectId);
    const aiToken = asString(body.aiToken);
    if (!projectId || !aiToken) {
      return context.json({ error: 'projectId and aiToken required' }, 400);
    }
    if (!(await verifyHmac(projectId, aiToken, context.env.JWT_SECRET))) {
      return context.json({ error: 'invalid project token' }, 403);
    }
    context.set('projectId', projectId);
  }

  await next();
});

// AI usage limit check — only applies to AI routes
app.post('/ai/*', async (context, next) => {
  if (await context.env.ROUTING.get(`ai-block:${context.get('projectId')}`, { cacheTtl: 60 })) {
    return context.json({ error: 'AI usage limit exceeded' }, 429);
  }
  await next();
});

app.post('/sandbox/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'sandbox')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'sandbox',
        message: 'This Void platform does not enable sandbox.',
      },
      501,
    );
  }
  await next();
});

// Same gate for the email group. A deployed worker on a platform without
// the email module still holds `__VOID_PROXY` and a valid project token, so
// an explicit-`from` `sendEmail()` reaches `/email/send` and would otherwise
// answer with the sender-domain / send-binding configuration failures — or
// send, if the operator left the bindings in place. `/email/internal/send`
// is covered too: its only caller is the api's verification mail, which
// sits behind the api's own `email` capability gate.
app.post('/email/*', async (context, next) => {
  if (!proxyCapabilityEnabled(context.env.PLATFORM_CAPABILITIES, 'email')) {
    return context.json(
      {
        error: 'platform capability unavailable',
        capability: 'email',
        message: 'This Void platform does not enable email.',
      },
      501,
    );
  }
  await next();
});

// Route groups
app.route('/ai', ai);
app.route('/d1', d1);
app.route('/kv', kv);
app.route('/r2', r2);
app.route('/revalidate', revalidate);
app.route('/sandbox', sandbox);
app.route('/email', email);
app.route('/email', emailRelay);

export default {
  fetch: app.fetch,
  /**
   * Inbound email entry point — bound as the catch-all CF Email Routing rule
   * on the platform mail zone. See `email-router.ts`.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await routeInbound(message, env, ctx);
  },
};

function proxyCapabilityEnabled(value: string | undefined, capability: string): boolean {
  if (!value) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)[capability] === true
    );
  } catch {
    return false;
  }
}

// --- HMAC verification ---

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedVerifyKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  if (cachedVerifyKey && cachedKeySecret === secret) {
    return cachedVerifyKey;
  }
  cachedVerifyKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  cachedKeySecret = secret;
  return cachedVerifyKey;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Constant-time equality for two sha256-hex strings. Length is checked
 * first: both sides are 64-char hex digests in every legitimate use (the
 * mirror's `relaySecretSha256` and the presented secret's hash), so the
 * early out leaks nothing an attacker doesn't already know.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyHmac(data: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    return crypto.subtle.verify('HMAC', key, sigBytes.buffer as ArrayBuffer, encoder.encode(data));
  } catch {
    return false;
  }
}

// --- JWT verification ---

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (context) => context.charCodeAt(0));
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;

  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) {
      return null;
    }

    const payload = JSON.parse(decoder.decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }

    if (payload.aud !== 'api' && payload.aud !== 'prerender') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
