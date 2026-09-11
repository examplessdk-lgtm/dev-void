import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyJwt } from '../../auth/jwt.ts';
import { getUser, getFirstAdmin } from '../../db.ts';
import { type ApiEnv, isDevBypass } from '../../env.ts';

export const adminAuthMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
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
  if (!payload) {
    return context.redirect('/admin/login');
  }

  const user = await getUser(context.get('db'), payload.sub);
  if (!user || user.role !== 'admin') {
    return context.html('<h1>403 Forbidden</h1><p>Admin access required.</p>', 403);
  }

  context.set('user', user);
  await next();
};
