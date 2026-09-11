import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// Mock db.ts (createDb is called inside processUsageEventBatch).
const getUserMock = vi.fn();
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  getUser: (...args: Array<unknown>) => getUserMock(...args),
  suspendUser: vi.fn(),
  unsuspendUserIfReason: vi.fn(),
}));

import type { UsageEvent } from '../../src/usage-counter.ts';
import { groupEventsByUser, processUsageEventBatch } from '../../src/usage-queue.ts';

describe('groupEventsByUser', () => {
  it('groups events by userId', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u2', slug: 's2', requests: 1, responseBytes: 200 },
      { projectId: 'p3', userId: 'u1', slug: 's3', requests: 1, responseBytes: 300 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get('u1')).toHaveLength(2);
    expect(grouped.get('u2')).toHaveLength(1);
  });

  it('returns empty map for empty events', () => {
    const grouped = groupEventsByUser([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single user with multiple events', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u1', slug: 's2', requests: 1, responseBytes: 200 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(1);
    expect(grouped.get('u1')).toHaveLength(2);
  });
});

type FakeStubFetch = (req: Request) => Promise<Response>;

function fetchCalls(mock: ReturnType<typeof vi.fn>): Array<[Request, ...Array<unknown>]> {
  return (mock as unknown as { mock: { calls: Array<[Request, ...Array<unknown>]> } }).mock.calls;
}

function makeBatch(events: ReadonlyArray<UsageEvent>, timestamps?: ReadonlyArray<number>) {
  // Cloudflare stamps every queue message with its enqueue time.
  const messages = events.map((event, i) => ({
    body: event,
    timestamp: new Date(timestamps?.[i] ?? Date.now()),
  }));
  const calls = { retryAll: 0, ackAll: 0 };
  return {
    queue: 'void-usage-events',
    messages,
    retryAll: () => {
      calls.retryAll++;
    },
    ackAll: () => {
      calls.ackAll++;
    },
    calls,
  };
}

function makeEnv(stubFetch: FakeStubFetch, errorStub?: FakeStubFetch) {
  const errorStubFetch: FakeStubFetch =
    errorStub ?? (async () => new Response(null, { status: 200 }));
  return {
    HYPERDRIVE: { connectionString: 'postgres://mock' },
    USAGE_COUNTER: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: stubFetch }),
    },
    ERROR_ALERT_MONITOR: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: errorStubFetch }),
    },
  };
}

describe('processUsageEventBatch — sandbox events', () => {
  beforeEach(() => {
    getUserMock.mockReset();
  });

  it('forwards a sandbox event with userId to the DO', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 30,
        sandboxInstanceId: 'sb-1',
      },
    ];
    const batch = makeBatch(events);
    const env = makeEnv(stubFetch);

    await processUsageEventBatch(batch as never, env as never);

    expect(stubFetch).toHaveBeenCalledTimes(1);
    const callReq = fetchCalls(stubFetch)[0][0];
    const payload = (await callReq.json()) as {
      events: Array<UsageEvent>;
      userId: string;
    };
    expect(payload.userId).toBe('u1');
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].sandboxRuntimeSeconds).toBe(30);
    expect(batch.calls.ackAll).toBe(1);
  });
});

describe('processUsageEventBatch — 5xx alert window', () => {
  beforeEach(() => {
    getUserMock.mockReset();
  });

  function error5xx(projectId: string): UsageEvent {
    return {
      projectId,
      userId: 'u1',
      slug: projectId,
      requests: 1,
      responseBytes: 0,
      status: 503,
    };
  }

  it('carries the edge enqueue times through to the ErrorAlertMonitor', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    // A burst metered at the edge over ten minutes. Whenever this consumer
    // drains the batch, the window must report the edge times — stamping the
    // drain time is what makes the emailed `--range` miss the rows.
    const t0 = Date.parse('2026-07-23T10:00:00Z');
    const t1 = Date.parse('2026-07-23T10:05:00Z');
    const t2 = Date.parse('2026-07-23T10:10:00Z');
    // Deliberately out of order: queues do not guarantee ordering.
    const batch = makeBatch([error5xx('p1'), error5xx('p1'), error5xx('p1')], [t1, t0, t2]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(errorStubFetch).toHaveBeenCalledTimes(1);
    const body = (await fetchCalls(errorStubFetch)[0][0].json()) as {
      count: number;
      firstAt: number;
      lastAt: number;
    };
    expect(body.count).toBe(3);
    expect(body.firstAt).toBe(t0);
    expect(body.lastAt).toBe(t2);
  });

  it('keeps per-project windows separate', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const early = Date.parse('2026-07-23T10:00:00Z');
    const late = Date.parse('2026-07-23T10:30:00Z');
    const batch = makeBatch([error5xx('p1'), error5xx('p2')], [early, late]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    const bodies = await Promise.all(
      fetchCalls(errorStubFetch).map(
        (call) => call[0].json() as Promise<{ projectId: string; firstAt: number; lastAt: number }>,
      ),
    );
    const p1 = bodies.find((b) => b.projectId === 'p1');
    const p2 = bodies.find((b) => b.projectId === 'p2');
    expect(p1).toMatchObject({ firstAt: early, lastAt: early });
    expect(p2).toMatchObject({ firstAt: late, lastAt: late });
  });

  it('bills platform static-asset failures without sending user error alerts', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const platformFailures: Array<UsageEvent> = [
      { ...error5xx('docs'), failureKind: 'platform-static-asset-timeout' },
      { ...error5xx('docs'), failureKind: 'platform-static-asset-error' },
      { ...error5xx('docs'), failureKind: 'platform-static-asset-missing' },
    ];
    const batch = makeBatch(platformFailures);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(stubFetch).toHaveBeenCalledOnce();
    const counterBody = (await fetchCalls(stubFetch)[0][0].json()) as {
      events: Array<UsageEvent>;
    };
    expect(counterBody.events).toEqual(platformFailures);
    expect(errorStubFetch).not.toHaveBeenCalled();
    expect(batch.calls.ackAll).toBe(1);
  });

  it('still alerts for application 5xx events mixed with a platform timeout', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const platformTimeout: UsageEvent = {
      ...error5xx('docs'),
      failureKind: 'platform-static-asset-timeout',
    };
    const appFailure = error5xx('repl');
    const batch = makeBatch([platformTimeout, appFailure]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(errorStubFetch).toHaveBeenCalledOnce();
    const alertBody = (await fetchCalls(errorStubFetch)[0][0].json()) as {
      projectId: string;
      count: number;
    };
    expect(alertBody).toMatchObject({ projectId: 'repl', count: 1 });
    expect(batch.calls.ackAll).toBe(1);
  });
});
