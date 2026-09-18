/**
 * Tests for the proxy worker's inbound email router (`email-router.ts`).
 *
 * Bound as the catch-all CF Email Routing rule on the zone named by the
 * `EMAIL_SENDER_DOMAIN` var (`mail.void.cloud` in production,
 * `mail.staging.void.cloud` in staging). The router parses `<slug>+<tag>`
 * from the recipient, looks up the project's worker name in `ROUTING` KV,
 * dispatches into the user worker via the WfP namespace stub's
 * `email(envelope)` RPC method, and enacts the returned action queue on the
 * real `ForwardableEmailMessage`.
 *
 * These tests cover the seams the neighbouring `email.test.ts` doesn't:
 * slug parsing, KV lookup misses / corruption, platform suspension, the
 * email-only suspend kill-switch, per-project dispatch limits, size caps,
 * dispatch error classification, action enaction (terminal-reject,
 * declaration-order enaction, address validation, header injection guards),
 * the per-project allowlist + quota gate on forward/reply (HIGH H1), and
 * the two-phase validate/enact split (HIGH H2).
 *
 * Patterns mirror `email.test.ts`: in-memory KV mock, vi.fn'd dispatch
 * stub, fake `ForwardableEmailMessage`. We never spin up a real worker —
 * we exercise `routeInbound` directly with synthetic message objects.
 *
 * Time is frozen (`toFake: ['Date']` only — real timers still run) so the
 * minute/month quota buckets are deterministic instead of racing a bucket
 * rollover between seeding KV and reading it back.
 */

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
// The framework's own proxy — the record-time twin of this router's bounds.
// The platform depends on the framework, never the reverse, so the router
// cannot import its numbers; this test is where the two are pinned equal.
import {
  createMessageProxy,
  MAX_FORWARD_HEADER_LENGTH as FRAMEWORK_MAX_FORWARD_HEADER_LENGTH,
  MAX_FORWARD_HEADERS as FRAMEWORK_MAX_FORWARD_HEADERS,
  MAX_INBOUND_BYTES as FRAMEWORK_MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS as FRAMEWORK_MAX_INBOUND_HEADERS,
  MAX_REJECT_REASON_LENGTH as FRAMEWORK_MAX_REJECT_REASON_LENGTH,
} from '../../../../../packages/void/src/runtime/email/inbound.ts';
import { validateAddressParts } from '../../../../../packages/void/src/runtime/email/mime.ts';
import { createInboundTestHarness } from '../../../../../packages/void/src/runtime/email/testing.ts';
import {
  isValidEmailAddress,
  MAX_FORWARD_HEADER_LENGTH,
  MAX_FORWARD_HEADERS,
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
  MAX_REJECT_REASON_LENGTH,
  routeInbound,
} from '../../src/email-router.ts';
import type { Env } from '../../src/types.ts';

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
  return { env, kv, emailFn, dispatchGet };
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
// Slug parsing + KV lookup
// -----------------------------------------------------------------------

