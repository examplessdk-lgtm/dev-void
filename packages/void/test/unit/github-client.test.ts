import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformClient,
  type GithubConnection,
  type GithubInstallation,
} from '../../src/cli/client.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
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
      repository_id: '9876',
      branch: 'main',
      build_executor: 'container',
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
      repository_id: null,
      branch: 'main',
      build_executor: 'container',
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
