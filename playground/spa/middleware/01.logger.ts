import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  console.log(`[${c.req.method}] ${c.req.path}`);
  await next();
});
