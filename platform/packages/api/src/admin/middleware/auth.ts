import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyJwt } from '../../auth/jwt.ts';
import { validateHumanSession } from '../../auth/sessions.ts';
import { getUser, getFirstAdmin } from '../../db.ts';
import { type ApiEnv, isDevBypass } from '../../env.ts';
import { isAdminSuspended } from '../../suspension.ts';

export const adminAuthMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  // CSRF defense: every admin write is state-changing and authenticated by a
  // cookie alone, so a same-origin check guards against cross-site form posts.
  // `Origin` is preferred (modern browsers always send it on a POST) and
  // `Referer` is the fallback for old clients. Neither present on a write is a
  // strong "not a real browser navigation" signal — reject. This runs before
  // the auth check so a cross-site request never reaches a handler at all.
  const method = context.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = context.req.header('origin');
    const referer = context.req.header('referer');
    const requestHost = new URL(context.req.url).host;
    const sourceHost = origin ? safeHost(origin) : referer ? safeHost(referer) : null;
    if (sourceHost === null || sourceHost !== requestHost) {
      return context.json({ error: 'cross-site request blocked' }, 403);
    }
  }

  if (isDevBypass(context.env)) {
    const admin = await getFirstAdmin(context.get('db'));
    if (admin) {
      const user = await getUser(context.get('db'), admin.id);
      if (user) {
        context.set('user', user);
        return next();
      }
    }
  }

  const token = getCookie(context, 'admin_token');
  if (!token) {
    return context.redirect('/admin/login');
  }

  const payload = await verifyJwt(token, context.env.JWT_SECRET, 'admin');
  if (
    !payload ||
    !(await validateHumanSession(context.get('db'), payload, context.get('companyIdentity')))
  ) {
    return context.redirect('/admin/login');
  }

  const user = await getUser(context.get('db'), payload.sub);
  if (!user || user.role !== 'admin' || isAdminSuspended(user.suspended_reason)) {
    return context.html('<h1>403 Forbidden</h1><p>Admin access required.</p>', 403);
  }

  context.set('user', user);
  if (payload.sid) {
    context.set('humanSession', { id: payload.sid, audience: 'admin' });
  }
  await next();
};

function safeHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
