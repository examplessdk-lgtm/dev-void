import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import {
  ensureGitHubPreviewRepoAccess,
  getGitHubPreviewRepoConfig,
  hasGitHubPreviewRepoAccess,
} from '../auth/github-preview.ts';
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from '../auth/github.ts';
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from '../auth/google.ts';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import { signJwt } from '../auth/jwt.ts';
import {
  CLI_CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  isValidCodeVerifier,
} from '../auth/pkce.ts';
import { DEFAULT_DASHBOARD_URL } from '../constants.ts';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  createUser,
  updateUser,
  createOAuthAccount,
  acceptInvitationByEmail,
  storeOAuthNonce,
  consumeOAuthNonce,
  storeAuthCode,
  consumeAuthCode,
  consumeCliAuthCode,
  linkGitHubInstallationToUser,
  linkGitHubIdentity,
  GitHubIdentityAlreadyLinkedError,
} from '../db.ts';
import { sendWelcomeEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { isDevBypass } from '../env.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import { users } from '../schema.ts';
import { isSignupAllowed, getAllowlist } from '../signup-allowlist.ts';

const DEFAULT_REDIRECT_URI = 'https://api.void.cloud/auth/callback';
const DASHBOARD_AUTH_CODE_TTL_SECONDS = 5 * 60;
const CLI_AUTH_CODE_TTL_SECONDS = 5 * 60;

const app = new Hono<ApiEnv>();

export function isAllowedRedirect(url: string, dashboardUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Localhost: allow any port, require exact hostname and http protocol
  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }

  // Dashboard: compare exact origin (protocol + hostname + port)
  const origin = dashboardUrl ?? 'https://dash.void.cloud';
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function isLocalhostRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

// GET /auth/login?redirect=http://localhost:PORT/callback&provider=github|google
app.get('/login', async (context) => {
  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }

  if (!isAllowedRedirect(redirect, context.env.DASHBOARD_URL)) {
    return context.json({ error: 'redirect must be a localhost or dashboard URL' }, 400);
  }

  const provider = context.req.query('provider') ?? 'github';
  if (provider !== 'github' && provider !== 'google') {
    return context.json({ error: 'provider must be github or google' }, 400);
  }

  const codeChallenge = context.req.query('code_challenge');
  const codeChallengeMethod = context.req.query('code_challenge_method');
  let cliState: string | null = null;

  if (codeChallenge || codeChallengeMethod) {
    const redirectUrl = new URL(redirect);
    cliState = redirectUrl.searchParams.get('state');

    if (!isLocalhostRedirect(redirectUrl)) {
      return context.json({ error: 'CLI code exchange requires a localhost redirect' }, 400);
    }
    if (!cliState) {
      return context.json({ error: 'CLI code exchange requires callback state' }, 400);
    }
    if (!codeChallenge || codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD) {
      return context.json({ error: 'code_challenge_method must be S256' }, 400);
    }
  }

  const nonce = crypto.randomUUID();

  // Store nonce in PostgreSQL so callback can validate it (prevents login CSRF / replay).
  // Not KV: login and callback can hit different CF colos, and KV's eventual consistency
  // would make the lookup flaky. PG also gives us atomic DELETE for true single-use.
  const db = context.get('db');
  await storeOAuthNonce(db, nonce, 600);

  const stateData = JSON.stringify({
    redirect,
    nonce,
    provider,
    cliState,
    codeChallenge,
    codeChallengeMethod,
  });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;

  const redirectUri = context.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(context, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: 600,
  });

  if (provider === 'google') {
    const url = getGoogleAuthorizeUrl(context.env.GOOGLE_CLIENT_ID, redirectUri, state);
    return context.redirect(url);
  }

  const url = getGitHubAuthorizeUrl(context.env.GITHUB_CLIENT_ID, redirectUri, state);
  return context.redirect(url);
});

// GET /auth/dev-login?redirect=http://localhost:PORT/auth/callback — localhost-only, DEV_AUTH_BYPASS only
app.get('/dev-login', async (context) => {
  if (!isDevBypass(context.env)) {
    return context.json({ error: 'not found' }, 404);
  }

  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }

  const user = await context
    .get('db')
    .select()
    .from(users)
    .limit(1)
    .then((rows) => rows[0]);
  if (!user) {
    return context.json({ error: 'no seeded user — run pnpm -C packages/api setup' }, 404);
  }

  const jwt = await signJwt(
    { sub: user.id, login: user.login, aud: 'api' },
    context.env.JWT_SECRET,
  );

  const url = redirectUrl;
  url.searchParams.set('token', jwt);
  // 200 + JS redirect, not 302 — the target is always localhost and `wrangler dev`
  // mangles `Location: http://localhost:*` headers (see html-redirect.ts / meta/lessons.md).
  return localhostRedirectResponse(url.toString(), 'Dev login');
});

