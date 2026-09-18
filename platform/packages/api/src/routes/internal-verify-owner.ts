import { Hono } from 'hono';
import { platformAccessVerifier } from '../auth/access.ts';
import { readAuthSettings } from '../auth/configuration.ts';
import { hmacVerifyState } from '../auth/hmac.ts';
import { verifyJwt } from '../auth/jwt.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { getProject, getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { isAdminSuspended } from '../suspension.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal ownership verification — called by the proxy via service binding.
 * Used on the JWT auth path to confirm the authenticated user owns the project.
 * Authenticated via HMAC token in X-Void-Internal header.
 *
 * POST /internal/verify-owner/:projectId
 * Body: { "userId": "...", "proxyOrigin": "https://proxy.example.com", ... }
 * The actual proxy origin is included in the HMAC and is also the audience used
 * to verify a human Cloudflare Access assertion.
 * Returns: 200 { ok: true } or 403 { error: "forbidden" }
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');

  const token = context.req.header('x-void-internal');
  if (!token) {
    return context.json({ error: 'missing internal auth' }, 401);
  }

  const body = await context.req.json<{
    userId: string;
    jwt?: string;
    accessAssertion?: string;
    proxyOrigin?: string;
  }>();
  const proxyOrigin = body.proxyOrigin;
  if (
    typeof proxyOrigin !== 'string' ||
    !proxyOrigin ||
    (() => {
      try {
        return new URL(proxyOrigin).origin !== proxyOrigin;
      } catch {
        return true;
      }
    })()
  ) {
    return context.json({ error: 'proxyOrigin required' }, 400);
  }

  const signed = `void-proxy-owner-v2\n${projectId}\n${proxyOrigin}`;
  if (!(await hmacVerifyState(signed, token, context.env.JWT_SECRET))) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }

  const { userId, jwt, accessAssertion } = body;
  if (typeof userId !== 'string' || !userId) {
    return context.json({ error: 'userId required' }, 400);
  }

  const payload = jwt
    ? await verifyJwt(jwt, context.env.JWT_SECRET, 'api')
    : { sub: userId, aud: 'api' };
  const settings = await readAuthSettings(context.get('db'));
  let companyIdentity;
  if (settings?.protection) {
    try {
      const identity = await platformAccessVerifier.verify(
        proxyOrigin,
        accessAssertion,
        settings.protection,
      );
      if (identity.kind !== 'human') {
        return context.json({ error: 'company user identity required' }, 403);
      }
      companyIdentity = identity;
    } catch {
      return context.json({ error: 'invalid company identity' }, 403);
    }
  }
  if (
    !payload ||
    payload.sub !== userId ||
    !(await validateHumanSession(context.get('db'), payload, companyIdentity))
  ) {
    return context.json({ error: 'session revoked' }, 403);
  }
  const user = await getUser(context.get('db'), userId);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return context.json({ error: 'forbidden' }, 403);
  }

  const project = await getProject(context.get('db'), projectId);
  if (!project || project.user_id !== userId) {
    return context.json({ error: 'forbidden' }, 403);
  }

  return context.json({ ok: true });
});

export default app;
