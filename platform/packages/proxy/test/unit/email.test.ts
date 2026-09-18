import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `cloudflare:email` is a workerd built-in with no npm shim. The root
// vite.config.ts aliases `cloudflare:workers` to a stub for the same reason;
// until it does the same for `cloudflare:email`, this file registers its own
// mock (vi.mock is hoisted above the import below).
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
const { readMimeFromAddrSpec } = await import('../../src/email.ts');
// The framework's own MIME builder — the ONLY legitimate producer of the
// `mimeBase64` a tenant posts — so the proxy's From pin is checked against
// every `From:` shape it really renders, not against hand-typed lookalikes.
const { buildMime, normalizeEmail } =
  await import('../../../../../packages/void/src/runtime/email/mime.ts');

const JWT_SECRET = 'test-secret-key';
const PROD_DOMAIN = 'mail.void.cloud';
const STAGING_DOMAIN = 'mail.staging.void.cloud';

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

// --- Mock env ---

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

function createMockEnv(
  kv: MockKv,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    AI: {},
    JWT_SECRET,
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: vi.fn() },
    DISPATCH: { get: vi.fn(() => ({ email: vi.fn(async () => []) })) },
    SEND_EMAIL: { send: vi.fn(async () => ({ messageId: 'msg_1' })) },
    EMAIL_SENDER_DOMAIN: PROD_DOMAIN,
    ...overrides,
  };
}

const DEFAULT_FROM = `acme+noreply@${PROD_DOMAIN}`;

/** The smallest message `/email/send` accepts for `from`: a matching `From:` and a body. */
function mimeFor(from: string, rest = 'Subject: hi\r\n\r\nhello\r\n'): string {
  return `From: ${from}\r\n${rest}`;
}

