import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { resolveResource, clearResolveCache } from '../../src/resolve.ts';

const JWT_SECRET = 'test-secret-key';

function createMockApi(resources: Record<string, string>) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const projectId = new URL(url).pathname.split('/').pop()!;
      const body = JSON.parse(init?.body as string);
      const key = `${projectId}:${body.type}:${body.binding}`;
      const cfId = resources[key];
      if (cfId) {
        return Response.json({ cf_id: cfId });
      }
      return Response.json({ error: `unknown binding "${body.binding}"` }, { status: 404 });
    }),
  } as unknown as Fetcher;
}

describe('resolveResource', () => {
  beforeEach(() => {
    clearResolveCache();
  });

  it('returns cf_id for a known resource', async () => {
    const api = createMockApi({ 'proj_1:d1:DB': 'd1-uuid-123' });
    const result = await resolveResource(api, JWT_SECRET, 'proj_1', 'd1', 'DB');
    expect(result).toBe('d1-uuid-123');
  });

  it('throws for an unknown resource', async () => {
    const api = createMockApi({});
    await expect(resolveResource(api, JWT_SECRET, 'proj_1', 'kv', 'MISSING')).rejects.toThrow(
      'Resource resolution failed (404)',
    );
  });

  it('calls API with correct URL and body', async () => {
    const api = createMockApi({ 'proj_42:r2:STORAGE': 'r2-uuid-456' });
    await resolveResource(api, JWT_SECRET, 'proj_42', 'r2', 'STORAGE');

    expect(api.fetch).toHaveBeenCalledWith(
      'https://api/internal/resolve-resource/proj_42',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'r2', binding: 'STORAGE' }),
      }),
    );
  });

  it('caches resolved resource IDs', async () => {
    const api = createMockApi({ 'proj_1:d1:DB': 'd1-uuid-123' });
    await resolveResource(api, JWT_SECRET, 'proj_1', 'd1', 'DB');
    await resolveResource(api, JWT_SECRET, 'proj_1', 'd1', 'DB');
    await resolveResource(api, JWT_SECRET, 'proj_1', 'd1', 'DB');

    expect((api.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('includes HMAC token in x-void-internal header', async () => {
    const api = createMockApi({ 'proj_1:d1:DB': 'd1-uuid-123' });
    await resolveResource(api, JWT_SECRET, 'proj_1', 'd1', 'DB');

    const call = (api.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-void-internal']).toBeDefined();
    expect(typeof headers['x-void-internal']).toBe('string');
    expect(headers['x-void-internal'].length).toBeGreaterThan(0);
  });
});
