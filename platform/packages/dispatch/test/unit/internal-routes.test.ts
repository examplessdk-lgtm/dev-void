import { describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';

vi.stubGlobal('caches', {
  default: {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  },
});

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function createEnv(): Env {
  const workerFetch = vi.fn(async () => new Response('worker'));
  return {
    ROUTING: {
      get: async () => JSON.stringify({ workerName: 'user-app', projectId: 'proj_1' }),
    },
    DISPATCH: {
      get: vi.fn(() => ({ fetch: workerFetch })),
    },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async () => {},
      delete: async () => {},
    },
    ANALYTICS: {
      writeDataPoint: vi.fn(),
    },
  } as unknown as Env;
}

describe('internal route blocking', () => {
  it('blocks POST /__void/migrate with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/migrate', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks GET /__void/ready with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/ready', { method: 'GET' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__void/scheduled with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/scheduled', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__void/queue with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/queue', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  // Legacy: old SDK versions register these top-level paths.
  // TODO: remove these blocks once all deployed workers use /__void/* paths. See #88
  it('blocks /__scheduled (legacy compat) with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__scheduled', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__queue (legacy compat) with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__queue', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('does not block /__nuxt_content paths (framework assets)', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/__nuxt_content/articles/query'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });

  it('does not block /__og-image__ paths (framework assets)', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/__og-image__/static/og.png'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });

  it('does not block normal paths', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });
});
