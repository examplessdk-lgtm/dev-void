import { deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';

export const loader = defineHandler((context) => {
  deleteCookie(context, 'void_token', { path: '/' });
  return context.redirect('/login');
});
