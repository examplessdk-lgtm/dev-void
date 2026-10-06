import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Capture what the alert email would be sent with, without touching the binding.
const emailCalls: Array<{
  slug: string;
  count: number;
  window: { start: number; end: number } | null;
}> = [];
vi.mock('../../src/email.ts', () => ({
  sendErrorAlertEmail: vi.fn(
    async (
      _binding: unknown,
      _to: string,
      slug: string,
      count: number,
      window: { start: number; end: number } | null,
    ) => {
      emailCalls.push({ slug, count, window });
    },
  ),
}));

// Mock db.ts so fireAlert resolves an owner + canonical slug without Postgres.
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  getUser: vi.fn(async () => ({ email: 'owner@example.com' })),
  getProject: vi.fn(async () => ({ slug: 'recappi' })),
}));

import { ErrorAlertMonitor } from '../../src/error-alert-monitor.ts';

type State = {
  count: number;
  projectId: string;
  userId: string;
  slug: string;
  lastAlertAt: number | null;
  firstErrorAt?: number | null;
  lastErrorAt?: number | null;
};

function makeFakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    getAlarm: async () => alarm,
    setAlarm: async (ts: number) => {
      alarm = ts;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}

function makeMonitor(initial?: Partial<State>) {
  const storage = makeFakeStorage();
  if (initial) {
    storage.data.set('state', initial);
  }
  const env = {
    EMAIL: { send: async () => {} },
    HYPERDRIVE: { connectionString: 'postgres://mock' },
    DASHBOARD_URL: 'https://dash.void.cloud',
  };
  const ctx = { storage };
  const mon = new ErrorAlertMonitor(ctx as never, env as never);
  (mon as unknown as { ctx: unknown; env: unknown }).ctx = ctx;
  (mon as unknown as { ctx: unknown; env: unknown }).env = env;
  return { mon, storage };
}

