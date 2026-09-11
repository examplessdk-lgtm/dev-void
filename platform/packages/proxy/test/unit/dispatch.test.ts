import { describe, it, expect, vi, beforeAll, afterEach } from 'vite-plus/test';
import { clearWorkerNameCache } from '../../src/dispatch.ts';
import worker from '../../src/index.ts';

const JWT_SECRET = 'test-secret-key';

// --- HMAC helper ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signAiToken(projectId: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(projectId)));
  return base64urlEncode(sig);
}

// --- Mock factories ---

function createMockApi(workerNames: Record<string, string> = {}) {
  return {
    fetch: vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const match = path.match(/\/internal\/resolve-worker\/(.+)/);
      if (match) {
        const projectId = match[1];
        const workerName = workerNames[projectId];
        if (workerName) {
          return Response.json({ workerName });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      // Default: return 404 for resolve-resource (not needed for dispatch tests)
      return Response.json({ error: 'not found' }, { status: 404 });
    }),
  };
}

function createMockDispatch(handler?: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    get: vi.fn((_workerName: string) => ({
      fetch: vi.fn(async (url: string, init: RequestInit) => {
        if (handler) {
          return handler(url, init);
        }
        // Default: 404 (old deploy without /__void handler)
        return new Response('Not Found', { status: 404 });
      }),
    })),
  };
}

function createEnv(
  workerNames: Record<string, string> = {},
  dispatchHandler?: (url: string, init: RequestInit) => Promise<Response>,
) {
  return {
    AI: { run: vi.fn(), models: vi.fn(), toMarkdown: vi.fn() },
    JWT_SECRET,
    ROUTING: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    API: createMockApi(workerNames),
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-token',
    DISPATCH: createMockDispatch(dispatchHandler),
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://proxy.void.cloud${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function asFetchMock(mock: unknown): typeof fetch {
  return mock as typeof fetch;
}

// --- Tests ---

describe('WfP dispatch path', () => {
  let token: string;

  beforeAll(async () => {
    token = await signAiToken('proj_1', JWT_SECRET);
  });

  afterEach(() => {
    clearWorkerNameCache();
    vi.restoreAllMocks();
  });

  describe('D1 via dispatch', () => {
    it('dispatches D1 query through user worker and returns response', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () => {
        return Response.json({
          results: [{ id: 1, name: 'Alice' }],
          success: true,
          meta: { duration: 0.001 },
        });
      });

      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users',
          params: [],
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        results: Array<{ id: number; name: string }>;
        success: boolean;
      };
      expect(data.results).toEqual([{ id: 1, name: 'Alice' }]);
      expect(data.success).toBe(true);

      // Verify dispatch was called with correct worker name
      expect(env.DISPATCH.get).toHaveBeenCalledWith('user-my-app');
    });

    it('dispatches D1 batch through user worker', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () => {
        return Response.json([
          { results: [{ count: 1 }], success: true, meta: {} },
          { results: [{ count: 2 }], success: true, meta: {} },
        ]);
      });

      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'DB',
          statements: [
            { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Alice'] },
            { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] },
          ],
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as Array<{
        results: Array<{ count: number }>;
        success: boolean;
        meta: Record<string, unknown>;
      }>;
      expect(data).toHaveLength(2);
    });
  });

  describe('KV via dispatch', () => {
    it('dispatches KV get through user worker', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () => Response.json('hello world'));

      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'greeting',
          type: 'text',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBe('hello world');
    });

    it('dispatches KV put through user worker', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () =>
        Response.json({ success: true }),
      );

      const res = await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'greeting',
          value: 'hello',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });
  });

  describe('R2 via dispatch', () => {
    it('dispatches R2 list through user worker', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () =>
        Response.json({
          objects: [{ key: 'file.txt', size: 100, lastModified: '' }],
          truncated: false,
          cursor: null,
        }),
      );

      const res = await worker.fetch(
        post('/r2/list', {
          binding: 'STORAGE',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        objects: Array<{ key: string; size: number; lastModified: string }>;
        truncated: boolean;
        cursor: string | null;
      };
      expect(data.objects).toHaveLength(1);
    });
  });

  describe('fallback to REST API', () => {
    it('falls back when worker name resolution fails', async () => {
      // No worker names configured — resolveWorkerName returns null
      const env = createEnv({});
      // Need globalThis.fetch for the REST API fallback
      const rows = [{ id: 1, name: 'Alice' }];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({
            success: true,
            result: [{ results: rows, success: true, meta: { duration: 0.001 } }],
          }),
        ),
      );

      // Also need resource resolution to succeed
      env.API.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.includes('/internal/resolve-worker/')) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        // resolve-resource
        const body = JSON.parse(init?.body as string) as { type?: string; binding?: string };
        if (body.type === 'd1' && body.binding === 'DB') {
          return Response.json({ cf_id: 'd1-uuid-abc' });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }) as unknown as typeof env.API.fetch;

      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users',
          params: [],
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        results: Array<{ id: number; name: string }>;
        success: boolean;
      };
      expect(data.results).toEqual(rows);

      // Verify CF REST API was called
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.cloudflare.com'),
        expect.any(Object),
      );

      globalThis.fetch = originalFetch;
    });

    it('falls back when dispatch returns 404 (old deploy)', async () => {
      // Worker resolved but returns 404 for /__void
      const env = createEnv(
        { proj_1: 'user-my-app' },
        async () => new Response('Not Found', { status: 404 }),
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({
            success: true,
            result: [{ results: [{ id: 1 }], success: true, meta: {} }],
          }),
        ),
      );

      env.API.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.includes('/internal/resolve-worker/')) {
          return Response.json({ workerName: 'user-my-app' });
        }
        const body = JSON.parse(init?.body as string) as { type?: string; binding?: string };
        if (body.type === 'd1' && body.binding === 'DB') {
          return Response.json({ cf_id: 'd1-uuid-abc' });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }) as unknown as typeof env.API.fetch;

      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });
  });

  describe('worker name caching', () => {
    it('caches worker name after first resolution', async () => {
      const env = createEnv({ proj_1: 'user-my-app' }, async () =>
        Response.json({ results: [], success: true, meta: {} }),
      );

      // First call
      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      // Second call — should use cached worker name
      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 2',
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      // API should only be called once for resolve-worker (cached after first call)
      const resolveWorkerCalls = env.API.fetch.mock.calls.filter((call: Array<unknown>) =>
        new URL(call[0]).pathname.includes('/internal/resolve-worker/'),
      );
      expect(resolveWorkerCalls).toHaveLength(1);
    });
  });

  describe('auth forwarding', () => {
    it('sends x-void-internal header to dispatched worker', async () => {
      let capturedHeaders: Record<string, string> = {};
      const env = createEnv({ proj_1: 'user-my-app' }, async (_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
        return Response.json({ results: [], success: true, meta: {} });
      });

      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_1',
          aiToken: token,
        }),
        env,
      );

      expect(capturedHeaders['x-void-internal']).toBeDefined();
      expect(capturedHeaders['x-void-internal'].length).toBeGreaterThan(0);
    });
  });
});
