/** Inbound router validation and action execution with gateway-resolved routes. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
// This suite exercises router validation against a fake tenant. The gateway
// wire framing has its own tests; preserve direct access to malformed action
// fixtures that the production decoder now rejects before the router.
vi.mock('../../../email-gateway/src/tenant-dispatch.ts', () => ({
  dispatchBoundedEmailToTenant: async (
    stub: { email: (envelope: unknown) => Promise<unknown> },
    _env: unknown,
    input: { envelope: unknown; receiptId: string },
  ) => {
    const actions = await stub.email(input.envelope);
    if (!Array.isArray(actions)) {
      throw new Error('invalid email tenant response');
    }
    return { actions, receiptId: input.receiptId };
  },
}));
import {
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
  routeInbound as routeInboundWithRoute,
  routeRelayed,
} from '../../src/email-router.ts';
import type { Env } from '../../src/types.ts';

async function routeInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
  route?: Parameters<typeof routeInboundWithRoute>[3],
) {
  const to = String(message.to).toLowerCase();
  return routeInboundWithRoute(
    message,
    env,
    ctx,
    route ?? {
      projectId: 'p_test',
      workerName: 'user-worker',
      deploymentId: 'v1',
      slug: to.split('@')[0]!.split('+')[0]!,
      addressing: 'shared',
      domain: to.split('@')[1]!,
    },
  );
}

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

const PROD_DOMAIN = 'mail.void.cloud';

/**
 * Reply bytes the way `replyEmail()` renders them: a `From:` header naming
 * the envelope sender, then a body. The router pins the MIME `From:` to
 * `action.from`, so a fixture without one is dropped before enaction.
 */
function replyRaw(from: string, body = 'reply body'): Uint8Array {
  return new TextEncoder().encode(`From: ${from}\r\n\r\n${body}\r\n`);
}
const STAGING_DOMAIN = 'mail.staging.void.cloud';

/** Frozen clock. Drives both quota buckets below. */
const FIXED_NOW = new Date('2026-04-29T12:34:56.000Z');
const MONTH_BUCKET = '2026-04';
const MINUTE_BUCKET = '20260429T1234';

const SENT_KEY = `email-sent:p_test:${MONTH_BUCKET}`;
const BURST_KEY = `email-burst:p_test:${MINUTE_BUCKET}`;
const RECV_KEY = `email-recv:p_test:${MONTH_BUCKET}`;

/** Default routing entry: project p_test, worker user-worker, no limits. */
const DEFAULT_ROUTING = JSON.stringify({
  workerName: 'user-worker',
  projectId: 'p_test',
});

// -----------------------------------------------------------------------
// KV mock — the inbound router only touches `get` + `put`.
// -----------------------------------------------------------------------