/** Minimal base64 of an RFC 5322-ish body — content beyond `From:` is irrelevant here. */
function mimeBase64(body = mimeFor(DEFAULT_FROM)): string {
  let binary = '';
  for (const b of new TextEncoder().encode(body)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
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

/**
 * A `/email/send` body that passes every gate for `proj_1` / slug `acme`.
 * The MIME `From:` follows the envelope under test, exactly as the framework
 * renders both from one `from.email`; pass `mimeBase64` to diverge them.
 */
async function sendBody(overrides: Record<string, unknown> = {}) {
  const from = typeof overrides.from === 'string' ? overrides.from : DEFAULT_FROM;
  return {
    projectId: 'proj_1',
    aiToken: await signHmac('proj_1', JWT_SECRET),
    from,
    recipients: ['dev@example.com'],
    mimeBase64: mimeBase64(mimeFor(from)),
    requestId: 'req_1',
    ...overrides,
  };
}

/** KV contents that let `proj_1` send to `dev@example.com`. */
function happyPathKv(extra: Record<string, string> = {}) {
  return createMockKv({
    'email-slug:proj_1': 'acme',
    'email-allowlist:proj_1': JSON.stringify(['dev@example.com']),
    ...extra,
  });
}

// --- Inbound helpers ---

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createInboundMessage(to: string, from = 'sender@example.com') {
  const bytes = new TextEncoder().encode('Subject: hi\r\n\r\nhello\r\n');
  return {
    from,
    to,
    rawSize: bytes.byteLength,
    raw: streamOf(bytes),
    headers: new Headers({ Subject: 'hi' }),
    setReject: vi.fn(),
    forward: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

function createCtx() {
  const pending: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} },
    settle: () => Promise.allSettled(pending),
  };
}

type InboundMessage = ReturnType<typeof createInboundMessage>;

async function routeInboundMessage(
  env: Record<string, unknown>,
  message: InboundMessage,
): Promise<void> {
  const { ctx, settle } = createCtx();
  await (worker.email as (m: unknown, e: unknown, c: unknown) => Promise<void>)(message, env, ctx);
  await settle();
}

// --- wrangler.jsonc ---

/**
 * Strip `//` line comments and trailing commas so JSON.parse can read the
 * JSONC config. String-aware so a `//` inside a value is preserved.
 */
function parseJsonc(source: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      out += '\n';
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

const wranglerConfig = parseJsonc(
  readFileSync(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), 'utf8'),
);

describe('proxy wrangler config', () => {
  // Wrangler does NOT inherit `send_email` or `vars` into a named env, and
  // `deploy` runs `--env production`. A binding declared only at the top
  // level (or only in staging) ships a production proxy where
  // `env.SEND_EMAIL` is undefined — which staging never reproduces.
  const scopes: Array<[string, Record<string, unknown>]> = [
    ['top level', wranglerConfig],
    ['env.production', (wranglerConfig.env as Record<string, Record<string, unknown>>).production],
    ['env.staging', (wranglerConfig.env as Record<string, Record<string, unknown>>).staging],
  ];

  for (const [name, scope] of scopes) {
    it(`declares the SEND_EMAIL binding in ${name}`, () => {
      expect(scope, `${name} scope is missing from wrangler.jsonc`).toBeDefined();
      expect(scope.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    });

    it(`declares EMAIL_SENDER_DOMAIN in ${name}`, () => {
      const vars = scope.vars as Record<string, string> | undefined;
      expect(vars?.EMAIL_SENDER_DOMAIN).toBeTruthy();
    });
  }

  it('points staging at its own mail zone', () => {
    const env = wranglerConfig.env as Record<string, Record<string, unknown>>;
    expect((wranglerConfig.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(PROD_DOMAIN);
    expect((env.production.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(PROD_DOMAIN);
    expect((env.staging.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(STAGING_DOMAIN);
  });
});

describe('POST /email/send — sender domain', () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = happyPathKv();
  });

  it('sends when `from` is on the configured domain', async () => {
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'msg_1' }],
    });
  });

  it('rejects a production `from` when the worker is configured for staging', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const res = await postSend(env, await sendBody());
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_FROM');
    expect(body.error.message).toContain(STAGING_DOMAIN);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('accepts a staging `from` when the worker is configured for staging', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const res = await postSend(env, await sendBody({ from: `acme+noreply@${STAGING_DOMAIN}` }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('escapes the domain so a `.` cannot match an arbitrary character', async () => {
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody({ from: 'acme+noreply@mailxvoid.cloud' }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('fails closed — and burns no quota — when EMAIL_SENDER_DOMAIN is unset', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: undefined });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UPSTREAM_ERROR');
    expect(kv.put).not.toHaveBeenCalled();
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('fails closed — and burns no quota — when the SEND_EMAIL binding is missing', async () => {
    const env = createMockEnv(kv, { SEND_EMAIL: undefined });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe('POST /email/send — platform capability', () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = happyPathKv();
  });

  it('returns the standard 501 when the platform has no email module', async () => {
    // The bindings are configured on purpose: the gate must refuse on the
    // capability alone, not on the missing configuration an installed
    // platform happens to have.
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: JSON.stringify({ email: false }) });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: 'platform capability unavailable',
      capability: 'email',
      message: 'This Void platform does not enable email.',
    });
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('still authenticates first, like the sandbox gate', async () => {
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: JSON.stringify({ email: false }) });
    const res = await postSend(env, await sendBody({ aiToken: 'nope' }));
    expect(res.status).toBe(403);
  });

  it.each([
    ['email: true', JSON.stringify({ email: true })],
    ['unset (hosted platform)', undefined],
  ])('sends when the capability is %s', async (_, capabilities) => {
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: capabilities });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
  });
});

describe('POST /email/send — suspension', () => {
  it('refuses when the routing blob carries the platform-wide suspended marker', async () => {
    const kv = happyPathKv({ acme: JSON.stringify({ projectId: 'proj_1', suspended: 'abuse' }) });
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody());
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.error.message).toContain('abuse');
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('still sends when the routing blob exists without a suspended marker', async () => {
    const kv = happyPathKv({ acme: JSON.stringify({ projectId: 'proj_1', workerName: 'w' }) });
    const res = await postSend(createMockEnv(kv), await sendBody());
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('still sends when the project has no routing blob at all', async () => {
    // A missing blob is a legitimate production state: the marker is only
    // ever written INTO an existing entry, so a project that has not been
    // routed yet has nothing suspended. Failing closed on absence would
    // break every send made before the first routing write.
    const kv = happyPathKv();
    const res = await postSend(createMockEnv(kv), await sendBody());
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(kv.get.mock.calls.some((call) => call[0] === 'acme')).toBe(true);
  });

  it('fails closed with 502 when the routing blob is unparseable', async () => {
    // Unlike a missing blob, a malformed one has no legitimate writer —
    // every producer JSON.stringify's an object. Reading a parse failure as
    // "not suspended" would silently disable the platform-wide suspension
    // gate for exactly the project whose routing entry got corrupted.
    const kv = happyPathKv({ acme: '{"projectId":"proj_1","suspended":' });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody());
      expect(res.status).toBe(502);
      const body = await readSend(res);
      expect(body.error?.code).toBe('UPSTREAM_ERROR');
      expect(body.error?.message).toContain('malformed');
      expect(consoleError).toHaveBeenCalled();
      expect(sender.calls).toHaveLength(0);
      expect(kv.put).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // A truthy marker that is not a string has no writer — every producer
  // stamps a non-empty reason string or deletes the key — but the two
  // sibling readers refuse on it by truthiness: dispatch answers
  // `if (routing.suspended)` with a 429 and the inbound router rejects. The
  // send path must not be the one gate that reads the same value as "clear",
  // so it fails closed exactly like an unparseable blob.
  it.each([
    ['true', true],
    ['a number', 42],
    ['an object', {}],
    ['an array', ['x']],
  ])('fails closed with 502 when the suspended marker is %s', async (_kind, suspended) => {
    const kv = happyPathKv({ acme: JSON.stringify({ projectId: 'proj_1', suspended }) });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody());
      expect(res.status).toBe(502);
      const body = await readSend(res);
      expect(body.error?.code).toBe('UPSTREAM_ERROR');
      expect(body.error?.message).toContain('malformed');
      expect(consoleError).toHaveBeenCalled();
      expect(sender.calls).toHaveLength(0);
      expect(kv.put).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // A falsy present marker is "not suspended" to both sibling readers, and
  // no writer produces one today (an unsuspend DELETES the key). The send
  // path stays aligned so a future clear that stamps `suspended: null`
  // cannot brick every send. `undefined` is the absent key: `JSON.stringify`
  // drops it, so that row pins the no-marker blob through the same table.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['false', false],
    ['an empty string', ''],
    ['zero', 0],
  ])(
    'still sends when the suspended marker is %s (falsy to every reader)',
    async (_kind, suspended) => {
      const kv = happyPathKv({ acme: JSON.stringify({ projectId: 'proj_1', suspended }) });
      const sender = createSender();
      const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
      const res = await postSend(env, await sendBody());
      expect(res.status).toBe(200);
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
    },
  );

  it('refuses when the email-only kill-switch is set', async () => {
    const kv = happyPathKv({ 'email-suspended:proj_1': '1' });
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody());
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED');
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  // Suspension is an abuse-response control: convergence latency is the whole
  // point, so both suspension reads deliberately pay for an uncached KV get.
  // Nothing else pins this — a stray `{ cacheTtl: 60 }` would leave a
  // suspended project sending for another minute per colo.
  it('reads both suspension keys with no cacheTtl', async () => {
    const kv = happyPathKv({ acme: JSON.stringify({ projectId: 'proj_1' }) });
    await postSend(createMockEnv(kv), await sendBody());

    const suspendCall = kv.get.mock.calls.find((call) => call[0] === 'email-suspended:proj_1');
    expect(suspendCall, 'the email suspend key was never read').toBeDefined();
    expect(suspendCall?.[1]).toBeUndefined();

    const routingCall = kv.get.mock.calls.find((call) => call[0] === 'acme');
    expect(routingCall, 'the routing blob was never read').toBeDefined();
    expect(routingCall?.[1]).toBeUndefined();
  });

  it('reads the allowlist with a cacheTtl (the non-abuse-response path)', async () => {
    const kv = happyPathKv();
    await postSend(createMockEnv(kv), await sendBody());
    const call = kv.get.mock.calls.find((c) => c[0] === 'email-allowlist:proj_1');
    expect(call?.[1]).toEqual({ cacheTtl: 60 });
  });
});

describe('POST /email/internal/send', () => {
  async function internalBody(
    domain: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const from = `noreply@${domain}`;
    const to = 'dev@example.com';
    const mime = mimeBase64();
    const body = { from, to, mimeBase64: mime, ...overrides };
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = await sha256Hex(
      `${body.from as string}|${body.to as string}|${body.mimeBase64 as string}`,
    );
    return {
      ...body,
      platformTimestamp: timestamp,
      platformToken: await signHmac(
        `void-platform-internal-email-v1.${timestamp}.${hash}`,
        JWT_SECRET,
      ),
    };
  }

  async function postInternal(
    env: Record<string, unknown>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
      new Request('https://proxy.void.cloud/email/internal/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('accepts noreply@ on the configured domain', async () => {
    const env = createMockEnv(createMockKv());
    const res = await postInternal(env, await internalBody(PROD_DOMAIN));
    expect(res.status).toBe(200);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
  });

  it('rejects noreply@ on a different domain than the one configured', async () => {
    const env = createMockEnv(createMockKv(), { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const res = await postInternal(env, await internalBody(PROD_DOMAIN));
    expect(res.status).toBe(403);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('rejects a non-noreply local part on the configured domain', async () => {
    const env = createMockEnv(createMockKv());
    const res = await postInternal(
      env,
      await internalBody(PROD_DOMAIN, { from: `billing@${PROD_DOMAIN}` }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an unsigned request', async () => {
    const env = createMockEnv(createMockKv());
    const body = await internalBody(PROD_DOMAIN);
    const res = await postInternal(env, { ...body, platformToken: 'nope' });
    expect(res.status).toBe(403);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('fails closed when EMAIL_SENDER_DOMAIN is unset', async () => {
    const env = createMockEnv(createMockKv(), { EMAIL_SENDER_DOMAIN: '' });
    const res = await postInternal(env, await internalBody(PROD_DOMAIN));
    expect(res.status).toBe(502);
  });

  it('is behind the same email capability gate as /email/send', async () => {
    const env = createMockEnv(createMockKv(), {
      PLATFORM_CAPABILITIES: JSON.stringify({ email: false }),
    });
    const res = await postInternal(env, await internalBody(PROD_DOMAIN));
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ capability: 'email' });
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });
});

describe('inbound email router', () => {
  function routingKv(entry: Record<string, unknown>, extra: Record<string, string> = {}) {
    return createMockKv({
      acme: JSON.stringify(entry),
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com']),
      ...extra,
    });
  }

  it('passes the project dispatch limits into DISPATCH.get', async () => {
    const kv = routingKv({
      workerName: 'user-worker',
      projectId: 'proj_1',
      limits: { cpuMs: 12_345 },
    });
    const env = createMockEnv(kv);
    await routeInboundMessage(env, createInboundMessage(`acme+support@${PROD_DOMAIN}`));

    const dispatchGet = (env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get;
    expect(dispatchGet).toHaveBeenCalledWith('user-worker', {}, { limits: { cpuMs: 12_345 } });
  });

  it('omits the limits argument when routing has none', async () => {
    const kv = routingKv({ workerName: 'user-worker', projectId: 'proj_1' });
    const env = createMockEnv(kv);
    await routeInboundMessage(env, createInboundMessage(`acme@${PROD_DOMAIN}`));
    expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      'user-worker',
    );
  });

  it('rejects — without dispatching — when the project is platform-suspended', async () => {
    const kv = routingKv({ workerName: 'user-worker', projectId: 'proj_1', suspended: 'abuse' });
    const env = createMockEnv(kv);
    const message = createInboundMessage(`acme+support@${PROD_DOMAIN}`);
    await routeInboundMessage(env, message);

    expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledTimes(1);
    expect(String(message.setReject.mock.calls[0][0])).toContain('suspended');
  });

  it('rejects — without dispatching — when the email kill-switch is set', async () => {
    const kv = routingKv(
      { workerName: 'user-worker', projectId: 'proj_1' },
      { 'email-suspended:proj_1': '1' },
    );
    const env = createMockEnv(kv);
    const message = createInboundMessage(`acme+support@${PROD_DOMAIN}`);
    await routeInboundMessage(env, message);

    expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
    expect(message.setReject).toHaveBeenCalledTimes(1);
  });

  it('reads the inbound suspend key with no cacheTtl', async () => {
    const kv = routingKv({ workerName: 'user-worker', projectId: 'proj_1' });
    await routeInboundMessage(createMockEnv(kv), createInboundMessage(`acme@${PROD_DOMAIN}`));
    const call = kv.get.mock.calls.find((c) => c[0] === 'email-suspended:proj_1');
    expect(call, 'the email suspend key was never read').toBeDefined();
    expect(call?.[1]).toBeUndefined();
  });

  // The routing blob is keyed by slug, so a project that registered
  // `noreply` before it was reserved would receive every bounce and reply to
  // the platform's own verification mail (`noreply@<domain>`), and a
  // `postmaster` project the domain's abuse reports.
  it.each([
    ['bare noreply', 'noreply', `noreply@${PROD_DOMAIN}`],
    ['tagged noreply', 'noreply', `noreply+bounce@${PROD_DOMAIN}`],
    ['postmaster', 'postmaster', `postmaster@${PROD_DOMAIN}`],
    ['mixed case', 'abuse', `Abuse@${PROD_DOMAIN}`],
  ])(
    'rejects mail to a reserved email identity (%s) without reading routing or dispatching',
    async (_label, slug, to) => {
      const kv = createMockKv({
        [slug]: JSON.stringify({ workerName: 'legacy-worker', projectId: 'proj_legacy' }),
      });
      const env = createMockEnv(kv);
      const message = createInboundMessage(to);
      await routeInboundMessage(env, message);

      expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
      expect(message.setReject).toHaveBeenCalledTimes(1);
      expect(String(message.setReject.mock.calls[0][0])).toContain('reserved');
      expect(kv.get).not.toHaveBeenCalled();
    },
  );

  it('still routes an ordinary slug that merely CONTAINS a reserved word', async () => {
    const kv = createMockKv({
      'noreply-tools': JSON.stringify({ workerName: 'user-worker', projectId: 'proj_1' }),
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com']),
    });
    const env = createMockEnv(kv);
    const message = createInboundMessage(`noreply-tools+x@${PROD_DOMAIN}`);
    await routeInboundMessage(env, message);
    expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      'user-worker',
    );
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('names the configured zone in reject reasons', async () => {
    const env = createMockEnv(createMockKv(), { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const message = createInboundMessage(`nosuchproject@${STAGING_DOMAIN}`);
    await routeInboundMessage(env, message);
    expect(String(message.setReject.mock.calls[0][0])).toContain(STAGING_DOMAIN);
  });

  it('still routes when EMAIL_SENDER_DOMAIN is unset (inbound never fails closed on it)', async () => {
    const kv = routingKv({ workerName: 'user-worker', projectId: 'proj_1' });
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: undefined });
    const message = createInboundMessage(`acme@${PROD_DOMAIN}`);
    await routeInboundMessage(env, message);
    expect((env.DISPATCH as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound coverage restored from the original PR, re-aimed at the current
// contracts: the mail domain is configuration (`EMAIL_SENDER_DOMAIN`), the
// slug mirror pins the `from` local-part, and the gate chain runs
// size -> from -> suspend -> allowlist -> quota.
// ---------------------------------------------------------------------------

/**
 * Drain the `raw` argument the handler passed to `new EmailMessage(...)`.
 *
 * The bytes matter, not just the call count: `bytesToStream(raw)` is built
 * INSIDE the fan-out loop precisely because a ReadableStream is one-shot. A
 * regression that hoisted one stream out of the loop still records N sends —
 * only the delivered bytes show that recipients 2..N got an empty body.
 */
async function drainStream(raw: unknown): Promise<Uint8Array> {
  if (typeof raw === 'string') {
    return new TextEncoder().encode(raw);
  }
  if (!(raw instanceof ReadableStream)) {
    return new Uint8Array(0);
  }
  const reader = (raw as ReadableStream<Uint8Array>).getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface SenderCall {
  from: string;
  to: string;
  bytes: Uint8Array;
}

/** Recording `send_email` binding: captures from/to and the delivered bytes. */
function createSender(
  options: {
    fail?: (to: string) => Error | undefined;
    result?: (n: number) => unknown;
    onSend?: (to: string) => void;
  } = {},
) {
  const calls: Array<SenderCall> = [];
  const send = vi.fn(async (msg: { from: string; to: string; raw: unknown }) => {
    const bytes = await drainStream(msg.raw);
    calls.push({ from: msg.from, to: msg.to, bytes });
    options.onSend?.(msg.to);
    const failure = options.fail?.(msg.to);
    if (failure) {
      throw failure;
    }
    return options.result ? options.result(calls.length) : { messageId: `cf-msg-${calls.length}` };
  });
  return {
    calls,
    send,
    binding: { send },
    texts: (): Array<string> => calls.map((c) => new TextDecoder().decode(c.bytes)),
    recipients: (): Array<string> => calls.map((c) => c.to),
  };
}

function monthKeyFor(projectId: string): string {
  const now = new Date();
  return `email-sent:${projectId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function putsWithPrefix(kv: MockKv, prefix: string): Array<Array<unknown>> {
  return kv.put.mock.calls.filter((call) => String(call[0]).startsWith(prefix));
}

interface SendResponseBody {
  ok: boolean;
  error?: { code: string; message: string };
  ids?: Array<{ recipient: string; messageId: string }>;
  deliveries?: Array<{
    recipient: string;
    ok: boolean;
    messageId?: string;
    error?: { code: string };
  }>;
}

async function readSend(res: Response): Promise<SendResponseBody> {
  return (await res.json()) as SendResponseBody;
}

describe('POST /email/send — request validation', () => {
  it.each([
    ['from', { from: undefined }],
    ['mimeBase64', { mimeBase64: undefined }],
    ['recipients', { recipients: undefined }],
  ])('rejects a body missing `%s` with 400', async (_field, override) => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody(override));
    expect(res.status).toBe(400);
    expect((await readSend(res)).error?.code).toBe('UPSTREAM_ERROR');
  });

  it('rejects a non-array `recipients` with 400', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ recipients: 'dev@example.com' }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['an empty array', []],
    ['only non-string entries', [123, null, { to: 'dev@example.com' }]],
    ['only blank strings', ['', '   ']],
  ])('answers INVALID_TO when recipients are %s', async (_label, recipients) => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ recipients }));
    expect(res.status).toBe(200);
    expect((await readSend(res)).error?.code).toBe('INVALID_TO');
  });

  it('dedupes + normalizes recipients before quota math and fan-out', async () => {
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({
        recipients: ['Dev@Example.com', 'dev@example.com', '  DEV@EXAMPLE.COM  '],
      }),
    );
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(['dev@example.com']);
    // One recipient, therefore one unit of quota — not three.
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('1');
  });

  it('rejects invalid base64 with 400 MIME_ERROR', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ mimeBase64: '!!!not-base64!!!' }));
    expect(res.status).toBe(400);
    expect((await readSend(res)).error?.code).toBe('MIME_ERROR');
  });

  it('rejects a bad project HMAC with 403 before any handler work', async () => {
    const kv = happyPathKv();
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody({ aiToken: 'not-a-valid-hmac' }));
    expect(res.status).toBe(403);
    expect(kv.get).not.toHaveBeenCalled();
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('rejects a missing project token with 400', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ aiToken: undefined }));
    expect(res.status).toBe(400);
  });

  // A tenant worker holds a valid project HMAC (`__VOID_PROXY_TOKEN` is baked
  // in as a plain-text binding), so it can POST any body to the public proxy
  // hostname. Every recipient costs a normalized copy, a `seen` Set entry,
  // and — when the allowlist rejects it — a delivery object interpolating the
  // address, all of it then serialized into the response. Uncapped, a ~2.5 MB
  // body reaches the 128 MB per-isolate ceiling, and the all-rejected path
  // returns ABOVE the quota gates so the work is never metered and is
  // endlessly repeatable. The proxy isolate is shared with every other
  // tenant's in-flight traffic, so the kill is cross-tenant.
  it('rejects a recipient list one over the cap, before any KV read', async () => {
    const MAX_RECIPIENTS = 100;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({
        recipients: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `dev${i}@example.com`),
      }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_TO');
    // Refused above the normalization loop, so not one per-recipient
    // delivery object was built.
    expect(body.deliveries).toBeUndefined();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it('still sends a recipient list sitting exactly at the cap', async () => {
    const MAX_RECIPIENTS = 100;
    const recipients = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `dev${i}@example.com`);
    const kv = createMockKv({
      'email-slug:proj_1': 'acme',
      'email-allowlist:proj_1': JSON.stringify(recipients),
      // Raised so the burst + monthly gates cannot answer first and hide
      // whether the cap itself let the list through.
      'email-burst-limit:proj_1': '1000',
      'email-limit:proj_1': '1000',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients }));

    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(recipients);
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe(String(MAX_RECIPIENTS));
  });

  // `MAX_RECIPIENTS` alone still leaves a 100 x <address length> amplifier,
  // because `.trim().toLowerCase()` copies each entry before anything has
  // looked at its size.
  it('rejects an over-long recipient before normalization allocates', async () => {
    const MAX_RECIPIENT_LENGTH = 320;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: [`${'a'.repeat(MAX_RECIPIENT_LENGTH)}@example.com`] }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_TO');
    expect(body.deliveries).toBeUndefined();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  // The sender is one string, but `from.toLowerCase()` copies it whole and
  // a valid-shaped sender (`<slug>+<unbounded tag>@<domain>`) is then echoed
  // verbatim into the MIME `From:` refusal and serialized into the
  // response — all above the quota gates. The bound has to come first.
  it('rejects an over-long sender before the slug read, the copy, or the echo', async () => {
    const MAX_SENDER_LENGTH = 320;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    // Shaped to pass the strict regex AND the slug pin, so the only thing
    // that can refuse it is the length bound.
    const tag = 'a'.repeat(MAX_SENDER_LENGTH);
    const from = `acme+${tag}@${PROD_DOMAIN}`;
    const res = await postSend(
      env,
      // A MIME with no `From:` at all: without the bound this request would
      // reach the addr-spec refusal that interpolates the whole sender.
      await sendBody({ from, mimeBase64: mimeBase64('Subject: hi\r\n\r\nhello\r\n') }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).not.toContain(tag);
    expect(body.deliveries).toBeUndefined();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it('still sends from a sender sitting exactly at the cap', async () => {
    const MAX_SENDER_LENGTH = 320;
    const prefix = 'acme+';
    const suffix = `@${PROD_DOMAIN}`;
    const from = `${prefix}${'a'.repeat(MAX_SENDER_LENGTH - prefix.length - suffix.length)}${suffix}`;
    expect(from).toHaveLength(MAX_SENDER_LENGTH);
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));

    expect(res.status).toBe(200);
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].from).toBe(from);
  });
});

describe('POST /email/send — sender pinning (cross-project tenancy)', () => {
  it.each([
    ['bare <slug>@domain', `acme@${PROD_DOMAIN}`],
    ['<slug>+tag@domain', `acme+billing@${PROD_DOMAIN}`],
    ['a tag using the full safe charset', `acme+a.b_c=d/e-f@${PROD_DOMAIN}`],
    ['mixed case (normalized before the compare)', 'ACME+Tag@MAIL.VOID.CLOUD'],
  ])('accepts %s', async (_label, from) => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));
    expect((await readSend(res)).ok, `${from} should have been accepted`).toBe(true);
    expect(sender.calls).toHaveLength(1);
    // The envelope is forwarded verbatim — normalization is for the compare
    // only, so CF sees exactly the address the caller submitted.
    expect(sender.calls[0].from).toBe(from);
  });

  it("refuses to send as another project's slug", async () => {
    // proj_1 is `acme`; proj_2 is `victim`. The account-level send_email
    // binding would happily accept either — the slug mirror is the only
    // thing standing between the two tenants.
    const kv = happyPathKv({ 'email-slug:proj_2': 'victim' });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `victim+noreply@${PROD_DOMAIN}` }));
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
  });

  it.each([
    ['a different local part entirely', `spoof@${PROD_DOMAIN}`],
    ['the slug as a PREFIX of a longer local part', `acmex@${PROD_DOMAIN}`],
    ['the slug with a dotted suffix', `acme.evil@${PROD_DOMAIN}`],
    ['the slug with a dashed suffix', `acme-evil@${PROD_DOMAIN}`],
    ['an unrelated domain', 'acme@evil.com'],
    ['a subdomain of the configured zone', `acme@sub.${PROD_DOMAIN}`],
    ['the configured zone as a prefix of a longer domain', `acme@${PROD_DOMAIN}.evil.com`],
    ['a `+` tag with a disallowed character', `acme+a%b@${PROD_DOMAIN}`],
    ['a second `@`', `acme@${PROD_DOMAIN}@${PROD_DOMAIN}`],
    ['an empty local part', `@${PROD_DOMAIN}`],
    ['an empty `+` tag', `acme+@${PROD_DOMAIN}`],
  ])('rejects %s with INVALID_FROM', async (_label, from) => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));
    const body = await readSend(res);
    expect(body.ok, `${from} should have been rejected`).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['carriage return', `acme+x\r\nX-Bcc: attacker@evil.com@${PROD_DOMAIN}`],
    ['line feed', `acme+x\nX-Bcc: attacker@evil.com@${PROD_DOMAIN}`],
    ['display name with angle brackets', `Foo <acme@${PROD_DOMAIN}>`],
    ['quoted local part', `"ac+me"@${PROD_DOMAIN}`],
    ['leading whitespace', ` acme@${PROD_DOMAIN}`],
    ['trailing whitespace', `acme@${PROD_DOMAIN} `],
    ['null byte in the local part', `acme\x00@${PROD_DOMAIN}`],
    ['control byte in the +tag', `acme+\x01abc@${PROD_DOMAIN}`],
    ['DEL in the +tag', `acme+abc\x7fdef@${PROD_DOMAIN}`],
    ['BEL in the +tag', `acme+\x07@${PROD_DOMAIN}`],
  ])('rejects header-injection shaped from (%s)', async (_label, from) => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));
    const body = await readSend(res);
    expect(body.ok, `${JSON.stringify(from)} should have been rejected`).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('names the expected slug and the configured zone in the refusal', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ from: `spoof@${PROD_DOMAIN}` }));
    const message = (await readSend(res)).error?.message ?? '';
    expect(message).toContain('acme');
    expect(message).toContain(PROD_DOMAIN);
  });

  it('fails closed with 502 when the slug mirror is missing', async () => {
    const kv = createMockKv({ 'email-allowlist:proj_1': JSON.stringify(['dev@example.com']) });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect((await readSend(res)).error?.code).toBe('UPSTREAM_ERROR');
    expect(sender.calls).toHaveLength(0);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('fails closed with 502 when the slug mirror is poisoned with a malformed slug', async () => {
    // A poisoned slug must surface as an operator-visible error, not as a
    // silent permanent denial for every future send by that project.
    const kv = happyPathKv({ 'email-slug:proj_1': 'BADSLUG!' });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody({ from: `badslug!@${PROD_DOMAIN}` }));
      expect(res.status).toBe(502);
      const body = await readSend(res);
      expect(body.error?.code).toBe('UPSTREAM_ERROR');
      expect(body.error?.message).toContain('malformed');
      expect(sender.calls).toHaveLength(0);
      expect(kv.put).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reads the slug mirror without pinning a cacheTtl', async () => {
    const kv = happyPathKv();
    await postSend(createMockEnv(kv), await sendBody());
    const call = kv.get.mock.calls.find((c) => c[0] === 'email-slug:proj_1');
    expect(call, 'the slug mirror was never read').toBeDefined();
    expect(call?.[1]).toBeUndefined();
  });
});

describe('POST /email/send — reserved email identities (legacy slug holders)', () => {
  // `noreply`, `postmaster`, `abuse`, `bounce` and `security` joined
  // `RESERVED_SLUGS` only when email shipped. A project that registered one
  // of them BEFORE that still holds the slug and, until the api's hourly
  // backfill withholds it, its `email-slug:` mirror — which is all the pin
  // above checks. `noreply@<domain>` is the platform's own verification
  // sender, so such a project could send mail indistinguishable from ours.
  /** KV exactly as the mirror stands for a pre-reservation `noreply` project. */
  function legacyKv(slug: string) {
    return createMockKv({
      'email-slug:proj_1': slug,
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com']),
    });
  }

  it.each([
    ["the platform's own sender, bare", 'noreply', `noreply@${PROD_DOMAIN}`],
    ["the platform's own sender, tagged", 'noreply', `noreply+verify@${PROD_DOMAIN}`],
    ['postmaster', 'postmaster', `postmaster@${PROD_DOMAIN}`],
    ['abuse', 'abuse', `abuse+x@${PROD_DOMAIN}`],
    ['bounce', 'bounce', `bounce@${PROD_DOMAIN}`],
    ['security', 'security', `security@${PROD_DOMAIN}`],
  ])('refuses %s even though the mirror pins that very slug', async (_label, slug, from) => {
    const kv = legacyKv(slug);
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));
    expect(res.status).toBe(403);
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).toContain('reserved');
    expect(sender.calls).toHaveLength(0);
    // Refused on the mirror alone: no allowlist or quota read, nothing written.
    expect(kv.get.mock.calls.map((c) => c[0])).toEqual(['email-slug:proj_1']);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('is the slug that is refused, not the `from`: a wrong `from` on a reserved slug is refused too', async () => {
    const kv = legacyKv('noreply');
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `acme@${PROD_DOMAIN}` }));
    expect(res.status).toBe(403);
    expect((await readSend(res)).error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('leaves an ordinary slug that merely CONTAINS a reserved word untouched', async () => {
    const kv = createMockKv({
      'email-slug:proj_1': 'noreply-tools',
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com']),
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `noreply-tools+x@${PROD_DOMAIN}` }));
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toHaveLength(1);
  });
});

describe('POST /email/send — MIME From pin (what the recipient sees)', () => {
  /** A tenant that owns `acme` and wants to look like `victim`. */
  function twoTenantsKv() {
    return happyPathKv({ 'email-slug:proj_2': 'victim' });
  }

  async function sendMime(mime: string, overrides: Record<string, unknown> = {}) {
    const kv = twoTenantsKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ mimeBase64: mimeBase64(mime), ...overrides }));
    return { res, body: await readSend(res), sender, kv };
  }

  it("refuses a MIME From naming another project's sender under an authorized envelope", async () => {
    // The envelope `acme+noreply@` passes the slug pin; the bytes the
    // recipient's client renders as the sender say `victim+noreply@`.
    const { res, body, sender, kv } = await sendMime(mimeFor(`victim+noreply@${PROD_DOMAIN}`));
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
    // Refused before the suspension, allowlist and quota reads.
    expect(kv.get.mock.calls.map((c) => c[0])).toEqual(['email-slug:proj_1']);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it.each([
    ['a display name in front of the victim', `"Acme Billing" <victim+noreply@${PROD_DOMAIN}>`],
    [
      'the victim in the phrase, the envelope in brackets',
      `victim@${PROD_DOMAIN} <${DEFAULT_FROM}>`,
    ],
    ['a mailbox list, envelope first', `${DEFAULT_FROM}, victim@${PROD_DOMAIN}`],
    ['a mailbox list, victim first', `victim@${PROD_DOMAIN}, ${DEFAULT_FROM}`],
    ['a group', `Acme: victim@${PROD_DOMAIN};`],
    ['two angle-addrs', `<victim@${PROD_DOMAIN}> <${DEFAULT_FROM}>`],
    ['a comment carrying the victim', `${DEFAULT_FROM} (victim@${PROD_DOMAIN})`],
    ['trailing text after the angle-addr', `<${DEFAULT_FROM}> victim@${PROD_DOMAIN}`],
    ['an unterminated quoted-string', `"Acme <${DEFAULT_FROM}>`],
    ['an empty angle-addr', '<>'],
    ['an empty value', ''],
    ['whitespace inside the brackets', `< ${DEFAULT_FROM} >`],
  ])(
    'refuses a From that is not a single mailbox naming the envelope (%s)',
    async (_label, value) => {
      const { body, sender } = await sendMime(mimeFor(value));
      expect(body.ok, `${JSON.stringify(value)} should have been refused`).toBe(false);
      expect(body.error?.code).toBe('INVALID_FROM');
      expect(sender.calls).toHaveLength(0);
    },
  );

  it('refuses a From that only case-folds INTO the envelope sender', async () => {
    // U+212A KELVIN SIGN lower-cases to `k`. Without the printable-ASCII
    // check the compare would pass and CF would receive a From the envelope
    // check never saw.
    const from = `acme+link@${PROD_DOMAIN}`;
    const { body, sender } = await sendMime(mimeFor(`acme+lin\u212A@${PROD_DOMAIN}`), { from });
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('refuses a message with no From header at all', async () => {
    const { body, sender } = await sendMime('Subject: hi\r\n\r\nhello\r\n');
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).toContain('no From header');
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['plain duplicates', `From: ${DEFAULT_FROM}\r\nFrom: victim@${PROD_DOMAIN}\r\n`],
    [
      'the second one spelled `From :`',
      `From: ${DEFAULT_FROM}\r\nFrom : victim@${PROD_DOMAIN}\r\n`,
    ],
    ['the second one upper-cased', `From: ${DEFAULT_FROM}\r\nFROM: victim@${PROD_DOMAIN}\r\n`],
    [
      'the second one after an unrelated header',
      `From: ${DEFAULT_FROM}\r\nSubject: x\r\nFrom: victim@${PROD_DOMAIN}\r\n`,
    ],
    [
      'the second one hidden behind a bare LF',
      `From: ${DEFAULT_FROM}\nFrom: victim@${PROD_DOMAIN}\r\n`,
    ],
  ])('refuses two From headers (%s)', async (_label, headers) => {
    const { body, sender } = await sendMime(`${headers}Subject: hi\r\n\r\nhello\r\n`);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).toContain('more than one From');
    expect(sender.calls).toHaveLength(0);
  });

  it('refuses a bare CR that a LF-splitting parser would read as a second line', async () => {
    const { body, sender } = await sendMime(
      `From: ${DEFAULT_FROM}\rFrom: victim@${PROD_DOMAIN}\r\nSubject: hi\r\n\r\nhello\r\n`,
    );
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('does not read a From inside a MIME part as the message From', async () => {
    // The scan ends at the first empty line; a part's own `From:` is body.
    const { body } = await sendMime(
      `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nFrom: victim@${PROD_DOMAIN}\r\n\r\nx\r\n--b--\r\n`,
    );
    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain('no From header');
  });

  it.each([
    ['ASCII case differences', `ACME+NoReply@${PROD_DOMAIN.toUpperCase()}`],
    ['a display name', `Acme Billing <${DEFAULT_FROM}>`],
    ['a quoted display name with a comma', `"Smith, John" <${DEFAULT_FROM}>`],
    [
      'a quoted display name with escaped quotes and brackets',
      `"Acme \\"<Billing>\\" \\\\ Co" <${DEFAULT_FROM}>`,
    ],
    ['an encoded-word display name', `=?UTF-8?B?SsO8cmdlbg==?= <${DEFAULT_FROM}>`],
    [
      'a quoted display name that holds the victim (handed back: display names are not inspected)',
      `"victim@${PROD_DOMAIN}" <${DEFAULT_FROM}>`,
    ],
    ['a folded value', `Acme\r\n Billing\r\n <${DEFAULT_FROM}>`],
    ['a tab-folded value', `Acme\r\n\tBilling <${DEFAULT_FROM}>`],
    ['surrounding whitespace', `   ${DEFAULT_FROM}   `],
    ['the header name upper-cased', undefined],
  ])('accepts a single mailbox naming the envelope (%s)', async (_label, value) => {
    const mime =
      value === undefined
        ? `FROM: ${DEFAULT_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`
        : mimeFor(value);
    const { body, sender } = await sendMime(mime);
    expect(body.ok, `${JSON.stringify(value)} should have been accepted`).toBe(true);
    expect(sender.calls).toHaveLength(1);
    // The pin inspects; it never rewrites. CF receives the tenant's bytes.
    expect(sender.texts()[0]).toBe(mime);
  });

  it('accepts a message whose header block runs to the end of the bytes', async () => {
    const { body } = await sendMime(`From: ${DEFAULT_FROM}\r\nSubject: hi`);
    expect(body.ok).toBe(true);
  });

  it('accepts a +tag envelope whose From carries the same tag', async () => {
    const from = `acme+billing@${PROD_DOMAIN}`;
    const { body } = await sendMime(mimeFor(from), { from });
    expect(body.ok).toBe(true);
  });

  it('refuses a +tag envelope whose From carries a different tag', async () => {
    const { body, sender } = await sendMime(mimeFor(`acme+billing@${PROD_DOMAIN}`), {
      from: `acme+support@${PROD_DOMAIN}`,
    });
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  describe("every From shape the framework's buildMime renders is accepted", () => {
    // 200 CJK characters: 600 UTF-8 bytes → 14 encoded-words → folded over
    // many continuation lines, with `<addr>` alone on the last one.
    const longName = '東京都千代田区'.repeat(29).slice(0, 200);
    it.each([
      ['a bare address', { email: DEFAULT_FROM }],
      ['a plain display name', { email: DEFAULT_FROM, name: 'Acme Billing' }],
      ['a quoted display name', { email: DEFAULT_FROM, name: 'Smith, John' }],
      [
        'a display name with quotes and backslashes',
        { email: DEFAULT_FROM, name: 'Acme "Co" \\ Ltd <x>' },
      ],
      ['a short non-ASCII display name', { email: DEFAULT_FROM, name: 'Jürgen Müller' }],
      ['a 200-character CJK display name (folded)', { email: DEFAULT_FROM, name: longName }],
      ['an upper-case address', { email: `ACME+NoReply@${PROD_DOMAIN}` }],
    ])('%s', async (_label, from) => {
      const email = await normalizeEmail({
        from,
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const { raw } = buildMime(email);
      const parsed = readMimeFromAddrSpec(raw);
      expect(parsed).toEqual({ ok: true, addrSpec: from.email });

      // And through the route, as the framework would post it.
      const kv = twoTenantsKv();
      const sender = createSender();
      const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
      let binary = '';
      for (const b of raw) {
        binary += String.fromCharCode(b);
      }
      const res = await postSend(
        env,
        await sendBody({ from: from.email, mimeBase64: btoa(binary) }),
      );
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
    });

    it('the CJK fixture really is folded across continuation lines', async () => {
      const email = await normalizeEmail({
        from: { email: DEFAULT_FROM, name: longName },
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const text = new TextDecoder().decode(buildMime(email).raw);
      const fromHeader = text.slice(text.indexOf('From:'), text.indexOf('\r\nTo:'));
      expect(fromHeader.split('\r\n ').length).toBeGreaterThan(5);
      expect(fromHeader.endsWith(`<${DEFAULT_FROM}>`)).toBe(true);
    });
  });

  describe('the scan keeps nothing per line', () => {
    const MAX_MIME_BYTES = 10 * 1024 * 1024;

    /** `From: <value>` folded over as many `<fold>` continuations as fit in 10 MiB. */
    function foldedToTheCap(value: string, fold: string): { raw: Uint8Array; lines: number } {
      const head = new TextEncoder().encode(`From: ${value}\r\n`);
      const cont = new TextEncoder().encode(fold);
      const lines = Math.floor((MAX_MIME_BYTES - head.byteLength) / cont.byteLength);
      const raw = new Uint8Array(head.byteLength + lines * cont.byteLength);
      raw.set(head, 0);
      for (let i = 0, at = head.byteLength; i < lines; i++, at += cont.byteLength) {
        raw.set(cont, at);
      }
      return { raw, lines };
    }

    it.each([
      ['CRLF', ' \r\n', 3_495_249],
      ['bare LF', ' \n', 5_242_874],
    ])(
      'unfolds a From spread over millions of %s continuations in bounded heap',
      (_label, fold, expectedLines) => {
        // Every continuation is one space: a value that is the address
        // followed by millions of spaces, which trim away, so the scan
        // still has to visit every line. `MAX_MIME_BYTES` bounds bytes, not
        // lines, and one retained view per line was ~125 bytes of heap
        // each — 437 MB for the CRLF case and 694 MB for bare LF, measured,
        // against a 128 MB isolate that every tenant shares; the same bytes
        // with no `From:` cost 1 MB. The offsets-only scan measured 0.2 MB
        // of heap and 85 ms (CRLF) / 111 ms (LF) on the same input; the
        // ceilings below leave room for the test runner, not for a
        // per-line allocation.
        const { raw, lines } = foldedToTheCap('a@b', fold);
        expect(lines).toBe(expectedLines);
        expect(raw.byteLength).toBeLessThanOrEqual(MAX_MIME_BYTES);
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        const parsed = readMimeFromAddrSpec(raw);
        const elapsed = performance.now() - started;
        const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
        expect(parsed).toEqual({ ok: true, addrSpec: 'a@b' });
        expect(elapsed).toBeLessThan(2000);
        expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
      },
    );

    it('refuses the same shape through /email/send before any KV read past the slug', async () => {
      // The pathological fold names a sender that is not the envelope, so
      // the pin refuses it — after unfolding, not by a size gate: the
      // scan's bound is the message itself, which `MAX_MIME_BYTES` already
      // holds in memory. The base64 is built with Buffer: 10 MiB of
      // per-byte string concatenation is the test's own cost, not the
      // proxy's.
      const { raw } = foldedToTheCap(`victim+noreply@${PROD_DOMAIN}`, ' \r\n');
      const kv = twoTenantsKv();
      const sender = createSender();
      const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
      const started = performance.now();
      const res = await postSend(
        env,
        await sendBody({ mimeBase64: Buffer.from(raw).toString('base64') }),
      );
      expect(performance.now() - started).toBeLessThan(5000);
      const body = await readSend(res);
      expect(res.status).toBe(403);
      expect(body.error?.code).toBe('INVALID_FROM');
      expect(body.error?.message).toContain('does not match the envelope sender');
      expect(sender.calls).toHaveLength(0);
      expect(kv.get.mock.calls.map((c) => c[0])).toEqual(['email-slug:proj_1']);
    });

    it.each([
      [
        'a continuation after the NEXT header belongs to that header',
        `From: ${DEFAULT_FROM}\r\nSubject: a\r\n b\r\n\r\nx`,
      ],
      [
        'a continuation before the From belongs to the header before it',
        `Subject: a\r\n b\r\nFrom: ${DEFAULT_FROM}\r\n\r\nx`,
      ],
      ['a whitespace-only continuation line', `From: ${DEFAULT_FROM}\r\n \r\nSubject: a\r\n\r\nx`],
      ['the From on the last line, unterminated', `Subject: a\r\nFrom: ${DEFAULT_FROM}`],
      ['a fold on the last line, unterminated', `From: Acme\r\n <${DEFAULT_FROM}>`],
    ])('tracks the From by offsets: %s', (_label, mime) => {
      expect(readMimeFromAddrSpec(new TextEncoder().encode(mime))).toEqual({
        ok: true,
        addrSpec: DEFAULT_FROM,
      });
    });

    it('still refuses a bare CR on a line after the one From', () => {
      // The lazy CR search restarts past each terminator; a bare CR inside
      // a LATER header must still fail the scan (an LF-splitting parser
      // would read what follows it as part of that header).
      const mime = `From: ${DEFAULT_FROM}\r\nSubject: a\rFrom: victim@${PROD_DOMAIN}\r\n\r\nx`;
      expect(readMimeFromAddrSpec(new TextEncoder().encode(mime))).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('accepts a From value of any length the framework renders (no value bound)', async () => {
      // `buildMime` bounds the ADDRESS at 320 (`MAX_ADDRESS_LENGTH`) and
      // deliberately leaves the display name unbounded — it is encoded and
      // folded at any length (mime.ts). A 100k-character CJK name renders as
      // a ~486 KB `From:` over ~6.7k continuation lines, and the proxy must
      // keep accepting what the framework's own preflight accepts: the fix
      // for the per-line cost was to stop retaining lines, not to cap the
      // value, and a cap would be a contract change owned by the framework.
      const name = '東京都千代田区'.repeat(15000).slice(0, 100_000);
      const email = await normalizeEmail({
        from: { email: DEFAULT_FROM, name },
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const { raw } = buildMime(email);
      const text = new TextDecoder().decode(raw);
      const fromHeader = text.slice(text.indexOf('From:'), text.indexOf('\r\nTo:'));
      expect(fromHeader.length).toBeGreaterThan(400_000);
      expect(fromHeader.split('\r\n ').length).toBeGreaterThan(6000);
      expect(readMimeFromAddrSpec(raw)).toEqual({ ok: true, addrSpec: DEFAULT_FROM });
    });
  });
});

describe('POST /email/send — allowlist fails closed', () => {
  it.each([
    ['the key is missing entirely', undefined],
    ['the value is not JSON at all', 'not json'],
    ['the value is a JSON object, not an array', JSON.stringify({ dev: true })],
    ['the value is a bare JSON string', JSON.stringify('dev@example.com')],
    ['the value is JSON null', 'null'],
    ['the value is a JSON number', '42'],
  ])('denies every recipient when %s', async (_label, raw) => {
    const kv = createMockKv({
      'email-slug:proj_1': 'acme',
      ...(raw === undefined ? {} : { 'email-allowlist:proj_1': raw }),
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries?.[0].error?.code).toBe('UNVERIFIED_DESTINATION');
    expect(sender.calls).toHaveLength(0);
    // A fully-denied batch must not touch either counter.
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
  });

  it('ignores non-string entries but honors the strings beside them', async () => {
    const kv = happyPathKv({
      'email-allowlist:proj_1': JSON.stringify([42, null, 'dev@example.com']),
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(['dev@example.com']);
  });

  it('matches allowlist entries case-insensitively', async () => {
    const kv = happyPathKv({ 'email-allowlist:proj_1': JSON.stringify(['DEV@Example.COM']) });
    const res = await postSend(createMockEnv(kv), await sendBody());
    expect((await readSend(res)).ok).toBe(true);
  });

  it('sends only to the allowed recipients and reports the rest mid-batch', async () => {
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: ['dev@example.com', 'bob@example.com'] }),
    );
    expect(res.status).toBe(200);
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries?.find((d) => d.recipient === 'dev@example.com')?.ok).toBe(true);
    const bob = body.deliveries?.find((d) => d.recipient === 'bob@example.com');
    expect(bob?.ok).toBe(false);
    expect(bob?.error?.code).toBe('UNVERIFIED_DESTINATION');
    expect(sender.recipients()).toEqual(['dev@example.com']);
  });
});

describe('POST /email/send — recipient policy', () => {
  const policyKv = (policy: unknown, allowlist: Array<string> = ['dev@example.com']) =>
    createMockKv({
      'email-slug:proj_1': 'acme',
      'email-allowlist:proj_1': JSON.stringify(allowlist),
      'email-recipient-policy': typeof policy === 'string' ? policy : JSON.stringify(policy),
    });

  it('still delivers to an allowlisted recipient when the policy read rejects', async () => {
    const kv = policyKv({ mode: 'any', domains: [] });
    kv.get.mockImplementation(async (key: string) => {
      if (key === 'email-recipient-policy') {
        throw new Error('policy KV unavailable');
      }
      return kv.store.get(key) ?? null;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sender = createSender();
    const res = await postSend(
      createMockEnv(kv, { SEND_EMAIL: sender.binding }),
      await sendBody({ recipients: ['dev@example.com'] }),
    );
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(['dev@example.com']);
    expect(error).toHaveBeenCalledWith(
      '[email-policy] recipient policy read failed; enforcing verified:',
      expect.any(Error),
    );
  });

  it('under `domains`, reaches a same-domain recipient the allowlist lacks and refuses others', async () => {
    const kv = policyKv({ mode: 'domains', domains: ['acme.test'] });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: ['x@acme.test', 'dev@example.com', 'x@other.test'] }),
    );
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries?.find((d) => d.recipient === 'x@acme.test')?.ok).toBe(true);
    expect(body.deliveries?.find((d) => d.recipient === 'dev@example.com')?.ok).toBe(true);
    const other = body.deliveries?.find((d) => d.recipient === 'x@other.test');
    expect(other?.ok).toBe(false);
    expect(other?.error?.code).toBe('UNVERIFIED_DESTINATION');
    expect(other?.error?.message).toContain("platform's recipient policy");
    expect(sender.recipients().sort()).toEqual(['dev@example.com', 'x@acme.test']);
  });

  it('under `any`, sends to every recipient with an empty allowlist', async () => {
    const kv = policyKv({ mode: 'any', domains: [] }, []);
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients: ['a@x.test', 'b@y.test'] }));
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients().sort()).toEqual(['a@x.test', 'b@y.test']);
  });

  it("does not widen `any` to another tenant's address on the platform sender domain", async () => {
    const consented = `consented+tag@${PROD_DOMAIN}`;
    const refused = `otherproject+tag@${PROD_DOMAIN}`;
    const kv = policyKv({ mode: 'any', domains: [] }, [consented]);
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: [refused, consented, 'someone@other.test'] }),
    );
    const body = await readSend(res);
    expect(body.deliveries?.find((delivery) => delivery.recipient === refused)).toMatchObject({
      ok: false,
      error: { code: 'UNVERIFIED_DESTINATION' },
    });
    expect(sender.recipients().sort()).toEqual([consented, 'someone@other.test'].sort());
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['an unknown mode', { mode: 'open', domains: [] }],
    ['`domains` with an empty list', { mode: 'domains', domains: [] }],
    ['a bare array', ['acme.test']],
  ])('falls back to verified-only when the mirror holds %s', async (_label, policy) => {
    const kv = policyKv(policy, []);
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients: ['x@acme.test'] }));
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries?.[0].error?.code).toBe('UNVERIFIED_DESTINATION');
    expect(body.deliveries?.[0].error?.message).toBe(
      "recipient 'x@acme.test' is not a verified destination for this project",
    );
    expect(sender.calls).toHaveLength(0);
  });
});

describe('POST /email/send — quota', () => {
  it('charges both counters by the ALLOWED recipient count and scopes the burst key', async () => {
    const kv = happyPathKv({
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com', 'ops@example.com']),
    });
    const env = createMockEnv(kv);
    const res = await postSend(
      env,
      await sendBody({ recipients: ['dev@example.com', 'ops@example.com'] }),
    );
    expect((await readSend(res)).ok).toBe(true);

    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('2');
    const monthPuts = putsWithPrefix(kv, 'email-sent:proj_1:');
    expect(monthPuts).toHaveLength(1);
    // KV refuses an expirationTtl under 60s; the month bucket rolls on its own.
    expect((monthPuts[0][2] as { expirationTtl: number }).expirationTtl).toBeGreaterThanOrEqual(60);

    const burstPuts = putsWithPrefix(kv, 'email-burst:proj_1:');
    expect(burstPuts).toHaveLength(1);
    expect(burstPuts[0][1]).toBe('2');
    // Fixed 5-minute TTL on a per-minute bucket — the bucket rolls, the key
    // expires, and a stale bucket can never gate a later minute.
    expect(burstPuts[0][2]).toEqual({ expirationTtl: 5 * 60 });
    expect(String(burstPuts[0][0])).toMatch(/^email-burst:proj_1:\d{8}T\d{4}$/);
  });

  it('counts ONLY allowed recipients — unverified ones never burn quota', async () => {
    // Monthly limit 5 with 4 already spent. One of the three recipients is
    // verified, so this must fit. Counting all three would 429.
    const kv = happyPathKv({
      'email-limit:proj_1': '5',
      [monthKeyFor('proj_1')]: '4',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({
        recipients: ['dev@example.com', 'bob@example.com', 'carol@example.com'],
      }),
    );
    expect(res.status).toBe(200);
    expect(sender.recipients()).toEqual(['dev@example.com']);
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('5');
  });

  it('charges quota BEFORE the first send, not after the batch', async () => {
    const kv = happyPathKv();
    const observed: Array<string | undefined> = [];
    const sender = createSender({
      onSend: () => observed.push(kv.store.get(monthKeyFor('proj_1'))),
    });
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    await postSend(env, await sendBody());
    // The counter is already advanced when CF is called — a crash mid-batch
    // cannot hand back free quota.
    expect(observed).toEqual(['1']);
  });

  it('keeps the charge when every send fails upstream', async () => {
    const kv = happyPathKv();
    const sender = createSender({ fail: () => new Error('upstream blew up') });
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    expect((await readSend(res)).ok).toBe(false);
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('1');
  });

  it('denies with 429 when the burst cap would be exceeded, advancing no counter', async () => {
    const kv = happyPathKv({
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com', 'ops@example.com']),
      'email-burst-limit:proj_1': '1',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: ['dev@example.com', 'ops@example.com'] }),
    );
    expect(res.status).toBe(429);
    const body = await readSend(res);
    expect(body.error?.code).toBe('QUOTA_EXCEEDED');
    expect(body.error?.message).toContain('burst');
    expect(sender.calls).toHaveLength(0);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
  });

  it('denies with 429 when the monthly cap would be exceeded, advancing no counter', async () => {
    const kv = happyPathKv({
      'email-limit:proj_1': '5',
      [monthKeyFor('proj_1')]: '5',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(429);
    const body = await readSend(res);
    expect(body.error?.code).toBe('QUOTA_EXCEEDED');
    expect(body.error?.message).toContain('monthly');
    expect(sender.calls).toHaveLength(0);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
  });

  it('checks the burst cap before the monthly cap', async () => {
    const kv = happyPathKv({
      'email-burst-limit:proj_1': '1',
      'email-limit:proj_1': '1',
      [monthKeyFor('proj_1')]: '1',
      'email-allowlist:proj_1': JSON.stringify(['dev@example.com', 'ops@example.com']),
    });
    const res = await postSend(
      createMockEnv(kv),
      await sendBody({ recipients: ['dev@example.com', 'ops@example.com'] }),
    );
    expect((await readSend(res)).error?.message).toContain('burst');
  });

  it('defaults to 10/min when no burst limit is configured', async () => {
    const recipients = Array.from({ length: 11 }, (_, i) => `r${i}@example.com`);
    const kv = happyPathKv({ 'email-allowlist:proj_1': JSON.stringify(recipients) });
    const res = await postSend(createMockEnv(kv), await sendBody({ recipients }));
    expect(res.status).toBe(429);
    expect((await readSend(res)).error?.message).toContain('10/min');
  });

  it('defaults to 200/month when no monthly limit is configured', async () => {
    const kv = happyPathKv({ [monthKeyFor('proj_1')]: '200' });
    const res = await postSend(createMockEnv(kv), await sendBody());
    expect(res.status).toBe(429);
    expect((await readSend(res)).error?.message).toContain('200');
  });

  it.each([
    ['a non-numeric value', 'abc'],
    ['zero', '0'],
    ['a negative value', '-5'],
  ])('falls back to the default limits when the override is %s', async (_label, raw) => {
    const kv = happyPathKv({
      'email-burst-limit:proj_1': raw,
      'email-limit:proj_1': raw,
    });
    const res = await postSend(createMockEnv(kv), await sendBody());
    // A poisoned override must not read as "limit 0" (deny everything) nor as
    // NaN (allow everything) — the documented behavior is the default.
    expect((await readSend(res)).ok).toBe(true);
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('1');
  });

  it.each([
    ['NaN', 'NaN'],
    ['a non-numeric string', 'abc'],
    ['a negative number', '-7'],
  ])('reads a %s-poisoned counter as 0 instead of bypassing the gate', async (_label, raw) => {
    // `parseInt('NaN', 10)` is NaN, and `NaN > limit` is false — a naive read
    // would BYPASS the cap and then write the literal "NaN" back.
    const kv = happyPathKv({ [monthKeyFor('proj_1')]: raw });
    const res = await postSend(createMockEnv(kv), await sendBody());
    expect(res.status).toBe(200);
    expect(kv.store.get(monthKeyFor('proj_1'))).toBe('1');
  });

  it('logs and continues when a counter put fails (documented best-effort)', async () => {
    const kv = happyPathKv();
    kv.put.mockImplementation(async () => {
      throw new Error('kv unavailable');
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody());
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /email/send — per-recipient fan-out', () => {
  it('gives every recipient its own message with a FRESH body stream', async () => {
    // A regression that hoisted `bytesToStream(raw)` out of the loop would
    // still record three sends — but recipients 2 and 3 would receive an
    // already-drained (empty) stream. Assert the delivered BYTES.
    const mime = mimeFor(DEFAULT_FROM, 'Subject: fan-out\r\n\r\nbody bytes\r\n');
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];
    const kv = happyPathKv({ 'email-allowlist:proj_1': JSON.stringify(recipients) });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients, mimeBase64: mimeBase64(mime) }));

    const body = await readSend(res);
    expect(body.ok).toBe(true);
    expect(sender.recipients()).toEqual(recipients);
    expect(sender.texts()).toEqual([mime, mime, mime]);
    // One envelope sender for the whole batch; one message per recipient.
    expect(new Set(sender.calls.map((c) => c.from)).size).toBe(1);
    expect(body.ids).toEqual([
      { recipient: 'a@example.com', messageId: 'cf-msg-1' },
      { recipient: 'b@example.com', messageId: 'cf-msg-2' },
      { recipient: 'c@example.com', messageId: 'cf-msg-3' },
    ]);
  });

  it('surfaces an empty messageId rather than crashing when CF returns none', async () => {
    const sender = createSender({ result: () => ({}) });
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    const body = await readSend(res);
    expect(body.ok).toBe(true);
    expect(body.ids).toEqual([{ recipient: 'dev@example.com', messageId: '' }]);
  });

  it('records per-recipient outcomes when one send fails mid-batch', async () => {
    const recipients = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
    const kv = happyPathKv({ 'email-allowlist:proj_1': JSON.stringify(recipients) });
    const sender = createSender({
      fail: (to) => (to === 'bob@example.com' ? new Error('upstream blew up') : undefined),
    });
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients }));

    expect(res.status).toBe(200);
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries).toHaveLength(3);
    expect(body.deliveries?.find((d) => d.recipient === 'alice@example.com')?.ok).toBe(true);
    expect(body.deliveries?.find((d) => d.recipient === 'carol@example.com')?.ok).toBe(true);
    const bob = body.deliveries?.find((d) => d.recipient === 'bob@example.com');
    expect(bob?.ok).toBe(false);
    expect(bob?.error?.code).toBe('UPSTREAM_ERROR');
    // One failure does not abort the batch.
    expect(sender.calls).toHaveLength(3);
  });
});

describe('POST /email/send — upstream error classification', () => {
  async function sendWithError(message: string): Promise<SendResponseBody> {
    const sender = createSender({ fail: () => new Error(message) });
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    return readSend(await postSend(env, await sendBody()));
  }

  it.each([
    ['destination address dev@example.com is not verified'],
    ['destination address dev@example.com is not yet verified'],
    ['Destination Address dev@example.com Not Verified'],
  ])('classifies %s as UNVERIFIED_DESTINATION (non-retryable)', async (message) => {
    const body = await sendWithError(message);
    expect(body.deliveries?.[0].error?.code).toBe('UNVERIFIED_DESTINATION');
  });

  it.each([
    [
      'transient MX error mentioning an unrelated RDNS check',
      'could not deliver to destination MX; reason: domain not yet RDNS-verified',
    ],
    [
      'a preamble longer than the leading bound',
      `${'x'.repeat(300)} destination address dev@example.com is not verified`,
    ],
    [
      'reverse phrasing — verified domain, different destination',
      'sender domain verified; destination address differs from configured allow list',
    ],
    ['a transient SMTP DSN', '4.7.1 temporary delivery failure; please retry later'],
    [
      'a match dragged in from a later log line',
      'connection reset\ndestination address dev@example.com is not verified',
    ],
  ])('does NOT classify %s as UNVERIFIED_DESTINATION', async (_label, message) => {
    // A false positive here turns a retryable transient failure into a
    // permanent "go verify your address" for the developer.
    const body = await sendWithError(message);
    expect(body.deliveries?.[0].error?.code).toBe('UPSTREAM_ERROR');
  });

  // Email Service throws a plain `Error` with a string `code` (Cloudflare's
  // `E_*` table). These messages deliberately do NOT match the
  // destination-verification regex, so a pass can only come from the code.
  function bindingError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  async function sendWithThrow(thrown: unknown): Promise<SendResponseBody> {
    const send = vi.fn(async () => {
      throw thrown;
    });
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: { send } });
    return readSend(await postSend(env, await sendBody()));
  }

  it.each([
    ['E_RECIPIENT_NOT_ALLOWED', 'UNVERIFIED_DESTINATION'],
    ['E_RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['E_DAILY_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
  ])('classifies a binding throw carrying %s as %s', async (code, expected) => {
    const body = await sendWithThrow(bindingError(code, 'Email Service refused the send'));
    expect(body.deliveries?.[0].error?.code).toBe(expected);
    expect(body.deliveries?.[0].error?.message).toBe('Email Service refused the send');
  });

  it.each(['E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE'])(
    'keeps %s as UPSTREAM_ERROR (the pinned platform sender is not the tenant to fix) and logs it',
    async (code) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const body = await sendWithThrow(bindingError(code, 'Sender domain not verified'));
        expect(body.deliveries?.[0].error?.code).toBe('UPSTREAM_ERROR');
        expect(body.deliveries?.[0].error?.message).toBe('Sender domain not verified');
        expect(consoleError).toHaveBeenCalledTimes(1);
        const line = String(consoleError.mock.calls[0]?.[0]);
        expect(line).toContain(code);
        expect(line).toContain('proj_1');
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it('falls back to the message regex when the code is not one it knows', async () => {
    const body = await sendWithThrow(
      bindingError('E_SOMETHING_NEW', 'destination address dev@example.com is not verified'),
    );
    expect(body.deliveries?.[0].error?.code).toBe('UNVERIFIED_DESTINATION');
  });

  it('classifies a non-Error throw as UPSTREAM_ERROR', async () => {
    const body = await sendWithThrow('boom');
    expect(body.deliveries?.[0].ok).toBe(false);
    expect(body.deliveries?.[0].error?.code).toBe('UPSTREAM_ERROR');
    expect(body.deliveries?.[0].error?.message).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// Gate ORDER. Each gate has its own negative test above; these pin the
// SEQUENCE — size -> from -> suspend -> allowlist -> quota. A reordering that
// let an unverified recipient burn quota (or an oversized body reach the
// allowlist read) passes every per-gate test and only fails here.
// ---------------------------------------------------------------------------
describe('POST /email/send — gate order', () => {
  /** Was `key` ever read from KV during this request? */
  function readKey(kv: MockKv, key: string): boolean {
    return kv.get.mock.calls.some((call) => call[0] === key);
  }

  /** KV where every downstream gate would ALSO refuse. */
  function everyGateTrippedKv() {
    return createMockKv({
      'email-slug:proj_1': 'acme',
      acme: JSON.stringify({ projectId: 'proj_1', suspended: 'abuse' }),
      'email-suspended:proj_1': '1',
      'email-allowlist:proj_1': JSON.stringify([]),
      'email-burst-limit:proj_1': '1',
      'email-limit:proj_1': '1',
      [monthKeyFor('proj_1')]: '99',
    });
  }

  it('missing sender configuration short-circuits before any KV work', async () => {
    const kv = everyGateTrippedKv();
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: undefined });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('an oversized body is refused before the slug, suspend and allowlist reads', async () => {
    const MAX_MIME_BYTES = 10 * 1024 * 1024;
    const overBound = Math.ceil((MAX_MIME_BYTES * 4) / 3) + 5;
    const kv = everyGateTrippedKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      // Deliberately not valid base64 — the pre-decode length guard runs
      // before atob(), so an adversary can't force a ~75 MB allocation.
      await sendBody({ mimeBase64: 'A'.repeat(overBound) }),
    );
    expect(res.status).toBe(413);
    expect((await readSend(res)).error?.code).toBe('MIME_ERROR');
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it('a bad `from` is refused before the suspend, allowlist and quota reads', async () => {
    const kv = everyGateTrippedKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `spoof@${PROD_DOMAIN}` }));

    expect((await readSend(res)).error?.code).toBe('INVALID_FROM');
    expect(readKey(kv, 'email-slug:proj_1'), 'the slug mirror must be read first').toBe(true);
    expect(readKey(kv, 'acme')).toBe(false);
    expect(readKey(kv, 'email-suspended:proj_1')).toBe(false);
    expect(readKey(kv, 'email-allowlist:proj_1')).toBe(false);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);
  });

  it('platform suspension is answered before the allowlist and quota reads', async () => {
    const kv = everyGateTrippedKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());

    const body = await readSend(res);
    expect(body.error?.code).toBe('QUOTA_EXCEEDED');
    expect(body.error?.message).toContain('abuse');
    expect(readKey(kv, 'email-allowlist:proj_1')).toBe(false);
    expect(readKey(kv, 'email-burst-limit:proj_1')).toBe(false);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);
  });

  it('the email kill-switch is answered before the allowlist and quota reads', async () => {
    const kv = createMockKv({
      'email-slug:proj_1': 'acme',
      'email-suspended:proj_1': '1',
      'email-allowlist:proj_1': JSON.stringify([]),
      'email-limit:proj_1': '1',
      [monthKeyFor('proj_1')]: '99',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());

    const body = await readSend(res);
    expect(body.error?.code).toBe('QUOTA_EXCEEDED');
    expect(body.error?.message).toContain('suspended');
    expect(readKey(kv, 'email-allowlist:proj_1')).toBe(false);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);
  });

  it('unverified recipients are answered BEFORE the quota gates and burn nothing', async () => {
    // The regression this guards: moving the quota gates ahead of the
    // allowlist would let anyone charge a project's monthly cap by naming
    // recipients it never verified — and would answer 429 instead of the
    // actionable UNVERIFIED_DESTINATION.
    const kv = createMockKv({
      'email-slug:proj_1': 'acme',
      'email-allowlist:proj_1': JSON.stringify([]),
      'email-limit:proj_1': '1',
      [monthKeyFor('proj_1')]: '99',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());

    expect(res.status).toBe(200);
    const body = await readSend(res);
    expect(body.error).toBeUndefined();
    expect(body.deliveries?.[0].error?.code).toBe('UNVERIFIED_DESTINATION');
    expect(readKey(kv, 'email-burst-limit:proj_1')).toBe(false);
    expect(readKey(kv, 'email-limit:proj_1')).toBe(false);
    expect(putsWithPrefix(kv, 'email-')).toHaveLength(0);
    expect(sender.calls).toHaveLength(0);
  });
});

describe('POST /email/send — sender domain is configuration, never a baked-in default', () => {
  it.each([
    ['unset', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string', 123],
  ])('fails closed with 502 when EMAIL_SENDER_DOMAIN is %s', async (_label, value) => {
    // The old build hard-coded `mail.void.cloud`. A fallback here would let a
    // misconfigured staging proxy accept — and send — production senders.
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: value, SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `acme@${PROD_DOMAIN}` }));
    expect(res.status).toBe(502);
    expect((await readSend(res)).error?.message).toContain('domain');
    expect(sender.calls).toHaveLength(0);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('trims and lowercases the configured domain before pinning the regex', async () => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), {
      EMAIL_SENDER_DOMAIN: `  MAIL.VOID.CLOUD  `,
      SEND_EMAIL: sender.binding,
    });
    const res = await postSend(env, await sendBody({ from: `acme@${PROD_DOMAIN}` }));
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Platform-internal endpoint. Auth is an HMAC of
// `<sentinel>.<unixSeconds>.<sha256(from|to|mimeBase64)>` under JWT_SECRET.
// The content binding is what stops a captured token inside the skew window
// from being replayed against a different recipient or different bytes.
// ---------------------------------------------------------------------------
describe('POST /email/internal/send — replay window + content binding', () => {
  const SENTINEL = 'void-platform-internal-email-v1';
  const FROM = `noreply@${PROD_DOMAIN}`;
  const TO = 'recipient@example.com';

  async function signPlatform(opts: {
    unixSeconds: number;
    from: string;
    to: string;
    mimeBase64: string;
  }): Promise<string> {
    const hash = await sha256Hex(`${opts.from}|${opts.to}|${opts.mimeBase64}`);
    return signHmac(`${SENTINEL}.${opts.unixSeconds}.${hash}`, JWT_SECRET);
  }

  async function post(
    env: Record<string, unknown>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
      new Request('https://proxy.void.cloud/email/internal/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('accepts a token signed for exactly this body', async () => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64('Subject: Confirm\r\n\r\nclick the link\r\n');
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(200);
    expect(sender.recipients()).toEqual([TO]);
    expect(sender.texts()).toEqual(['Subject: Confirm\r\n\r\nclick the link\r\n']);
  });

  it.each([
    ['stale by more than the 5-minute window', -6 * 60],
    ['future-dated by more than the 5-minute window', 6 * 60],
  ])('rejects a token %s with 403', async (_label, offset) => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000) + offset;
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['4 minutes in the past', -4 * 60],
    ['4 minutes in the future', 4 * 60],
  ])('accepts a token %s (inside the skew window)', async (_label, offset) => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000) + offset;
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(200);
    expect(sender.calls).toHaveLength(1);
  });

  it('rejects a captured token replayed with a different (in-window) timestamp', async () => {
    // Extending a captured token's life by moving the timestamp forward must
    // fail: the timestamp is part of the signed message.
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const signedAt = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: signedAt,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp: signedAt + 60,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['the recipient', { to: 'attacker@evil.com' }],
    ['the MIME bytes', { mimeBase64: mimeBase64('Subject: swapped\r\n\r\nB\r\n') }],
    ['the envelope sender', { from: `noreply@${STAGING_DOMAIN}` }],
  ])('rejects a token replayed after changing %s', async (_label, tamper) => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64('Subject: Confirm\r\n\r\nA\r\n');
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const platformToken = await signPlatform({
      unixSeconds: platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    const res = await post(env, {
      platformToken,
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
      ...tamper,
    });
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['platformToken', 'platformToken'],
    ['platformTimestamp', 'platformTimestamp'],
    ['from', 'from'],
    ['to', 'to'],
    ['mimeBase64', 'mimeBase64'],
  ])('rejects with 403 when `%s` is missing', async (_label, field) => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const body: Record<string, unknown> = {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    };
    delete body[field];
    const res = await post(env, body);
    // Malformed bodies are rejected at the auth boundary, not by the handler,
    // so nothing leaks about which field the verifier could not bind.
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it("refuses a user worker's own project HMAC aimed at the internal endpoint", async () => {
    // A user worker holds HMAC(projectId); it does not hold JWT_SECRET and
    // cannot produce HMAC(sentinel.ts.hash).
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const res = await post(env, {
      platformToken: await signHmac('proj_1', JWT_SECRET),
      platformTimestamp: Math.floor(Date.now() / 1000),
      from: FROM,
      to: TO,
      mimeBase64: mimeBase64(),
    });
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it('allows exactly one `from` — noreply@ on the configured zone', async () => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    // Correctly signed for this exact body — auth passes, the allow-list is
    // what refuses. Without it, a compromised api worker could send
    // arbitrary platform-branded mail.
    const from = `support@${PROD_DOMAIN}`;
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it('rejects invalid base64 with 400 and oversized MIME with 413', async () => {
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });

    const badTs = Math.floor(Date.now() / 1000);
    const bad = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: badTs,
        from: FROM,
        to: TO,
        mimeBase64: '!!!not-base64!!!',
      }),
      platformTimestamp: badTs,
      from: FROM,
      to: TO,
      mimeBase64: '!!!not-base64!!!',
    });
    expect(bad.status).toBe(400);

    // 11 MB decodes past the 10 MB cap. The size bound for this endpoint lives
    // at the AUTH boundary, not in the handler: the token binds
    // sha256(from|to|mimeBase64), so hashing an unbounded body would let an
    // unauthenticated caller choose how much work we do. The middleware
    // therefore refuses to hash anything longer than the base64 form of the
    // cap, and an oversized body is rejected as an invalid token rather than
    // reaching the handler's 413. Outsiders get one uniform rejection.
    const big = new Uint8Array(11 * 1024 * 1024);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < big.length; i += CHUNK) {
      binary += String.fromCharCode(...big.subarray(i, i + CHUNK));
    }
    const oversized = btoa(binary);
    const bigTs = Math.floor(Date.now() / 1000);
    const tooBig = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: bigTs,
        from: FROM,
        to: TO,
        mimeBase64: oversized,
      }),
      platformTimestamp: bigTs,
      from: FROM,
      to: TO,
      mimeBase64: oversized,
    });
    expect(tooBig.status).toBe(403);
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['from', { from: 'a'.repeat(321), to: TO }],
    ['to', { from: FROM, to: 'a'.repeat(321) }],
  ])('refuses an over-long `%s` at the auth boundary, before hashing it', async (_field, addrs) => {
    // The MIME field was bounded before the content hash; `from` and `to`
    // are hashed with it and were not. The template that joins the three
    // flattens them into one full-size string and `TextEncoder` copies it
    // again, both before the token is verified — so an unauthenticated
    // caller with a small MIME still chose two full-size copies plus the
    // sha256 over them. Same 320 as `/email/send`'s sender and recipient
    // bounds, and the same opaque refusal as the other pre-auth gates: the
    // body is `{ error: 'invalid platform token' }`, not the handler's
    // `ok: false` shape, which is how this asserts the handler never ran.
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      // Correctly signed for this exact body, so only the bound refuses it.
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        ...addrs,
        mimeBase64: mime,
      }),
      platformTimestamp,
      ...addrs,
      mimeBase64: mime,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid platform token' });
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['one character short (42)', (t: string) => t.slice(0, 42)],
    ['one character long (44)', (t: string) => `${t}A`],
    ['30 MB', () => 'ab-_'.repeat((30 * 1024 * 1024) / 4)],
  ])('refuses a token that is %s before decoding it', async (_label, mutate) => {
    // The only signer emits an HMAC-SHA256 tag as unpadded base64url — 32
    // bytes, exactly 43 characters — so any other length can never verify.
    // `verifyHmac` decodes the token before comparing (two global replaces,
    // `atob`, then `Uint8Array.from` over every character), which is ~50 B
    // of heap per token character and runs ahead of every credential check:
    // measured, a 30 MB token is ~1.5 GB and ~2 s, and a 4 MB one exhausts
    // a 128 MB heap. The gate refuses on length, so `crypto.subtle.verify`
    // — the only consumer of the decoded bytes — is never reached, and the
    // refusal is the same opaque one every other pre-auth gate gives.
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const platformToken = mutate(
      await signPlatform({ unixSeconds: platformTimestamp, from: FROM, to: TO, mimeBase64: mime }),
    );
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      const t0 = performance.now();
      const res = await post(env, {
        platformToken,
        platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      });
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid platform token' });
      expect(verify).not.toHaveBeenCalled();
      expect(sender.calls).toHaveLength(0);
      // Generous: parsing the 30 MB JSON body is the whole cost now; the
      // decode it no longer reaches measured ~2 s on this input.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      verify.mockRestore();
    }
  });

  it('a 43-character token that is not the signature is still refused by the HMAC, not the length gate', async () => {
    // Pins the gate to LENGTH only: a well-formed but wrong token must reach
    // `crypto.subtle.verify` and fail there, so the length check cannot be
    // mistaken for the credential check.
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const platformToken = await signHmac('not-the-sentinel', JWT_SECRET);
    expect(platformToken).toHaveLength(43);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    try {
      const res = await post(env, {
        platformToken,
        platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid platform token' });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(sender.calls).toHaveLength(0);
    } finally {
      verify.mockRestore();
    }
  });

  it('a 320-character `to` under a valid signature still reaches the handler', async () => {
    // The bound sits exactly where `/email/send` puts its recipient bound.
    // The handler applies no length rule of its own to `to`: it hands the
    // address to `EmailMessage`, so the send goes through with it verbatim.
    const sender = createSender();
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const to = `${'a'.repeat(320 - '@example.com'.length)}@example.com`;
    expect(to).toHaveLength(320);
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to,
      mimeBase64: mime,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].to).toBe(to);
  });

  it('fails closed with 502 when the SEND_EMAIL binding is missing', async () => {
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: undefined });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(502);
  });

  it('reports 502 without leaking the upstream message when CF rejects the send', async () => {
    const sender = createSender({ fail: () => new Error('cf mta exploded') });
    const env = createMockEnv(createMockKv(), { SEND_EMAIL: sender.binding });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mime = mimeBase64();
      const platformTimestamp = Math.floor(Date.now() / 1000);
      const res = await post(env, {
        platformToken: await signPlatform({
          unixSeconds: platformTimestamp,
          from: FROM,
          to: TO,
          mimeBase64: mime,
        }),
        platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'upstream error' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('applies no per-project gate: platform mail touches neither quota nor allowlist', async () => {
    // Documented contract — verification mail is account-level, bounded by
    // the api worker's own rate limit on POST /destinations.
    const kv = happyPathKv({ 'email-suspended:proj_1': '1' });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const mime = mimeBase64();
    const platformTimestamp = Math.floor(Date.now() / 1000);
    const res = await post(env, {
      platformToken: await signPlatform({
        unixSeconds: platformTimestamp,
        from: FROM,
        to: TO,
        mimeBase64: mime,
      }),
      platformTimestamp,
      from: FROM,
      to: TO,
      mimeBase64: mime,
    });
    expect(res.status).toBe(200);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(1);
  });
});

describe('POST /email/send — the envelope handed to CF', () => {
  /**
   * The regex is tested against `from.toLowerCase()` but `EmailMessage`
   * receives the ORIGINAL string, so the validated value and the transmitted
   * value are not the same bytes. That divergence is only safe while nothing
   * can fold INTO the allowed set from outside it — no Unicode code point
   * lower-cases to CR, LF or NUL, so header injection stays closed. This test
   * pins the invariant that actually matters, whichever way the divergence is
   * resolved: nothing with a control character reaches the shared sender.
   *
   * (U+212A KELVIN SIGN does fold to `k`, so a slug containing `k` currently
   * lets a non-ASCII byte through into the envelope — reported separately,
   * deliberately not asserted here so a tightening fix does not read as a
   * regression.)
   */
  it.each([
    ['ASCII upper case', `ACME@${PROD_DOMAIN}`, 'acme'],
    ['a code point that case-folds into the slug', `acmeK@${PROD_DOMAIN}`, 'acmek'],
    ['a carriage return', `acme\r\nX-Bcc: attacker@evil.com@${PROD_DOMAIN}`, 'acme'],
    ['a null byte', `acme\x00@${PROD_DOMAIN}`, 'acme'],
  ])('never hands a control character to the send binding (%s)', async (_label, from, slug) => {
    const kv = happyPathKv({ 'email-slug:proj_1': slug });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    await postSend(env, await sendBody({ from }));
    for (const call of sender.calls) {
      // oxlint-disable-next-line no-control-regex
      expect(new RegExp('[\\u0000-\\u001f\\u007f]').test(call.from)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// `requestId` is a caller-supplied log correlation id. The framework sends 16
// hex chars, but a hand-built tenant worker holding a valid project HMAC can
// send any string, and `logSend` used to interpolate it verbatim into one
// `[email-log]` line per delivery — so a `\n` in it forged a second line under
// any project id, and a multi-megabyte one was repeated up to 100 times into
// the shared proxy log stream. It is bounded and sanitized once at intake.
// ---------------------------------------------------------------------------

describe('POST /email/send — requestId is bounded and sanitized at intake', () => {
  // oxlint-disable-next-line no-control-regex
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');

  it('a 5 MB control-heavy requestId still sends, and logs a short clean id', async () => {
    // Alternating LF / letter: one regex match per LF, the shape that made
    // the old replace-then-slice order materialize one part per match
    // (measured: +170 MB on this input, past the 128 MB isolate ceiling).
    const requestId = `\na`.repeat((5 * 1024 * 1024) / 2);
    const forged = `req_1\n[email-log] proj_victim x@example.com sent forged @0`;
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const t0 = performance.now();
      const res = await postSend(env, await sendBody({ requestId }));
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
      const lines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines).toHaveLength(1);
      // The id is sliced to 128 code units and each LF becomes one space,
      // so the whole line is the fixed fields plus at most 128 chars of id.
      const fixed = `[email-log] proj_1  dev@example.com sent cf-msg-1 @${Date.now()}`.length;
      expect(lines[0]!.length).toBeLessThanOrEqual(fixed + 128);
      expect(lines[0]).not.toMatch(CONTROL);
      expect(lines[0]!.split(' ')[1]).toBe('proj_1');
      // Generous: the slice-first path is ~0 ms; the JSON body is ~5 MB.
      expect(elapsed).toBeLessThan(500);

      // And a newline can no longer forge a second `[email-log]` line.
      logSpy.mockClear();
      const res2 = await postSend(env, await sendBody({ requestId: forged }));
      expect(res2.status).toBe(200);
      const lines2 = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines2).toHaveLength(1);
      expect(lines2[0]).not.toMatch(CONTROL);
      expect(lines2[0]).not.toContain('\n[email-log]');
      expect(lines2[0]!.split(' ')[1]).toBe('proj_1');
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
  ])('a requestId that is %s logs as `unknown`', async (_label, requestId) => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody({ requestId }));
      expect(res.status).toBe(200);
      const lines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.split(' ')[2]).toBe('unknown');
    } finally {
      logSpy.mockRestore();
    }
  });
});
