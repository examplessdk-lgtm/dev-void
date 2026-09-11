import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import {
  listAuthorizedInstallationIds,
  verifyUserRepoAccess,
} from '../../src/github/user-installations.ts';

// The App's user-to-server OAuth creds present → isAppUserOAuthConfigured true.
const CONFIGURED_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as unknown as ApiEnv['Bindings'];

// No user-OAuth creds → isAppUserOAuthConfigured false → fail closed, no fetch.
const UNCONFIGURED_ENV = {} as unknown as ApiEnv['Bindings'];

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

// Parse the JSON body the source POSTs to the token-exchange endpoint so a test
// can assert the forwarded `redirect_uri` (or its absence).
function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (!init || typeof init.body !== 'string') {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get('page') ?? '1');
}

function range(start: number, end: number): Array<number> {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

type StubHandlers = {
  // Token-exchange response; defaults to a valid `{ access_token }`.
  tokenResponse?: () => Response;
  // `GET /user/installations` page → its installations list.
  installations?: (page: number) => { installations: Array<{ id: number }> };
  // `GET /user` → the code-holder's numeric id.
  user?: () => { id: number };
  // `GET /user/installations/:id/repositories` page → response (a raw Response
  // to exercise the non-ok throw, or a JSON body object).
  repositories?: (
    page: number,
  ) => Response | { total_count: number; repositories: Array<{ id: number; full_name: string }> };
};

// Route the stubbed global fetch by URL, mirroring the real GitHub endpoints the
// module hits. Captures every token-exchange body so redirect_uri forwarding is
// assertable. `/repositories` is matched BEFORE `/user/installations` because
// the repositories URL contains that path.
function stubFetch(handlers: StubHandlers): {
  tokenBodies: Array<Record<string, unknown>>;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const tokenBodies: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.includes('login/oauth/access_token')) {
      tokenBodies.push(bodyOf(init));
      return handlers.tokenResponse?.() ?? Response.json({ access_token: 'user-to-server-token' });
    }
    if (url.includes('/repositories')) {
      const result = handlers.repositories?.(pageOf(url));
      if (result instanceof Response) {
        return result;
      }
      return Response.json(result ?? { total_count: 0, repositories: [] });
    }
    if (url.includes('/user/installations')) {
      return Response.json(handlers.installations?.(pageOf(url)) ?? { installations: [] });
    }
    if (url.endsWith('/user')) {
      return Response.json(handlers.user?.() ?? { id: 0 });
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { tokenBodies, fetchSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('listAuthorizedInstallationIds', () => {
  it('returns an empty set and null id with NO fetch when the app is not configured', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when unconfigured');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listAuthorizedInstallationIds(UNCONFIGURED_ENV, 'code');

    expect(result.installationIds.size).toBe(0);
    expect(result.callerAccountId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('unions installation ids across a full page + a short page, returns the caller id, and forwards redirect_uri', async () => {
    const { tokenBodies } = stubFetch({
      installations: (page) =>
        page === 1
          ? { installations: range(1, 100).map((id) => ({ id })) }
          : { installations: [{ id: 101 }, { id: 102 }] },
      user: () => ({ id: 4242 }),
    });

    const result = await listAuthorizedInstallationIds(
      CONFIGURED_ENV,
      'code-x',
      'https://api.void.example/cb',
    );

    expect(result.installationIds.size).toBe(102);
    expect(result.installationIds.has('1')).toBe(true);
    expect(result.installationIds.has('100')).toBe(true);
    expect(result.installationIds.has('102')).toBe(true);
    expect(result.callerAccountId).toBe('4242');
    // The token-exchange POST forwarded the authorize redirect_uri byte-for-byte.
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0].redirect_uri).toBe('https://api.void.example/cb');
  });

  it('returns an empty set and null id when the token exchange errors, and omits redirect_uri when none is passed', async () => {
    const { tokenBodies } = stubFetch({
      tokenResponse: () => Response.json({ error: 'bad_verification_code' }),
    });

    const result = await listAuthorizedInstallationIds(CONFIGURED_ENV, 'bad-code');

    expect(result.installationIds.size).toBe(0);
    expect(result.callerAccountId).toBeNull();
    // No redirectUri argument → no redirect_uri key on the exchange body.
    expect(tokenBodies).toHaveLength(1);
    expect('redirect_uri' in tokenBodies[0]).toBe(false);
  });
});

describe('verifyUserRepoAccess', () => {
  it('returns the repository id and caller id when the repo is on page 1, forwarding redirect_uri', async () => {
    const { tokenBodies } = stubFetch({
      repositories: (page) =>
        page === 1
          ? {
              total_count: 2,
              repositories: [
                { id: 7, full_name: 'octo/other' },
                { id: 42, full_name: 'octo/target' },
              ],
            }
          : { total_count: 2, repositories: [] },
      user: () => ({ id: 555 }),
    });

    const result = await verifyUserRepoAccess(
      CONFIGURED_ENV,
      'code',
      '12345',
      'octo/target',
      'https://api.void.example/cb',
    );

    expect(result.repositoryId).toBe(42);
    expect(result.callerAccountId).toBe('555');
    expect(tokenBodies[0].redirect_uri).toBe('https://api.void.example/cb');
  });

  it('paginates past a full page 1 to find the repo on page 2', async () => {
    const pagesRequested: Array<number> = [];
    stubFetch({
      repositories: (page) => {
        pagesRequested.push(page);
        if (page === 1) {
          return {
            total_count: 101,
            repositories: range(1, 100).map((id) => ({ id, full_name: `octo/repo-${id}` })),
          };
        }
        return { total_count: 101, repositories: [{ id: 999, full_name: 'octo/target' }] };
      },
      user: () => ({ id: 1 }),
    });

    const result = await verifyUserRepoAccess(CONFIGURED_ENV, 'code', '12345', 'octo/target');

    expect(result.repositoryId).toBe(999);
    expect(result.callerAccountId).toBe('1');
    expect(pagesRequested).toEqual([1, 2]);
  });

  it('returns a null repositoryId (confused-deputy reject) when the repo is absent across all pages', async () => {
    stubFetch({
      repositories: () => ({
        total_count: 1,
        repositories: [{ id: 7, full_name: 'octo/other' }],
      }),
      user: () => ({ id: 8 }),
    });

    const result = await verifyUserRepoAccess(CONFIGURED_ENV, 'code', '12345', 'octo/target');

    expect(result.repositoryId).toBeNull();
    expect(result.callerAccountId).toBe('8');
  });

  it('returns null/null with NO fetch when the app is not configured', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when unconfigured');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyUserRepoAccess(UNCONFIGURED_ENV, 'code', '12345', 'octo/target');

    expect(result).toEqual({ repositoryId: null, callerAccountId: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null/null when the token exchange errors', async () => {
    stubFetch({ tokenResponse: () => Response.json({ error: 'bad_verification_code' }) });

    const result = await verifyUserRepoAccess(CONFIGURED_ENV, 'bad-code', '12345', 'octo/target');

    expect(result).toEqual({ repositoryId: null, callerAccountId: null });
  });

  it('throws when the repositories response is not ok', async () => {
    stubFetch({ repositories: () => new Response('boom', { status: 500 }) });

    await expect(
      verifyUserRepoAccess(CONFIGURED_ENV, 'code', '12345', 'octo/target'),
    ).rejects.toThrow(/Failed to list installation repositories/);
  });
});