interface KvWrite {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

function createMockKv(seed: Record<string, string> = {}, failGetKeys: Array<string> = []) {
  const store = new Map<string, string>(Object.entries(seed));
  const writes: Array<KvWrite> = [];
  const failures = new Set(failGetKeys);
  const kv = {
    store,
    writes,
    get: vi.fn(async (key: string, _opts?: { cacheTtl?: number }) => {
      if (failures.has(key)) {
        throw new Error(`KV get failed for ${key}`);
      }
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      writes.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return kv;
}

// -----------------------------------------------------------------------
// Fake ForwardableEmailMessage. Records every method call — and their
// interleaved ORDER — so tests can assert on action enaction sequencing
// as well as side effects.
// -----------------------------------------------------------------------

interface RecordedForward {
  to: string;
  headers?: Headers;
}

interface RecordedReply {
  from: string;
  to: string;
  raw: unknown;
}

interface FakeMessage {
  message: ForwardableEmailMessage;
  rejectCalls: Array<string>;
  forwardCalls: Array<RecordedForward>;
  replyCalls: Array<RecordedReply>;
  /** Interleaved log across reject/forward/reply, in call order. */
  order: Array<string>;
}

function createFakeMessage(opts: {
  to: string;
  from?: string;
  rawBytes?: Uint8Array;
  rawSize?: number;
  subject?: string;
  /** When set, throws this error from every `forward()` call. */
  forwardError?: Error;
  /** When set, throws this error from every `reply()` call. */
  replyError?: Error;
  /**
   * When set, `message.headers` iterates these pairs instead of being a
   * real `Headers`. Shaped after workerd, where `entries()` snapshots the
   * bag into a `kj::Array` in C++ memory (`Headers::getDisplayedHeaders`)
   * that the V8 heap limit never sees. Node's undici `Headers` instead
   * caches a sorted copy of the WHOLE bag on the V8 heap on first
   * iteration (measured ~70 B per entry retained, 103 MB at 1.5M), so a
   * heap assertion through a real `Headers` here would measure undici,
   * not the router. Only what the router touches is modelled: iteration
   * and `get()`.
   */
  headerEntries?: Iterable<[string, string]>;
}): FakeMessage {
  const rawBytes = opts.rawBytes ?? new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
  const rejectCalls: Array<string> = [];
  const forwardCalls: Array<RecordedForward> = [];
  const replyCalls: Array<RecordedReply> = [];
  const order: Array<string> = [];
  const realHeaders = new Headers();
  if (opts.subject) {
    realHeaders.set('Subject', opts.subject);
  }
  const headerEntries = opts.headerEntries;
  const headers: Headers = headerEntries
    ? ({
        [Symbol.iterator]: () => headerEntries[Symbol.iterator](),
        get: () => null,
      } as unknown as Headers)
    : realHeaders;
  const message: Partial<ForwardableEmailMessage> & Record<string, unknown> = {
    from: opts.from ?? 'sender@example.com',
    to: opts.to,
    rawSize: opts.rawSize ?? rawBytes.byteLength,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rawBytes);
        controller.close();
      },
    }),
    setReject(reason: string) {
      rejectCalls.push(reason);
      order.push(`reject:${reason}`);
    },
    async forward(to: string, h?: Headers) {
      if (opts.forwardError) {
        throw opts.forwardError;
      }
      forwardCalls.push({ to, headers: h });
      order.push(`forward:${to}`);
    },
    async reply(reply: unknown) {
      const r = reply as RecordedReply;
      if (opts.replyError) {
        throw opts.replyError;
      }
      replyCalls.push(r);
      order.push(`reply:${r.from}->${r.to}`);
    },
  };
  return {
    message: message as ForwardableEmailMessage,
    rejectCalls,
    forwardCalls,
    replyCalls,
    order,
  };
}

// -----------------------------------------------------------------------
// ExecutionContext fake — captures `waitUntil` promises so we can assert
// log-recv was scheduled.
// -----------------------------------------------------------------------

