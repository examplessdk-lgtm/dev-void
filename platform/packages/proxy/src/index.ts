import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ai } from './ai.ts';
import { asNumber, asString, isProxyBody } from './body.ts';
import { d1 } from './d1.ts';
import { routeInbound } from './email-router.ts';
import { email } from './email.ts';
import { kv } from './kv.ts';
import { r2 } from './r2.ts';
import { verifyPrerenderBuild, verifyProjectOwner } from './resolve.ts';
import { revalidate } from './revalidate.ts';
import { sandbox } from './sandbox.ts';
import type { Env, JwtPayload, ProxyBody, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();

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

// Auth middleware — parses body, authenticates, sets projectId
app.post('/*', async (context, next) => {
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
  const path = new URL(context.req.url).pathname;
  if (path.startsWith('/email/internal/')) {
    const platformToken = asString(body.platformToken);
    const platformTimestamp = asNumber(body.platformTimestamp);
    if (!platformToken || platformTimestamp === null) {
      return context.json({ error: 'platform token required' }, 403);
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

// Route groups
app.route('/ai', ai);
app.route('/d1', d1);
app.route('/kv', kv);
app.route('/r2', r2);
app.route('/revalidate', revalidate);
app.route('/sandbox', sandbox);
app.route('/email', email);

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
