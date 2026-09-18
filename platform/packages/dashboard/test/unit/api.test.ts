import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getCurrentUser } from '../../lib/api.ts';

function createContext() {
  return {
    env: { API_URL: 'https://api.test' },
    get: vi.fn((key: string) => (key === 'token' ? 'test-token' : undefined)),
    req: {
      raw: new Request('https://localhost:5173/me'),
      header: vi.fn((key: string) => (key === 'host' ? 'localhost:5173' : undefined)),
    },
  };
}

describe('dashboard API helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats non-JSON /me responses as unauthenticated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html><body>Access required</body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUser(createContext() as never)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/me',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get('Accept')).toBe('application/json');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected JSON from API'));
  });
});
