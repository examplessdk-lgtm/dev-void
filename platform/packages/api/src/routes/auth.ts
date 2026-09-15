import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { handleAdminOAuthCallback, isAdminOAuthState } from '../admin/routes/login.ts';
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
import { getPlatformCapabilities } from '../capabilities.ts';
import { DEFAULT_DASHBOARD_URL } from '../constants.ts';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  createUserForPlatform,
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
  revokeOwnerVerifiedDestinationsForUserChange,
  GitHubIdentityAlreadyLinkedError,
  SelfHostedSignupRestrictedError,
  type Db,
} from '../db.ts';
import { sendWelcomeEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { isDevBypass } from '../env.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import {
  syncProjectAllowlistKv,
  syncProjectAllowlistKvBestEffort,
} from '../provisioning/email-allowlist.ts';
import { users } from '../schema.ts';
import { isSignupAllowed, getAllowlist } from '../signup-allowlist.ts';

const DEFAULT_REDIRECT_URI = 'https://api.void.cloud/auth/callback';
const DASHBOARD_AUTH_CODE_TTL_SECONDS = 5 * 60;
const CLI_AUTH_CODE_TTL_SECONDS = 5 * 60;

const app = new Hono<ApiEnv>();

export function isAllowedRedirect(
  url: string,
  dashboardUrl?: string,
  platformInstallationId?: string,
): boolean {
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
  const origin = dashboardUrl ?? (platformInstallationId ? null : DEFAULT_DASHBOARD_URL);
  if (!origin) {
    return false;
  }
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

  if (
    !isAllowedRedirect(redirect, context.env.DASHBOARD_URL, context.env.PLATFORM_INSTALLATION_ID)
  ) {
    return context.json({ error: 'redirect must be a localhost or dashboard URL' }, 400);
  }

  const provider = context.req.query('provider') ?? 'github';
  if (provider !== 'github' && provider !== 'google') {
    return context.json({ error: 'provider must be github or google' }, 400);
  }
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (provider === 'github' && !capabilities.githubOAuth) ||
    (provider === 'google' && !capabilities.googleOAuth)
  ) {
    return context.json({ error: 'authentication provider unavailable', provider }, 501);
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

/**
 * A mirror tighten inside `updateUserRevokingInheritedDestinations` failed.
 * Thrown from inside the transaction so drizzle rolls it back, then caught
 * by name outside it so the sign-in can go on; any other error from the same
 * transaction keeps propagating.
 */
class AllowlistTightenError extends Error {
  constructor(
    readonly projectId: string,
    cause: unknown,
  ) {
    super(`allowlist tighten failed for project=${projectId}`, { cause });
    this.name = 'AllowlistTightenError';
  }
}

/**
 * Write the provider's current login/email back to `users`, and when the
 * email actually changed, retire the owner-inherited destinations that the
 * OLD address was granted.
 *
 * This runs on EVERY login for the user's primary provider and writes back
 * whatever the provider currently reports, so `users.email` is a mutable
 * field, not a signup-time constant. Two places mint destination rows that
 * are verified purely on "this address IS the project owner's" — the
 * Option C owner branch in `routes/email.ts` and `autoAddOwnerDestination` in
 * `routes/projects.ts`. Once the owner's address changes, that claim is stale:
 * the old mailbox may have been handed to someone else, while the row stays
 * `verified` and stays in the project's `email-allowlist:<projectId>` mirror,
 * which is the ONLY per-project send boundary the proxy enforces. So demote
 * those rows and re-derive each affected project's mirror from the remaining
 * verified rows.
 *
 * The email write, the demotion and the mirror tighten commit TOGETHER, in
 * that order, with the tighten INSIDE the transaction. The only retry this
 * path has is the next login, and it retries only while the stored address
 * still differs from the provider's — so anything committed ahead of a
 * failed step is permanent. A demotion that fails after `users.email` is
 * committed is never retried (every later login compares equal); a mirror
 * write that fails after the demotion is committed is never retried either,
 * and nothing else re-derives the key on its own: the listing repairs a
 * differing mirror (`projectAllowlistKvDiffers`) only when the owner lists,
 * and until then the proxy keeps authorizing the old address from the stale
 * key. Tightening BEFORE the commit inverts that: a lost write rolls the
 * whole change back, `users.email` still reads the old address, and the next
 * login retries the (idempotent, old-snapshot-keyed) demotion and the
 * tighten. The mirror can then only ever be AHEAD of Postgres in the
 * tightening direction — a rolled-back login leaves the key without the old
 * address next to rows still `verified` — which the proxy reads as deny and
 * the listing re-widens to match the rows. `activate-domain.ts` and the
 * rollback route write routing KV under their project lock the same way; the
 * deploy go-live path writes routing only AFTER its commit because there a
 * write ahead of the row would widen. The tighten reads the verified rows
 * through the transaction so it sees the uncommitted demotion; a pool read
 * would write the old address straight back.
 *
 * Interleavings. `L` is this transaction. `I` is an owner-audited Option C
 * write (`tryCreateEmailDestination`, `promoteEmailDestinationWithOwnerAudit`):
 * it locks the owner's `users` row `FOR SHARE`, so it waits on the
 * `FOR NO KEY UPDATE` the email write takes. `G` is a listing repair or a
 * confirm click: no lock, best-effort re-derive.
 *
 *   I commits before L locks   L demotes I's row; L's tighten (transaction
 *                              view) excludes it. I's own post-commit widen
 *                              can still land after L's — the residual.
 *   I waits, L commits         I re-reads the rotated address, writes nothing.
 *   I waits, L rolls back      I re-reads the unchanged address and writes a
 *                              `verified` row keyed on it; the next login
 *                              demotes that one too.
 *   G derives between L's      G sees a tight key next to still-`verified`
 *   tighten and L's commit     rows and writes the old address back; the
 *                              best-effort re-derive after the commit undoes
 *                              it, as the DELETE route re-derives after its
 *                              row delete.
 *   two logins, same change    The second waits on the row lock, demotes
 *                              nothing, tightens to the same value.
 *
 * Residual, shared with the DELETE route: KV has no compare-and-swap, so a
 * writer that derived its mirror while the row was still `verified` can land
 * its put after BOTH of L's, and that grant lasts until the project's next
 * mirror write. Serializing the mirror writers is the project-level lock
 * class from design doc 0067, deliberately not taken here.
 *
 * A failure of the email write or the demotion surfaces as a failed sign-in,
 * exactly as a failure of the plain `updateUser` write always has. A failed
 * tighten (its row read or its KV write) does not: nothing is committed, the
 * sign-in proceeds on the stored address, and the retry is the next login —
 * failing an OAuth callback over a KV blip would buy nothing the rollback
 * has not already bought.
 */
async function updateUserRevokingInheritedDestinations(
  db: Db,
  kv: KVNamespace,
  userId: string,
  login: string,
  previousEmail: string | null,
  nextEmail: string | null,
): Promise<void> {
  // Only a real address-to-address change revokes. A first-ever email (no
  // previous) grants nothing to revoke, and a provider that stops reporting
  // one is a data gap, not a reassignment.
  if (!previousEmail || !nextEmail || previousEmail.toLowerCase() === nextEmail.toLowerCase()) {
    await updateUser(db, userId, login, nextEmail);
    return;
  }
  let projectIds: Array<string>;
  try {
    projectIds = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await updateUser(txDb, userId, login, nextEmail);
      const affected = await revokeOwnerVerifiedDestinationsForUserChange(
        txDb,
        userId,
        previousEmail,
      );
      for (const projectId of affected) {
        try {
          await syncProjectAllowlistKv(txDb, kv, projectId);
        } catch (err) {
          throw new AllowlistTightenError(projectId, err);
        }
      }
      return affected;
    });
  } catch (err) {
    if (!(err instanceof AllowlistTightenError)) {
      throw err;
    }
    console.error(
      `[auth] allowlist tighten failed for project=${err.projectId}; keeping the stored email for user=${userId} so the next login retries:`,
      err.cause,
    );
    return;
  }
  // Undo a re-widen by a listing or confirm click that derived its mirror
  // between the tighten and the commit (see the table above). Best-effort:
  // the tighten already committed the boundary, so there is nothing left for
  // a failure here to strand.
  for (const projectId of projectIds) {
    await syncProjectAllowlistKvBestEffort(db, kv, projectId);
  }
}

