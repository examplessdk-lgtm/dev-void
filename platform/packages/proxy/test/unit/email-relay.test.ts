/**
 * Tests for POST /email/relay — the inbound hop for custom sender domains
 * (design doc 0078, "Custom domains on Cloudflare").
 *
 * A relay worker in the CUSTOMER's Cloudflare account streams the raw MIME
 * here with the envelope in headers; the auth branch in the proxy's global
 * middleware (index.ts) bounds the inputs before any crypto, proves the
 * relay secret against the domain's KV mirror, and resolves the project.
 * The handler (email-relay.ts) builds the EmailEnvelope and runs the second
 * half of routeInbound — `routeRelayed` — for the mirror's project.
 *
 * The relay worker answers any non-2xx with `message.setReject`, so every
 * refusal below asserts a non-2xx status. Patterns mirror `email.test.ts`:
 * the real worker entry, an in-memory KV mock, and a vi.fn'd dispatch stub.
 * The secret and checksums below are dummy fixture values, never real
 * credentials.
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
const { MAX_MIME_BYTES } = await import('../../src/email.ts');
const { clearEmailDomainLeaseCache } = await import('../../src/email-lease.ts');

const JWT_SECRET = 'test-secret-key';
const PROD_DOMAIN = 'mail.void.cloud';

/** Dummy fixture secret; the mirror only ever holds its sha256. */
const RELAY_SECRET = 'dGVzdC1yZWxheS1zZWNyZXQtZml4dHVyZS12YWx1ZS0xMjM';
/** Dummy fixture value for the leased credential — not a real token. */
const LEASED = 'leased-credential-fixture-value';

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  let hex = '';
  for (const b of digest) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

const MIME =
  'From: sender@example.com\r\nTo: support+T-42@acme.com\r\nSubject: hi\r\n\r\nhello\r\n';

// -----------------------------------------------------------------------
// Mocks — same shapes as email.test.ts / email-router.test.ts.
// -----------------------------------------------------------------------

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

type MockKv = ReturnType<typeof createMockKv>;

interface MakeEnvOptions {
  emailReturn?: unknown;
  emailThrow?: unknown;
  capabilities?: string;
}

function createMockEnv(kv: MockKv, options: MakeEnvOptions = {}) {
  const emailFn = vi.fn(async (_envelope: unknown) => {
    if (options.emailThrow) {
      throw options.emailThrow;
    }
    return options.emailReturn;
  });
  const dispatchGet = vi.fn((_name: string, _args?: unknown, _opts?: unknown) => ({
    email: emailFn,
  }));
  const env = {
    AI: {},
    JWT_SECRET,
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: vi.fn() },
    DISPATCH: { get: dispatchGet },
    SANDBOX_CONCURRENCY_COUNTER: {},
    SEND_EMAIL: { send: vi.fn(async () => ({ messageId: 'msg_1' })) },
    EMAIL_SENDER_DOMAIN: PROD_DOMAIN,
    ...(options.capabilities ? { PLATFORM_CAPABILITIES: options.capabilities } : {}),
  };
  return { env, emailFn, dispatchGet };
}

/** The standard fixture set: active mirror for acme.com + routing for p_test. */
async function relayKv(extra: Record<string, string> = {}): Promise<MockKv> {
  const mirror = {
    projectId: 'p_test',
    status: 'active',
    relaySecretSha256: await sha256Hex(RELAY_SECRET),
    relayWorkerName: 'void-email-relay',
    accountId: 'acct_customer',
    zoneId: 'zone_1',
    mode: 'subdomain',
  };
  return createMockKv({
    'email-domain:acme.com': JSON.stringify(mirror),
    'email-slug:p_test': 'myslug',
    myslug: JSON.stringify({ workerName: 'user-worker', projectId: 'p_test' }),
    ...extra,
  });
}

interface RelayOptions {
  /** Full Authorization header value; `null` omits it. Default: the fixture bearer. */
  auth?: string | null;
  domain?: string;
  from?: string;
  to?: string;
  mime?: string;
  /** 'omit' sends a stream body without a content-length; any other string is set verbatim. */
  contentLength?: 'omit' | string;
  /** Raw bytes override (for the over-cap case). */
  body?: Uint8Array;
}

