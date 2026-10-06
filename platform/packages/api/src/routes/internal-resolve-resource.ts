import { Hono } from 'hono';
import { getResourceByBinding } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal resource resolution endpoint — called by the proxy via service binding.
 * Authenticated by the proxy's own credential (see requireProxyInternalAuth), no JWT/userId.
 *
 * POST /internal/resolve-resource/:projectId
 * Body: { "type": "d1" | "kv" | "r2" | "queue", "binding": "DB" }
 * Returns: { "cf_id": "..." } or 404
 */
app.post('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');

  const denied = await requireProxyInternalAuth(context, 'resolve-resource', projectId);
  if (denied) {
    return denied;
  }

  const { type, binding } = await context.req.json<{
    type: 'd1' | 'kv' | 'r2' | 'queue';
    binding: string;
  }>();
  if (!type || !binding) {
    return context.json({ error: 'type and binding required' }, 400);
  }

  const resource = await getResourceByBinding(context.get('db'), projectId, type, binding);
  if (!resource) {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  return context.json({ cf_id: resource.cf_id });
});

export default app;
