import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runLogin } from '../../src/cli/auth.ts';

const mockExecFile = vi.fn();
const exchangeRequests: Array<{
  url: string;
  headers: Record<string, string>;
  body: unknown;
}> = [];
const originalFetch = globalThis.fetch.bind(globalThis);

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
  exchangeRequests.length = 0;
  process.env.VOID_API_URL = 'https://api.test';

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input.toString();

    if (url.startsWith('http://localhost:')) {
      return originalFetch(input, init);
    }

    exchangeRequests.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(init.body.toString()) : null,
    });

    return Response.json({ token: 'real-token' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VOID_API_URL;
  delete process.env.CF_ACCESS_TOKEN;
});

describe('runLogin', () => {
  it('binds the localhost callback to the login request with state', async () => {
    let resolveLoginUrl!: (url: string) => void;
    const loginUrlPromise = new Promise<string>((resolve) => {
      resolveLoginUrl = resolve;
    });

    const loginPromise = runLogin('/project', 'github', resolveLoginUrl);
    const loginUrl = new URL(await loginUrlPromise);
    const redirect = loginUrl.searchParams.get('redirect');

    expect(redirect).toBeTruthy();
    expect(loginUrl.searchParams.has('state')).toBe(false);
    expect(loginUrl.searchParams.get('code_challenge')).toEqual(expect.any(String));
    expect(loginUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const redirectUrl = new URL(redirect!);
    const state = redirectUrl.searchParams.get('state');
    expect(state).toEqual(expect.any(String));
    expect(state).toHaveLength(64);

    const attackUrl = new URL(redirectUrl);
    attackUrl.searchParams.set('token', 'attacker-controlled-token');
    attackUrl.searchParams.set('state', 'wrong-state');

    const attackResponse = await fetch(attackUrl);
    expect(attackResponse.status).toBe(400);

    const validUrl = new URL(redirectUrl);
    validUrl.searchParams.set('code', 'real-code');

    const validResponse = await fetch(validUrl);
    expect(validResponse.status).toBe(200);
    await expect(loginPromise).resolves.toBe('real-token');

    const exchange = exchangeRequests[0];
    expect(exchange?.body).toEqual(
      expect.objectContaining({
        code_verifier: expect.any(String),
      }),
    );
    const codeVerifier = (exchange!.body as { code_verifier: string }).code_verifier;

    expect(exchangeRequests).toEqual([
      {
        url: 'https://api.test/auth/cli/token',
        headers: {
          'content-type': 'application/json',
        },
        body: {
          code: 'real-code',
          state,
          code_verifier: expect.any(String),
        },
      },
    ]);
    expect(loginUrl.searchParams.get('code_challenge')).toBe(codeChallengeFor(codeVerifier));
  });

  it('rejects attacker tokens when the callback state is copied from the login URL', async () => {
    let resolveLoginUrl!: (url: string) => void;
    const loginUrlPromise = new Promise<string>((resolve) => {
      resolveLoginUrl = resolve;
    });

    const loginPromise = runLogin('/project', 'github', resolveLoginUrl);
    const loginUrl = new URL(await loginUrlPromise);
    const redirect = loginUrl.searchParams.get('redirect');

    expect(redirect).toBeTruthy();

    const redirectUrl = new URL(redirect!);
    const attackUrl = new URL(redirectUrl);
    attackUrl.searchParams.set('token', 'attacker-controlled-token');

    const attackResponse = await fetch(attackUrl);
    expect(attackResponse.status).toBe(400);

    const validUrl = new URL(redirectUrl);
    validUrl.searchParams.set('code', 'real-code');

    const validResponse = await fetch(validUrl);
    expect(validResponse.status).toBe(200);
    await expect(loginPromise).resolves.toBe('real-token');
  });

  it('shows the failure page and throws when the code exchange fails (F3 regression)', async () => {
    // Override fetch so the localhost callback still hits the real server, but
    // the API token exchange returns a non-ok response (expired code, etc.).
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof Request ? input.url : input instanceof URL ? input.href : input.toString();
      if (url.startsWith('http://localhost:')) {
        return originalFetch(input, init);
      }
      return new Response('expired', { status: 400 });
    });

    let resolveLoginUrl!: (url: string) => void;
    const loginUrlPromise = new Promise<string>((resolve) => {
      resolveLoginUrl = resolve;
    });

    const loginPromise = runLogin('/project', 'github', resolveLoginUrl);
    // Attach the rejection assertion up front so the exchange failure doesn't
    // surface as an unhandled rejection.
    const rejection = expect(loginPromise).rejects.toThrow(/Failed to exchange login code/);

    const loginUrl = new URL(await loginUrlPromise);
    const redirect = loginUrl.searchParams.get('redirect');
    expect(redirect).toBeTruthy();

    const validUrl = new URL(redirect!);
    validUrl.searchParams.set('code', 'real-code');

    const validResponse = await fetch(validUrl);
    // The exchange ran INSIDE the request handler and failed → failure page,
    // never the success page.
    expect(validResponse.status).toBe(400);
    const body = await validResponse.text();
    expect(body).not.toContain('successful');
    expect(body).toContain('Could not complete');

    await rejection;
  });

  it('sends Cloudflare Access headers when exchanging the login code', async () => {
    process.env.CF_ACCESS_TOKEN = 'cf-access-token';

    let resolveLoginUrl!: (url: string) => void;
    const loginUrlPromise = new Promise<string>((resolve) => {
      resolveLoginUrl = resolve;
    });

    const loginPromise = runLogin('/project', 'github', resolveLoginUrl);
    const loginUrl = new URL(await loginUrlPromise);
    const redirect = loginUrl.searchParams.get('redirect');
    expect(redirect).toBeTruthy();

    const validUrl = new URL(redirect!);
    validUrl.searchParams.set('code', 'real-code');

    const validResponse = await fetch(validUrl);
    expect(validResponse.status).toBe(200);
    await expect(loginPromise).resolves.toBe('real-token');

    expect(exchangeRequests[0]?.headers).toMatchObject({
      'cf-access-token': 'cf-access-token',
      'content-type': 'application/json',
    });
  });
});
