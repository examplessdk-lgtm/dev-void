import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../../env.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const adminCsrfMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (SAFE_METHODS.has(context.req.method)) {
    await next();
    return;
  }

  const expectedOrigin = new URL(context.req.url).origin;
  const origin = context.req.header('Origin');
  if (origin) {
    if (parseOrigin(origin) !== expectedOrigin) {
      return context.text('Forbidden: invalid request origin.', 403);
    }
    await next();
    return;
  }

  const referer = context.req.header('Referer');
  if (!referer || parseOrigin(referer) !== expectedOrigin) {
    return context.text('Forbidden: missing request origin.', 403);
  }
  await next();
};

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