function createCtx() {
  const waited: Array<Promise<unknown>> = [];
  const ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>) {
      waited.push(p);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

// -----------------------------------------------------------------------
// Env factory.
// -----------------------------------------------------------------------

interface MakeEnvOptions {
  kvSeed?: Record<string, string>;
  /** KV keys whose `get` throws — used to exercise fail-closed paths. */
  kvGetFailures?: Array<string>;
  /** When provided, the dispatch stub's `email()` returns this value. */
  emailReturn?: unknown;
  /** When provided, the dispatch stub's `email()` throws this. */
  emailThrow?: unknown;
  /** When provided, env.DISPATCH.get itself throws. */
  dispatchGetThrow?: Error;
  /**
   * `EMAIL_SENDER_DOMAIN`. Defaults to the production zone. Pass `null` to
   * omit the var entirely (the router must still route — see the
   * "sender domain is configuration" describe block).
   */
  senderDomain?: string | null;
}

function makeEnv(options: MakeEnvOptions = {}) {
  const kv = createMockKv(options.kvSeed ?? {}, options.kvGetFailures ?? []);
  const emailFn = vi.fn(async (_envelope: unknown) => {
    if (options.emailThrow) {
      throw options.emailThrow;
    }
    return options.emailReturn;
  });
  const dispatchGet = vi.fn((_name: string, _args?: unknown, _opts?: unknown) => {
    if (options.dispatchGetThrow) {
      throw options.dispatchGetThrow;
    }
    return { email: emailFn };
  });
  const senderDomain = options.senderDomain === undefined ? PROD_DOMAIN : options.senderDomain;
  const actions = new Map<
    string,
    {
      operationId: string;
      recipients: Array<{
        recipient: string;
        state: string;
        errorCode: string | null;
        providerReference: string | null;
      }>;
    }
  >();
  const apiFetch = vi.fn(async (request: Request | string, init?: RequestInit) => {
    const path = new URL(typeof request === 'string' ? request : request.url).pathname;
    const body = (
      typeof request === 'string' ? JSON.parse(String(init?.body)) : await request.json()
    ) as Record<string, unknown>;
    if (path.endsWith('/receipts')) {
      return Response.json({ ok: true });
    }
    if (path.endsWith('/admit')) {
      if (body.kind === 'forward' && body.transport === 'send_raw') {
        return Response.json({
          operationId: 'unsupported_forward',
          replay: false,
          recipients: (body.recipients as Array<string>).map((recipient) => ({
            recipient,
            state: 'rejected',
            errorCode: 'UNSUPPORTED_ACTION',
            providerReference: null,
          })),
        });
      }
      const key = body.key as string;
      const previous = actions.get(key);
      if (previous) {
        return Response.json({ ...previous, replay: true });
      }
      const recipients = (body.recipients as Array<string>).map((recipient) => ({
        recipient,
        state: 'reserved',
        errorCode: null,
        providerReference: null,
      }));
      const entry = { operationId: `act_${actions.size}`, recipients };
      actions.set(key, entry);
      return Response.json({ ...entry, replay: false });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((a) => a.operationId === operationId)!;
    for (const recipient of body.recipients as Array<string>) {
      const row = entry.recipients.find((r) => r.recipient === recipient)!;
      row.state = path.endsWith('/start') ? 'attempt_started' : (body.state as string);
      row.errorCode = (body.errorCode as string) ?? null;
    }
    return Response.json({ recipients: entry.recipients });
  });
  const env = {
    AI: {},
    JWT_SECRET: 'test-secret',
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'token',
    API: { fetch: apiFetch },
    DISPATCH: { get: dispatchGet },
    SEND_EMAIL: { send: vi.fn() },
    ...(senderDomain === null ? {} : { EMAIL_SENDER_DOMAIN: senderDomain }),
  } as unknown as Env;
  return { env, kv, emailFn, dispatchGet, apiFetch };
}

function apiBodies(
  apiFetch: ReturnType<typeof vi.fn>,
  suffix: string,
): Array<Record<string, unknown>> {
  return apiFetch.mock.calls
    .filter(([url]) => new URL(String(url)).pathname.endsWith(suffix))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

/** Routing + allowlist seed for the happy outbound-gate path. */
function withAllowlist(
  addresses: Array<string> = ['admin@example.com', 'support@example.com'],
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    myslug: DEFAULT_ROUTING,
    'email-allowlist:p_test': JSON.stringify(addresses),
    ...extra,
  };
}

// -----------------------------------------------------------------------
// Console spies + frozen clock. Every test runs under these.
// -----------------------------------------------------------------------

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Only `Date` is faked — setTimeout/queueMicrotask stay real so stream
  // reads and vitest's own timeouts are unaffected.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  vi.useRealTimers();
});

// -----------------------------------------------------------------------
// Shared-address parsing
// -----------------------------------------------------------------------

