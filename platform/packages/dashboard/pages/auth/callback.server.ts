import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';
import { fetchApi, getApiErrorMessage, readApiJson } from '../../lib/api.ts';

function loginUrl(context: Context): string {
  return `${requestOrigin(context)}/login`;
}

function requestOrigin(context: Context): string {
  const host = context.req.header('host');
  if (!host) {
    return new URL(context.req.url).origin;
  }
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return `${isLocal ? 'http' : 'https'}://${host}`;
}

export const loader = defineHandler(async (context) => {
  const homeUrl = `${requestOrigin(context)}/`;

  // Production/staging: exchange short-lived auth code for JWT via API
  const code = context.req.query('code');
  if (code) {
    // Verify login nonce — prevents login CSRF / session fixation.
    // The nonce is set as a cookie on /login and included in the redirect URL.
    // The API passes it through, so we get it back as ?login_nonce=<value>.
    // Both the cookie and URL param must match — an attacker crafting
    // /auth/callback?code=xxx can't match the victim's cookie.
    const nonceCookie = getCookie(context, 'void_auth_nonce');
    const nonceParam = context.req.query('login_nonce');
    if (!nonceCookie || !nonceParam || nonceCookie !== nonceParam) {
      console.warn('[dashboard] auth callback nonce mismatch');
      return context.redirect(loginUrl(context));
    }
    const resp = await fetchApi(context, '/auth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) {
      console.warn(
        `[dashboard] /auth/exchange returned ${resp.status}: ${await getApiErrorMessage(resp)}`,
      );
      return context.redirect(loginUrl(context));
    }
    const exchange = await readApiJson<{ token: string }>(resp);
    if (!exchange?.token) {
      console.warn('[dashboard] /auth/exchange returned no token');
      return context.redirect(loginUrl(context));
    }
    deleteCookie(context, 'void_auth_nonce', { path: '/' });
    deleteCookie(context, 'void_auth_nonce', { path: '/auth' });
    const host = context.req.header('host') ?? '';
    setCookie(context, 'void_token', exchange.token, {
      httpOnly: true,
      secure: !(host.startsWith('localhost') || host.startsWith('127.0.0.1')),
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return context.redirect(homeUrl);
  }

  // Local dev: token arrives as query param (localhost-only, not available in production)
  // Use Host header, not context.req.url — Workers Assets internal dispatch can set
  // context.req.url to localhost even in production.
  const token = context.req.query('token');
  if (token) {
    const host = context.req.header('host') ?? '';
    if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
      return context.redirect(loginUrl(context));
    }
    // Verify login nonce — same protection as the OAuth code path above.
    const nonceCookie = getCookie(context, 'void_auth_nonce');
    const nonceParam = context.req.query('login_nonce');
    if (!nonceCookie || !nonceParam || nonceCookie !== nonceParam) {
      console.warn('[dashboard] auth callback nonce mismatch');
      return context.redirect(loginUrl(context));
    }
    deleteCookie(context, 'void_auth_nonce', { path: '/' });
    deleteCookie(context, 'void_auth_nonce', { path: '/auth' });
    setCookie(context, 'void_token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return context.redirect(homeUrl);
  }

  return context.redirect(loginUrl(context));
});
