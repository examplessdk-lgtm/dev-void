/**
 * Tests for the custom sender domain fork of POST /email/send (design doc
 * 0078, "Custom domains on Cloudflare").
 *
 * A `from` whose domain is NOT `EMAIL_SENDER_DOMAIN` belongs to a
 * registered `email_domains` row. The proxy reads the `email-domain:<d>`
 * KV mirror (its only view of the row), leases a credential from the api
 * (`email-lease.ts`, contract 4), and delivers through the CUSTOMER's
 * account via Email Sending's `send_raw` — never through the platform's
 * `send_email` binding. Platform quota, kill-switch and suspension gates
 * run unchanged and BEFORE the external call.
 *
 * Harness mirrors `email.test.ts`: the real worker entry, an in-memory KV
 * mock, `env.API.fetch` as the lease endpoint, and a stubbed global
 * `fetch` as `api.cloudflare.com`. The leased credential below is a dummy
 * fixture string, never a real token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `cloudflare:email` is a workerd built-in with no npm shim — same mock as
// email.test.ts, hoisted above the worker import.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: unknown,
    ) {}
  },
}));

const worker = (await import('../../src/index.ts')).default;

const JWT_SECRET = 'test-secret-key';
const PROD_DOMAIN = 'mail.void.cloud';
const CUSTOM_DOMAIN = 'acme.com';
const CUSTOM_FROM = `support@${CUSTOM_DOMAIN}`;
/** Dummy fixture value for the leased credential — not a real token. */
const LEASED = 'leased-credential-fixture-value';

// --- HMAC helper (mirrors the worker's project token signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signHmac(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64urlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))),
  );
}

// --- Mocks ---

type MockKv = ReturnType<typeof createMockKv>;

function createMockKv(data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data));
  return {
    store,
    get: vi.fn(async (key: string, _options?: unknown) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _options?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createMockEnv(kv: MockKv) {
  const actions = new Map<
    string,
    {
      operationId: string;
      digest: string;
      recipients: Array<{
        recipient: string;
        state: string;
        errorCode: string | null;
        providerReference: string | null;
      }>;
    }
  >();
  const apiFetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/domain-credential')) {
      return Response.json({ kind: 'api_token', token: LEASED, accountId: 'acct_customer' });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path.endsWith('/admit')) {
      const key = body.key as string;
      const previous = actions.get(key);
      if (previous && previous.digest !== body.digest) {
        return Response.json({ code: 'CONFLICT' }, { status: 409 });
      }
      if (previous) {
        return Response.json({
          operationId: previous.operationId,
          replay: true,
          recipients: previous.recipients,
          accountId: 'acct_customer',
        });
      }
      const entry = {
        operationId: `act_${actions.size + 1}`,
        digest: body.digest as string,
        recipients: (body.recipients as Array<string>).map((recipient) => ({
          recipient,
          state: 'reserved',
          errorCode: null,
          providerReference: null,
        })),
      };
      actions.set(key, entry);
      return Response.json({
        operationId: entry.operationId,
        replay: false,
        recipients: entry.recipients,
        accountId: 'acct_customer',
      });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((action) => action.operationId === operationId)!;
    if (path.endsWith('/start')) {
      for (const recipient of body.recipients as Array<string>) {
        entry.recipients.find((row) => row.recipient === recipient)!.state = 'attempt_started';
      }
    }
    if (path.endsWith('/finish')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((item) => item.recipient === recipient)!;
        row.state = body.state as string;
        row.errorCode = (body.errorCode as string) ?? null;
        row.providerReference = (body.providerReference as string) ?? null;
      }
    }
    return Response.json({ recipients: entry.recipients });
  });
  const sendEmail = vi.fn(async () => ({ messageId: 'msg_platform' }));
  const env = {
    AI: {},
    JWT_SECRET,
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: apiFetch },
    DISPATCH: { get: vi.fn(() => ({ email: vi.fn(async () => []) })) },
    SANDBOX_CONCURRENCY_COUNTER: {},
    SEND_EMAIL: { send: sendEmail },
    EMAIL_SENDER_DOMAIN: PROD_DOMAIN,
  };
  return { env, apiFetch, sendEmail };
}

/** The mirror the api writes to ROUTING KV; sha field is a placeholder hex string. */
function domainMirror(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    projectId: 'proj_1',
    status: 'active',
    relaySecretSha256: '00'.repeat(32),
    relayWorkerName: 'void-email-relay',
    accountId: 'acct_customer',
    zoneId: 'zone_1',
    mode: 'subdomain',
    ...overrides,
  });
}