describe('routeInbound — shared-address parsing', () => {
  it('rejects when recipient has no slug (bare +tag@…)', async () => {
    const { env, dispatchGet } = makeEnv();
    const { message, rejectCalls } = createFakeMessage({ to: `+orphan@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('missing project slug');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('routes a tag-less recipient (whole local-part is the slug)', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
    // The user worker sees the full, untruncated recipient.
    const envelope = emailFn.mock.calls[0]?.[0] as { to: string };
    expect(envelope.to).toBe(`myslug@${PROD_DOMAIN}`);
  });

  it('uppercase recipients are lowercased before dispatch', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({ to: `MySlug+Tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
// Gateway-resolved routing and delivery limits.
// -----------------------------------------------------------------------

describe('routeInbound — authoritative routing', () => {
  it('rejects a route for another domain before dispatch', async () => {
    const { env, dispatchGet } = makeEnv();
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx, {
      projectId: 'p_test',
      workerName: 'user-worker',
      deploymentId: 'v1',
      slug: 'myslug',
      addressing: 'shared',
      domain: 'other.example.com',
    });
    expect(rejectCalls[0]).toContain('authoritative route mismatch');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('passes the resolved route limits to tenant dispatch', async () => {
    const { env, dispatchGet } = makeEnv({ emailReturn: [] });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const limits = { cpuMs: 1000 };
    await routeInbound(message, env, ctx, {
      projectId: 'p_test',
      workerName: 'user-worker',
      deploymentId: 'v1',
      slug: 'myslug',
      addressing: 'shared',
      domain: PROD_DOMAIN,
      limits,
    });
    expect(dispatchGet).toHaveBeenCalledWith('user-worker', {}, { limits });
  });

  it('leaves a failed tenant dispatch unresolved for the gateway', async () => {
    const { env } = makeEnv({ emailThrow: new Error('boom') });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await expect(routeInbound(message, env, ctx)).rejects.toThrow(
      'email handler execution unresolved',
    );
    expect(waited).toHaveLength(0);
  });
});

describe('routeInbound — message size guards', () => {
  it('rejects messages exceeding rawSize > 10MB before streaming', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING } });
    const { message, rejectCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
      rawBytes: new Uint8Array(0),
      // Lie about size: pre-stream rawSize > cap.
      rawSize: 11 * 1024 * 1024,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('too large');
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('rejects when stream overflow exceeds cap (rawSize lied)', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING } });
    // rawSize claims 1KB but the stream actually carries 11MB.
    const big = new Uint8Array(11 * 1024 * 1024);
    const { message, rejectCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
      rawBytes: big,
      rawSize: 1024,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('too large');
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('accepts a message just under the cap', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
      rawBytes: new Uint8Array(10 * 1024 * 1024),
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
// Header count cap. The byte cap bounds the bag's bytes, not its count,
// and `Object.fromEntries` pays ~75–110 B of V8 heap per distinct name
// against 7 wire bytes per line — so a 10 MiB message of short distinct
// headers (~1.5M of them) is an OOM in the 128 MB proxy isolate before
// dispatch. The router counts first and refuses over the cap.
// -----------------------------------------------------------------------

describe('routeInbound — inbound header count cap', () => {
  const MAX_INBOUND_HEADERS = 1024;

  function* distinctHeaders(n: number): Generator<[string, string]> {
    for (let i = 0; i < n; i++) {
      yield [`h${i.toString(36)}`, 'v'];
    }
  }

  it('rejects a message carrying more distinct headers than the cap, before dispatch', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    for (const [name, value] of distinctHeaders(MAX_INBOUND_HEADERS + 1)) {
      message.headers.append(name, value);
    }
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toBe(`${PROD_DOMAIN}: too many headers (max ${MAX_INBOUND_HEADERS})`);
    expect(emailFn).not.toHaveBeenCalled();
    // Same shape as the byte-cap refusal: no dispatch, no recv log.
    expect(waited).toHaveLength(0);
  });

  it('dispatches a message with exactly the cap, every header in the envelope', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    for (const [name, value] of distinctHeaders(MAX_INBOUND_HEADERS)) {
      message.headers.append(name, value);
    }
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
    const envelope = emailFn.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(Object.keys(envelope.headers)).toHaveLength(MAX_INBOUND_HEADERS);
    expect(envelope.headers['h0']).toBe('v');
    expect(envelope.headers[`h${(MAX_INBOUND_HEADERS - 1).toString(36)}`]).toBe('v');
  });

  it('a 1.5M-header bag — what the byte cap admits — is refused in bounded time and heap', async () => {
    // 1.5M distinct names at 7 wire bytes each (`abcd:\r\n`) fits the
    // 10 MiB byte cap. Materializing them measured 158 MB retained and
    // ~580 ms in Node, ~1.2 s of CPU in workerd, and a hard OOM under a
    // 128 MB heap. The bag is a workerd-shaped iterable (see
    // `headerEntries`), so the heap read below is the router's own cost:
    // the first `MAX_INBOUND_HEADERS + 1` pairs, then the refusal.
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
      headerEntries: distinctHeaders(1_500_000),
    });
    const { ctx } = createCtx();
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    const elapsed = performance.now() - t0;
    const grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('too many headers');
    expect(emailFn).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(100);
    expect(grew).toBeLessThan(32);
  });
});

// -----------------------------------------------------------------------
// Dispatch result handling
// -----------------------------------------------------------------------

describe('routeInbound — action enaction', () => {
  it('drops the WHOLE list when a tenant returns more than 100 actions', async () => {
    // The tenant worker is not trusted to have capped its own queue: on WfP
    // it can ship any WorkerEntrypoint whose email() returns any array. The
    // list is walked HERE, in the shared proxy isolate, before any quota gate
    // has charged for it — so the count is checked before the loop.
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: Array.from({ length: 101 }, () => ({
        type: 'forward',
        to: 'admin@example.com',
      })),
    });
    const { message, forwardCalls, replyCalls, rejectCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
    // Dropping the list is not a bounce — CF still accepted the message.
    expect(rejectCalls).toHaveLength(0);
    // Nothing was charged: the list never reached the gate.
    expect(kv.writes.filter((w) => w.key.startsWith('email-sent:'))).toHaveLength(0);
    expect(kv.writes.filter((w) => w.key.startsWith('email-burst:'))).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('enacts a list of exactly 100 actions', async () => {
    // The bound is > MAX_ACTIONS, not >=.
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        // Burst/month caps must clear 100 for this to be about the action
        // count rather than the quota.
        'email-burst-limit:p_test': '1000',
        'email-limit:p_test': '1000',
      }),
      emailReturn: Array.from({ length: 100 }, () => ({
        type: 'forward',
        to: 'admin@example.com',
      })),
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(100);
  });

  it('reject is terminal: forward and reply after a reject do NOT fire', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        { type: 'reject', reason: 'spam' },
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'sender@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'reply body'),
        },
      ],
    });
    const { message, rejectCalls, forwardCalls, replyCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual(['spam']);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
  });

  it('a reject with no reason gets the default reason', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [{ type: 'reject' }],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual(['rejected by handler']);
  });

  it('forward followed by reply: both fire in order', async () => {
    // Both targets must be in the per-project allowlist (HIGH H1).
    const { env } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'reply body'),
        },
      ],
    });
    const { message, forwardCalls, replyCalls, order } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.to).toBe('admin@example.com');
    expect(replyCalls).toHaveLength(1);
    expect(order).toEqual([
      'forward:admin@example.com',
      `reply:myslug+support@${PROD_DOMAIN}->admin@example.com`,
    ]);
  });

  it('enacts the list in DECLARATION order across mixed action types', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'support@example.com', 'ops@example.com']),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'ops@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'r'),
        },
        { type: 'forward', to: 'ops@example.com' },
      ],
    });
    const { message, order } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(order).toEqual([
      'forward:admin@example.com',
      `reply:myslug+support@${PROD_DOMAIN}->ops@example.com`,
      'forward:ops@example.com',
    ]);
  });

  it('rejects a whole action list with an invalid forward address', async () => {
    const { env, apiFetch } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        { type: 'forward', to: 'not-an-email' },
        { type: 'forward', to: 'has\x00control@example.com' },
        { type: 'forward', to: 'no-at-sign-here' },
        { type: 'forward', to: 'admin@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(apiBodies(apiFetch, '/receipts').at(-1)?.status).toBe('actions_rejected');
  });

  it('reply with invalid from/to is dropped with console.error', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        {
          type: 'reply',
          from: 'not-an-email',
          to: 'admin@example.com',
          raw: new Uint8Array(),
        },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'no-at-sign',
          raw: new Uint8Array(),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reject reason with CR/LF/NUL is sanitized', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [
        {
          type: 'reject',
          reason: 'spam\r\nX-Inject: foo\nbar\x00null',
        },
      ],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    // No CR, LF, or NUL bytes left. Build via RegExp() to satisfy
    // oxlint's no-control-regex rule (mirrors the production-side
    // dodge in src/email-router.ts).
    // oxlint-disable-next-line no-control-regex
    expect(rejectCalls[0]).not.toMatch(new RegExp('[\\r\\n\\u0000]'));
  });

  it('a throwing forward is logged and does not abort the list', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, forwardCalls, replyCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
      forwardError: new Error('destination not verified'),
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    // The later reply still fires…
    expect(replyCalls).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reply carries the action bytes through EmailMessage, not a decoded string', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'reply body'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(`myslug+support@${PROD_DOMAIN}`);
    expect(replyCalls[0]?.to).toBe('admin@example.com');
    expect(replyCalls[0]?.raw).toBeInstanceOf(ReadableStream);
  });
});