describe('routeInbound — slug parsing + KV lookup', () => {
  it('rejects when recipient has no slug (bare +tag@…)', async () => {
    const { env, dispatchGet } = makeEnv();
    const { message, rejectCalls } = createFakeMessage({ to: `+orphan@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('missing project slug');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('rejects when slug is missing in ROUTING KV', async () => {
    const { env, dispatchGet } = makeEnv();
    const { message, rejectCalls } = createFakeMessage({ to: `unknown+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('no project found');
    expect(rejectCalls[0]).toContain('unknown');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('rejects when routing JSON is corrupt', async () => {
    const { env } = makeEnv({ kvSeed: { myslug: '{this is not json' } });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('routing data corrupt');
  });

  // `JSON.parse` succeeds on `null`, on a bare number and on a string, none of
  // which carry a suspension marker to read. Reaching for `.suspended` on
  // `null` throws out of the handler, and a non-string marker crashes the
  // reject formatter. Both are the same defect as the outbound `corrupt`
  // case: the suspension state is unknown, so the message must be refused.
  it('rejects a routing blob that parses to null', async () => {
    const { env, dispatchGet } = makeEnv({ kvSeed: { myslug: 'null' } });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('routing data corrupt');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('rejects a routing blob that parses to a non-object', async () => {
    const { env, dispatchGet } = makeEnv({ kvSeed: { myslug: '42' } });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('routing data corrupt');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('rejects a non-string suspension marker instead of crashing the formatter', async () => {
    const { env, dispatchGet } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({ workerName: 'w_test', projectId: 'p_test', suspended: 1 }),
      },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('suspended');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('rejects when routing.workerName is missing (static deploy)', async () => {
    const { env, dispatchGet } = makeEnv({
      kvSeed: { myslug: JSON.stringify({ projectId: 'p_test' }) },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('no worker (static deploy)');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  // `workerName` is declared `string` but arrives from KV, exactly like
  // `suspended` above. A truthy non-string passed the `!workerName` check and
  // reached `DISPATCH.get`; every failure handler after that point renders
  // the name through `sanitize`, whose `.slice`/`.replace` throw on a
  // non-string — so a worker that could not be reached surfaced as an
  // unhandled handler error instead of a reject. No producer writes a
  // non-string name (`buildRoutingJson` types it), so it is corrupt data.
  it.each([
    ['a number', 42],
    ['an object', {}],
    ['a boolean', true],
    ['an array', ['user-worker']],
  ])('rejects a routing blob whose workerName is %s as corrupt', async (_kind, workerName) => {
    const { env, dispatchGet } = makeEnv({
      kvSeed: { myslug: JSON.stringify({ workerName, projectId: 'p_test' }) },
      // The realistic failure: a stub for a name no worker has throws at
      // call time, and the catch block is what used to crash.
      emailThrow: new Error('Worker not found'),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await expect(routeInbound(message, env, ctx)).resolves.toBeUndefined();
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('routing data corrupt');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('an empty-string workerName still reads as a static deploy', async () => {
    const { env, dispatchGet } = makeEnv({
      kvSeed: { myslug: JSON.stringify({ workerName: '', projectId: 'p_test' }) },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('no worker (static deploy)');
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  // `projectId` is the other KV-sourced field the router keys a control on.
  // The email-only kill-switch is `email-suspended:<projectId>`, built with a
  // template literal: `42` becomes `email-suspended:42`, `{}` becomes
  // `email-suspended:[object Object]`, `''` becomes `email-suspended:` — keys
  // no writer has ever set — so the lookup missed and a project suspended
  // under its real id kept receiving mail. A number also reaches `sanitize`
  // from the gate-load and counter-put failure handlers, where `.slice`
  // throws inside a catch. Every worker routing has carried a string id since
  // the first writer, so absent / null / empty / mistyped is corrupt data:
  // the suspension state cannot be read, and the message must not run.
  it.each([
    ['a number', 42],
    ['an object', {}],
    ['a boolean', true],
    ['an array', ['p_test']],
    ['an empty string', ''],
    ['null', null],
    ['absent', undefined],
  ])('rejects a routing blob whose projectId is %s as corrupt', async (_kind, projectId) => {
    const { env, kv, emailFn, dispatchGet } = makeEnv({
      kvSeed: {
        // `JSON.stringify` drops an `undefined` value, so that row seeds a
        // blob with no `projectId` key at all.
        myslug: JSON.stringify({ workerName: 'user-worker', projectId }),
        // The real project IS suspended under its real id. Before the guard
        // the coerced key missed this row and the message was dispatched.
        'email-suspended:p_test': '2026-04-29T00:00:00Z',
      },
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, rejectCalls, forwardCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx, waited } = createCtx();
    await expect(routeInbound(message, env, ctx)).resolves.toBeUndefined();
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: routing data corrupt`]);
    // No suspension lookup was even attempted on a key built from the bad
    // value — the guard sits in front of it.
    const suspensionLookups = kv.get.mock.calls
      .map((call) => call[0])
      .filter((key) => key.startsWith('email-suspended:'));
    expect(suspensionLookups).toEqual([]);
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
    // Refused before dispatch, so nothing is scheduled for log-recv either.
    expect(waited).toHaveLength(0);
  });

  it('a string projectId reaches the email-only suspension lookup', async () => {
    const { env, kv, emailFn, dispatchGet } = makeEnv({
      kvSeed: {
        myslug: DEFAULT_ROUTING,
        'email-suspended:p_test': '2026-04-29T00:00:00Z',
      },
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, rejectCalls, forwardCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(kv.get).toHaveBeenCalledWith('email-suspended:p_test');
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: project "myslug" inbound is suspended`]);
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
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

  it('uppercase recipients are lowercased before the slug lookup', async () => {
    const { env, emailFn } = makeEnv({ kvSeed: { myslug: DEFAULT_ROUTING }, emailReturn: [] });
    const { message, rejectCalls } = createFakeMessage({ to: `MySlug+Tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
// The mail zone is CONFIGURATION, not a baked-in constant.
//
// Re-land contract change: `EMAIL_SENDER_DOMAIN` names the zone. The
// inbound router uses it only as the bounce LABEL, and deliberately does
// NOT fail closed when it's absent — nothing about routing depends on the
// domain, so dropping legitimate mail over a cosmetic var would be worse.
// -----------------------------------------------------------------------

describe('routeInbound — sender domain is configuration, not a constant', () => {
  it('prefixes reject reasons with the configured production zone', async () => {
    const { env } = makeEnv({ senderDomain: PROD_DOMAIN });
    const { message, rejectCalls } = createFakeMessage({ to: `unknown@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls[0]).toMatch(new RegExp(`^${PROD_DOMAIN.replace(/\./g, '\\.')}: `));
  });

  it('prefixes reject reasons with the configured staging zone', async () => {
    const { env } = makeEnv({ senderDomain: STAGING_DOMAIN });
    const { message, rejectCalls } = createFakeMessage({ to: `unknown@${STAGING_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls[0]).toMatch(new RegExp(`^${STAGING_DOMAIN.replace(/\./g, '\\.')}: `));
    // No baked-in production domain leaks into a staging bounce.
    expect(rejectCalls[0]).not.toContain(`${PROD_DOMAIN}:`);
  });

  it('falls back to a neutral label when the var is missing — and still routes', async () => {
    const { env, emailFn } = makeEnv({
      senderDomain: null,
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    // Deliberately NOT fail-closed: inbound routing doesn't depend on the
    // zone name, so a missing var must not drop legitimate mail.
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });

  it('uses the neutral label (never a baked-in domain) in bounces when unset', async () => {
    const { env } = makeEnv({ senderDomain: null });
    const { message, rejectCalls } = createFakeMessage({ to: `unknown@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls[0]).toMatch(/^void email: /);
    expect(rejectCalls[0]).not.toContain(PROD_DOMAIN);
  });

  it('treats a blank sender domain as unset', async () => {
    const { env } = makeEnv({ senderDomain: '   ' });
    const { message, rejectCalls } = createFakeMessage({ to: `unknown@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls[0]).toMatch(/^void email: /);
  });
});

// -----------------------------------------------------------------------
// Platform suspension (`routing.suspended`) — NEW in the re-land.
//
// The same marker `applyRoutingSuspension` writes and `packages/dispatch`
// answers with a 429. Running a suspended tenant's code on platform CPU
// is exactly what suspension exists to stop, so inbound mail must honour
// it too — and it is a SEPARATE control from `email-suspended:<projectId>`.
// -----------------------------------------------------------------------

describe('routeInbound — platform suspension via routing.suspended', () => {
  const SUSPENDED_ROUTING = JSON.stringify({
    workerName: 'user-worker',
    projectId: 'p_test',
    suspended: 'abuse',
  });

  it('rejects and never dispatches when routing.suspended is set', async () => {
    const { env, emailFn, dispatchGet } = makeEnv({
      kvSeed: { myslug: SUSPENDED_ROUTING },
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, rejectCalls, forwardCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('is suspended');
    expect(rejectCalls[0]).toContain('abuse');
    // The tenant's worker must not be resolved at all, let alone run.
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
  });

  it('platform suspension alone is enough — no email-suspended key needed', async () => {
    const { env, kv, dispatchGet } = makeEnv({ kvSeed: { myslug: SUSPENDED_ROUTING } });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(kv.store.has('email-suspended:p_test')).toBe(false);
    expect(rejectCalls).toHaveLength(1);
    expect(dispatchGet).not.toHaveBeenCalled();
  });

  it('email-only suspension alone is enough — no routing.suspended needed', async () => {
    const { env, emailFn, dispatchGet } = makeEnv({
      kvSeed: {
        myslug: DEFAULT_ROUTING,
        'email-suspended:p_test': '2026-04-29T00:00:00Z',
      },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('inbound is suspended');
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
  });

  it('platform suspension takes precedence when BOTH switches are set', async () => {
    const { env } = makeEnv({
      kvSeed: {
        myslug: SUSPENDED_ROUTING,
        'email-suspended:p_test': '1',
      },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    // The platform-suspension bounce, not the email-only one.
    expect(rejectCalls[0]).toContain('abuse');
    expect(rejectCalls[0]).not.toContain('inbound is suspended');
  });

  it('platform suspension outranks the static-deploy check', async () => {
    const { env } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({ projectId: 'p_test', suspended: 'abuse' }),
      },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls[0]).toContain('is suspended');
    expect(rejectCalls[0]).not.toContain('static deploy');
  });

  it('sanitizes a control-char suspension reason before it reaches the MTA', async () => {
    const { env } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({
          workerName: 'user-worker',
          projectId: 'p_test',
          suspended: 'abuse\r\nX-Inject: y\x00',
        }),
      },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    // oxlint-disable-next-line no-control-regex
    expect(rejectCalls[0]).not.toMatch(new RegExp('[\\r\\n\\u0000]'));
  });

  it('a falsy/absent suspended field does not block routing', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({ workerName: 'user-worker', projectId: 'p_test', suspended: '' }),
      },
      emailReturn: [],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
// Per-project dispatch limits — NEW in the re-land.
//
// Inbound mail dispatches into the same tenant worker as HTTP, so it has
// to pass the same `{ limits }` `packages/dispatch` passes. Without it,
// anyone who can send mail to a project's address runs that tenant's
// worker at the namespace default instead of its configured ceiling.
// -----------------------------------------------------------------------

describe('routeInbound — per-project dispatch limits', () => {
  it('passes routing.limits through to DISPATCH.get as the third argument', async () => {
    const limits = { cpuMs: 1234, subRequests: 60 };
    const { env, emailFn, dispatchGet } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({ workerName: 'user-worker', projectId: 'p_test', limits }),
      },
      emailReturn: [],
    });
    const { message } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(dispatchGet).toHaveBeenCalledTimes(1);
    const call = dispatchGet.mock.calls[0] as [string, unknown, unknown];
    expect(call[0]).toBe('user-worker');
    expect(call[1]).toEqual({});
    // The point of the case: the limits object itself, not just that a
    // dispatch happened.
    expect(call[2]).toEqual({ limits });
    expect(emailFn).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate a limits object when routing carries none', async () => {
    const { env, emailFn, dispatchGet } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [],
    });
    const { message } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(dispatchGet).toHaveBeenCalledTimes(1);
    // Exactly one argument — no `{ limits: undefined }` handed to the
    // namespace, which is not the same thing as "no limits".
    expect(dispatchGet.mock.calls[0]).toEqual(['user-worker']);
    expect(emailFn).toHaveBeenCalledTimes(1);
  });

  it('a suspended project never reaches DISPATCH.get, limits or not', async () => {
    const { env, dispatchGet } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({
          workerName: 'user-worker',
          projectId: 'p_test',
          limits: { cpuMs: 50 },
          suspended: 'abuse',
        }),
      },
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(dispatchGet).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// Size guards
// -----------------------------------------------------------------------

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

describe('routeInbound — dispatch result handling', () => {
  it('rejects an undefined action response', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: undefined,
    });
    const { message, rejectCalls, forwardCalls, replyCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(emailFn).toHaveBeenCalled();
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: project handler error`]);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
  });

  it('rejects a null action response', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: null,
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: project handler error`]);
  });

  it('rejects a non-array action response', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: { actions: [] },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: project handler error`]);
  });

  it('classifies workerd "does not implement the method" as no-handler reject', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new TypeError('The RPC receiver does not implement the method "email"'),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('no email handler');
  });

  it('inspects only a bounded prefix of a thrown message: a 1 MB one classifies in milliseconds', async () => {
    // `receiver does not.*method` backtracks quadratically when the message
    // repeats the prefix without the suffix — 1 MB was 21 s of CPU on the
    // whole string. The prefix keeps workerd's own text recognizable.
    const filler = 'receiver does not '.repeat(60_000);
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new Error(filler),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('project handler error');
  });

  it('never coerces a non-Error throw whole: a 30 MB Uint8Array is described by kind', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new Uint8Array(30 * 1024 * 1024),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('project handler error');
  });

  it('classifies other dispatch errors as project handler error', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new Error('something else'),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('project handler error');
  });

  it('rejects when DISPATCH.get itself throws', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      dispatchGetThrow: new Error('namespace unavailable'),
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toContain('worker unavailable');
  });
});

// -----------------------------------------------------------------------
// Action enaction
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

  it('drops a forward whose `to` is a megabyte long', async () => {
    // The address matches VALID_ADDRESS_RE and is IN the allowlist, so
    // nothing downstream would have stopped it: the only thing standing
    // between a 1 MiB string and the address regex is the length check.
    const hugeTo = `${'a'.repeat(1024 * 1024)}@example.com`;
    const { env } = makeEnv({
      kvSeed: withAllowlist([hugeTo, 'admin@example.com']),
      emailReturn: [{ type: 'forward', to: hugeTo }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops the WHOLE list when a forward carries too many headers', async () => {
    // Same response as header construction throwing: an oversized bag says
    // the handler is hostile, and partially enacting its list is worse.
    const headers: Record<string, string> = {};
    for (let i = 0; i < 33; i++) {
      headers[`X-Void-${i}`] = 'v';
    }
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'ops@example.com']),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com', headers },
        { type: 'forward', to: 'ops@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops the WHOLE list when a forward header value is over-long', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'forward',
          to: 'admin@example.com',
          headers: { 'X-Void-Tag': 'v'.repeat(1025) },
        },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops the WHOLE list when forward headers is not a plain object, before enumerating it', async () => {
    // A tenant can return anything as `headers`. `Object.entries` walks one
    // own property PER ELEMENT of a string, a `String`, an Array or a typed
    // array (~100 B each — measured OOM at a 1.5 MiB string under a 128 MB
    // heap), and `for…in` / `Object.keys` are no better: V8 builds the whole
    // key set before the first iteration. The old `new Headers(x)` threw in
    // O(1) on every one of these shapes, so the shape check has to be what
    // stops them, and it has to fire BEFORE the count — the count is what
    // enumerates. The log line pins which branch fired.
    const shapes: Array<[string, unknown]> = [
      ['string', 'a'.repeat(64)],
      ['String wrapper', new String('a'.repeat(64))],
      ['array of pairs', [['X-Void-Tag', 'v']]],
      ['typed array', new Uint8Array(64)],
    ];
    for (const [label, headers] of shapes) {
      errorSpy.mockClear();
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com', 'ops@example.com']),
        emailReturn: [
          { type: 'forward', to: 'admin@example.com', headers },
          { type: 'forward', to: 'ops@example.com' },
        ],
      });
      const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(forwardCalls, label).toHaveLength(0);
      expect(errorSpy, label).toHaveBeenCalledWith(
        expect.stringContaining('forward headers is not a plain object'),
      );
    }
  });

  it('drops the WHOLE list when a forward header VALUE is not a string', async () => {
    // The bag is a plain object (passes the shape check), but a VALUE crossed
    // RPC as an Array / typed array / number. `typeof value === 'string'`
    // skipped the length bound, and `new Headers({ x: <Array> })` does NOT
    // throw — it coerces with `String()`, joining an Array into one giant
    // comma-separated value ~30x its wire size (a Date-filled Array OOMs a
    // 128 MB isolate from a ~4 MiB RPC payload). So an RPC-sized nested value
    // evaded the 1024-char bound entirely. Every value must be a string.
    const shapes: Array<[string, unknown]> = [
      ['array of strings', new Array(8).fill('a')],
      ['nested array', [new Array(4).fill('a')]],
      ['typed array', new Uint8Array(8).fill(255)],
      ['number', 12345],
    ];
    for (const [label, value] of shapes) {
      errorSpy.mockClear();
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com']),
        emailReturn: [
          { type: 'forward', to: 'admin@example.com', headers: { 'X-Void-Tag': value } },
        ],
      });
      const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(forwardCalls, label).toHaveLength(0);
      expect(errorSpy, label).toHaveBeenCalledWith(
        expect.stringContaining('value is not a string'),
      );
    }
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

  it('a reject after a successful forward preserves the earlier submission', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        { type: 'reject', reason: 'done' },
      ],
    });
    const { message, forwardCalls, rejectCalls, order } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(order).toEqual(['forward:admin@example.com', 'reject:done']);
    expect(forwardCalls).toHaveLength(1);
    expect(rejectCalls).toEqual(['done']);
  });

  it('forward with invalid `to` is dropped with console.error', async () => {
    const { env } = makeEnv({
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
    // Only the valid one fires.
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.to).toBe('admin@example.com');
    expect(errorSpy).toHaveBeenCalled();
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

  it('unknown action types are warned about and skipped, list continues', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        { type: 'quarantine', to: 'admin@example.com' },
        { type: 'forward', to: 'admin@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(warnSpy).toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(1);
  });

  it('non-object entries are dropped without aborting the list', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [null, 'reject', { type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls, rejectCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    // `logRecv` currently throws on this input (see the log-recv describe
    // block below). Swallow it here so the enaction assertions aren't
    // masked by an unhandled rejection.
    await Promise.allSettled(waited);
    expect(rejectCalls).toHaveLength(0);
    expect(forwardCalls).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
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

describe('routeInbound — header construction safety (HIGH H2)', () => {
  it('drops the entire action list when forward headers contain CRLF (cannot partial-enact)', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        // First action: a forward with malformed headers — should drop
        // the whole list. CRLF in a header VALUE is what `new Headers()`
        // throws on.
        {
          type: 'forward',
          to: 'admin@example.com',
          headers: { 'X-Foo': 'a\r\nInjected: y' },
        },
        // Second action: a reply that would otherwise fire — must NOT
        // fire because validation aborted the whole list.
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: new Uint8Array(),
        },
      ],
    });
    const { message, forwardCalls, replyCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a VALID action DECLARED BEFORE the bad headers also does not fire', async () => {
    // This is the case that distinguishes two-phase from single-pass: a
    // single-pass enactor would already have forwarded to admin@ before
    // reaching the poisoned headers.
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'ops@example.com']),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'forward',
          to: 'ops@example.com',
          headers: { 'X-Foo': 'a\r\nInjected: y' },
        },
      ],
    });
    const { message, forwardCalls, replyCalls, rejectCalls, order } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(order).toEqual([]);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
    // The message is still ACCEPTED by CF — dropping the list is not a bounce.
    expect(rejectCalls).toHaveLength(0);
    // Phase A has no side effects: no quota was charged and no counter
    // was written back.
    expect(kv.writes.filter((w) => w.key.startsWith('email-sent:'))).toHaveLength(0);
    expect(kv.writes.filter((w) => w.key.startsWith('email-burst:'))).toHaveLength(0);
  });

  it('valid forward headers are constructed once and handed to forward()', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'forward',
          to: 'admin@example.com',
          headers: { 'X-Void-Tag': 'support' },
        },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+support@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.headers).toBeInstanceOf(Headers);
    expect(forwardCalls[0]?.headers?.get('X-Void-Tag')).toBe('support');
  });
});

// -----------------------------------------------------------------------
// Prototype pollution guard
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

  it('schedules log-recv even when the dispatch threw (no-handler reject path)', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new TypeError('The RPC receiver does not implement the method "email"'),
    });
    const { message } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  it('schedules log-recv on the generic dispatch-error reject path', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new Error('boom'),
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  // FINDING (pre-existing, also present in pr117): `logRecv` reads
  // `a.type` straight off the RAW action array, while `validateActions`
  // defends against non-object entries. A user worker that returns an
  // array containing `null` therefore crashes the metering log inside
  // `ctx.waitUntil` — the recv counter is never written and the audit
  // line for that delivery is silently lost (as an UNHANDLED rejection,
  // outside logRecv's own try/catch). Expressed as the correct
  // expectation; this test fails until logRecv guards the entry.
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

  it('does NOT log-recv for messages rejected before dispatch (suspended)', async () => {
    const { env, kv } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({
          workerName: 'user-worker',
          projectId: 'p_test',
          suspended: 'abuse',
        }),
      },
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(0);
    expect(kv.store.get(RECV_KEY)).toBeUndefined();
  });
});

// Recipient consent and atomic quotas are covered by the API admission integration tests.

describe('routeInbound — authoritative native custom domain', () => {
  it('dispatches the full custom recipient without KV and enacts native forward and reply', async () => {
    const from = 'support@custom.example.com';
    const { env, kv, emailFn, dispatchGet } = makeEnv({
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

  it('drops a reply that exceeds the 8 MiB cumulative budget and accepts a later smaller reply', async () => {
    // The overrunning reply is dropped and NOT charged, exactly as the
    // framework's `reply()` throws before advancing `replyBytesUsed`: a
    // later reply that fits the remaining budget (3 + 3 + 2 = 8 MiB) still
    // goes.
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
    expect(replyCalls).toHaveLength(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `reply dropped: cumulative reply bytes ${9 * MIB} exceed this delivery's budget of ${8 * MIB}`,
      ),
    );
  });
});

// -----------------------------------------------------------------------
// Framework ↔ router parity for the record-time bounds.
//
// The framework's `createMessageProxy` restates `MAX_FORWARD_HEADERS`,
// `MAX_FORWARD_HEADER_LENGTH` and `MAX_REJECT_REASON_LENGTH` and applies
// them where the action is RECORDED — in the handler's own call — so the
// test harness (which builds its message with that proxy) and a native
// own-account replay answer what this router answers. A number that
// drifted on one side would reopen the gap: a forward the harness reports
// and this router drops, or a reject reason that is clean here and injects
// into the SMTP reply natively. The numbers are pinned equal, and the
// agreement is pinned at the bound in both directions: the largest bag the
// proxy records is enacted here, one past it is refused there and dropped
// here, and a reason the proxy has normalized passes through this router
// unchanged.
//
// The harness also restates this router's ADMISSION — `MAX_INBOUND_BYTES`
// and `MAX_INBOUND_HEADERS` — and refuses a synthetic message before the
// handler runs, as `routeInbound` refuses the real one before dispatch. A
// number that drifted there would let a test invoke a handler on a message
// this router bounces. Pinned equal, and pinned in behaviour: the same
// bytes, one past each cap, draw the same reject string from both sides
// with the handler never called.
// -----------------------------------------------------------------------

describe('framework ↔ router bound parity', () => {
  const ENVELOPE = {
    from: 'sender@example.com',
    to: 'tag@example.com',
    headers: {},
    raw: new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n'),
    rawSize: 21,
  };

  it('restates the same numbers', () => {
    // Guarded on type: an export missing on either side reads `undefined`,
    // and `undefined === undefined` is not parity.
    for (const [framework, router] of [
      [FRAMEWORK_MAX_FORWARD_HEADERS, MAX_FORWARD_HEADERS],
      [FRAMEWORK_MAX_FORWARD_HEADER_LENGTH, MAX_FORWARD_HEADER_LENGTH],
      [FRAMEWORK_MAX_REJECT_REASON_LENGTH, MAX_REJECT_REASON_LENGTH],
      [FRAMEWORK_MAX_INBOUND_BYTES, MAX_INBOUND_BYTES],
      [FRAMEWORK_MAX_INBOUND_HEADERS, MAX_INBOUND_HEADERS],
    ]) {
      expect(router).toBeTypeOf('number');
      expect(framework).toBe(router);
    }
  });

  it('enacts the maximum forward header count within the action metadata budget', async () => {
    const bag: Record<string, string> = {};
    for (let i = 0; i < MAX_FORWARD_HEADERS; i++) {
      const suffix = String(i).padStart(2, '0');
      bag[`X-Forward-${suffix}`] = 'v'.repeat(200);
    }
    const proxy = createMessageProxy(ENVELOPE);
    await proxy.message.forward('admin@example.com', bag as unknown as Headers);
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: proxy.getActions(),
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect([...forwardCalls[0]!.headers!.keys()]).toHaveLength(MAX_FORWARD_HEADERS);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'one header too many',
      (() => {
        const bag: Record<string, string> = {};
        for (let i = 0; i <= MAX_FORWARD_HEADERS; i++) {
          bag[`X-Void-${i}`] = 'v';
        }
        return bag;
      })(),
    ],
    ['a name one character too long', { [`X${'a'.repeat(MAX_FORWARD_HEADER_LENGTH)}`]: 'v' }],
    ['a value one character too long', { 'X-Void-Tag': 'v'.repeat(MAX_FORWARD_HEADER_LENGTH + 1) }],
  ])(
    'refuses a bag with %s at the framework call, and drops the same raw list here',
    async (_label, bag) => {
      // Both sides, same input: the framework fails the handler's call (so
      // the list never exists), and a hand-built entrypoint that returns the
      // list anyway loses the WHOLE list here.
      const proxy = createMessageProxy(ENVELOPE);
      await expect(
        proxy.message.forward('admin@example.com', bag as unknown as Headers),
      ).rejects.toThrow(/^forward: /);
      expect(proxy.getActions()).toEqual([]);
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com', 'ops@example.com']),
        emailReturn: [
          { type: 'forward', to: 'admin@example.com', headers: bag },
          { type: 'forward', to: 'ops@example.com' },
        ],
      });
      const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(forwardCalls).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('action list dropped'));
    },
  );

  it.each([
    ['a control-heavy reason past the cap', 'line\r\n'.repeat(300)],
    ['a multi-megabyte reason ending in CRLF and NUL', `${'x'.repeat(5 * 1024 * 1024)}\r\n\x00`],
    ['an empty reason', ''],
    ['a controls-only reason', '\r\n'],
  ])('sends the reject reason the framework recorded for %s unchanged', async (_label, reason) => {
    // What the proxy records is already this router's `sanitize` output, so
    // the router's own pass is the identity on it — the native replay and
    // the managed one hand the remote MTA the same string.
    const proxy = createMessageProxy(ENVELOPE);
    proxy.message.setReject(reason);
    const [recorded] = proxy.getActions();
    expect(recorded!.type).toBe('reject');
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [recorded],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual([(recorded as { reason: string }).reason]);
    expect(rejectCalls[0]!.length).toBeLessThanOrEqual(MAX_REJECT_REASON_LENGTH);
  });

  describe('admission', () => {
    // One message, one past each cap, delivered to the same wire address on
    // both sides. The router's fake carries the raw's own header lines as
    // its `Headers`, which is the bag Cloudflare builds from the wire; its
    // `rawSize` is the byte length, as Cloudflare sets it.
    const WIRE_TO = `myslug+tag@${PROD_DOMAIN}`;

    function headerLinesOf(raw: Uint8Array): Array<[string, string]> {
      const text = new TextDecoder().decode(raw);
      const block = text.slice(0, text.indexOf('\r\n\r\n'));
      return block.split('\r\n').map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      });
    }

    function oversized(): Uint8Array {
      const head = new TextEncoder().encode(`From: u@x.dev\r\nTo: ${WIRE_TO}\r\n\r\n`);
      const raw = new Uint8Array(MAX_INBOUND_BYTES + 1);
      raw.set(head, 0);
      raw.fill(0x61, head.byteLength);
      return raw;
    }

    function overHeaders(): Uint8Array {
      const lines = ['From: u@x.dev', `To: ${WIRE_TO}`];
      for (let i = lines.length; i <= MAX_INBOUND_HEADERS; i++) {
        lines.push(`h${i.toString(36)}: v`);
      }
      return new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\nbody\r\n`);
    }

    it.each([
      [
        'one byte over the size cap',
        oversized,
        `${PROD_DOMAIN}: message too large (max ${MAX_INBOUND_BYTES} bytes)`,
      ],
      [
        'one distinct header over the cap',
        overHeaders,
        `${PROD_DOMAIN}: too many headers (max ${MAX_INBOUND_HEADERS})`,
      ],
    ])(
      'refuses a message %s with the same reason on both sides, handler never called',
      async (_label, build, reason) => {
        const raw = build();

        const handler = vi.fn(async (message: ForwardableEmailMessage) => {
          await message.forward('admin@example.com');
        });
        const harness = createInboundTestHarness({ routes: { _default: handler } });
        await harness.deliver({ from: 'u@x.dev', to: WIRE_TO, raw });
        expect(handler).not.toHaveBeenCalled();
        expect(harness.rejects).toEqual([reason]);

        const { env, emailFn } = makeEnv({
          kvSeed: withAllowlist(['admin@example.com']),
          emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
        });
        const { message, rejectCalls, forwardCalls } = createFakeMessage({
          to: WIRE_TO,
          rawBytes: raw,
          rawSize: raw.byteLength,
        });
        for (const [name, value] of headerLinesOf(raw)) {
          message.headers.append(name, value);
        }
        const { ctx } = createCtx();
        await routeInbound(message, env, ctx);
        expect(emailFn).not.toHaveBeenCalled();
        expect(forwardCalls).toEqual([]);
        expect(rejectCalls).toEqual([reason]);
      },
    );
  });

  describe('address rule', () => {
    // The framework's `validateAddressParts` is what `forward(to)` and a
    // hand-built `reply({ from, to })` record through; `isValidEmailAddress`
    // is what this router drops on. Anything the framework records and the
    // router drops is an action a handler's test reported as a success and
    // the managed deployment silently lost — after the actions before it
    // had fired. Both sides now call the same package (`email-validator`),
    // so the rule is: framework-accepts ⇔ router-accepts, for every entry
    // below, with ZERO divergences either way. This test is the pin that
    // the two `package.json`s stay on the same rule; the old "one known
    // divergence" (the dot in the domain) is gone because both refuse it.
    const frameworkAccepts = (address: string): boolean => {
      try {
        validateAddressParts('to', address);
        return true;
      } catch {
        return false;
      }
    };

    // Every C0 control and DEL, each inside the local part.
    const controls = Array.from({ length: 0x21 }, (_, i) => (i === 0x20 ? 0x7f : i)).map(
      (code) => `a${String.fromCharCode(code)}b@example.com`,
    );
    // Every RFC 5322 §3.2.3 special (`.` and `@` aside — `.` is dot-atom
    // punctuation and `@` has its own exactly-one rule), in the local part
    // and in the domain.
    const specials = [...'()<>[]:;\\,"'].flatMap((ch) => [
      `a${ch}b@example.com`,
      `a@b${ch}c.example.com`,
    ]);
    // `a@` plus 252 characters of labels: the longest path RFC 5321 makes
    // every receiver accept, and the package's 254 total.
    const domain252 = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(60)}`;
    const deliverable = [
      'ops@example.com',
      'ops+T-42@example.com',
      'first.last@sub.example.com',
      `${'a'.repeat(64)}@example.com`,
      `a@${domain252}`,
      'a@xn--bcher-kva.example',
      'a@b.c1',
      "a!#$%&'*+-/=?^_`{|}~@example.com",
    ];
    // The router's 320 work bound, with a dot in the domain; both sides
    // refuse both on the package's 254 total (the labels are also over 63).
    const at320 = `${'a'.repeat(64)}@${'b'.repeat(251)}.dev`;
    const at321 = `${'a'.repeat(64)}@${'b'.repeat(252)}.dev`;
    // Dot-atom shapes BOTH sides used to accept — no divergence, one shared
    // hole an MTA refused after the handler's test reported a success.
    const malformedDotAtom = [
      'a..b@example.com',
      '.a@example.com',
      'a.@example.com',
      'a@example..com',
      'a@.example.com',
      'a@example.com.',
    ];
    // The framework used to accept these and the router refused them (the
    // dot), or both accepted them (non-ASCII, the TLD shapes); both refuse
    // them now.
    const newlyRefused = [
      'user@localhost',
      'x@y',
      'a@example',
      'jöhn@example.com',
      'ünicode@example.com',
      'a@exämple.com',
      'a@b.c',
      'a@b.1c',
      '`a@x.com',
    ];
    const corpus: Array<string> = [
      ...deliverable,
      // One `@`, and something on both sides of it.
      'not-an-address',
      'a@b@example.com',
      '@example.com',
      'user@',
      '@',
      '',
      // Quoting, display names, list separators.
      '"a b"@example.com',
      '"a@b"@example.com',
      'Ops <ops@example.com>',
      'a@example.com,b@example.com',
      'a@example.com;b@example.com',
      // Whitespace: the ASCII kinds and the non-ASCII one `\s` also matches.
      'a b@example.com',
      'a\tb@example.com',
      'a\vb@example.com',
      'a\fb@example.com',
      'a\u00a0b@example.com',
      ' ops@example.com',
      'ops@example.com ',
      ...controls,
      ...specials,
      ...malformedDotAtom,
      ...newlyRefused,
      at320,
      at321,
      `${'a'.repeat(65)}@example.com`,
      `a@${'b'.repeat(253)}`,
      `a@${'b'.repeat(64)}.dev`,
      // The package quirk, from the other side: a backtick AFTER the first
      // character is fine.
      'a`b@x.com',
    ];

    it('accepts and refuses exactly what the framework does — zero divergences', () => {
      expect(at320).toHaveLength(320);
      expect(at321).toHaveLength(321);
      expect(deliverable[4]).toHaveLength(254);
      const divergent = corpus.filter((a) => frameworkAccepts(a) !== isValidEmailAddress(a));
      expect(
        divergent,
        `framework and router disagree on: ${JSON.stringify(divergent[0])}`,
      ).toEqual([]);
      // Not vacuous: both sides accept every deliverable shape, and both
      // refuse the 320-character address, every special, every control,
      // every malformed dot-atom and every newly refused shape.
      expect(deliverable.every((a) => frameworkAccepts(a) && isValidEmailAddress(a))).toBe(true);
      expect(frameworkAccepts('a`b@x.com') && isValidEmailAddress('a`b@x.com')).toBe(true);
      expect(isValidEmailAddress(at320)).toBe(false);
      expect(frameworkAccepts(at320)).toBe(false);
      expect(
        [...controls, ...specials, ...malformedDotAtom, ...newlyRefused].some(
          (a) => frameworkAccepts(a) || isValidEmailAddress(a),
        ),
      ).toBe(false);
    });

    it('drops a malformed dot-atom the framework also refuses', () => {
      // The thread this closes: `a..b@example.com` was accepted by BOTH the
      // hand-written framework rule and this router's regex.
      for (const address of malformedDotAtom) {
        expect(isValidEmailAddress(address), `router refuses ${address}`).toBe(false);
        expect(frameworkAccepts(address), `framework refuses ${address}`).toBe(false);
      }
    });

    it('refuses the dot-less domain on both sides now, not as a divergence', () => {
      for (const address of ['user@localhost', 'x@y', 'a@example']) {
        expect(frameworkAccepts(address), `framework refuses ${address}`).toBe(false);
        expect(isValidEmailAddress(address), `router refuses ${address}`).toBe(false);
      }
    });

    it('is length-first: a non-string or an over-long value never reaches the package', () => {
      expect(isValidEmailAddress(undefined)).toBe(false);
      expect(isValidEmailAddress(42)).toBe(false);
      expect(isValidEmailAddress(['ops@example.com'])).toBe(false);
      expect(isValidEmailAddress(`ops@${'b'.repeat(400)}.dev`)).toBe(false);
    });
  });
});