/** KV contents that let `proj_1` send from `support@acme.com`. */
function customDomainKv(extra: Record<string, string> = {}) {
  return createMockKv({
    'email-slug:proj_1': 'acme',
    [`email-domain:${CUSTOM_DOMAIN}`]: domainMirror(),
    ...extra,
  });
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function mimeBase64(body = `From: ${CUSTOM_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`): string {
  return base64Of(new TextEncoder().encode(body));
}

async function postSend(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Response> {
  return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
    new Request('https://proxy.void.cloud/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj_1',
    aiToken: await signHmac('proj_1', JWT_SECRET),
    from: CUSTOM_FROM,
    recipients: ['dev@example.com'],
    mimeBase64: mimeBase64(),
    requestId: 'req_1',
    ...overrides,
  };
}

/** A stubbed `api.cloudflare.com` that records calls; 200 success by default. */
function stubCloudflare(handler?: (call: { url: string; init: RequestInit }) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (handler) {
        return handler({ url, init });
      }
      // The real send_raw result: snake_case `message_id`, and per-recipient
      // lists (`delivered` echoes the accepted recipients here).
      const recipients =
        (JSON.parse(init.body as string) as { recipients?: Array<string> }).recipients ?? [];
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            message_id: 'cf_msg_1',
            delivered: recipients,
            permanent_bounces: [],
            queued: [],
            suppressed_recipients: [],
          },
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

function kvKeysMatching(kv: MockKv, prefix: string): Array<string> {
  return [...kv.store.keys()].filter((k) => k.startsWith(prefix));
}

beforeEach(() => {
  // The lease cache is module-level — isolate every test from its neighbours.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('POST /email/send — custom sender domain', () => {
  it('leases a credential and delivers through the customer account via send_raw', async () => {
    const kv = customDomainKv();
    const { env, apiFetch, sendEmail } = createMockEnv(kv);
    const calls = stubCloudflare();
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_1' }],
      operationId: 'act_1',
    });

    // The lease: one POST to the api's internal endpoint, HMAC-authed.
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(1);
    const [leaseUrl, leaseInit] = apiFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/domain-credential'),
    )! as [string, RequestInit];
    expect(leaseUrl).toBe('https://api/internal/email/domain-credential');
    expect(leaseInit.method).toBe('POST');
    expect(JSON.parse(leaseInit.body as string)).toEqual({
      domain: CUSTOM_DOMAIN,
      projectId: 'proj_1',
    });
    const leaseHeaders = new Headers(leaseInit.headers);
    expect(leaseHeaders.get('x-void-internal')).toBe(
      await signHmac(`email-lease-v1\nproj_1\n${CUSTOM_DOMAIN}`, JWT_SECRET),
    );

    // The delivery: one POST to the CUSTOMER account's send_raw, leased
    // credential as Bearer, envelope + MIME in the JSON body.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_customer/email/sending/send_raw',
    );
    const sendHeaders = new Headers(calls[0]?.init.headers);
    expect(sendHeaders.get('authorization')).toBe(`Bearer ${LEASED}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      from: CUSTOM_FROM,
      recipients: ['dev@example.com'],
      mime_message: `From: ${CUSTOM_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`,
    });

    // The platform binding is never touched on this path.
    expect(sendEmail).not.toHaveBeenCalled();

    expect(kvKeysMatching(kv, 'email-sent:proj_1:')).toHaveLength(0);
    expect(kvKeysMatching(kv, 'email-burst:proj_1:')).toHaveLength(0);
  });

  it('re-leases the domain for each send', async () => {
    const kv = customDomainKv();
    const { env, apiFetch } = createMockEnv(kv);
    stubCloudflare();
    await postSend(env, await sendBody());
    await postSend(env, await sendBody({ requestId: 'req_2' }));
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(2);
  });

  it('replays a completed operation without consulting a later revoked credential', async () => {
    const { env, apiFetch } = createMockEnv(customDomainKv());
    const calls = stubCloudflare();
    const body = await sendBody({ idempotencyKey: 'same-operation' });
    expect((await (await postSend(env, body)).json()).ok).toBe(true);
    const leaseCalls = apiFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/domain-credential'),
    ).length;
    const replay = await postSend(env, body);
    expect((await replay.json()).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(leaseCalls);
  });

  it('re-leases after a definitive 401 from send_raw', async () => {
    const kv = customDomainKv();
    const { env, apiFetch } = createMockEnv(kv);
    let sendCount = 0;
    stubCloudflare(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return new Response('nope', { status: 401 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            message_id: 'cf_msg_2',
            delivered: ['dev@example.com'],
            permanent_bounces: [],
            queued: [],
            suppressed_recipients: [],
          },
        }),
        {
          status: 200,
        },
      );
    });
    const first = await postSend(env, await sendBody());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: { code: 'UPSTREAM_ERROR', message: 'email sending API returned 401' },
        },
      ],
    });
    // The refusal evicted the lease — the next send re-leases and succeeds.
    const second = await postSend(env, await sendBody({ requestId: 'req_2' }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_2' }],
      operationId: 'act_2',
    });
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(2);
  });

  it('maps a 429 from send_raw to QUOTA_EXCEEDED', async () => {
    const kv = customDomainKv();
    const { env } = createMockEnv(kv);
    stubCloudflare(() => new Response('slow down', { status: 429 }));
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.deliveries[0].error.code).toBe('QUOTA_EXCEEDED');
  });

  it('marks a network failure on send_raw as an unknown outcome', async () => {
    const kv = customDomainKv();
    const { env } = createMockEnv(kv);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hangup');
      }),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.deliveries[0].error).toEqual({
      code: 'OUTCOME_UNKNOWN',
      message: 'provider outcome unknown; inspect email logs before retrying',
    });
  });

  it('sends with a stale KV domain mirror when PostgreSQL lease and admission agree', async () => {
    const kv = customDomainKv({
      [`email-domain:${CUSTOM_DOMAIN}`]: domainMirror({
        projectId: 'p_other',
        status: 'pending',
        accountId: null,
      }),
    });
    const { env } = createMockEnv(kv);
    const calls = stubCloudflare();
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('answers 502 when the lease fails, without burning quota or calling send_raw', async () => {
    const kv = customDomainKv();
    const { env, apiFetch } = createMockEnv(kv);
    const normalFetch = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/domain-credential')
        ? new Response('denied', { status: 403 })
        : normalFetch(url, init),
    );
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toEqual({
      code: 'UPSTREAM_ERROR',
      message: 'could not lease the domain credential',
    });
    expect(cfFetch).not.toHaveBeenCalled();
    expect(kvKeysMatching(kv, 'email-sent:proj_1:')).toHaveLength(0);
    expect(kvKeysMatching(kv, 'email-burst:proj_1:')).toHaveLength(0);
  });

  it('pins the MIME From to the envelope sender on the custom domain too', async () => {
    const kv = customDomainKv();
    const { env, apiFetch } = createMockEnv(kv);
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const res = await postSend(
      env,
      await sendBody({ mimeBase64: mimeBase64(`From: other@${CUSTOM_DOMAIN}\r\n\r\nx\r\n`) }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FROM');
    expect(body.error.message).toContain('mime From must be the envelope sender');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(cfFetch).not.toHaveBeenCalled();
  });

  it('refuses MIME that is not valid UTF-8 before leasing or burning quota', async () => {
    const kv = customDomainKv();
    const { env, apiFetch } = createMockEnv(kv);
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const prefix = new TextEncoder().encode(`From: ${CUSTOM_FROM}\r\n\r\n`);
    const bytes = new Uint8Array(prefix.length + 2);
    bytes.set(prefix);
    bytes.set([0xff, 0xfe], prefix.length);
    const res = await postSend(env, await sendBody({ mimeBase64: base64Of(bytes) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      code: 'MIME_ERROR',
      message: 'mime must be valid UTF-8',
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(cfFetch).not.toHaveBeenCalled();
    expect(kvKeysMatching(kv, 'email-sent:proj_1:')).toHaveLength(0);
  });

  it('reports a permanently bounced recipient as failed, not sent', async () => {
    const kv = customDomainKv();
    const { env } = createMockEnv(kv);
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_b',
              delivered: [],
              permanent_bounces: ['dev@example.com'],
              queued: [],
              suppressed_recipients: [],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'dev@example.com' permanently bounced",
          },
        },
      ],
    });
  });

  it('reports a suppressed recipient as failed, not sent', async () => {
    const kv = customDomainKv();
    const { env } = createMockEnv(kv);
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_s',
              delivered: [],
              permanent_bounces: [],
              queued: [],
              suppressed_recipients: ['dev@example.com'],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'dev@example.com' is on the suppression list",
          },
        },
      ],
    });
  });

  it('splits a mixed batch: delivered recipients keep the id, bounced ones fail', async () => {
    const kv = customDomainKv();
    const { env } = createMockEnv(kv);
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_m',
              delivered: ['dev@example.com'],
              permanent_bounces: ['gone@example.com'],
              queued: [],
              suppressed_recipients: [],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(
      env,
      await sendBody({ recipients: ['dev@example.com', 'gone@example.com'] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: true,
          state: 'provider_accepted',
          messageId: 'cf_msg_m',
        },
        {
          recipient: 'gone@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'gone@example.com' permanently bounced",
          },
        },
      ],
    });
  });
});