// -----------------------------------------------------------------------
// HIGH H2 — two-phase validate-then-enact split.
//
// Header construction (`new Headers(...)`) throws on CRLF / NUL. Under a
// single-pass impl an earlier forward/reply would already have fired by
// the time the bad headers are reached. Validation therefore runs over
// the WHOLE list first, and any header failure drops everything.
// -----------------------------------------------------------------------

describe('routeInbound — envelope header bag (prototype pollution guard)', () => {
  it('survives a __proto__ header in the inbound message', async () => {
    // Inject a __proto__-named header on the inbound side. The router
    // pre-buffers headers with Object.fromEntries so the framework
    // sees it as a plain string property, not as a prototype mutation.
    const { env, emailFn } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [],
    });
    const { message } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    // Force-add a proto-named header.
    message.headers.set('__proto__', 'evil');
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    // Pull the envelope passed into emailFn; assert the header bag is an
    // ORDINARY object (workerd RPC refuses to serialize a null-prototype
    // one) and that the __proto__ key is a real own property (not a
    // prototype mutation that affects {}).
    const envelope = emailFn.mock.calls[0]?.[0] as { headers: Record<string, string> };
    expect(Object.getPrototypeOf(envelope.headers)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(envelope.headers, '__proto__')).toBe(true);
    expect(envelope.headers['__proto__']).toBe('evil');
    // Nothing leaked onto Object.prototype.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['evil']).toBeUndefined();
  });

  it('serializes the envelope with RPC-safe primitives only', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [],
    });
    const body = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    const { message } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
      from: 'sender@example.com',
      rawBytes: body,
      subject: 'hi',
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    const envelope = emailFn.mock.calls[0]?.[0] as {
      from: string;
      to: string;
      raw: Uint8Array;
      rawSize: number;
      headers: Record<string, string>;
    };
    expect(envelope.from).toBe('sender@example.com');
    expect(envelope.to).toBe(`myslug+tag@${PROD_DOMAIN}`);
    // Pre-buffered bytes, not a stream — the framework must be able to
    // replay them after parseEmail consumes a copy.
    expect(envelope.raw).toBeInstanceOf(Uint8Array);
    expect(envelope.raw.byteLength).toBe(body.byteLength);
    expect(envelope.rawSize).toBe(body.byteLength);
    expect(envelope.headers['subject']).toBe('hi');
  });
});