// GET /auth/callback?code=...&state=...
app.get('/callback', async (context) => {
  const code = context.req.query('code');
  const state = context.req.query('state');

  if (!code || !state) {
    return context.json({ error: 'missing code or state' }, 400);
  }

  if (isAdminOAuthState(state)) {
    return handleAdminOAuthCallback(context);
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
  if (
    !isAllowedRedirect(redirect, context.env.DASHBOARD_URL, context.env.PLATFORM_INSTALLATION_ID)
  ) {
    return context.json({ error: 'invalid redirect' }, 400);
  }

  const resolvedProvider = provider ?? 'github';
  const capabilities = getPlatformCapabilities(context.env);
  if (
    (resolvedProvider === 'github' && !capabilities.githubOAuth) ||
    (resolvedProvider === 'google' && !capabilities.googleOAuth)
  ) {
    return context.json(
      { error: 'authentication provider unavailable', provider: resolvedProvider },
      501,
    );
  }
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
  // Set when the email-match branch rejects a SECOND github identity for an account that already has one
  // (RFC 0074). The user is signed into the existing account, but `providerId` is NOT their github identity, so
  // the installation backfill below must be skipped.
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
        await updateUserRevokingInheritedDestinations(
          db,
          context.env.ROUTING,
          user.id,
          login,
          user.email,
          email,
        );
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
    const selfHosted = Boolean(context.env.PLATFORM_INSTALLATION_ID);
    let additionalSignupAllowed = !selfHosted || enabled === 'false';
    if (enabled === 'true' || (selfHosted && enabled !== 'false')) {
      const entries = await getAllowlist(context.env.ROUTING);
      additionalSignupAllowed = isSignupAllowed(
        resolvedProvider,
        login,
        emailVerified ? email : null,
        entries,
      );
      if (!selfHosted && !additionalSignupAllowed) {
        return context.redirect('/signup-restricted');
      }
    }
    try {
      user = await db.transaction(async (tx) => {
        const txDb = tx as unknown as typeof db;
        const newUser = await createUserForPlatform(
          txDb,
          resolvedProvider,
          providerId,
          login,
          emailVerified ? email : null,
          context.env.PLATFORM_INSTALLATION_ID,
          {
            additionalSignupAllowed,
            bootstrapGitHubId: context.env.PLATFORM_BOOTSTRAP_GITHUB_ID ?? '',
          },
        );
        await createOAuthAccount(txDb, newUser.id, resolvedProvider, providerId);
        return newUser;
      });
    } catch (error) {
      if (error instanceof SelfHostedSignupRestrictedError) {
        return context.redirect('/signup-restricted');
      }
      throw error;
    }
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
          sendWelcomeEmail(context.env, email, login).catch((err) =>
            console.error(`[welcome-email] Failed for ${email}:`, err),
          ),
        );
      }
    }
  }

  if (resolvedProvider === 'github' && !githubIdentityRejected) {
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
