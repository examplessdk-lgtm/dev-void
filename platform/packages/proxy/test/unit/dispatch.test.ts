import { describe, it, expect, vi, beforeAll, afterEach } from 'vite-plus/test';
import { createBindingHandler } from '../../../../../packages/void/src/runtime/remote/binding-handler.ts';
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
          return Response.json({ workerName, deploymentId: 'dpl_active' });
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

type InMemoryStatement = D1PreparedStatement & {
  sql: string;
  params: Array<unknown>;
};

function createAtomicD1() {
  const rows = new Map<number, string>();
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      params: [] as Array<unknown>,
      bind(...params: Array<unknown>) {
        statement.params = params;
        return statement;
      },
    } as unknown as InMemoryStatement;
    return statement;
  });
  const batch = vi.fn(async (statements: Array<D1PreparedStatement>) => {
    const pending = new Map(rows);
    const results: Array<Record<string, unknown>> = [];
    for (const rawStatement of statements) {
      const statement = rawStatement as InMemoryStatement;
      if (!/^INSERT INTO users\b/i.test(statement.sql)) {
        throw new Error(`unsupported test SQL: ${statement.sql}`);
      }
      const id = Number(statement.params[0]);
      const name = String(statement.params[1]);
      if (pending.has(id)) {
        throw new Error('UNIQUE constraint failed: users.id');
      }
      pending.set(id, name);
      results.push({ results: [], success: true, meta: { changes: 1 } });
    }
    rows.clear();
    for (const [id, name] of pending) {
      rows.set(id, name);
    }
    return results as Array<D1Result>;
  });
  return { db: { prepare, batch } as unknown as D1Database, rows, batch };
}

function attachNativeBindingHandler(
  env: ReturnType<typeof createEnv>,
  token: string,
  db: D1Database,
  afterResponse?: (response: Response) => void,
): void {
  const bindingHandler = createBindingHandler({ DB: db, __VOID_PROXY_TOKEN: token });
  env.DISPATCH.get = vi.fn(() => ({
    fetch: async (url: string, init: RequestInit) => {
      const target = new URL(url);
      target.pathname = target.pathname.replace(/^\/__void/, '');
      const response = await bindingHandler.fetch(new Request(target, init));
      afterResponse?.(response);
      return response;
    },
  })) as unknown as typeof env.DISPATCH.get;
}

// --- Tests ---

