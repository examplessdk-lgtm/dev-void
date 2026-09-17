import { createHash } from 'node:crypto';
import { log } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CF_OAUTH_CALLBACK_PATH,
  CF_OAUTH_CALLBACK_PORT,
  CF_OAUTH_CLIENT_ID,
  CF_OAUTH_REDIRECT_URI,
  CF_OAUTH_SCOPE,
  CF_OAUTH_TOKEN_URL,
  runCfOauthGrant,
} from '../../src/cli/cf-oauth.ts';

/**
 * The PKCE grant on wrangler's public client (contract 8) against a mocked
 * loopback/token endpoint — no real network: the loopback server on :8976 is
 * real (the platform login tests do the same on a random port), and
 * Cloudflare's token endpoint is a fetch stub. Token values are inert
 * placeholders and are never printed.
 */

const mockExecFile = vi.fn();
const originalFetch = globalThis.fetch.bind(globalThis);

const AUTH_CODE = 'cf-auth-code-placeholder';
const REFRESH_SENTINEL = 'cf-refresh-token-placeholder';

let tokenExchangeBodies: Array<URLSearchParams>;
let tokenEndpointResponse: () => Response;

function codeChallengeFor(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

beforeEach(() => {
  mockExecFile.mockReset();
  tokenExchangeBodies = [];
  tokenEndpointResponse = () =>
    Response.json({
      access_token: 'cf-access-token-placeholder',
      refresh_token: REFRESH_SENTINEL,
      expires_in: 3600,
    });
  vi.spyOn(log, 'warn').mockImplementation(() => {});

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input.toString();
    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
      return originalFetch(input, init);
    }
    if (url === CF_OAUTH_TOKEN_URL) {
      tokenExchangeBodies.push(new URLSearchParams(init?.body?.toString() ?? ''));
      return tokenEndpointResponse();
    }
    throw new Error(`unexpected network call in test: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function startGrant(): Promise<{ url: URL; grant: Promise<unknown> }> {
  let ready!: (url: URL) => void;
  const urlPromise = new Promise<URL>((resolve) => {
    ready = resolve;
  });
  const grant = runCfOauthGrant({
    timeoutMs: 5000,
    onUrl: (url) => ready(new URL(url)),
  });
  return { url: await urlPromise, grant };
}

function callbackUrl(): URL {
  return new URL(CF_OAUTH_REDIRECT_URI);
}

describe('runCfOauthGrant', () => {
  it('runs the full PKCE flow and resolves the grant refresh token', async () => {
    const { url, grant } = await startGrant();

    // The authorize URL is Cloudflare's consent endpoint with the pinned
    // contract-8 parameters — wrangler's client, the fixed loopback
    // redirect, the email scope set, and an S256 challenge.
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CF_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CF_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(CF_OAUTH_SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toEqual(expect.any(String));
    const state = url.searchParams.get('state');
    expect(state).toEqual(expect.any(String));

    // The Wrangler-named consent page warning is printed before opening.
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('names Wrangler'));

    const callback = callbackUrl();
    callback.searchParams.set('state', state!);
    callback.searchParams.set('code', AUTH_CODE);
    const pageResponse = await fetch(callback);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain('Cloudflare connected');

    await expect(grant).resolves.toEqual({ refreshToken: REFRESH_SENTINEL });

    // The exchange is form-encoded against the token endpoint with the code,
    // the pinned redirect and client, and the verifier behind the challenge.
    expect(tokenExchangeBodies).toHaveLength(1);
    const body = tokenExchangeBodies[0]!;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe(AUTH_CODE);
    expect(body.get('redirect_uri')).toBe(CF_OAUTH_REDIRECT_URI);
    expect(body.get('client_id')).toBe(CF_OAUTH_CLIENT_ID);
    const verifier = body.get('code_verifier');
    expect(verifier).toEqual(expect.any(String));
    expect(codeChallengeFor(verifier!)).toBe(url.searchParams.get('code_challenge'));

    // The browser was asked to open the consent URL, via argv (never a shell).
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('rejects a mismatched state but keeps listening for the real callback', async () => {
    const { url, grant } = await startGrant();
    const state = url.searchParams.get('state')!;

    const attack = callbackUrl();
    attack.searchParams.set('state', 'attacker-state');
    attack.searchParams.set('code', AUTH_CODE);
    expect((await fetch(attack)).status).toBe(400);
    expect(tokenExchangeBodies).toHaveLength(0);

    const valid = callbackUrl();
    valid.searchParams.set('state', state);
    valid.searchParams.set('code', AUTH_CODE);
    expect((await fetch(valid)).status).toBe(200);
    await expect(grant).resolves.toEqual({ refreshToken: REFRESH_SENTINEL });
  });

  it('rejects when the customer denies the consent', async () => {
    const { url, grant } = await startGrant();
    const rejection = expect(grant).rejects.toThrow(/consent was denied/);

    const denied = callbackUrl();
    denied.searchParams.set('state', url.searchParams.get('state')!);
    denied.searchParams.set('error', 'access_denied');
    const pageResponse = await fetch(denied);
    expect(pageResponse.status).toBe(403);
    expect(await pageResponse.text()).toContain('consent was denied');

    await rejection;
    expect(tokenExchangeBodies).toHaveLength(0);
  });

  it('rejects when the token exchange fails, without echoing the response body', async () => {
    const canary = 'body-canary-never-in-errors';
    tokenEndpointResponse = () => new Response(canary, { status: 400 });
    const { url, grant } = await startGrant();
    const rejection = expect(grant).rejects.toThrow(/HTTP 400/);

    const callback = callbackUrl();
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', AUTH_CODE);
    const pageResponse = await fetch(callback);
    // The exchange runs inside the request handler, so a failure renders the
    // failure page, never the success page.
    expect(pageResponse.status).toBe(400);
    expect(await pageResponse.text()).toContain('Could not complete');

    const error = await grant.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(canary);
    await rejection;
  });

  it('rejects when the answer carries no refresh token', async () => {
    tokenEndpointResponse = () => Response.json({ access_token: 'cf-access-token-placeholder' });
    const { url, grant } = await startGrant();
    const rejection = expect(grant).rejects.toThrow(/no refresh token/);

    const callback = callbackUrl();
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', AUTH_CODE);
    await fetch(callback);
    await rejection;
  });

  it('rejects when the callback port is already in use', async () => {
    const http = await import('node:http');
    const blocker = http.createServer((_req, res) => res.end('busy'));
    await new Promise<void>((resolve) =>
      blocker.listen(CF_OAUTH_CALLBACK_PORT, '127.0.0.1', resolve),
    );
    try {
      await expect(runCfOauthGrant({ timeoutMs: 5000 })).rejects.toThrow(
        new RegExp(`could not start the local callback server on port ${CF_OAUTH_CALLBACK_PORT}`),
      );
      // No browser, no consent warning — nothing opened.
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('rejects on abort (Enter switching to the token path) and closes the server', async () => {
    const controller = new AbortController();
    const { url, grant } = await (async () => {
      let ready!: (url: URL) => void;
      const urlPromise = new Promise<URL>((resolve) => {
        ready = resolve;
      });
      const grantPromise = runCfOauthGrant({
        timeoutMs: 5000,
        signal: controller.signal,
        onUrl: (url) => ready(new URL(url)),
      });
      return { url: await urlPromise, grant: grantPromise };
    })();
    expect(url).toBeInstanceOf(URL);

    controller.abort();
    await expect(grant).rejects.toThrow(/cancelled/);

    // The port is free again immediately — the next grant can bind it.
    const { url: secondUrl, grant: secondGrant } = await startGrant();
    const callback = callbackUrl();
    callback.searchParams.set('state', secondUrl.searchParams.get('state')!);
    callback.searchParams.set('code', AUTH_CODE);
    expect((await fetch(callback)).status).toBe(200);
    await expect(secondGrant).resolves.toEqual({ refreshToken: REFRESH_SENTINEL });
  });

  it(`listens on the pinned ${CF_OAUTH_CALLBACK_PORT}${CF_OAUTH_CALLBACK_PATH} and 404s everything else`, async () => {
    const { url, grant } = await startGrant();
    const rejection = expect(grant).rejects.toThrow(); // settled below via deny

    expect(new URL(CF_OAUTH_REDIRECT_URI).pathname).toBe(CF_OAUTH_CALLBACK_PATH);
    const off = new URL(CF_OAUTH_REDIRECT_URI);
    off.pathname = '/favicon.ico';
    expect((await fetch(off)).status).toBe(404);

    const denied = new URL(CF_OAUTH_REDIRECT_URI);
    denied.searchParams.set('state', url.searchParams.get('state')!);
    denied.searchParams.set('error', 'access_denied');
    await fetch(denied);
    await rejection;
  });
});
