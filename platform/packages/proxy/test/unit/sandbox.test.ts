import { describe, it, expect, vi, beforeAll } from 'vite-plus/test';
import worker from '../../src/index.ts';

const JWT_SECRET = 'test-secret-key';

// --- HMAC helper (mirrors the worker's project token signing) ---

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

// --- Mock env factory ---

function createMockKv(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

type AcquireResult = { ok: true } | { ok: false; reason: 'concurrency' };
type RefreshResult = { ok: true } | { ok: false; reason: 'not_held' };

type MockCounterStub = {
  acquire: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function createMockCounter(opts?: {
  acquire?: (sandboxId: string, limit: number) => Promise<AcquireResult> | AcquireResult;
  refresh?: (sandboxId: string) => Promise<RefreshResult> | RefreshResult;
  release?: (sandboxId: string) => Promise<void> | void;
}) {
  const lastIdFromName: { value?: string } = {};
  // One stub object is reused for the whole test — assertions check the
  // `idFromName` value separately.
  const stub: MockCounterStub = {
    acquire: vi.fn(async (sandboxId: string, limit: number): Promise<AcquireResult> =>
      opts?.acquire ? opts.acquire(sandboxId, limit) : { ok: true },
    ),
    refresh: vi.fn(async (sandboxId: string): Promise<RefreshResult> =>
      opts?.refresh ? opts.refresh(sandboxId) : { ok: true },
    ),
    release: vi.fn(async (sandboxId: string) => {
      if (opts?.release) {
        await opts.release(sandboxId);
      }
    }),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => {
      lastIdFromName.value = name;
      return { __id: name };
    }),
    get: vi.fn(() => stub),
  };
  return { namespace, stub, lastIdFromName };
}

function createEnv(opts?: {
  kvData?: Record<string, string>;
  counter?: ReturnType<typeof createMockCounter>;
  capabilities?: Record<string, boolean>;
}) {
  const counter = opts?.counter ?? createMockCounter();
  return {
    AI: {
      run: vi.fn(),
      models: vi.fn(),
      toMarkdown: vi.fn(),
      gateway: vi.fn(),
    },
    JWT_SECRET,
    ROUTING: createMockKv(opts?.kvData),
    CF_ACCOUNT_ID: 'test-account-id',
    CF_API_TOKEN: 'test-api-token',
    API: { fetch: vi.fn(async () => new Response('{}')) },
    DISPATCH: {
      get: vi.fn(() => {
        throw new Error('worker not found');
      }),
    },
    ...(opts?.capabilities ? { PLATFORM_CAPABILITIES: JSON.stringify(opts.capabilities) } : {}),
    SANDBOX_CONCURRENCY_COUNTER: counter.namespace,
  };
}

function post(path: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`https://proxy.void.cloud${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function projectKv(userId: string, plan: string): string {
  return JSON.stringify({ userId, plan });
}

// --- Tests ---

describe('proxy sandbox routes', () => {
  let aiTokens: Record<string, string> = {};

  beforeAll(async () => {
    aiTokens = {
      proj_solo: await signAiToken('proj_solo', JWT_SECRET),
      proj_pro: await signAiToken('proj_pro', JWT_SECRET),
      proj_unknown: await signAiToken('proj_unknown', JWT_SECRET),
    };
  });

  it('returns a clear response when the platform has no sandbox module', async () => {
    const env = createEnv({
      capabilities: { sandbox: false },
      kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
    });
    const res = await worker.fetch(
      post('/sandbox/acquire', {
        sandboxId: 'sb-1',
        projectId: 'proj_solo',
        aiToken: aiTokens.proj_solo,
      }),
      env,
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ capability: 'sandbox' });
  });

  describe('POST /sandbox/acquire', () => {
    it('returns 200 with empty body when under the plan limit', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(counter.namespace.idFromName).toHaveBeenCalledWith('account:user_solo');
      // solo plan = 2 concurrent sandboxes
      expect(counter.stub.acquire).toHaveBeenCalledWith('sb-1', 2);
    });

    it('returns 409 {reason:"concurrency"} when DO reports concurrency cap reached', async () => {
      const counter = createMockCounter({
        acquire: async () => ({ ok: false, reason: 'concurrency' }),
      });
      const env = createEnv({
        kvData: { 'project:proj_pro': projectKv('user_pro', 'pro') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-2',
          projectId: 'proj_pro',
          aiToken: aiTokens.proj_pro,
        }),
        env,
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ reason: 'concurrency' });
      // pro plan = 10 concurrent sandboxes
      expect(counter.stub.acquire).toHaveBeenCalledWith('sb-2', 10);
    });

    it('returns 409 {reason:"runtime_budget"} when sandbox-block KV key is set (before DO call)', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: {
          'project:proj_solo': projectKv('user_solo', 'solo'),
          'sandbox-block:user_solo': '1',
        },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-3',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ reason: 'runtime_budget' });
      // KV check must short-circuit before the DO RPC.
      expect(counter.stub.acquire).not.toHaveBeenCalled();
    });

    it('returns 403 when HMAC token is missing or wrong (auth middleware rejects)', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-x',
          projectId: 'proj_solo',
          aiToken: 'not-a-real-token',
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(counter.stub.acquire).not.toHaveBeenCalled();
    });

    it('returns 400 when HMAC token is missing entirely', async () => {
      const counter = createMockCounter();
      const env = createEnv({ counter });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-x',
          projectId: 'proj_solo',
          // no aiToken
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(counter.stub.acquire).not.toHaveBeenCalled();
    });

    it('returns 404 when project:{id} routing KV entry is missing', async () => {
      const counter = createMockCounter();
      const env = createEnv({ counter });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-1',
          projectId: 'proj_unknown',
          aiToken: aiTokens.proj_unknown,
        }),
        env,
      );

      expect(res.status).toBe(404);
      expect(counter.stub.acquire).not.toHaveBeenCalled();
    });

    it('returns 400 when sandboxId is missing from the body', async () => {
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'sandboxId required' });
    });

    it('returns 500 when the DO RPC throws (framework fail-open kicks in)', async () => {
      const counter = createMockCounter({
        acquire: async () => {
          throw new Error('do unavailable');
        },
      });
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/acquire', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(500);
    });
  });

  describe('POST /sandbox/refresh', () => {
    it('returns 200 with DO response and calls refresh on the DO', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/refresh', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(counter.namespace.idFromName).toHaveBeenCalledWith('account:user_solo');
      expect(counter.stub.refresh).toHaveBeenCalledWith('sb-1');
    });

    it('relays {ok:false, reason:"not_held"} when the DO reports the slot was missing', async () => {
      const counter = createMockCounter({
        refresh: async () => ({ ok: false, reason: 'not_held' }),
      });
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/refresh', {
          sandboxId: 'sb-ghost',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: 'not_held' });
    });

    it('returns 204 no-op when project entry is missing (KV propagation miss)', async () => {
      const counter = createMockCounter();
      const env = createEnv({ counter });

      const res = await worker.fetch(
        post('/sandbox/refresh', {
          sandboxId: 'sb-1',
          projectId: 'proj_unknown',
          aiToken: aiTokens.proj_unknown,
        }),
        env,
      );

      expect(res.status).toBe(204);
      expect(counter.stub.refresh).not.toHaveBeenCalled();
    });

    it('returns 400 when sandboxId is missing', async () => {
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
      });

      const res = await worker.fetch(
        post('/sandbox/refresh', {
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'sandboxId required' });
    });
  });

  describe('POST /sandbox/release', () => {
    it('returns 204 and calls release on the DO', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const res = await worker.fetch(
        post('/sandbox/release', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(counter.namespace.idFromName).toHaveBeenCalledWith('account:user_solo');
      expect(counter.stub.release).toHaveBeenCalledWith('sb-1');
    });

    it('is idempotent — second release call still returns 204', async () => {
      const counter = createMockCounter();
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
        counter,
      });

      const first = await worker.fetch(
        post('/sandbox/release', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );
      const second = await worker.fetch(
        post('/sandbox/release', {
          sandboxId: 'sb-1',
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      expect(counter.stub.release).toHaveBeenCalledTimes(2);
    });

    it('returns 204 (no-op) when project entry is missing', async () => {
      const counter = createMockCounter();
      const env = createEnv({ counter });

      const res = await worker.fetch(
        post('/sandbox/release', {
          sandboxId: 'sb-1',
          projectId: 'proj_unknown',
          aiToken: aiTokens.proj_unknown,
        }),
        env,
      );

      expect(res.status).toBe(204);
      expect(counter.stub.release).not.toHaveBeenCalled();
    });

    it('returns 400 when sandboxId is missing', async () => {
      const env = createEnv({
        kvData: { 'project:proj_solo': projectKv('user_solo', 'solo') },
      });

      const res = await worker.fetch(
        post('/sandbox/release', {
          projectId: 'proj_solo',
          aiToken: aiTokens.proj_solo,
        }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });
});