function postRelay(env: Record<string, unknown>, opts: RelayOptions = {}): Promise<Response> {
  const bytes = opts.body ?? new TextEncoder().encode(opts.mime ?? MIME);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-void-email-domain': opts.domain ?? 'acme.com',
    'x-void-email-from': opts.from ?? 'sender@example.com',
    'x-void-email-to': opts.to ?? 'support+T-42@acme.com',
  };
  const auth = opts.auth === undefined ? `Bearer ${RELAY_SECRET}` : opts.auth;
  if (auth !== null) {
    headers.authorization = auth;
  }
  let body: BodyInit = bytes;
  if (opts.contentLength === 'omit') {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  } else {
    // undici's Request constructor never derives a content-length, not even
    // for a fixed-size body — the relay contract requires one, so the test
    // client sets it explicitly (and a stream keeps it verbatim, which lets
    // the "lying length" case through).
    headers['content-length'] =
      typeof opts.contentLength === 'string' ? opts.contentLength : String(bytes.byteLength);
    if (typeof opts.contentLength === 'string') {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
  }
  const init = {
    method: 'POST',
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit;
  return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
    new Request('https://proxy.void.cloud/email/relay', init),
    env,
  );
}

// -----------------------------------------------------------------------
// Console spies — the relay lane logs its refusal detail; tests keep it
// off the test output and can assert on it.
// -----------------------------------------------------------------------

beforeEach(() => {
  // The lease cache is module-level — isolate every test from its neighbours.
  clearEmailDomainLeaseCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------
// Relay-lane sends go through the CUSTOMER's account as REST send_raw with
// the domain's leased credential (design doc 0078, "Inbound identity") —
// the platform's own send_email binding rejects a sender outside its
// verified zones. This helper wires both halves of that path: env.API.fetch
// answers the lease, and the stubbed global fetch is api.cloudflare.com.
// -----------------------------------------------------------------------

function stubRelayRest(
  env: { API: { fetch: ReturnType<typeof vi.fn> } },
  handler?: (call: { url: string; init: RequestInit }) => Response,
) {
  env.API.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ kind: 'api_token', token: LEASED }), { status: 200 }),
  );
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (handler) {
        return handler({ url, init });
      }
      const recipients =
        (JSON.parse(init.body as string) as { recipients?: Array<string> }).recipients ?? [];
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            message_id: 'cf_msg_relay',
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

// -----------------------------------------------------------------------
// The auth branch (index.ts)
// -----------------------------------------------------------------------

describe('POST /email/relay — auth branch', () => {
  it('rejects a bad relay secret with 403 before any dispatch', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { auth: 'Bearer wrong-secret' });
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header with 400', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { auth: null });
    expect(res.status).toBe(400);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization scheme with 403', async () => {
    const kv = await relayKv();
    const { env } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { auth: `token ${RELAY_SECRET}` });
    expect(res.status).toBe(403);
  });

  it.each([
    ['X-Void-Email-Domain', { domain: `${'a'.repeat(257)}` }],
    ['X-Void-Email-From', { from: `s${'a'.repeat(256)}@x.com` }],
    ['X-Void-Email-To', { to: `s${'a'.repeat(256)}@acme.com` }],
    ['Authorization', { auth: `Bearer ${'a'.repeat(300)}` }],
  ])('rejects an overlong %s header before any KV read', async (_name, overrides) => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, overrides);
    expect(res.status).toBe(400);
    // The size bound runs before the mirror lookup and before any crypto:
    // KV was never touched.
    expect(kv.get).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects when no mirror exists for the domain', async () => {
    const kv = await relayKv();
    kv.store.delete('email-domain:acme.com');
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a declared domain that does not match the envelope recipient domain', async () => {
    // A catch-all rule can be zone-wide: mail for a DIFFERENT domain on
    // the same zone can arrive via this relay, and its secret must not
    // author it. Attribution binds to the recipient, never the claim.
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { domain: 'acme.com', to: 'user@other-acme.com' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'relay domain mismatch' });
    // The cheap string check runs before the mirror lookup and any crypto.
    expect(kv.get).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a recipient with no domain part', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { to: 'not-an-address' });
    expect(res.status).toBe(403);
    expect(kv.get).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('matches the declared and recipient domains case-insensitively', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { domain: 'ACME.COM', to: 'Support+T-42@Acme.COM' });
    expect(res.status).toBe(200);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'token_revoked', 'token_expired', 'failed'])(
    'rejects a mirror whose status is %s',
    async (status) => {
      const kv = await relayKv();
      const mirror = JSON.parse(kv.store.get('email-domain:acme.com')!) as Record<string, unknown>;
      mirror.status = status;
      kv.store.set('email-domain:acme.com', JSON.stringify(mirror));
      const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
      const res = await postRelay(env as never);
      expect(res.status).toBe(403);
      expect(emailFn).not.toHaveBeenCalled();
    },
  );

  it('rejects a request without a content-length', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, { contentLength: 'omit' });
    expect(res.status).toBe(400);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a declared body over the MIME cap before reading it', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, {
      body: new Uint8Array(MAX_MIME_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects a body that outgrows the cap mid-stream (declared length lied)', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never, {
      body: new Uint8Array(MAX_MIME_BYTES + 1),
      contentLength: '100',
    });
    expect(res.status).toBe(413);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('is covered by the email capability gate', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, {
      emailReturn: [],
      capabilities: JSON.stringify({ email: false }),
    });
    const res = await postRelay(env as never);
    expect(res.status).toBe(501);
    expect(emailFn).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// The handler (email-relay.ts) + routeRelayed (email-router.ts)
