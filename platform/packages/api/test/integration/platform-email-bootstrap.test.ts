import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { emailDomainRoutes, emailOperations } from '../../src/email/connection-schema.ts';
import * as emailConnections from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
});

afterEach(async () => {
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
    EMAIL_SENDER_DOMAIN: 'mail.example.com',
    EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    EMAIL_SHARED_ZONE_ID: 'platform-mail-zone',
    EMAIL_SHARED_INGRESS_NAME: 'void-email-gateway',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ai: true,
      customDomains: false,
      email: true,
      githubActions: false,
      githubOAuth: true,
      googleOAuth: false,
      managedBuilds: false,
      sandbox: false,
    }),
    PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
    PLATFORM_INSTALLATION_ID: 'installation-id',
    PLATFORM_TRAFFIC_STATE: 'staging',
  } as unknown as ApiEnv['Bindings'];
}

function request(token = 'probe-token') {
  return new Request('http://localhost/internal/platform/email-bootstrap', {
    method: 'POST',
    headers: { 'X-Void-Platform-Probe': token },
  });
}

describe('POST /internal/platform/email-bootstrap', () => {
  it('retains the durable operation ID if execution fails after setup was recorded', async () => {
    stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
    });
    vi.spyOn(emailConnections, 'runEmailOperation').mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(503);
    const [operation] = await env.db.select().from(emailOperations);
    expect(operation).toBeDefined();
    expect(await response.json()).toMatchObject({ state: 'failed', operationId: operation!.id });
  });

  it('completes the durable shared route before the installer opens traffic', async () => {
    const cloudflare = stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
    });

    const response = await app.fetch(request(), bindings());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      state: 'ready',
      operationId: expect.any(String),
    });
    expect(callsByTag(cloudflare.calls, 'catchAll')).toHaveLength(1);
    const operation = (await env.db.select().from(emailOperations))[0];
    const route = (
      await env.db
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.id, operation!.route_id!))
    )[0];
    expect(operation?.status).toBe('completed');
    expect(route).toMatchObject({
      addressing: 'shared',
      desired_state: 'active',
      inbound_status: 'ready',
    });
  });

  it('does not let an invalid probe token bypass the lifecycle gate', async () => {
    const response = await app.fetch(request('wrong-token'), bindings());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Platform disabled' });
  });

  it('fails readiness when the durable setup operation is blocked', async () => {
    stubCustomerCf({
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: { 'mail.example.com': ['route1.mx.cloudflare.net'] },
      failOn: { catchAll: { message: 'permission denied', status: 403 } },
    });

    const response = await app.fetch(request(), bindings());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      version: 1,
      state: 'incomplete',
      operationStatus: 'blocked',
    });
  });

  it('resumes the same blocked shared operation after configuration is corrected', async () => {
    const config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = {
      zones: {
        'mail.example.com': {
          id: 'platform-mail-zone',
          name: 'mail.example.com',
          accountId: env.CF_ACCOUNT_ID,
        },
      },
      mx: {},
    };
    const cloudflare = stubCustomerCf(config);

    const blocked = await app.fetch(request(), bindings());
    expect(blocked.status).toBe(503);
    const blockedBody = (await blocked.json()) as Record<string, unknown>;
    expect(blockedBody).toMatchObject({
      version: 1,
      state: 'incomplete',
      operationStatus: 'blocked',
      currentStep: 'inbound_probe',
    });

    config.mx!['mail.example.com'] = ['route1.mx.cloudflare.net'];
    const resumed = await app.fetch(request(), bindings());
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({
      version: 1,
      state: 'ready',
      operationId: blockedBody.operationId,
    });
    expect(callsByTag(cloudflare.calls, 'catchAll')).toHaveLength(1);
    expect(await env.db.select().from(emailOperations)).toHaveLength(1);
  });
});
