import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient, PlatformApiError } from '../../src/cli/client.ts';
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
const projectId = 'proj_abc';
const token = 'test-token';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatformClient.getDatabaseUrl', () => {
  it('GETs the correct URL with auth headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'postgres://user:pass@host/db' }));

    const client = makeClient();
    await client.getDatabaseUrl(projectId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/database-url`);
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('returns the url from a successful response', async () => {
    const expected = 'postgres://user:pass@host:5432/mydb';
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: expected }));

    const client = makeClient();
    const result = await client.getDatabaseUrl(projectId);

    expect(result).toEqual({ url: expected });
  });

  it('throws PlatformApiError on 404 (database_url_not_stored)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'database_url_not_stored', message: 'No database URL stored.' }, 404),
    );

    const client = makeClient();
    const err = await client.getDatabaseUrl(projectId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect((err as PlatformApiError).status).toBe(404);
  });

  it('throws PlatformApiError on 403 (ownership check failure)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    const client = makeClient();
    const err = await client.getDatabaseUrl(projectId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformApiError);
    expect((err as PlatformApiError).status).toBe(403);
  });

  it('does not send a request body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'postgres://host/db' }));

    const client = makeClient();
    await client.getDatabaseUrl(projectId);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});
