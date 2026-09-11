import { and, eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  createOAuthAccount,
  getUserByOAuthAccount,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { githubInstallations, invitations, oauthAccounts, users } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createMockExecutionContext,
  seedOAuthNonce,
  JWT_SECRET,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
const executionCtx = createMockExecutionContext();

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // github_installations isn't known to the shared clearTables helper; clear it
  // before it removes the users they reference (mirrors the routes test).
  await env.db.delete(githubInstallations);
  await clearTables(env.db);
  delete env.GITHUB_PREVIEW_REPO_PAT;
  await env.ROUTING.delete('signup:enabled');
  await env.ROUTING.delete('signup:allowlist');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildSignedState(provider: string): Promise<string> {
  const redirect = 'http://localhost:9999/callback';
  const stateData = JSON.stringify({ redirect, nonce: 'test-nonce', provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi(ghUser: {
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
  publicEmail?: boolean;
  previewRepo?: {
    owner: string;
    repo: string;
    collaboratorStatus?: number;
    pendingInvite?: boolean;
  };
}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'test-gh-token' });
    }

    if (url === 'https://api.github.com/user') {
      return Response.json({
        id: ghUser.id,
        login: ghUser.login,
        email: ghUser.publicEmail ? ghUser.email : null,
      });
    }

    if (url === 'https://api.github.com/user/emails') {
      if (ghUser.email) {
        return Response.json([
          { email: ghUser.email, primary: true, verified: ghUser.emailVerified },
        ]);
      }
      return Response.json([]);
    }

    if (ghUser.previewRepo) {
      const repoBase = `https://api.github.com/repos/${ghUser.previewRepo.owner}/${ghUser.previewRepo.repo}`;
      const collaboratorUrl = `${repoBase}/collaborators/${ghUser.login}`;

      if (url === collaboratorUrl) {
        if (_init?.method === 'PUT') {
          return new Response(null, { status: 201 });
        }

        return new Response(null, { status: ghUser.previewRepo.collaboratorStatus ?? 404 });
      }

      if (url === `${repoBase}/invitations`) {
        return Response.json(
          ghUser.previewRepo.pendingInvite ? [{ id: 1, invitee: { login: ghUser.login } }] : [],
        );
      }
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('email verification gating on account linking', () => {
  it('allows new GitHub signup when signup is restricted but the user already has preview repo access', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';
    await env.ROUTING.put('signup:enabled', 'true');

    const fetchMock = mockGitHubApi({
      id: 44444,
      login: 'repo-collaborator',
      email: 'repo-collaborator@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        collaboratorStatus: 204,
      },
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('http://localhost:9999/callback?token=');
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/repo-collaborator',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('rejects new GitHub signup when signup is restricted and the user lacks preview repo access', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';
    await env.ROUTING.put('signup:enabled', 'true');

    const fetchMock = mockGitHubApi({
      id: 33333,
      login: 'not-a-collaborator',
      email: 'not-a-collaborator@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        collaboratorStatus: 404,
      },
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/signup-restricted');
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/not-a-collaborator',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('does not link to existing account when GitHub email is unverified', async () => {
    const existing = await createTestUser(env.db, 'existing-user');
    await env.db
      .update(users)
      .set({ email: 'shared@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 99999,
        login: 'new-gh-user',
        email: 'shared@example.com',
        emailVerified: false,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).not.toBe(existing.id);
  });

  it('links to existing account when GitHub has public email that is verified', async () => {
    const existing = await createTestUser(env.db, 'public-email-user');
    await env.db
      .update(users)
      .set({ email: 'public@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 77777,
        login: 'public-email-gh-user',
        email: 'public@example.com',
        emailVerified: true,
        publicEmail: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('links to existing account when GitHub email is verified (private email)', async () => {
    const existing = await createTestUser(env.db, 'linkable-user');
    await env.db
      .update(users)
      .set({ email: 'verified@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 88888,
        login: 'verified-gh-user',
        email: 'verified@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('accepts a pending invitation when an existing account logs in with a verified email', async () => {
    const inviter = await createTestUser(env.db, 'inviter');
    const existing = await createTestUser(env.db, 'invited-existing', 'github', '424242');
    await env.db
      .update(users)
      .set({ email: 'invited-existing@example.com' })
      .where(eq(users.id, existing.id));
    await env.db.insert(invitations).values({
      id: 'inv_existing_login',
      email: 'invited-existing@example.com',
      invited_by: inviter.id,
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 424242,
        login: 'invited-existing',
        email: 'invited-existing@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const [invitation] = await env.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, 'inv_existing_login'));
    expect(invitation.status).toBe('accepted');
    expect(invitation.accepted_by).toBe(existing.id);
    expect(invitation.accepted_at).toBeTruthy();
  });

  it('invites the GitHub user to the preview repo when configured', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';

    const fetchMock = mockGitHubApi({
      id: 55555,
      login: 'preview-gh-user',
      email: 'preview@example.com',
      emailVerified: true,
      previewRepo: { owner: 'void-sdk', repo: 'void' },
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/preview-gh-user',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('does not link a SECOND github identity when the existing account already has one (RFC 0074 one-github invariant)', async () => {
    // Alice signed in via google, then linked github id X.
    const existing = await createTestUser(env.db, 'one-github-alice', 'google', 'google-alice');
    await env.db
      .update(users)
      .set({ email: 'one-github@example.com' })
      .where(eq(users.id, existing.id));
    await createOAuthAccount(env.db, existing.id, 'github', '111111'); // X

    // An UNOWNED installation whose account_id is the REJECTED github id Y.
    // Because Y is rejected as an identity, the backfill must NOT claim it.
    await upsertGitHubInstallation(env.db, {
      installationId: '600',
      userId: null,
      accountLogin: 'another-gh-account',
      accountId: '222222', // Y
      accountType: 'User',
      repositories: [{ full_name: 'another-gh-account/app', id: 1 }],
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    // Now log in with a DIFFERENT github id Y whose verified email matches Alice.
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 222222, // Y != X
        login: 'another-gh-account',
        email: 'one-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the EXISTING account (not a new user)...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and NO github row for Y was created (still exactly one github row, X).
    const githubRows = await env.db
      .select({ providerId: oauthAccounts.provider_id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.user_id, existing.id), eq(oauthAccounts.provider, 'github')));
    expect(githubRows.length).toBe(1);
    expect(githubRows[0]!.providerId).toBe('111111');
    expect(await getUserByOAuthAccount(env.db, 'github', '222222')).toBeNull();

    // ...and the unowned installation for the REJECTED id Y was NOT claimed.
    const [install] = await env.db
      .select({ userId: githubInstallations.user_id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, '600'));
    expect(install?.userId).toBeNull();
  });

  it('consolidates a github login onto an existing account that has NO github yet (cross-provider link unchanged)', async () => {
    // Bob signed in via google, has NO github identity.
    const existing = await createTestUser(env.db, 'no-github-bob', 'google', 'google-bob');
    await env.db
      .update(users)
      .set({ email: 'no-github@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 333333,
        login: 'bob-gh',
        email: 'no-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the existing account...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and the github row WAS created and is owned by the existing account.
    const owner = await getUserByOAuthAccount(env.db, 'github', '333333');
    expect(owner?.id).toBe(existing.id);
  });

  it('does not create a duplicate preview repo invitation when one is already pending', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';

    const fetchMock = mockGitHubApi({
      id: 66666,
      login: 'pending-preview-gh-user',
      email: 'pending-preview@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        pendingInvite: true,
      },
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/pending-preview-gh-user',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
