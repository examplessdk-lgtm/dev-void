import { describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import { PLATFORM_DISABLED_KEY } from '../../src/platform-lifecycle.ts';

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

function createEnv(
  disabled = false,
  selfHosted = false,
  healthProbeToken?: string,
  trafficState?: string,
): Env {
  const workerFetch = vi.fn(async () => new Response('worker'));
  return {
    ROUTING: {
      get: vi.fn(async (key: string) =>
        key === PLATFORM_DISABLED_KEY
          ? disabled
            ? 'disabled'
            : null
          : JSON.stringify({ workerName: 'user-app', projectId: 'proj_1' }),
      ),
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
    ...(selfHosted ? { PLATFORM_INSTALLATION_ID: 'installation-id' } : {}),
    ...(healthProbeToken ? { PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken } : {}),
    ...(trafficState ? { PLATFORM_TRAFFIC_STATE: trafficState } : {}),
  } as unknown as Env;
}

describe('internal route blocking', () => {
  it('rejects every request while the platform is disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      createEnv(true, true),
      createCtx(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['staging', 'sandbox-drain'])(
    'fails closed in %s even when routing KV is missing the disabled value',
    async (trafficState) => {
      const response = await app.fetch(
        new Request('https://my-app.void.app/normal-path'),
        createEnv(false, true, undefined, trafficState),
        createCtx(),
      );
      expect(response.status).toBe(503);
    },
  );

  it('admits the installer health check during sandbox drain maintenance', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(false, true, 'probe-token', 'sandbox-drain'),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('admits installer health checks while public traffic is disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(true, true, 'probe-token'),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('serves only the authenticated health probe on the platform health hostname', async () => {
    const env = createEnv(false, true, 'probe-token');
    const probe = await app.fetch(
      new Request('https://void-platform-health.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      env,
      createCtx(),
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ok: true });

    // Project Zero Trust leaves this hostname outside Access, so nothing else
    // there may reach project routing, even when a route uses its slug.
    for (const request of [
      new Request('https://void-platform-health.void.app/health'),
      new Request('https://void-platform-health.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'wrong-token' },
      }),
      new Request('https://void-platform-health.void.app/'),
    ]) {
      const response = await app.fetch(request, env, createCtx());
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(env.ROUTING.get).not.toHaveBeenCalled();
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });

  it('rejects the legacy public installer header while disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(true, true, 'probe-token'),
      createCtx(),
    );
    expect(response.status).toBe(503);
  });

  it('preserves the legacy Void Cloud admin health probe', async () => {
    const response = await app.fetch(
      new Request('https://test.void.app/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not add a lifecycle routing read for hosted Void Cloud', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(env.ROUTING.get).toHaveBeenCalledTimes(1);
  });

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
