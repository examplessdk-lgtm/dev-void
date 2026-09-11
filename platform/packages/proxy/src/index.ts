import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ai } from './ai.ts';
import { asString, isProxyBody } from './body.ts';
import { d1 } from './d1.ts';
import { kv } from './kv.ts';
import { r2 } from './r2.ts';
import { verifyProjectOwner } from './resolve.ts';
import { revalidate } from './revalidate.ts';
import { sandbox } from './sandbox.ts';
import type { JwtPayload, ProxyBody, ProxyEnv } from './types.ts';

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
    // Verify the authenticated user owns this project
    const owns = await verifyProjectOwner(
      context.env.API,
      context.env.JWT_SECRET,
      projectId,
      payload.sub,
    );
    if (!owns) {
      return context.json({ error: 'forbidden' }, 403);
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

export default app;

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

    if (payload.aud !== 'api') {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