// -----------------------------------------------------------------------
// log-recv via ctx.waitUntil
// -----------------------------------------------------------------------

describe('routeInbound — log-recv via ctx.waitUntil', () => {
  it('schedules log-recv after a successful dispatch', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [],
    });
    const { message } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
      subject: 'hello',
    });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  // Invalid action data must not prevent inbound delivery from being logged.
  it('logs the inbound delivery even when the action list carries a non-object entry', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [null, { type: 'forward', to: 'admin@example.com' }],
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.allSettled(waited);
    expect(logSpy).toHaveBeenCalled();
  });
});

// Recipient consent and atomic quotas are covered by the API admission integration tests.

describe('routeInbound — authoritative native custom domain', () => {
  it('dispatches the full custom recipient without KV and enacts native forward and reply', async () => {
    const from = 'support@custom.example.com';
    const { env, kv, emailFn, dispatchGet, apiFetch } = makeEnv({
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        { type: 'reply', from, to: 'sender@example.com', raw: replyRaw(from) },
      ],
    });
    const { message, forwardCalls, replyCalls, rejectCalls } = createFakeMessage({
      to: 'support@custom.example.com',
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx, {
      projectId: 'p_test',
      workerName: 'custom-worker',
      deploymentId: 'v1',
      slug: 'myslug',
      addressing: 'custom',
      domain: 'custom.example.com',
    });
    expect(dispatchGet).toHaveBeenCalledWith('custom-worker');
    expect(emailFn).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@custom.example.com',
        viaDomain: 'custom.example.com',
      }),
    );
    expect(kv.get).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(1);
    expect(replyCalls).toHaveLength(1);
    expect(rejectCalls).toHaveLength(0);
    expect(apiBodies(apiFetch, '/admit').map((body) => body.transport)).toEqual([
      'native_forward',
      'native_reply',
    ]);
  });
});