function record(body: {
  projectId: string;
  count: number;
  userId: string;
  slug: string;
  firstAt?: number;
  lastAt?: number;
}): Request {
  return new Request('https://do/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ErrorAlertMonitor window stamping', () => {
  beforeEach(() => {
    emailCalls.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps firstErrorAt and lastErrorAt on a non-firing record', async () => {
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const now = Date.now();
    const { mon, storage } = makeMonitor();

    await mon.fetch(record({ projectId: 'p1', count: 5, userId: 'u1', slug: 'recappi' }));

    const state = storage.data.get('state') as State;
    expect(state.count).toBe(5);
    expect(state.firstErrorAt).toBe(now);
    expect(state.lastErrorAt).toBe(now);
    expect(emailCalls).toHaveLength(0);
  });

  it('opens the window once and advances only lastErrorAt on later records', async () => {
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const first = Date.now();
    const { mon, storage } = makeMonitor();
    await mon.fetch(record({ projectId: 'p1', count: 5, userId: 'u1', slug: 'recappi' }));

    vi.setSystemTime(new Date('2026-07-21T10:05:00Z'));
    const second = Date.now();
    await mon.fetch(record({ projectId: 'p1', count: 3, userId: 'u1', slug: 'recappi' }));

    const state = storage.data.get('state') as State;
    expect(state.count).toBe(8);
    expect(state.firstErrorAt).toBe(first);
    expect(state.lastErrorAt).toBe(second);
  });

  it('fires with the error window and clears the window after sending', async () => {
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const start = Date.now();
    const { mon, storage } = makeMonitor();

    await mon.fetch(record({ projectId: 'p1', count: 100, userId: 'u1', slug: 'recappi' }));

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].count).toBe(100);
    expect(emailCalls[0].window).toEqual({ start, end: start });

    const state = storage.data.get('state') as State;
    expect(state.count).toBe(0);
    expect(state.firstErrorAt).toBeNull();
    expect(state.lastErrorAt).toBeNull();
    expect(state.lastAlertAt).toBe(start);
  });

  it('keeps the accumulated count and original window start across an expired cooldown', async () => {
    // Recreates recappi: a burst days ago whose tail accumulated during cooldown.
    const burstStart = Date.parse('2026-07-16T16:30:00Z');
    const burstEnd = Date.parse('2026-07-16T17:30:00Z');
    const { mon } = makeMonitor({
      count: 1252,
      projectId: 'p1',
      userId: 'u1',
      slug: 'recappi',
      lastAlertAt: burstStart, // >24h before "now" => cooldown expired
      firstErrorAt: burstStart,
      lastErrorAt: burstEnd,
    });

    vi.setSystemTime(new Date('2026-07-21T10:16:00Z'));
    const now = Date.now();
    await mon.fetch(record({ projectId: 'p1', count: 4, userId: 'u1', slug: 'recappi' }));

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].count).toBe(1256); // keep-count: 1252 + 4
    expect(emailCalls[0].window).toEqual({ start: burstStart, end: now });
  });

  it('stamps the window from the edge times in the record body, not from ingest time', async () => {
    // Queue backlog: the errors were metered at 10:00-10:10 but this DO only
    // sees them at 13:00. Stamping 13:00 would report a wrong window AND size
    // the emailed `--range` so it excludes the very rows it points at.
    vi.setSystemTime(new Date('2026-07-23T13:00:00Z'));
    const firstAt = Date.parse('2026-07-23T10:00:00Z');
    const lastAt = Date.parse('2026-07-23T10:10:00Z');
    const { mon, storage } = makeMonitor();

    await mon.fetch(
      record({ projectId: 'p1', count: 5, userId: 'u1', slug: 'recappi', firstAt, lastAt }),
    );

    const state = storage.data.get('state') as State;
    expect(state.firstErrorAt).toBe(firstAt);
    expect(state.lastErrorAt).toBe(lastAt);
  });

  it('widens the window when a later batch reports earlier edge times', async () => {
    vi.setSystemTime(new Date('2026-07-23T13:00:00Z'));
    const early = Date.parse('2026-07-23T09:00:00Z');
    const mid = Date.parse('2026-07-23T10:00:00Z');
    const late = Date.parse('2026-07-23T11:00:00Z');
    const { mon, storage } = makeMonitor();

    await mon.fetch(
      record({
        projectId: 'p1',
        count: 1,
        userId: 'u1',
        slug: 'recappi',
        firstAt: mid,
        lastAt: mid,
      }),
    );
    // Queues do not guarantee ordering — an older batch can land second.
    await mon.fetch(
      record({
        projectId: 'p1',
        count: 1,
        userId: 'u1',
        slug: 'recappi',
        firstAt: early,
        lastAt: late,
      }),
    );

    const state = storage.data.get('state') as State;
    expect(state.firstErrorAt).toBe(early);
    expect(state.lastErrorAt).toBe(late);
  });

  it('falls back to ingest time when the record body carries no edge times', async () => {
    vi.setSystemTime(new Date('2026-07-23T13:00:00Z'));
    const now = Date.now();
    const { mon, storage } = makeMonitor();

    await mon.fetch(record({ projectId: 'p1', count: 5, userId: 'u1', slug: 'recappi' }));

    const state = storage.data.get('state') as State;
    expect(state.firstErrorAt).toBe(now);
    expect(state.lastErrorAt).toBe(now);
  });

  it('passes a null window (recently fallback) when legacy state lacks window fields', async () => {
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const { mon } = makeMonitor({
      // legacy pre-migration state: no firstErrorAt / lastErrorAt keys
      count: 99,
      projectId: 'p1',
      userId: 'u1',
      slug: 'recappi',
      lastAlertAt: null,
    });

    await mon.fetch(record({ projectId: 'p1', count: 1, userId: 'u1', slug: 'recappi' }));

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].window).toBeNull();
  });
});