// GET /auth/callback?code=...&state=...
app.get('/callback', async (context) => {
  const code = context.req.query('code');
  const state = context.req.query('state');

  if (!code || !state) {
    return context.json({ error: 'missing code or state' }, 400);
  }

  // Verify state HMAC
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return context.json({ error: 'invalid state' }, 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
  if (!valid) {
    return context.json({ error: 'invalid state signature' }, 400);
  }

  const { redirect, nonce, provider, cliState, codeChallenge, codeChallengeMethod } = JSON.parse(
    atob(stateEncoded),
  ) as {
    redirect: string;
    nonce: string;
    provider?: string;
    cliState?: string | null;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  };

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(context, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return context.json({ error: 'OAuth session mismatch' }, 400);
  }

  // Validate and consume nonce atomically (single-use, 10-minute TTL).
  // Uses PostgreSQL — not KV — for strong consistency across colos.
  const db = context.get('db');
  const nonceValid = await consumeOAuthNonce(db, nonce);
  if (!nonceValid) {
    return context.json({ error: 'invalid or expired OAuth state' }, 400);
  }

  // Clear the cookie only after successful validation so stale callbacks
  // from duplicate tabs don't invalidate a legitimate in-progress login.
  deleteCookie(context, 'oauth_nonce', { path: '/auth/callback' });

  // Re-validate redirect after decoding
  if (!isAllowedRedirect(redirect, context.env.DASHBOARD_URL)) {
    return context.json({ error: 'invalid redirect' }, 400);
  }

  const resolvedProvider = provider ?? 'github';
  let providerId: string;
  let login: string;
  let email: string | null;
  let emailVerified: boolean;

  if (resolvedProvider === 'google') {
    const redirectUri = context.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
    const googleToken = await exchangeGoogleCode(
      context.env.GOOGLE_CLIENT_ID,
      context.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(googleToken);
    providerId = googleUser.id;
    login = googleUser.email;
    email = googleUser.email;
    emailVerified = googleUser.emailVerified;
  } else {
    const ghToken = await exchangeCodeForToken(
      context.env.GITHUB_CLIENT_ID,
      context.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const ghUser = await getGitHubUser(ghToken);
    providerId = String(ghUser.id);
    login = ghUser.login;
    email = ghUser.email;
    emailVerified = ghUser.emailVerified;
  }
  const previewRepo =
    resolvedProvider === 'github' ? getGitHubPreviewRepoConfig(context.env) : null;

  // Set when the email-match branch rejects a SECOND github identity for an account that already has one
  // (RFC 0074). The user is signed into the existing account, but `providerId` is NOT their github identity, so
  // the github-identity-derived side effects below (installation backfill, preview-repo access) must be skipped.
  let githubIdentityRejected = false;

  // Upsert user — check oauth_accounts first, then email, then create
  let user = await getUserByOAuthAccount(db, resolvedProvider, providerId);
  if (user) {
    // Only update login/email when the provider matches the user's primary provider
    // (avoids overwriting GitHub username with Google email)
    if (user.provider === resolvedProvider) {
      // Only overwrite stored email when the new one is verified;
      // a transient /user/emails failure must not wipe the existing email.
      if (emailVerified) {
        await updateUser(db, user.id, login, email);
      } else {
        await updateUser(db, user.id, login, user.email);
      }
    }
  } else if (email && emailVerified) {
    // Link new provider to existing account with the same email.
    const existing = await getUserByEmail(db, email);
    if (existing) {
      if (resolvedProvider === 'github') {
        // Enforce RFC 0074's one-github-identity-per-account invariant on the login
        // path too (Vercel model: a Void account has a single GitHub login identity;
        // extra repo access is via installations, not a second identity). `providerId`
        // is guaranteed NOT yet an oauth row (the getUserByOAuthAccount branch above
        // handled that), so linkGitHubIdentity either links it (existing had no github)
        // or throws GitHubIdentityAlreadyLinkedError (existing already linked a
        // DIFFERENT github) — in which case sign the user into the existing account
        // WITHOUT creating a duplicate github row.
        try {
          await linkGitHubIdentity(db, existing.id, providerId);
        } catch (err) {
          if (!(err instanceof GitHubIdentityAlreadyLinkedError)) {
            throw err;
          }
          githubIdentityRejected = true;
        }
      } else {
        await createOAuthAccount(db, existing.id, resolvedProvider, providerId);
      }
      user = existing;
    }
  }

  let createdUser = false;
  if (!user) {
    // Check signup allowlist (new users only)
    const enabled = await context.env.ROUTING.get('signup:enabled');
    if (enabled === 'true') {
      let allowedByRepoAccess = false;
      if (resolvedProvider === 'github' && previewRepo) {
        try {
          allowedByRepoAccess = await hasGitHubPreviewRepoAccess(previewRepo, login);
        } catch (err) {
          console.error(`[github-preview] Failed to check repo access for ${login}:`, err);
        }
      }

      const entries = allowedByRepoAccess ? [] : await getAllowlist(context.env.ROUTING);
      if (
        !allowedByRepoAccess &&
        !isSignupAllowed(resolvedProvider, login, emailVerified ? email : null, entries)
      ) {
        return context.redirect('/signup-restricted');
      }
    }
    user = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const newUser = await createUser(
        txDb,
        resolvedProvider,
        providerId,
        login,
        emailVerified ? email : null,
      );
      await createOAuthAccount(txDb, newUser.id, resolvedProvider, providerId);
      return newUser;
    });
    createdUser = true;
  }

  if (emailVerified && email) {
    try {
      await acceptInvitationByEmail(db, email, user.id);
    } catch (err) {
      console.error(`Failed to accept invitation for ${email} (user ${user.id}):`, err);
    }
    if (createdUser) {
      if (context.env.EMAIL) {
        context.executionCtx.waitUntil(
          sendWelcomeEmail(context.env.EMAIL, email, login).catch((err) =>
            console.error(`[welcome-email] Failed for ${email}:`, err),
          ),
        );
      }
    }
  }

  if (resolvedProvider === 'github' && !githubIdentityRejected) {
    if (previewRepo) {
      context.executionCtx.waitUntil(
        ensureGitHubPreviewRepoAccess(previewRepo, login).catch((err) =>
          console.error(`[github-preview] Failed to grant void-sdk/void access to ${login}:`, err),
        ),
      );
    }

    // Backfill GitHub App installations created before this user signed in.
    // `providerId` is the user's numeric GitHub account id, matched against
    // `github_installations.account_id`. Best-effort — a failure here must
    // never block login.
    try {
      await linkGitHubInstallationToUser(db, providerId, user.id);
    } catch (err) {
      console.error(`[github-app] Failed to backfill installations for ${login}:`, err);
    }
  }

  // Sign JWT
  const jwt = await signJwt({ sub: user.id, login, aud: 'api' }, context.env.JWT_SECRET);

  const redirectUrl = new URL(redirect);

  if (isLocalhostRedirect(redirectUrl)) {
    if (codeChallenge && codeChallengeMethod === CLI_CODE_CHALLENGE_METHOD && cliState) {
      const authCode = crypto.randomUUID();
      await storeAuthCode(db, authCode, jwt, CLI_AUTH_CODE_TTL_SECONDS, {
        cliState,
        codeChallenge,
        codeChallengeMethod,
      });
      redirectUrl.searchParams.set('code', authCode);
      redirectUrl.searchParams.delete('token');
    } else {
      // Legacy CLI / local dev: token in query param (localhost-only, safe).
      redirectUrl.searchParams.set('token', jwt);
    }
  } else {
    // Dashboard: short-lived auth code exchanged server-side, so the JWT never appears in the URL.
    // Stored in PostgreSQL (not KV) for strong cross-colo consistency and atomic single-use
    // via DELETE … RETURNING — same rationale as the OAuth nonce flow.
    const authCode = crypto.randomUUID();
    await storeAuthCode(db, authCode, jwt, DASHBOARD_AUTH_CODE_TTL_SECONDS);
    redirectUrl.searchParams.set('code', authCode);
  }

  return context.redirect(redirectUrl.toString());
});

// POST /auth/exchange — single-use code → JWT (called by dashboard callback)
app.post('/exchange', async (context) => {
  const { code } = await context.req.json<{ code: string }>();
  if (!code) {
    return context.json({ error: 'missing code' }, 400);
  }

  const db = context.get('db');
  const jwt = await consumeAuthCode(db, code);
  if (!jwt) {
    return context.json({ error: 'invalid or expired code' }, 400);
  }

  return context.json({ token: jwt });
});

// POST /auth/cli/token — single-use CLI code + PKCE verifier → JWT
app.post('/cli/token', async (context) => {
  const body = await context.req.json<{
    code?: unknown;
    state?: unknown;
    code_verifier?: unknown;
  }>();

  if (
    typeof body.code !== 'string' ||
    typeof body.state !== 'string' ||
    !isValidCodeVerifier(body.code_verifier)
  ) {
    return context.json({ error: 'code, state, and code_verifier are required' }, 400);
  }

  const codeChallenge = await createCodeChallenge(body.code_verifier);
  const db = context.get('db');
  const jwt = await consumeCliAuthCode(
    db,
    body.code,
    body.state,
    codeChallenge,
    CLI_CODE_CHALLENGE_METHOD,
  );

  if (!jwt) {
    return context.json({ error: 'invalid or expired code' }, 400);
  }

  return context.json({ token: jwt });
});

export default app;
