import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

async function createInstallationClaim(): Promise<void> {
  await env.db.execute(sql`
    CREATE TABLE "__void_platform_installation" (
      "singleton" boolean PRIMARY KEY,
      "installation_id" text NOT NULL
    )
  `);
  await env.db.execute(sql`
    INSERT INTO "__void_platform_installation" ("singleton", "installation_id")
    VALUES (true, 'installation-id')
  `);
}

async function dropInstallationClaim(): Promise<void> {
  await env.db.execute(sql`DROP TABLE "__void_platform_installation"`);
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects health checks while the platform is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const res = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'installation-id',
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Platform disabled' });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('fails closed in staging even when routing KV is missing the disabled value', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      PLATFORM_INSTALLATION_ID: 'installation-id',
      PLATFORM_TRAFFIC_STATE: 'staging',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Platform disabled' });
  });

  it('admits installer health checks while public traffic is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    await createInstallationClaim();
    try {
      const res = await app.fetch(
        new Request('http://localhost/health', {
          headers: { 'X-Void-Platform-Probe': 'probe-token' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await dropInstallationClaim();
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('rejects the legacy public installer header while disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const res = await app.fetch(
        new Request('http://localhost/health', {
          headers: { 'X-Health-Check': 'void-admin' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(res.status).toBe(503);
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('does not read the lifecycle gate for hosted Void Cloud', async () => {
    const get = vi.fn(async () => {
      throw new Error('hosted health must not read routing KV');
    });
    const res = await app.fetch(new Request('http://localhost/health'), {
      ...env,
      ROUTING: { ...env.ROUTING, get } as typeof env.ROUTING,
    });
    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it('verifies a self-hosted installation through its database claim', async () => {
    await createInstallationClaim();
    try {
      const healthy = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'installation-id',
      });
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ status: 'ok' });

      const wrongDatabase = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'another-installation',
      });
      expect(wrongDatabase.status).toBe(503);
      expect(await wrongDatabase.json()).toEqual({ status: 'unhealthy' });
    } finally {
      await dropInstallationClaim();
    }
  });
});
