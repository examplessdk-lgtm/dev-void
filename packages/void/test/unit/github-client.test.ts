import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformClient,
  type GithubConnection,
  type GithubInstallation,
} from '../../src/cli/client.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const token = 'auth-token-x';
const projectId = 'proj_test';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatformClient.getGithubInstallUrl', () => {
  it('GETs the right URL, sends auth headers, returns parsed { url }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://github.com/apps/void-test/installations/new' }),
    );

    const client = makeClient();
    const result = await client.getGithubInstallUrl();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/github/install-url`);
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual({ url: 'https://github.com/apps/void-test/installations/new' });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const client = makeClient();
    await expect(client.getGithubInstallUrl()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 401,
    });
  });
});

describe('PlatformClient.listGithubInstallations', () => {
  it('GETs the right URL and returns the parsed array', async () => {
    const installations: Array<GithubInstallation> = [
      {
        id: 'install_1',
        installation_id: '123456',
        account_login: 'octocat',
        account_id: '1',
        account_type: 'User',
        repositories: [{ full_name: 'octocat/hello-world', id: 1 }],
        repository_selection: 'selected',
        status: 'active',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ];

    fetchMock.mockResolvedValueOnce(jsonResponse(installations));

    const client = makeClient();
    const result = await client.listGithubInstallations();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/github/installations`);
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual(installations);
  });
});

describe('PlatformClient.connectGithub', () => {
  it('POSTs the right URL with Content-Type and exact JSON body, returns parsed connection', async () => {
    const connection: GithubConnection = {
      id: 'conn_1',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'main',
      build_executor: 'container',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    const result = await client.connectGithub(projectId, {
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
      branch: 'main',
      buildExecutor: 'container',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/github`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
      branch: 'main',
      buildExecutor: 'container',
    });
    expect(result).toEqual(connection);
  });

  it('omits optional fields from JSON body when not provided', async () => {
    const connection: GithubConnection = {
      id: 'conn_2',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'main',
      build_executor: 'container',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    await client.connectGithub(projectId, {
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
    });
  });

  it('includes connectGrant + codeVerifier in the JSON body when provided', async () => {
    const connection: GithubConnection = {
      id: 'conn_3',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'main',
      build_executor: 'container',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    const result = await client.connectGithub(projectId, {
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
      branch: 'main',
      buildExecutor: 'container',
      connectGrant: 'grant-abc',
      codeVerifier: 'verifier-abc',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      installationId: '123456',
      repoFullName: 'octocat/hello-world',
      branch: 'main',
      buildExecutor: 'container',
      connectGrant: 'grant-abc',
      codeVerifier: 'verifier-abc',
    });
    expect(result).toEqual(connection);
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const client = makeClient();
    await expect(
      client.connectGithub(projectId, {
        installationId: '123456',
        repoFullName: 'octocat/hello-world',
      }),
    ).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 404,
    });
  });
});

describe('PlatformClient.getGithubConnectAuthorizeUrl', () => {
  it('GETs connect-authorize-url with redirect + S256 challenge + installationId + repoFullName, auth headers, returns { url }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://github.com/login/oauth/authorize?client_id=x' }),
    );

    const client = makeClient();
    const redirect = 'http://localhost:54321/callback?state=abc';
    const result = await client.getGithubConnectAuthorizeUrl(
      redirect,
      'challenge-xyz',
      '123456',
      'octocat/hello-world',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${apiUrl}/github/connect-authorize-url`);
    expect(parsed.searchParams.get('redirect')).toBe(redirect);
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('installationId')).toBe('123456');
    expect(parsed.searchParams.get('repoFullName')).toBe('octocat/hello-world');
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual({ url: 'https://github.com/login/oauth/authorize?client_id=x' });
  });

  it('throws PlatformApiError on non-2xx (503 github_oauth_not_configured)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'github_oauth_not_configured' }, 503));
    const client = makeClient();
    await expect(
      client.getGithubConnectAuthorizeUrl('http://localhost:1/callback', 'c', '1', 'o/r'),
    ).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 503,
      code: 'github_oauth_not_configured',
    });
  });
});