// -----------------------------------------------------------------------

describe('POST /email/relay — dispatch', () => {
  it('dispatches the relayed message to the project worker and answers 200', async () => {
    const kv = await relayKv();
    const { env, emailFn, dispatchGet } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatchGet).toHaveBeenCalledWith('user-worker');
    expect(emailFn).toHaveBeenCalledTimes(1);

    // The envelope is built from the header envelope + body, with
    // viaDomain set so the framework dispatcher runs in no-prefix mode.
    const envelope = emailFn.mock.calls[0]?.[0] as {
      from: string;
      to: string;
      headers: Record<string, string>;
      raw: Uint8Array;
      rawSize: number;
      viaDomain?: string;
    };
    expect(envelope.from).toBe('sender@example.com');
    expect(envelope.to).toBe('support+T-42@acme.com');
    expect(envelope.viaDomain).toBe('acme.com');
    expect(envelope.headers.subject).toBe('hi');
    expect(envelope.raw).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(envelope.raw)).toBe(MIME);
    expect(envelope.rawSize).toBe(new TextEncoder().encode(MIME).byteLength);

    // The delivery is metered like a platform-lane one: the recv counter
    // is written before the response settles (the test's fallback ctx
    // flushes waitUntil work).
    const recvPuts = kv.put.mock.calls.filter((call) =>
      String(call[0]).startsWith('email-recv:p_test:'),
    );
    expect(recvPuts).toHaveLength(1);
  });

  it('parses folded and duplicated MIME headers into the envelope', async () => {
    const kv = await relayKv();
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const mime =
      'From: sender@example.com\r\n' +
      'Received: first\r\n' +
      'X-Custom: one\r\n\ttwo\r\n' +
      'Received: second\r\n' +
      'Subject: folded\r\n\r\nbody\r\n';
    const res = await postRelay(env as never, { mime });
    expect(res.status).toBe(200);
    const envelope = emailFn.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(envelope.headers['x-custom']).toBe('one two');
    // Duplicates fold with ", ", matching workerd's Headers on the platform lane.
    expect(envelope.headers.received).toBe('first, second');
  });

  it('a handler reject action answers non-2xx so the relay setRejects', async () => {
    const kv = await relayKv();
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'reject', reason: 'not for us' }],
    });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
  });

  it('a dispatch failure answers non-2xx (the relay setRejects)', async () => {
    const kv = await relayKv();
    const { env } = createMockEnv(kv, { emailThrow: new Error('boom') });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
  });

  it('rejects when the project has no email handler (RPC method missing)', async () => {
    const kv = await relayKv();
    const { env } = createMockEnv(kv, {
      emailThrow: new TypeError('The RPC receiver does not implement the method "email"'),
    });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
  });

  it('enacts an allowlisted forward through the customer account via send_raw', async () => {
    const kv = await relayKv({
      'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
    });
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const calls = stubRelayRest(env as never);
    const res = await postRelay(env as never);
    expect(res.status).toBe(200);

    // The platform's own binding cannot carry a customer-domain send —
    // Email Service rejects a sender outside its verified zones.
    expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();

    // One REST send_raw to the CUSTOMER account, leased credential as
    // Bearer, original sender + original MIME bytes preserved.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_customer/email/sending/send_raw',
    );
    const sendHeaders = new Headers(calls[0]?.init.headers);
    expect(sendHeaders.get('authorization')).toBe(`Bearer ${LEASED}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      from: 'sender@example.com',
      recipients: ['admin@example.com'],
      mime_message: MIME,
    });
  });

  it('drops a forward to a non-allowlisted address but still accepts the message', async () => {
    const kv = await relayKv({
      'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
    });
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'forward', to: 'stranger@example.net' }],
    });
    const calls = stubRelayRest(env as never);
    const res = await postRelay(env as never);
    expect(res.status).toBe(200);
    expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(env.API.fetch).not.toHaveBeenCalled();
  });

  it('enacts a reply from an address on the relayed domain via send_raw (registered-domain pin)', async () => {
    const kv = await relayKv({
      'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
    });
    const replyFrom = 'support@acme.com';
    const replyMime = `From: ${replyFrom}\r\n\r\nreply body\r\n`;
    const replyRaw = new TextEncoder().encode(replyMime);
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'reply', from: replyFrom, to: 'admin@example.com', raw: replyRaw }],
    });
    const calls = stubRelayRest(env as never);
    const res = await postRelay(env as never);
    expect(res.status).toBe(200);
    expect(env.SEND_EMAIL.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_customer/email/sending/send_raw',
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      from: replyFrom,
      recipients: ['admin@example.com'],
      mime_message: replyMime,
    });
  });

  it('a failed relayed send is logged like the platform lane and the message stays accepted', async () => {
    const kv = await relayKv({
      'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
    });
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    // send_raw reports the one recipient as permanently bounced: success
    // at the envelope level, a permanent per-recipient failure in result.
    stubRelayRest(
      env as never,
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_relay',
              delivered: [],
              permanent_bounces: ['admin@example.com'],
              queued: [],
              suppressed_recipients: [],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postRelay(env as never);
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalled();
  });

  it('evicts the leased credential when send_raw refuses it (401) and re-leases next time', async () => {
    const kv = await relayKv({
      'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
    });
    const { env } = createMockEnv(kv, {
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    stubRelayRest(env as never, () => new Response('nope', { status: 401 }));
    const first = await postRelay(env as never);
    // The action failure is logged; the message itself stays accepted,
    // exactly as a failed native forward does on the platform lane.
    expect(first.status).toBe(200);
    expect(env.API.fetch).toHaveBeenCalledTimes(1);

    // The refusal evicted the cached lease — the next relayed send
    // re-leases instead of replaying the refused credential.
    stubRelayRest(env as never);
    const second = await postRelay(env as never);
    expect(second.status).toBe(200);
    expect(env.API.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects when the project routing is suspended', async () => {
    const kv = await relayKv({
      myslug: JSON.stringify({
        workerName: 'user-worker',
        projectId: 'p_test',
        suspended: 'abuse',
      }),
    });
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects when the project email kill-switch is set', async () => {
    const kv = await relayKv({ 'email-suspended:p_test': '2026-09-16T00:00:00Z' });
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects when the routing blob belongs to another project', async () => {
    const kv = await relayKv({
      myslug: JSON.stringify({ workerName: 'user-worker', projectId: 'p_other' }),
    });
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects when the project has no slug mirror', async () => {
    const kv = await relayKv();
    kv.store.delete('email-slug:p_test');
    const { env, emailFn } = createMockEnv(kv, { emailReturn: [] });
    const res = await postRelay(env as never);
    expect(res.status).toBe(403);
    expect(emailFn).not.toHaveBeenCalled();
  });
});
