import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import {
  SandboxConcurrencyCounter,
  STALE_MS,
  RECONCILE_INTERVAL_MS,
} from '../../src/sandbox-concurrency-counter.ts';

type StoredEntry = { acquiredAt: number };

function makeFakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const setAlarmCalls: Array<number> = [];
  return {
    data,
    setAlarmCalls,
    getAlarmRef: () => alarm,
    // Mirror CF behavior: after `alarm()` fires, the alarm is cleared
    // unless re-set inside the handler.
    fireAlarm: () => {
      alarm = null;
    },
    get: async <T>(key: string): Promise<T | undefined> => {
      const v = data.get(key);
      // Mirror Durable Object storage cloning semantics so callers can't
      // mutate the in-memory store through the returned reference.
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    getAlarm: async () => alarm,
    setAlarm: async (ts: number) => {
      alarm = ts;
      setAlarmCalls.push(ts);
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}

function makeCounter() {
  const storage = makeFakeStorage();
  const env = {} as never;
  const ctx = { storage } as never;
  const counter = new SandboxConcurrencyCounter(ctx, env);
  // Mocked DurableObject base doesn't run super(); assign manually so
  // `this.ctx` / `this.env` resolve.
  (counter as unknown as { ctx: unknown; env: unknown }).ctx = ctx;
  (counter as unknown as { ctx: unknown; env: unknown }).env = env;
  return { counter, storage };
}

function entries(storage: ReturnType<typeof makeFakeStorage>): Record<string, StoredEntry> {
  return (storage.data.get('entries') as Record<string, StoredEntry>) ?? {};
}

describe('SandboxConcurrencyCounter.acquire', () => {
  it('grants slot when under the plan limit', async () => {
    const { counter, storage } = makeCounter();
    const result = await counter.acquire('sb-1', 2);
    expect(result).toEqual({ ok: true });
    const stored = entries(storage);
    expect(Object.keys(stored)).toEqual(['sb-1']);
    expect(stored['sb-1']?.acquiredAt).toBeTypeOf('number');
  });

  it('is idempotent for the same sandboxInstanceId — no double count, refreshes acquiredAt', async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000_000_000;
    vi.setSystemTime(t0);
    try {
      const { counter, storage } = makeCounter();
      const r1 = await counter.acquire('sb-1', 1);
      expect(r1).toEqual({ ok: true });
      const firstAcquiredAt = entries(storage)['sb-1']?.acquiredAt;
      expect(firstAcquiredAt).toBe(t0);

      // Advance time and re-acquire the same id; should refresh, not reject,
      // and count must remain 1 so a separate acquire is still blocked.
      vi.setSystemTime(t0 + 1_000);
      const r2 = await counter.acquire('sb-1', 1);
      expect(r2).toEqual({ ok: true });
      const stored = entries(storage);
      expect(Object.keys(stored)).toEqual(['sb-1']);
      expect(stored['sb-1']?.acquiredAt).toBe(t0 + 1_000);

      // A different id should now be rejected because limit is still 1.
      const r3 = await counter.acquire('sb-2', 1);
      expect(r3).toEqual({ ok: false, reason: 'concurrency' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects at the limit and leaves storage unchanged', async () => {
    const { counter, storage } = makeCounter();
    expect(await counter.acquire('sb-1', 2)).toEqual({ ok: true });
    expect(await counter.acquire('sb-2', 2)).toEqual({ ok: true });
    const beforeReject = JSON.stringify(entries(storage));

    const r = await counter.acquire('sb-3', 2);
    expect(r).toEqual({ ok: false, reason: 'concurrency' });
    expect(JSON.stringify(entries(storage))).toBe(beforeReject);
  });

  it('treats planLimit=0 as unlimited (always grants)', async () => {
    const { counter, storage } = makeCounter();
    for (let i = 0; i < 25; i++) {
      const r = await counter.acquire(`sb-${i}`, 0);
      expect(r).toEqual({ ok: true });
    }
    expect(Object.keys(entries(storage)).length).toBe(25);
  });

  it('schedules an alarm on first acquire', async () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    try {
      const { counter, storage } = makeCounter();
      expect(storage.getAlarmRef()).toBe(null);
      await counter.acquire('sb-1', 5);
      expect(storage.getAlarmRef()).toBe(t0 + RECONCILE_INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SandboxConcurrencyCounter.release', () => {
  it('removes an existing entry', async () => {
    const { counter, storage } = makeCounter();
    await counter.acquire('sb-1', 2);
    await counter.acquire('sb-2', 2);
    expect(Object.keys(entries(storage)).sort()).toEqual(['sb-1', 'sb-2']);

    await counter.release('sb-1');
    expect(Object.keys(entries(storage))).toEqual(['sb-2']);
  });

  it('is a no-op for unknown ids', async () => {
    const { counter, storage } = makeCounter();
    await counter.release('does-not-exist');
    // Storage was never written
    expect(storage.data.has('entries')).toBe(false);
  });

  it('allows re-acquire at the boundary after release', async () => {
    const { counter } = makeCounter();
    expect(await counter.acquire('sb-1', 1)).toEqual({ ok: true });
    expect(await counter.acquire('sb-2', 1)).toEqual({
      ok: false,
      reason: 'concurrency',
    });

    await counter.release('sb-1');
    expect(await counter.acquire('sb-2', 1)).toEqual({ ok: true });
  });
});

describe('SandboxConcurrencyCounter.refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches acquiredAt for an existing slot and returns ok', async () => {
    const t0 = 4_000_000_000_000;
    vi.setSystemTime(t0);
    const { counter, storage } = makeCounter();
    await counter.acquire('sb-live', 10);
    // Advance halfway through the stale window so the refresh's effect is
    // visible (timestamp must end up at the new clock, not the old one).
    vi.setSystemTime(t0 + STALE_MS / 2);

    const result = await counter.refresh('sb-live');
    expect(result).toEqual({ ok: true });
    expect(entries(storage)['sb-live']?.acquiredAt).toBe(t0 + STALE_MS / 2);
    // Slot count unchanged — refresh never adds entries.
    expect(Object.keys(entries(storage))).toEqual(['sb-live']);
  });

  it('returns not_held when the slot is missing (already swept or never acquired)', async () => {
    const { counter, storage } = makeCounter();
    const result = await counter.refresh('sb-ghost');
    expect(result).toEqual({ ok: false, reason: 'not_held' });
    // Storage must not be touched — refresh is a no-op for unknown slots so
    // it doesn't auto-acquire and bypass the planLimit check.
    expect(storage.data.has('entries')).toBe(false);
  });

  it('keeps refreshed slots alive across an alarm sweep that reaps unrefreshed ones', async () => {
    const t0 = 5_000_000_000_000;
    vi.setSystemTime(t0);
    const { counter, storage } = makeCounter();
    await counter.acquire('sb-refreshed', 10);
    await counter.acquire('sb-stale', 10);

    // Jump just past STALE_MS — both slots would be reaped if left alone.
    // Refresh one to simulate the framework's heartbeat keepalive.
    vi.setSystemTime(t0 + STALE_MS + 1);
    expect(await counter.refresh('sb-refreshed')).toEqual({ ok: true });

    storage.fireAlarm();
    await counter.alarm();
    const stored = entries(storage);
    expect(Object.keys(stored)).toEqual(['sb-refreshed']);
  });
});

describe('SandboxConcurrencyCounter.alarm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps stale entries, leaves recent ones, and re-arms while entries remain', async () => {
    const t0 = 2_000_000_000_000;
    vi.setSystemTime(t0);
    const { counter, storage } = makeCounter();
    // Two slots acquired at t0
    await counter.acquire('sb-old', 10);
    await counter.acquire('sb-recent', 10);

    // Advance past STALE_MS for sb-old, refresh sb-recent right before sweep.
    vi.setSystemTime(t0 + STALE_MS + 60_000);
    await counter.acquire('sb-recent', 10); // idempotent refresh

    // Simulate CF firing the alarm: clear it first, then run the handler.
    storage.fireAlarm();
    const setAlarmCallsBeforeAlarm = storage.setAlarmCalls.length;
    await counter.alarm();

    const stored = entries(storage);
    expect(Object.keys(stored)).toEqual(['sb-recent']);

    // Re-armed because still has entries: exactly one new setAlarm call.
    expect(storage.setAlarmCalls.length).toBe(setAlarmCallsBeforeAlarm + 1);
    expect(storage.setAlarmCalls.at(-1)).toBe(t0 + STALE_MS + 60_000 + RECONCILE_INTERVAL_MS);
    expect(storage.getAlarmRef()).toBe(t0 + STALE_MS + 60_000 + RECONCILE_INTERVAL_MS);
  });

  it('does not re-arm when no entries remain after sweep', async () => {
    const t0 = 3_000_000_000_000;
    vi.setSystemTime(t0);
    const { counter, storage } = makeCounter();
    await counter.acquire('sb-old', 10);

    // Advance well past STALE_MS so the only entry is reaped.
    vi.setSystemTime(t0 + STALE_MS + 1);
    storage.fireAlarm();
    const setAlarmCallsBeforeAlarm = storage.setAlarmCalls.length;
    await counter.alarm();

    expect(entries(storage)).toEqual({});
    // No new alarm scheduled — DO is idle, leave it cold.
    expect(storage.setAlarmCalls.length).toBe(setAlarmCallsBeforeAlarm);
    expect(storage.getAlarmRef()).toBe(null);
  });
});
