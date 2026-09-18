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
  const env = {
    AI: {},
    JWT_SECRET: 'test-secret',
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'token',
    API: { fetch: vi.fn() },
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
  it('treats undefined return as empty action list (no crash)', async () => {
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
    expect(rejectCalls).toHaveLength(0);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
  });

  it('treats null return as empty action list', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: null,
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
  });

  it('treats non-array return as empty action list (logs warning)', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: { actions: [] },
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
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

  it('a reject after a successful forward still flushes the quota counters', async () => {
    const { env, kv } = makeEnv({
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
    // The forward that already fired must be charged before the terminal
    // reject returns.
    expect(kv.store.get(SENT_KEY)).toBe('1');
    expect(kv.store.get(BURST_KEY)).toBe('1');
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

  it('a throwing forward is logged, charges no quota, and does not abort the list', async () => {
    const { env, kv } = makeEnv({
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
    // …and only IT is charged — the failed forward isn't.
    expect(kv.store.get(SENT_KEY)).toBe('1');
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
    const { env, kv } = makeEnv({
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
    // recordInboundDelivery wrote a recv counter.
    expect(kv.store.get(RECV_KEY)).toBe('1');
  });

  it('schedules log-recv even when the dispatch threw (no-handler reject path)', async () => {
    const { env, kv } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new TypeError('The RPC receiver does not implement the method "email"'),
    });
    const { message } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(kv.store.get(RECV_KEY)).toBe('1');
  });

  it('schedules log-recv on the generic dispatch-error reject path', async () => {
    const { env, kv } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailThrow: new Error('boom'),
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(kv.store.get(RECV_KEY)).toBe('1');
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
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [null, { type: 'forward', to: 'admin@example.com' }],
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx, waited } = createCtx();
    await routeInbound(message, env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.allSettled(waited);
    expect(kv.store.get(RECV_KEY)).toBe('1');
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

// -----------------------------------------------------------------------
// HIGH H1 — per-project allowlist + quota gating on forward/reply
//
// CF Email Routing destinations are account-wide. Without these gates,
// inbound mail is a fan-out primitive against any tenant's verified
// addresses. The platform's per-project allowlist is the security
// boundary; CF's account-wide verified flag is NOT a substitute.
// -----------------------------------------------------------------------

describe('routeInbound — per-project gating on forward/reply (HIGH H1)', () => {
  it('drops forward to an address not in the per-project allowlist', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        // CF would accept this account-wide; the project allowlist
        // doesn't include it, so we drop.
        { type: 'forward', to: 'someone-elses-verified@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
  });

  it('drops reply to an address not in the per-project allowlist', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'someone-elses-verified@example.com',
          raw: new Uint8Array(),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
  });

  it('drops every forward/reply when the project has no allowlist at all', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: new Uint8Array(),
        },
      ],
    });
    const { message, forwardCalls, replyCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(replyCalls).toHaveLength(0);
  });

  it('matches the allowlist case-insensitively', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['Admin@Example.com']),
      emailReturn: [{ type: 'forward', to: 'ADMIN@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
  });

  it('widens the gate to a same-domain forward under the `domains` recipient policy', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-recipient-policy': JSON.stringify({ mode: 'domains', domains: ['corp.test'] }),
      }),
      emailReturn: [
        { type: 'forward', to: 'anyone@corp.test' },
        { type: 'forward', to: 'anyone@other.test' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls.map((call) => call.to)).toEqual(['anyone@corp.test']);
  });

  it('under `any`, still drops a reply that claims another project as sender', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist([], {
        'email-recipient-policy': JSON.stringify({ mode: 'any', domains: [] }),
      }),
      emailReturn: [
        {
          type: 'reply',
          from: `otherproject+support@${PROD_DOMAIN}`,
          to: 'anyone@elsewhere.test',
          raw: replyRaw(`otherproject+support@${PROD_DOMAIN}`, 'r'),
        },
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'anyone@elsewhere.test',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    // The sender pin does not move with the policy: only the project's own
    // sender goes out, to a recipient the policy now permits.
    expect(replyCalls).toHaveLength(1);
  });

  it("never widens a forward to another tenant's inbox on the platform's own mail domain", async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist([`consented+tag@${PROD_DOMAIN}`], {
        'email-recipient-policy': JSON.stringify({ mode: 'any', domains: [] }),
      }),
      emailReturn: [
        { type: 'forward', to: `otherproject+intake@${PROD_DOMAIN}` },
        { type: 'forward', to: `consented+tag@${PROD_DOMAIN}` },
        { type: 'forward', to: 'anyone@elsewhere.test' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls.map((call) => call.to)).toEqual([
      `consented+tag@${PROD_DOMAIN}`,
      'anyone@elsewhere.test',
    ]);
  });

  it('keeps the gate closed for the same forward under the default `verified` policy', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [{ type: 'forward', to: 'anyone@corp.test' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
  });

  it('fails CLOSED when the routing entry has no projectId — refused before dispatch', async () => {
    // No projectId → no per-project guard is available, so forward/reply
    // must be refused rather than falling back to CF's account-wide flag.
    // This used to pin "dispatch, then drop the forward". A worker routing
    // with no id is corrupt data (every writer has put one in the blob since
    // the first), and the email-only suspension key cannot be built from it
    // either — so the router now refuses it in front of dispatch, which is
    // strictly more closed: no tenant code runs, no forward can fire.
    const { env, emailFn, dispatchGet } = makeEnv({
      kvSeed: { myslug: JSON.stringify({ workerName: 'user-worker' }) },
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls, rejectCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toEqual([`${PROD_DOMAIN}: routing data corrupt`]);
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
  });

  it('fails CLOSED when the gate cannot be loaded (KV read error)', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      kvGetFailures: ['email-allowlist:p_test'],
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls, rejectCalls } = createFakeMessage({
      to: `myslug@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(emailFn).toHaveBeenCalledTimes(1);
    expect(forwardCalls).toHaveLength(0);
    // Quota/gate failures never turn into a bounce.
    expect(rejectCalls).toHaveLength(0);
  });

  it('drops forward when burst limit would be exceeded', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-burst-limit:p_test': '1',
        // Pre-seed counter at the limit so +1 trips.
        [BURST_KEY]: '1',
      }),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    // Counter not advanced.
    expect(kv.store.get(BURST_KEY)).toBe('1');
  });

  it('drops forward when monthly limit would be exceeded', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-limit:p_test': '5',
        [SENT_KEY]: '5',
      }),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(0);
    expect(kv.store.get(SENT_KEY)).toBe('5');
  });

  it('once quota is exhausted, further forward/reply are also dropped', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'support@example.com'], {
        'email-limit:p_test': '5',
        [SENT_KEY]: '5',
      }),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
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
  });

  it('quota exhaustion does not bounce the inbound message', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-limit:p_test': '1',
        [SENT_KEY]: '1',
      }),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(0);
  });

  it('charges quota per action — two forwards cost two', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'support@example.com']),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        { type: 'forward', to: 'support@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(2);
    expect(kv.store.get(SENT_KEY)).toBe('2');
    expect(kv.store.get(BURST_KEY)).toBe('2');
  });

  it('the burst limit cuts a run of forwards off mid-list', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com', 'support@example.com'], {
        'email-burst-limit:p_test': '1',
      }),
      emailReturn: [
        { type: 'forward', to: 'admin@example.com' },
        { type: 'forward', to: 'support@example.com' },
      ],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.to).toBe('admin@example.com');
    expect(kv.store.get(BURST_KEY)).toBe('1');
  });

  it('successful forward increments burst + monthly counters', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect(kv.store.get(SENT_KEY)).toBe('1');
    const burstWrite = kv.writes.find((w) => w.key.startsWith('email-burst:p_test:'));
    expect(burstWrite?.key).toBe(BURST_KEY);
    expect(burstWrite?.value).toBe('1');
    // Burst window is short-lived; the monthly counter outlives the month.
    expect(burstWrite?.options?.expirationTtl).toBe(5 * 60);
    const monthWrite = kv.writes.find((w) => w.key === SENT_KEY);
    expect(monthWrite?.options?.expirationTtl).toBeGreaterThan(60);
  });

  it('successful reply increments counters', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'reply'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(kv.store.get(SENT_KEY)).toBe('1');
  });

  it('a NaN-poisoned counter reads as zero rather than disabling the gate', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], { [SENT_KEY]: 'not-a-number' }),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(forwardCalls).toHaveLength(1);
    expect(kv.store.get(SENT_KEY)).toBe('1');
  });

  // Suspended is already covered above (it rejects before dispatch); the
  // gate's "suspended drops both" assertion is implicit — no dispatch
  // happens, so no forward/reply runs. This test pins it explicitly.
  it('suspended project: dispatch never runs and forward/reply are not enacted', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], { 'email-suspended:p_test': '1' }),
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
  });

  it('platform-suspended project: dispatch never runs and forward/reply are not enacted', async () => {
    const { env, emailFn } = makeEnv({
      kvSeed: {
        myslug: JSON.stringify({
          workerName: 'user-worker',
          projectId: 'p_test',
          suspended: 'abuse',
        }),
        'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
      },
      emailReturn: [{ type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(emailFn).not.toHaveBeenCalled();
    expect(forwardCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// F1 — reply sender pin
//
// The reply branch builds `new EmailMessage(action.from, …)` from a value
// the tenant's worker returned over RPC. CF Email Routing's own reply rule
// is DOMAIN-level only, and every tenant plus the platform's reserved
// `noreply` slug share one mail zone — so without a pin here any project
// can emit mail as any other project, or as the platform. This is the
// inbound analogue of the outbound `from` pin in `email.ts` (strict shape
// + local-part-before-`+` equals the project's slug).
//
// The expected DOMAIN comes from the RECEIVED `message.to`, not from
// `EMAIL_SENDER_DOMAIN`: that is the domain CF pinned when it accepted the
// message, and `routeInbound` deliberately treats a missing
// `EMAIL_SENDER_DOMAIN` as non-fatal (a cosmetic var must not stop mail).
// -----------------------------------------------------------------------

describe('routeInbound — reply sender pin (F1)', () => {
  it("drops a reply that claims ANOTHER project's slug", async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          // `otherproject` is a different tenant on the same mail zone.
          from: `otherproject+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: new TextEncoder().encode('r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops a reply as the platform noreply address', async () => {
    // `noreply` is a RESERVED slug, so this inbound reply path is the only
    // way to emit it at all — the outbound `/email/send` pin can't be
    // satisfied by any project for it.
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `noreply@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`noreply@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
  });

  it('drops a reply whose MIME From names another address than the envelope sender', async () => {
    // The sender pin above checks `action.from`; the recipient's client
    // shows the `From:` header inside `raw`, which is the tenant's bytes.
    // Same pin as `/email/send`, applied to the recorded reply.
    const shapes: Array<[string, unknown]> = [
      ['sibling project in From:', replyRaw(`otherproject+support@${PROD_DOMAIN}`)],
      [
        'display name around a sibling',
        replyRaw(`"Support" <otherproject+support@${PROD_DOMAIN}>`),
      ],
      ['no From: header', new TextEncoder().encode('Subject: hi\r\n\r\nreply body\r\n')],
      [
        'two From: headers',
        new TextEncoder().encode(
          `From: myslug+support@${PROD_DOMAIN}\r\nFrom: otherproject+support@${PROD_DOMAIN}\r\n\r\nr\r\n`,
        ),
      ],
      ['raw is not bytes', `From: myslug+support@${PROD_DOMAIN}\r\n\r\nr\r\n`],
    ];
    for (const [label, raw] of shapes) {
      errorSpy.mockClear();
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com']),
        emailReturn: [
          { type: 'reply', from: `myslug+support@${PROD_DOMAIN}`, to: 'admin@example.com', raw },
        ],
      });
      const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(replyCalls, label).toHaveLength(0);
      expect(errorSpy, label).toHaveBeenCalledWith(expect.stringContaining('reply dropped'));
    }
  });

  it('accepts a MIME From that differs from the envelope sender only by case, or carries a display name', async () => {
    for (const header of [
      `MySlug+Support@${PROD_DOMAIN.toUpperCase()}`,
      `"Acme Support" <myslug+support@${PROD_DOMAIN}>`,
      `=?UTF-8?B?5pSv5o+0?= <myslug+support@${PROD_DOMAIN}>`,
    ]) {
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com']),
        emailReturn: [
          {
            type: 'reply',
            from: `myslug+support@${PROD_DOMAIN}`,
            to: 'admin@example.com',
            raw: replyRaw(header),
          },
        ],
      });
      const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(replyCalls, header).toHaveLength(1);
    }
  });

  it("accepts replyEmail's default sender, <slug>+noreply@<domain>", async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug+noreply@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+noreply@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(`myslug+noreply@${PROD_DOMAIN}`);
  });

  it('accepts the tag-less <slug>@<domain> form', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
  });

  // DECISION — a bare `<tag>@<domain>` reply is REFUSED.
  //
  // The framework strips the `<slug>+` prefix from `message.to` before the
  // handler sees it, so a handler that hand-rolls `from: message.to` emits
  // `<tag>@<domain>`. CF accepts that today, so refusing it is a
  // deliberate, breaking narrowing. It has to be: a bare local-part is
  // indistinguishable from another tenant's slug (`otherproject@<domain>`)
  // and from the platform's reserved `noreply@<domain>`, so allowing the
  // shape at all would re-open exactly the impersonation this pin closes.
  // `replyEmail`'s default (`<slug>+noreply@<domain>`) and the wire form
  // `<slug>+<tag>@<domain>` both keep working; a hand-rolled sender must
  // use the preserved `message.__voidPlatformTo` (the un-stripped
  // recipient) or an explicit `<slug>+…` address.
  it('drops a bare <tag>@<domain> reply (the slug-stripped message.to)', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          // What `from: message.to` yields inside a handler: the framework
          // stripped `myslug+` before the handler ever saw the address.
          from: `tag@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: new TextEncoder().encode('r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
  });

  it('matches the slug case-insensitively (the routed slug is lowercased, action.from is not)', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `MySlug+Support@${PROD_DOMAIN.toUpperCase()}`,
          to: 'admin@example.com',
          raw: replyRaw(`MySlug+Support@${PROD_DOMAIN.toUpperCase()}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    // The address is handed to EmailMessage VERBATIM — we compare folded,
    // we do not rewrite the tenant's sender.
    expect(replyCalls[0]?.from).toBe(`MySlug+Support@${PROD_DOMAIN.toUpperCase()}`);
  });

  it('drops a local-part that only case-FOLDS to the slug (U+212A KELVIN SIGN)', async () => {
    // `'K'.toLowerCase() === 'k'`, so a lowercased compare alone would
    // accept this while `EmailMessage` still receives the non-ASCII bytes
    // verbatim. Same reasoning as the printable-ASCII guard in email.ts.
    const { env } = makeEnv({
      kvSeed: {
        kslug: DEFAULT_ROUTING,
        'email-allowlist:p_test': JSON.stringify(['admin@example.com']),
      },
      emailReturn: [
        {
          type: 'reply',
          from: `Kslug@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`Kslug@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `kslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
  });

  it('pins the domain to the RECEIVED recipient, not EMAIL_SENDER_DOMAIN', async () => {
    // A message received on the staging zone may only be replied to from
    // the staging zone — even though EMAIL_SENDER_DOMAIN says production.
    const { env } = makeEnv({
      senderDomain: PROD_DOMAIN,
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `myslug+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${PROD_DOMAIN}`, 'r'),
        },
        {
          type: 'reply',
          from: `myslug+support@${STAGING_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+support@${STAGING_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${STAGING_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(`myslug+support@${STAGING_DOMAIN}`);
  });

  it('still pins the sender when EMAIL_SENDER_DOMAIN is unset', async () => {
    // The var is cosmetic here (it only labels reject reasons), so the pin
    // must not acquire a dependency on it — routing keeps working without.
    const { env } = makeEnv({
      senderDomain: null,
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `noreply@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`noreply@${PROD_DOMAIN}`, 'r'),
        },
        {
          type: 'reply',
          from: `myslug+noreply@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`myslug+noreply@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(`myslug+noreply@${PROD_DOMAIN}`);
  });

  it('a dropped reply consumes NO quota', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `otherproject+support@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`otherproject+support@${PROD_DOMAIN}`, 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(kv.store.get(SENT_KEY)).toBeUndefined();
    expect(kv.store.get(BURST_KEY)).toBeUndefined();
    expect(kv.writes.filter((w) => w.key.startsWith('email-sent:'))).toHaveLength(0);
    expect(kv.writes.filter((w) => w.key.startsWith('email-burst:'))).toHaveLength(0);
  });

  it('a dropped reply does not abort the rest of the list', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: `noreply@${PROD_DOMAIN}`,
          to: 'admin@example.com',
          raw: replyRaw(`noreply@${PROD_DOMAIN}`, 'r'),
        },
        { type: 'forward', to: 'admin@example.com' },
      ],
    });
    const { message, replyCalls, forwardCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(forwardCalls).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// Reply sender pin extension (design doc 0078, "What changes in the
// existing rules"): beyond `<slug>[+tag]@<received-domain>`, a reply may
// send as ANY address on a custom domain whose `email-domain:<domain>`
// mirror is `active` and maps to the receiving project. The mirror is the
// authorization — the router has no other view of `email_domains`.
// -----------------------------------------------------------------------

describe('routeInbound — reply sender pin: registered custom domains', () => {
  // Dummy mirror fixture — the sha field is a placeholder hex string, never
  // a real secret or checksum of one.
  const registeredMirror = (projectId = 'p_test', status = 'active') =>
    JSON.stringify({
      projectId,
      status,
      relaySecretSha256: '00'.repeat(32),
      relayWorkerName: 'void-email-relay',
      accountId: 'acct_customer',
      zoneId: 'zone_1',
      mode: 'subdomain',
    });

  it('accepts any address on a domain whose active mirror maps to the receiving project', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-domain:acme.com': registeredMirror(),
      }),
      emailReturn: [
        {
          type: 'reply',
          from: 'support@acme.com',
          to: 'admin@example.com',
          raw: replyRaw('support@acme.com', 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe('support@acme.com');
  });

  it('rejects a custom-domain sender whose mirror maps to ANOTHER project', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-domain:acme.com': registeredMirror('p_other'),
      }),
      emailReturn: [
        {
          type: 'reply',
          from: 'support@acme.com',
          to: 'admin@example.com',
          raw: replyRaw('support@acme.com', 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reply dropped'));
  });

  it.each(['pending', 'token_revoked', 'token_expired', 'failed'])(
    'rejects a custom-domain sender whose mirror status is %s',
    async (status) => {
      const { env } = makeEnv({
        kvSeed: withAllowlist(['admin@example.com'], {
          'email-domain:acme.com': registeredMirror('p_test', status),
        }),
        emailReturn: [
          {
            type: 'reply',
            from: 'support@acme.com',
            to: 'admin@example.com',
            raw: replyRaw('support@acme.com', 'r'),
          },
        ],
      });
      const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
      const { ctx } = createCtx();
      await routeInbound(message, env, ctx);
      expect(replyCalls).toHaveLength(0);
    },
  );

  it('rejects a custom-domain sender with no mirror at all', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        {
          type: 'reply',
          from: 'support@unregistered.example',
          to: 'admin@example.com',
          raw: replyRaw('support@unregistered.example', 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
  });

  it('fails closed when the mirror read throws — the reply is dropped, the delivery is not retried', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-domain:acme.com': registeredMirror(),
      }),
      kvGetFailures: ['email-domain:acme.com'],
      emailReturn: [
        {
          type: 'reply',
          from: 'support@acme.com',
          to: 'admin@example.com',
          raw: replyRaw('support@acme.com', 'r'),
        },
      ],
    });
    const { message, rejectCalls, replyCalls } = createFakeMessage({
      to: `myslug+tag@${PROD_DOMAIN}`,
    });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    // A dropped action is not a bounce.
    expect(rejectCalls).toHaveLength(0);
  });

  it('memoizes the mirror lookup across replies from one domain in a message', async () => {
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com'], {
        'email-domain:acme.com': registeredMirror(),
      }),
      emailReturn: [
        {
          type: 'reply',
          from: 'support@acme.com',
          to: 'admin@example.com',
          raw: replyRaw('support@acme.com', 'r'),
        },
        {
          type: 'reply',
          from: 'sales@acme.com',
          to: 'admin@example.com',
          raw: replyRaw('sales@acme.com', 'r'),
        },
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(2);
    const mirrorReads = kv.get.mock.calls.filter(([key]) => key === 'email-domain:acme.com');
    expect(mirrorReads).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// Reject reasons are truncated BEFORE control chars are stripped.
//
// `sanitize()` used to run its global replacement over the whole string and
// only then slice. A control-heavy reason makes V8 materialize one part per
// match (~68 B each, measured), so a 4 MB `\0a\0a…` reason — 8x below the
// 32 MiB RPC ceiling — is ~140 MB of transient heap in the 128 MB proxy
// isolate, ahead of every outbound gate. Slicing first bounds the work to
// `maxLen` code units.
// -----------------------------------------------------------------------

describe('routeInbound — reject reason is truncated before sanitizing', () => {
  it('bounds a multi-megabyte control-heavy reason without a full-string pass', async () => {
    // 32 MiB of alternating NUL / letter: one regex match per NUL, which is
    // the shape that maximizes the parts array. The RPC transport could not
    // deliver a larger reason.
    const reason = '\x00a'.repeat(16 * 1024 * 1024);
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [{ type: 'reject', reason }],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    const elapsed = performance.now() - t0;
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]!.length).toBeLessThanOrEqual(1000);
    // oxlint-disable-next-line no-control-regex
    expect(rejectCalls[0]).not.toMatch(new RegExp('[\\u0000-\\u001f\\u007f]'));
    // Generous: the slice-first path is ~0 ms; the old order measured 800+ ms
    // on this input on a laptop, and an OOM under a 128 MB heap.
    expect(elapsed).toBeLessThan(500);
  });

  it('collapses controls inside the 1000-char window and does not refill from beyond it', async () => {
    // 300 x "line\r\n" is 1800 chars. Slice-first keeps the first 1000 code
    // units — 166 full lines (996) plus "line" — then each CRLF becomes one
    // space, so the reason is 834 clean chars, not 1000. The reason is DSN
    // text for a remote MTA, so a shorter window is the acceptable trade.
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [{ type: 'reject', reason: 'line\r\n'.repeat(300) }],
    });
    const { message, rejectCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]).toBe('line '.repeat(166) + 'line');
  });
});

// -----------------------------------------------------------------------
// Untrusted values are never coerced with `String()` for a log line.
//
// `sanitize(String(x), 320)` is bounded only when `x` is a string. A typed
// array or an Array as an action's `type` (or as an address that failed
// validation) is joined element by element before the slice — measured, a
// 30 MB `Uint8Array` is a 107M-char string, +385 MB and ~580 ms, an OOM
// under the 128 MB isolate — and a BigInt as the action itself is a decimal
// conversion superlinear in its size (4 MiB: 1.9 s; 32 MiB: 20 s of CPU).
// All of it runs ahead of every outbound gate, from any hand-built
// entrypoint. `describeUntrusted` renders such values by kind only.
// -----------------------------------------------------------------------

describe('routeInbound — non-string action fields are described, not coerced', () => {
  /** Heap growth across `fn`, in MB, with a GC before when one is exposed. */
  async function heapDeltaMB(fn: () => Promise<void>): Promise<number> {
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    await fn();
    return (process.memoryUsage().heapUsed - before) / (1024 * 1024);
  }

  function warnLines(): Array<string> {
    return warnSpy.mock.calls.map((call) => String(call[0]));
  }
  function errorLines(): Array<string> {
    return errorSpy.mock.calls.map((call) => String(call[0]));
  }

  it('a 30 MB Uint8Array as an unknown action `type` is logged by kind, in bounded time and heap', async () => {
    const type = new Uint8Array(30 * 1024 * 1024).fill(0x41);
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [{ type }, { type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    const grew = await heapDeltaMB(() => routeInbound(message, env, ctx));
    const elapsed = performance.now() - t0;
    const line = warnLines().find((l) => l.includes('dropping unknown action type'));
    expect(line).toBe('[email-router] dropping unknown action type: [object Uint8Array]');
    // The list continues: the unknown entry is skipped, the forward fires.
    expect(forwardCalls).toHaveLength(1);
    // `String(type)` alone measured ~580 ms and +385 MB on this input.
    expect(elapsed).toBeLessThan(100);
    expect(grew).toBeLessThan(64);
  });

  it.each([
    ['a nested Array', [[1, 2], [3]], '[object Array]'],
    ['a plain object', { nested: true }, '[object Object]'],
    ['a BigInt', 1n << 4096n, '[bigint]'],
    ['null', null, 'null'],
    ['a number', 42, '42'],
    ['a boolean', false, 'false'],
    ['undefined', undefined, 'undefined'],
  ])('an unknown action `type` that is %s is rendered by kind', async (_label, type, rendered) => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [{ type }],
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(warnLines()).toContain(`[email-router] dropping unknown action type: ${rendered}`);
  });

  it('a string `type` is still rendered, sliced then stripped', async () => {
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [{ type: `quarantine\r\n${'x'.repeat(1000)}` }],
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    const line = warnLines().find((l) => l.includes('dropping unknown action type'));
    expect(line).toBe(`[email-router] dropping unknown action type: quarantine ${'x'.repeat(308)}`);
  });

  it('a 30 MB control-heavy string as the action itself is bounded', async () => {
    // Already closed by the slice-first `sanitize` — `String()` of a string
    // is the string — pinned here beside the cases it does not cover.
    const action = '\x00a'.repeat(15 * 1024 * 1024);
    const { env } = makeEnv({
      kvSeed: { myslug: DEFAULT_ROUTING },
      emailReturn: [action],
    });
    const { message } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    expect(performance.now() - t0).toBeLessThan(100);
    const line = errorLines().find((l) => l.includes('dropping non-object action'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(
      '[email-router] dropping non-object action: '.length + 320,
    );
    // oxlint-disable-next-line no-control-regex
    expect(line).not.toMatch(new RegExp('[\\u0000-\\u001f\\u007f]'));
  });

  it('a BigInt as the action itself is logged by kind, never converted to decimal', async () => {
    // 4 MiB of magnitude: `String()` of it measured 1.9 s of CPU. The
    // transport could carry eight times this.
    const action = 1n << BigInt(4 * 1024 * 1024 * 8);
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [action, { type: 'forward', to: 'admin@example.com' }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    await routeInbound(message, env, ctx);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(errorLines()).toContain('[email-router] dropping non-object action: [bigint]');
    expect(forwardCalls).toHaveLength(1);
  });

  it('a 30 MB Uint8Array as a forward `to` is logged by kind', async () => {
    // `logAddress` renders whatever failed `isValidEmailAddress`, which is
    // not necessarily a string.
    const to = new Uint8Array(30 * 1024 * 1024).fill(0x41);
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [{ type: 'forward', to }],
    });
    const { message, forwardCalls } = createFakeMessage({ to: `myslug@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    const t0 = performance.now();
    const grew = await heapDeltaMB(() => routeInbound(message, env, ctx));
    expect(performance.now() - t0).toBeLessThan(100);
    expect(grew).toBeLessThan(64);
    expect(errorLines()).toContain(
      '[email-router] forward dropped: invalid "to" address [object Uint8Array]',
    );
    expect(forwardCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Proxy-side reply size limits.
//
// The framework bounds a `reply()` at `MAX_MESSAGE_BYTES` (10 MiB) and one
// dispatch's replies at `MAX_REPLY_BYTES_TOTAL` (20 MiB), but those checks
// run inside the tenant's own worker. A hand-written Workers-for-Platforms
// entrypoint can return any `Uint8Array` the 32 MiB RPC transport carries,
// and the router used to scan it for `From:` and stream it into
// `message.reply()` with no bound of its own. Same belt-and-suspenders split
// as `MAX_ACTIONS`.
// -----------------------------------------------------------------------

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

  it('drops a reply over 10 MiB before the MIME From scan', async () => {
    // No `From:` header at all: if the size check ran AFTER the scan, the
    // drop would be logged as a missing From header instead.
    const raw = new Uint8Array(10 * MIB + 1).fill(0x41);
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [replyAction(raw)],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`reply dropped: raw is ${10 * MIB + 1} bytes (max ${10 * MIB})`),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('no From header'));
    expect(kv.store.get(SENT_KEY)).toBeUndefined();
  });

  it('accepts a reply of exactly 10 MiB', async () => {
    const { env } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [replyAction(sizedReply(10 * MIB))],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]?.from).toBe(SENDER);
  });

  it('three 8 MiB replies: the third overruns the 20 MiB budget and is dropped, the rest fire', async () => {
    // The overrunning reply is dropped and NOT charged, exactly as the
    // framework's `reply()` throws before advancing `replyBytesUsed`: a
    // later reply that fits the remaining budget (16 + 4 = 20 MiB) still
    // goes.
    const { env, kv } = makeEnv({
      kvSeed: withAllowlist(['admin@example.com']),
      emailReturn: [
        replyAction(sizedReply(8 * MIB)),
        replyAction(sizedReply(8 * MIB)),
        replyAction(sizedReply(8 * MIB)),
        replyAction(sizedReply(4 * MIB)),
      ],
    });
    const { message, replyCalls } = createFakeMessage({ to: `myslug+tag@${PROD_DOMAIN}` });
    const { ctx } = createCtx();
    await routeInbound(message, env, ctx);
    expect(replyCalls).toHaveLength(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `reply dropped: cumulative reply bytes ${24 * MIB} exceed this delivery's budget of ${20 * MIB}`,
      ),
    );
    // Three enacted replies, three quota units.
    expect(kv.store.get(SENT_KEY)).toBe('3');
    expect(kv.store.get(BURST_KEY)).toBe('3');
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

  it('enacts the largest forward header bag the framework records', async () => {
    const bag: Record<string, string> = {};
    for (let i = 0; i < MAX_FORWARD_HEADERS; i++) {
      const suffix = String(i).padStart(2, '0');
      bag[`X-${'a'.repeat(MAX_FORWARD_HEADER_LENGTH - 2 - suffix.length)}${suffix}`] = 'v'.repeat(
        MAX_FORWARD_HEADER_LENGTH,
      );
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
