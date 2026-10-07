import { defineMiddleware } from 'void';

// No dashboard page is meant to be framed. Only HTML is touched, so redirects,
// WebSocket upgrades and other responses pass through unchanged.
export default defineMiddleware(async (context, next) => {
  await next();
  if (context.res.headers.get('Content-Type')?.startsWith('text/html')) {
    context.header('X-Frame-Options', 'DENY');
    context.header('Content-Security-Policy', "frame-ancestors 'none'");
  }
});