describe('routeInbound — receipt checkpoint', () => {
  it('does not bounce accepted mail when handler completion cannot be recorded', async () => {
    const { env, apiFetch } = makeEnv({ emailReturn: [] });
    const normalFetch = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url, init) => {
      if (
        String(url).endsWith('/receipts') &&
        JSON.parse(String(init?.body)).status === 'handler_completed'
      ) {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      return normalFetch(url, init);
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual([]);
  });
});

describe('routeRelayed — unsupported forward', () => {
  it('records an unsupported action without resending inbound MIME', async () => {
    const { env, apiFetch } = makeEnv({
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { ctx } = createCtx();
    const outcome = await routeRelayed(env, ctx, {
      projectId: 'p_test',
      domain: 'custom.example.com',
      receiptId: 'receipt_1',
      envelope: {
        from: 'sender@example.com',
        to: 'support@custom.example.com',
        headers: {},
        raw: new TextEncoder().encode('From: sender@example.com\r\n\r\nbody'),
        rawSize: 42,
      },
      authoritative: {
        projectId: 'p_test',
        workerName: 'user-worker',
        deploymentId: 'v1',
        slug: 'myslug',
        addressing: 'custom',
        domain: 'custom.example.com',
      },
    });
    expect(outcome.reject).toBe(false);
    expect(apiBodies(apiFetch, '/admit')[0]?.transport).toBe('send_raw');
    expect(apiBodies(apiFetch, '/admit')[0]?.kind).toBe('forward');
    expect(apiBodies(apiFetch, '/start')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('routeInbound — reply size limits', () => {
  const MIB = 1024 * 1024;
  const SENDER = `myslug+support@${PROD_DOMAIN}`;

  /** `size` bytes of reply MIME with a valid `From:` naming the sender. */
  function sizedReply(size: number, from = SENDER): Uint8Array {
    const head = new TextEncoder().encode(`From: ${from}\r\n\r\n`);
    const raw = new Uint8Array(size);
    raw.set(head);
    raw.fill(0x41, head.length);
    return raw;
  }

  function replyAction(raw: Uint8Array) {
    return { type: 'reply', from: SENDER, to: 'admin@example.com', raw };
  }

  it('drops a reply over 5 MiB before the MIME From scan', async () => {
    // No `From:` header at all: if the size check ran AFTER the scan, the
    // drop would be logged as a missing From header instead.
    const raw = new Uint8Array(5 * MIB + 1).fill(0x41);
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [replyAction(raw)],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`reply dropped: raw is ${5 * MIB + 1} bytes (max ${5 * MIB})`),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('no From header'));
    expect(kv.store.get(SENT_KEY)).toBeUndefined();
  });

  it('accepts a reply of exactly 5 MiB', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [replyAction(sizedReply(5 * MIB))],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(SENDER);
  });

  it('rejects a whole list that exceeds the 8 MiB cumulative reply budget', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        replyAction(sizedReply(3 * MIB)),
        replyAction(sizedReply(3 * MIB)),
        replyAction(sizedReply(3 * MIB)),
        replyAction(sizedReply(2 * MIB)),
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `reply dropped: cumulative reply bytes ${9 * MIB} exceed this delivery's budget of ${8 * MIB}`,
      ),
    );
  });
});