describe('WfP dispatch path', () => {
  let token: string;

  beforeAll(async () => {
    token = await signAiToken('proj_000000000001', JWT_SECRET);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('D1 via dispatch', () => {
    it('dispatches D1 query through user worker and returns response', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () => {
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
          projectId: 'proj_000000000001',
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
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () => {
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
          projectId: 'proj_000000000001',
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

    it('keeps a native batch atomic when the second statement violates a constraint', async () => {
      const native = createAtomicD1();
      const env = createEnv({ proj_000000000001: 'user-my-app-dpl_active' });
      attachNativeBindingHandler(env, token, native.db);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const restFetch = vi.spyOn(globalThis, 'fetch');

      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'DB',
          statements: [
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Alice'] },
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Bob'] },
          ],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(500);
      expect(native.batch).toHaveBeenCalledTimes(1);
      expect(native.rows.size).toBe(0);
      expect(restFetch).not.toHaveBeenCalled();
    });

    it('commits a successful native batch exactly once', async () => {
      const native = createAtomicD1();
      const env = createEnv({ proj_000000000001: 'user-my-app-dpl_active' });
      attachNativeBindingHandler(env, token, native.db);
      const restFetch = vi.spyOn(globalThis, 'fetch');

      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'DB',
          statements: [
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Alice'] },
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [2, 'Bob'] },
          ],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(2);
      expect(native.batch).toHaveBeenCalledTimes(1);
      expect([...native.rows]).toEqual([
        [1, 'Alice'],
        [2, 'Bob'],
      ]);
      expect(restFetch).not.toHaveBeenCalled();
    });

    it('does not replay a native batch when transport fails after the commit', async () => {
      const native = createAtomicD1();
      const env = createEnv({ proj_000000000001: 'user-my-app-dpl_active' });
      attachNativeBindingHandler(env, token, native.db, (response) => {
        if (response.ok) {
          throw new Error('response lost after native commit');
        }
      });
      const restFetch = vi.spyOn(globalThis, 'fetch');

      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'DB',
          statements: [
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [1, 'Alice'] },
            { sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: [2, 'Bob'] },
          ],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'worker dispatch failed; operation result is unknown',
      });
      expect(native.batch).toHaveBeenCalledTimes(1);
      expect([...native.rows]).toEqual([
        [1, 'Alice'],
        [2, 'Bob'],
      ]);
      expect(restFetch).not.toHaveBeenCalled();
    });
  });

  describe('KV via dispatch', () => {
    it('dispatches KV get through user worker', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () =>
        Response.json('hello world'),
      );

      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'greeting',
          type: 'text',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBe('hello world');
    });

    it('dispatches KV put through user worker', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () =>
        Response.json({ success: true }),
      );

      const res = await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'greeting',
          value: 'hello',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it('preserves the REST fallback for a read-only dispatch transport failure', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () => {
        throw new Error('dispatch transport unavailable');
      });
      env.API.fetch = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        return path.includes('/internal/resolve-worker/')
          ? Response.json({ workerName: 'user-my-app', deploymentId: 'dpl_active' })
          : Response.json({ cf_id: 'kv-namespace' });
      }) as unknown as typeof env.API.fetch;
      const restFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('from-rest'));

      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'greeting',
          type: 'text',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBe('from-rest');
      expect(restFetch).toHaveBeenCalledTimes(1);
    });

    it('does not replay a write after a dispatch transport failure', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () => {
        throw new Error('response lost after KV write');
      });
      const restFetch = vi.spyOn(globalThis, 'fetch');

      const res = await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'greeting',
          value: 'hello',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'worker dispatch failed; operation result is unknown',
      });
      expect(restFetch).not.toHaveBeenCalled();
    });
  });

  describe('R2 via dispatch', () => {
    it('dispatches R2 list through user worker', async () => {
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async () =>
        Response.json({
          objects: [{ key: 'file.txt', size: 100, lastModified: '' }],
          truncated: false,
          cursor: null,
        }),
      );

      const res = await worker.fetch(
        post('/r2/list', {
          binding: 'STORAGE',
          projectId: 'proj_000000000001',
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
          projectId: 'proj_000000000001',
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
        { proj_000000000001: 'user-my-app' },
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
          return Response.json({ workerName: 'user-my-app', deploymentId: 'dpl_active' });
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
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });
  });

  describe('active worker resolution', () => {
    it('resolves every operation so rollback immediately selects the active deployment', async () => {
      const workerNames = ['user-my-app-dpl_new', 'user-my-app-dpl_rollback'];
      const env = createEnv({}, async () =>
        Response.json({ results: [], success: true, meta: {} }),
      );
      env.API.fetch = vi.fn(async () => {
        const workerName = workerNames.shift();
        return Response.json({
          workerName,
          deploymentId: workerName?.split('-').at(-1),
        });
      }) as unknown as typeof env.API.fetch;

      // First call
      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      // A rollback changes the active deployment between operations.
      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 2',
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(env.API.fetch).toHaveBeenCalledTimes(2);
      expect(env.DISPATCH.get).toHaveBeenNthCalledWith(1, 'user-my-app-dpl_new');
      expect(env.DISPATCH.get).toHaveBeenNthCalledWith(2, 'user-my-app-dpl_rollback');
    });
  });

  describe('auth forwarding', () => {
    it('sends x-void-internal header to dispatched worker', async () => {
      let capturedHeaders: Record<string, string> = {};
      const env = createEnv({ proj_000000000001: 'user-my-app' }, async (_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
        return Response.json({ results: [], success: true, meta: {} });
      });

      await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(capturedHeaders['x-void-internal']).toBeDefined();
      expect(capturedHeaders['x-void-internal'].length).toBeGreaterThan(0);
    });
  });
});
