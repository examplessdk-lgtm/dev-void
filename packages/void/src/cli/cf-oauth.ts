/**
 * The Cloudflare OAuth grant on wrangler's public PKCE client (design doc
 * 0078, "The OAuth grant on wrangler's client"; task contract 8) — the
 * primary credential grant for `void email domain add`. The customer clicks
 * Allow on Cloudflare's hosted consent page, the loopback server below
 * receives the code, exchanges it at the token endpoint, and returns the
 * grant's refresh token.
 *
 * The refresh token is held in memory only: the command POSTs it to the
 * platform as its first use and drops it. It is never written to disk, the
 * keychain, a log line, or an error message.
 *
 * The client id is wrangler's own public client (no secret), which
 * Cloudflare can rotate or revoke any day — so the template-link + paste
 * path in `email.ts` is the permanent fallback, not a legacy branch. The
 * consent page is Cloudflare's and names Wrangler; it cannot say Void, so
 * the warning line is printed here before the browser opens.
 */

import { randomBytes } from 'node:crypto';
import { log } from '@clack/prompts';
import { createCodeChallenge, createCodeVerifier, openBrowser } from './auth.ts';

/** wrangler's public PKCE OAuth client id (no secret). Not ours — see the header. */
export const CF_OAUTH_CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
export const CF_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CF_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
/**
 * The redirect registered on wrangler's client. Fixed port and path: the
 * consent flow redirects here and only here, so the loopback server binds
 * exactly :8976 and answers exactly /oauth/callback — unlike the platform
 * login's random-port /callback in auth.ts, which cannot serve this flow.
 */
export const CF_OAUTH_CALLBACK_PORT = 8976;
export const CF_OAUTH_CALLBACK_PATH = '/oauth/callback';
export const CF_OAUTH_REDIRECT_URI: string = `http://localhost:${CF_OAUTH_CALLBACK_PORT}${CF_OAUTH_CALLBACK_PATH}`;
/** The scopes the email-domain setup needs; `offline_access` is what yields the refresh token. */
export const CF_OAUTH_SCOPE =
  'zone:read email_routing:write email_sending:write workers_scripts:write offline_access';

export type CfOauthGrant = Readonly<{
  /** The grant's refresh token. Never logged, never persisted locally. */
  refreshToken: string;
}>;

/**
 * Revoke a grant at Cloudflare — RFC 7009 on wrangler's public client, the
 * same form wrangler's `logout` posts (a public client authenticates with
 * the token itself; no Authorization header). Never throws, never logs the
 * token; the boolean is whether Cloudflare CONFIRMED the revocation (200 —
 * CF answers 200 even for a bogus token), so `false` means the grant's
 * state is unknown and it may still be live: callers that print an outcome
 * must not claim a revocation they cannot prove. For when the CLI holds a
 * grant it will not hand to the platform: a consent exchange that
 * completed after the flow settled (fire-and-forget there — the flow is
 * settled), or an add request that provably never persisted one.
 */
export async function revokeCfOauthGrant(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(CF_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: CF_OAUTH_CLIENT_ID,
      }).toString(),
    });
    return res.ok;
  } catch {
    // The grant's state at Cloudflare is unknown either way.
    return false;
  }
}

/** The consent URL the browser opens — PKCE S256, state-bound to the loopback server. */
export function buildCfOauthAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
  const url = new URL(CF_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CF_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', CF_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CF_OAUTH_SCOPE);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

/**
 * Exchange the authorization code at Cloudflare's token endpoint. The
 * response body is never logged and never copied into an error — it carries
 * token material on success, so failure messages name only the HTTP status.
 */
async function exchangeCfOauthCode(code: string, codeVerifier: string): Promise<CfOauthGrant> {
  const res = await fetch(CF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CF_OAUTH_REDIRECT_URI,
      client_id: CF_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`cf-oauth: Cloudflare's token exchange failed (HTTP ${res.status}).`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("cf-oauth: Cloudflare's token exchange returned an invalid response.");
  }
  const refreshToken =
    body && typeof body === 'object' && 'refresh_token' in body ? body.refresh_token : undefined;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // `offline_access` is on the scope string, so a grant without a refresh
    // token is a Cloudflare-side surprise worth naming — the refresh token is
    // the one thing the platform stores.
    throw new Error("cf-oauth: Cloudflare's answer carried no refresh token.");
  }
  return { refreshToken };
}

/** Same minimal callback page the platform login renders (auth.ts keeps its own copy). */
function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Void</title>
<style>:root{color-scheme:light dark}*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#111}.card{text-align:center;padding:3rem}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#666;font-size:1rem}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}p{color:#a3a3a3}}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Run the grant: bind the loopback server on :8976, warn about the
 * Wrangler-named consent page, open the browser, and resolve with the
 * refresh token once the code has been exchanged INSIDE the request handler
 * (so the browser only sees the success page after the exchange succeeded).
 *
 * Rejects on a busy port, a denied consent, a failed exchange, an abort
 * (`signal` — the command aborts when Enter switches to the token path), or
 * the timeout; the caller falls back to the template-link path on any of
 * them. `onUrl` fires with the authorize URL once the server is listening,
 * so the command can show it as the manual fallback when the browser fails
 * to open. The server is always closed before settling.
 */