describe('PlatformClient.getGithubConnection', () => {
  it('GETs the right URL, sends auth headers, returns the parsed connection', async () => {
    const connection: GithubConnection = {
      id: 'conn_1',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'main',
      build_executor: 'container',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    const result = await client.getGithubConnection(projectId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/github`);
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual(connection);
  });

  it('throws PlatformApiError on non-2xx (e.g. 404 connection not found)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'connection not found' }, 404));
    const client = makeClient();
    await expect(client.getGithubConnection(projectId)).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 404,
      code: 'connection not found',
    });
  });
});

describe('PlatformClient.updateGithubConnection', () => {
  it('PATCHes the right URL with Content-Type and exact JSON body, returns parsed connection', async () => {
    const connection: GithubConnection = {
      id: 'conn_1',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'release',
      build_executor: 'github_actions',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    const result = await client.updateGithubConnection(projectId, {
      branch: 'release',
      buildExecutor: 'github_actions',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/github`);
    expect(init.method).toBe('PATCH');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({
      branch: 'release',
      buildExecutor: 'github_actions',
    });
    expect(result).toEqual(connection);
  });

  it('sends only the fields provided (executor only)', async () => {
    const connection: GithubConnection = {
      id: 'conn_2',
      project_id: projectId,
      installation_id: '123456',
      repo_full_name: 'octocat/hello-world',
      branch: 'main',
      build_executor: 'github_actions',
      workflow_path: '.github/workflows/void-deploy.yml',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(connection));

    const client = makeClient();
    await client.updateGithubConnection(projectId, { buildExecutor: 'github_actions' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ buildExecutor: 'github_actions' });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const client = makeClient();
    await expect(
      client.updateGithubConnection(projectId, { branch: 'main' }),
    ).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 404,
    });
  });
});

describe('PlatformClient.deleteGithubConnection', () => {
  it('DELETEs the right URL with auth headers and no body, returns parsed { ok }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = makeClient();
    const result = await client.deleteGithubConnection(projectId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/github`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual({ ok: true });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const client = makeClient();
    await expect(client.deleteGithubConnection(projectId)).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 403,
    });
  });
});

describe('PlatformClient.getGithubLinkUrl', () => {
  it('GETs link-url with redirect + S256 challenge query, auth headers, returns { url }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://github.com/login/oauth/authorize?client_id=x' }),
    );

    const client = makeClient();
    const redirect = 'http://localhost:54321/callback?state=abc';
    const result = await client.getGithubLinkUrl(redirect, 'challenge-xyz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${apiUrl}/github/link-url`);
    expect(parsed.searchParams.get('redirect')).toBe(redirect);
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual({ url: 'https://github.com/login/oauth/authorize?client_id=x' });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const client = makeClient();
    await expect(client.getGithubLinkUrl('http://localhost:1/callback', 'c')).rejects.toMatchObject(
      {
        name: 'PlatformApiError',
        status: 403,
      },
    );
  });
});

describe('PlatformClient.completeGithubLink', () => {
  it('POSTs link/complete with exact JSON body + auth headers, returns { status }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'linked' }));

    const client = makeClient();
    const result = await client.completeGithubLink('link-code-1', 'verifier-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/github/link/complete`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({
      link_code: 'link-code-1',
      code_verifier: 'verifier-1',
    });
    expect(result).toEqual({ status: 'linked' });
  });

  it('returns already_linked status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'already_linked' }));
    const client = makeClient();
    const result = await client.completeGithubLink('link-code-2', 'verifier-2');
    expect(result).toEqual({ status: 'already_linked' });
  });

  it('throws PlatformApiError with status 409 and code on github_identity_conflict', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'github_identity_conflict' }, 409));
    const client = makeClient();
    await expect(client.completeGithubLink('link-code-3', 'verifier-3')).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 409,
      code: 'github_identity_conflict',
    });
  });
});

describe('PlatformClient.getGithubJoinUrl', () => {
  it('GETs join-url with redirect + S256 challenge query, auth headers, returns { url }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://github.com/login/oauth/authorize?client_id=x' }),
    );

    const client = makeClient();
    const redirect = 'http://localhost:54321/callback?state=abc';
    const result = await client.getGithubJoinUrl(redirect, 'challenge-xyz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${apiUrl}/github/join-url`);
    expect(parsed.searchParams.get('redirect')).toBe(redirect);
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(init.method).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(result).toEqual({ url: 'https://github.com/login/oauth/authorize?client_id=x' });
  });

  it('throws PlatformApiError on non-2xx (503 github_oauth_not_configured)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'github_oauth_not_configured' }, 503));
    const client = makeClient();
    await expect(client.getGithubJoinUrl('http://localhost:1/callback', 'c')).rejects.toMatchObject(
      {
        name: 'PlatformApiError',
        status: 503,
        code: 'github_oauth_not_configured',
      },
    );
  });
});

describe('PlatformClient.completeGithubJoin', () => {
  it('POSTs join/complete with exact JSON body + auth headers, returns { status, count }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'joined', count: 3 }));

    const client = makeClient();
    const result = await client.completeGithubJoin('join-code-1', 'verifier-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/github/join/complete`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({
      join_code: 'join-code-1',
      code_verifier: 'verifier-1',
    });
    expect(result).toEqual({ status: 'joined', count: 3 });
  });

  it('returns a zero count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'joined', count: 0 }));
    const client = makeClient();
    const result = await client.completeGithubJoin('join-code-2', 'verifier-2');
    expect(result).toEqual({ status: 'joined', count: 0 });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = makeClient();
    await expect(client.completeGithubJoin('join-code-3', 'verifier-3')).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 500,
    });
  });
});
