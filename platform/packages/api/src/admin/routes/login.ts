import { Hono, type Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from '../../auth/github.ts';
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from '../../auth/google.ts';
import { hmacSignState, hmacVerifyState } from '../../auth/hmac.ts';
import { signJwt } from '../../auth/jwt.ts';
import { getPlatformCapabilities } from '../../capabilities.ts';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  updateUserProviderId,
  createOAuthAccount,
  storeOAuthNonce,
  consumeOAuthNonce,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { isAdminSuspended } from '../../suspension.ts';

const app = new Hono<ApiEnv>();
type AdminProvider = 'github' | 'google';

export function isAdminOAuthState(state: string): boolean {
  try {
    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1) {
      return false;
    }
    const stateData = JSON.parse(atob(state.slice(0, dotIndex))) as { audience?: unknown };
    return stateData.audience === 'admin';
  } catch {
    return false;
  }
}

// GET /login
app.get('/login', (context) => {
  const capabilities = getPlatformCapabilities(context.env);
  const providers = [
    capabilities.githubOAuth ? '<p><a href="/admin/login/github">Sign in with GitHub</a></p>' : '',
    capabilities.googleOAuth ? '<p><a href="/admin/login/google">Sign in with Google</a></p>' : '',
  ].join('');
  return context.html(`<!DOCTYPE html>
<html>
<head><title>Admin Login - Void</title></head>
<body style="font-family: monospace; line-height: 1.5">
<div style="max-width: 800px; margin: 0 auto; padding: 20px">
<h1>Void Admin</h1>
<p>Sign in with your admin account</p>
${providers}
</div>
</body>
</html>`);
});

// GET /login/:provider
app.get('/login/:provider', async (context) => {
  const provider = context.req.param('provider');
  if (provider !== 'github' && provider !== 'google') {
    return context.html('<h1>Login failed</h1><p>Unknown authentication provider.</p>', 404);
  }
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (provider === 'github' && !capabilities.githubOAuth) ||
    (provider === 'google' && !capabilities.googleOAuth)
  ) {
    return context.html('<h1>Login failed</h1><p>Authentication provider unavailable.</p>', 501);
  }
  const redirectUri =
    context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).toString();
  const nonce = crypto.randomUUID();
  await storeOAuthNonce(context.get('db'), nonce, 600);
  const stateData = JSON.stringify({ audience: 'admin', nonce, provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;
  const url =
    provider === 'github'
      ? getGitHubAuthorizeUrl(context.env.GITHUB_CLIENT_ID, redirectUri, state)
      : getGoogleAuthorizeUrl(context.env.GOOGLE_CLIENT_ID, redirectUri, state);
  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(context, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: 600,
  });
  return context.redirect(url);
});

export async function handleAdminOAuthCallback(context: Context<ApiEnv>): Promise<Response> {
  const code = context.req.query('code');
  const state = context.req.query('state');

  if (!code || !state) {
    return context.html('<h1>Login failed</h1><p>Missing code or state.</p>', 400);
  }

  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return context.html('<h1>Login failed</h1><p>Invalid state.</p>', 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
  if (!valid) {
    return context.html('<h1>Login failed</h1><p>Invalid state signature.</p>', 400);
  }

  // Consume the nonce atomically — prevents replay of the callback URL
  let nonce: string;
  let provider: AdminProvider;
  try {
    const stateData = JSON.parse(atob(stateEncoded)) as {
      audience?: string;
      nonce: string;
      provider?: AdminProvider;
    };
    if (stateData.audience !== 'admin') {
      throw new Error('unknown audience');
    }
    nonce = stateData.nonce;
    // Preserve Google callbacks initiated before a deployment of this version.
    provider = stateData.provider ?? 'google';
    if (provider !== 'github' && provider !== 'google') {
      throw new Error('unknown provider');
    }
  } catch {
    return context.html('<h1>Login failed</h1><p>Invalid state data.</p>', 400);
  }

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(context, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return context.html('<h1>Login failed</h1><p>OAuth session mismatch.</p>', 400);
  }

  const nonceValid = await consumeOAuthNonce(context.get('db'), nonce);
  if (!nonceValid) {
    return context.html('<h1>Login failed</h1><p>Invalid or expired login state.</p>', 400);
  }

  deleteCookie(context, 'oauth_nonce', { path: '/auth/callback' });

  const redirectUri =
    context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).toString();
  let providerId: string;
  let login: string;
  let email: string | null;
  let emailVerified: boolean;
  if (provider === 'github') {
    const token = await exchangeCodeForToken(
      context.env.GITHUB_CLIENT_ID,
      context.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const githubUser = await getGitHubUser(token);
    providerId = String(githubUser.id);
    login = githubUser.login;
    email = githubUser.email;
    emailVerified = githubUser.emailVerified;
  } else {
    const token = await exchangeGoogleCode(
      context.env.GOOGLE_CLIENT_ID,
      context.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(token);
    providerId = googleUser.id;
    login = googleUser.email;
    email = googleUser.email;
    emailVerified = googleUser.emailVerified;
  }

  const db = context.get('db');
  let user = await getUserByOAuthAccount(db, provider, providerId);

  // Fall back to email lookup — handles first login after seeding by email
  if (!user && email && emailVerified) {
    const byEmail = await getUserByEmail(db, email);
    if (byEmail && byEmail.provider === provider) {
      // Backfill the real provider_id so future logins match directly
      await updateUserProviderId(db, byEmail.id, providerId);
      await createOAuthAccount(db, byEmail.id, provider, providerId);
      user = byEmail;
    }
  }

  if (!user || user.role !== 'admin' || isAdminSuspended(user.suspended_reason)) {
    return context.html(
      '<h1>403 Forbidden</h1><p>Admin access required. You must have an admin account to sign in.</p>',
      403,
    );
  }

  const jwt = await signJwt({ sub: user.id, login, aud: 'admin' }, context.env.JWT_SECRET);

  setCookie(context, 'admin_token', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  return context.redirect('/admin/');
}

// GET /logout
app.get('/logout', (context) => {
  deleteCookie(context, 'admin_token', { path: '/' });
  return context.redirect('/admin/login');
});

export default app;