export async function runCfOauthGrant(options: {
  onUrl?: (url: string) => void;
  /** Default 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the real `node:child_process` `execFile`. */
  execFile?: typeof import('node:child_process').execFile;
}): Promise<CfOauthGrant> {
  const http = await import('node:http');
  const { onUrl, signal } = options;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const execFile = options.execFile ?? (await import('node:child_process')).execFile;

  if (signal?.aborted) {
    throw new Error('cf-oauth: cancelled.');
  }

  return new Promise<CfOauthGrant>((resolve, reject) => {
    let settled = false;

    const state = randomBytes(32).toString('hex');
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    const onAbort = (): void => fail(new Error('cf-oauth: cancelled.'));

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };

    const succeed = (grant: CfOauthGrant): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      signal?.removeEventListener('abort', onAbort);
      resolve(grant);
    };

    // server.close() stops new connections but leaves the in-flight callback
    // socket open — both settled branches below still answer the tab.
    const cancelled = (res: import('node:http').ServerResponse): void => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        page(
          'Authorization cancelled',
          'This sign-in was cancelled in the terminal. You can close this tab.',
        ),
      );
    };

    const server = http.createServer(async (req, res) => {
      // This is a one-shot browser callback, so never leave a keep-alive
      // connection behind after answering it. `server.close()` stops new
      // connections, but an HTTP client may otherwise reuse an existing
      // socket and send a later grant's callback to this server after its
      // listener has closed.
      res.setHeader('Connection', 'close');
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname !== CF_OAUTH_CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Authorization failed', 'Invalid callback. Please try again.'));
        return;
      }

      // The customer clicked deny, or Cloudflare refused the request itself.
      const cfError = url.searchParams.get('error');
      if (cfError) {
        const message =
          cfError === 'access_denied'
            ? 'The Cloudflare consent was denied.'
            : `Cloudflare returned an error (${cfError}).`;
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end(page('Authorization failed', message));
        fail(new Error(`cf-oauth: ${message}`));
        return;
      }

      // Reject-but-keep-listening: a stray request without a code (favicon
      // aside, everything off-path 404s above) must not settle the flow — the
      // genuine callback can still arrive.
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Authorization failed', 'No authorization code received. Please try again.'));
        return;
      }

      // Exchange INSIDE the request path so the browser only sees the success
      // page once the token exchange succeeded — the same rule the platform
      // login keeps. Guard against the timeout racing the in-flight exchange.
      let grant: CfOauthGrant;
      try {
        grant = await exchangeCfOauthCode(code, codeVerifier);
      } catch (err) {
        if (settled) {
          cancelled(res);
          return;
        }
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          page(
            'Authorization failed',
            'Could not complete the Cloudflare grant. Please try again.',
          ),
        );
        fail(
          err instanceof Error ? err : new Error("cf-oauth: Cloudflare's token exchange failed."),
        );
        return;
      }

      if (settled) {
        // The flow settled (Enter, abort, or the timeout) while the
        // exchange was in flight — but Cloudflare still minted the grant,
        // and the CLI is the only actor holding it. Revoke rather than
        // strand a live user-wide grant with no handle. Fire-and-forget:
        // the flow is settled, so this must never throw or stall anything.
        void revokeCfOauthGrant(grant.refreshToken);
        cancelled(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Cloudflare connected', 'You can close this tab and return to the terminal.'));
      succeed(grant);
    });

    // Close immediately after the callback — don't wait for keep-alive timeout.
    server.on('connection', (socket) => socket.unref());

    server.on('error', (err) => {
      // EADDRINUSE: another login (or wrangler's own) holds :8976. The caller
      // falls back to the template-link path on any failure here.
      const code = (err as NodeJS.ErrnoException).code;
      fail(
        new Error(
          `cf-oauth: could not start the local callback server on port ${CF_OAUTH_CALLBACK_PORT}${code ? ` (${code})` : ''}.`,
        ),
      );
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    server.listen(CF_OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      // The consent page is Cloudflare's hosted page for the wrangler client
      // and cannot say Void — say it here, before the browser opens (0078).
      log.warn(
        "Opening Cloudflare's consent page — it names Wrangler; that is expected (Void borrows wrangler's OAuth client for this one-click grant).",
      );
      const authorizeUrl = buildCfOauthAuthorizeUrl({ state, codeChallenge });
      onUrl?.(authorizeUrl);
      openBrowser(authorizeUrl, execFile);
    });

    const timeout = setTimeout(() => {
      fail(new Error('cf-oauth: the consent timed out.'));
    }, timeoutMs);
    timeout.unref();
  });
}
