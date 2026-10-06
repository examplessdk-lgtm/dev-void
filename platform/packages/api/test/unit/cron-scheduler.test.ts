import { describe, it, expect, vi } from 'vite-plus/test';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import {
  cfCronToUnix,
  chunkMessages,
  cronMatchesMinute,
  CronScheduler,
  getNextFireTime,
} from '../../src/cron-scheduler.ts';
import type { ApiEnv } from '../../src/env.ts';

describe('cfCronToUnix', () => {
  it('converts single numeric DOW (CF 1=Sun → Unix 0=Sun)', () => {
    expect(cfCronToUnix('0 12 * * 1')).toBe('0 12 * * 0');
  });

  it('converts CF 2=Mon → Unix 1=Mon', () => {
    expect(cfCronToUnix('0 12 * * 2')).toBe('0 12 * * 1');
  });

  it('converts CF 7=Sat → Unix 6=Sat', () => {
    expect(cfCronToUnix('0 0 * * 7')).toBe('0 0 * * 6');
  });

  it('converts ranges: CF 2-6 → Unix 1-5', () => {
    expect(cfCronToUnix('0 9 * * 2-6')).toBe('0 9 * * 1-5');
  });

  it('converts lists: CF 1,4,7 → Unix 0,3,6', () => {
    expect(cfCronToUnix('0 0 * * 1,4,7')).toBe('0 0 * * 0,3,6');
  });

  it('converts ranges with steps: CF 2-6/2 → Unix 1-5/2', () => {
    expect(cfCronToUnix('30 8 * * 2-6/2')).toBe('30 8 * * 1-5/2');
  });

  it('preserves * and */N', () => {
    expect(cfCronToUnix('* * * * *')).toBe('* * * * *');
    expect(cfCronToUnix('0 0 * * */2')).toBe('0 0 * * */2');
  });

  it('preserves abbreviations (MON, FRI)', () => {
    expect(cfCronToUnix('0 12 * * MON')).toBe('0 12 * * MON');
    expect(cfCronToUnix('0 9 * * MON-FRI')).toBe('0 9 * * MON-FRI');
  });

  it('passes through non-5-field expressions unchanged', () => {
    expect(cfCronToUnix('not-a-cron')).toBe('not-a-cron');
  });
});

describe('cronMatchesMinute', () => {
  it('matches every-minute cron at any time', () => {
    const now = new Date('2026-03-02T10:30:00Z').getTime();
    expect(cronMatchesMinute('* * * * *', now)).toBe(true);
  });

  it('matches hourly cron at the correct minute', () => {
    const atTop = new Date('2026-03-02T10:00:00Z').getTime();
    expect(cronMatchesMinute('0 * * * *', atTop)).toBe(true);

    const atHalf = new Date('2026-03-02T10:30:00Z').getTime();
    expect(cronMatchesMinute('0 * * * *', atHalf)).toBe(false);
  });

  it('matches within the same minute even with seconds offset', () => {
    const now = new Date('2026-03-02T10:00:45Z').getTime();
    expect(cronMatchesMinute('0 * * * *', now)).toBe(true);
  });

  it('does not match hourly cron at wrong minute', () => {
    const now = new Date('2026-03-02T10:15:00Z').getTime();
    expect(cronMatchesMinute('0 * * * *', now)).toBe(false);
  });

  it('matches day-of-week using CF convention (2=Mon)', () => {
    // 2026-03-02 is a Monday
    const monday = new Date('2026-03-02T12:00:00Z').getTime();
    expect(cronMatchesMinute('0 12 * * 2', monday)).toBe(true); // CF 2=Mon

    // Should not match on Tuesday
    const tuesday = new Date('2026-03-03T12:00:00Z').getTime();
    expect(cronMatchesMinute('0 12 * * 2', tuesday)).toBe(false);
  });

  it('matches Sunday as CF 1', () => {
    // 2026-03-01 is a Sunday
    const sunday = new Date('2026-03-01T12:00:00Z').getTime();
    expect(cronMatchesMinute('0 12 * * 1', sunday)).toBe(true); // CF 1=Sun
    expect(cronMatchesMinute('0 12 * * 2', sunday)).toBe(false); // CF 2=Mon
  });

  it('matches with abbreviations (unambiguous)', () => {
    const monday = new Date('2026-03-02T12:00:00Z').getTime();
    expect(cronMatchesMinute('0 12 * * MON', monday)).toBe(true);
  });

  it('returns false for invalid cron expression', () => {
    const now = Date.now();
    expect(cronMatchesMinute('not-a-cron', now)).toBe(false);
  });
});

describe('getNextFireTime', () => {
  it('returns next minute for every-minute cron', () => {
    const now = new Date('2026-03-02T10:30:00Z').getTime();
    const next = getNextFireTime([{ cron: '* * * * *' }], now);
    expect(next).toBe(new Date('2026-03-02T10:31:00Z').getTime());
  });

  it('returns next hour for hourly cron', () => {
    const now = new Date('2026-03-02T10:00:01Z').getTime();
    const next = getNextFireTime([{ cron: '0 * * * *' }], now);
    expect(next).toBe(new Date('2026-03-02T11:00:00Z').getTime());
  });

  it('returns earliest across multiple schedules', () => {
    const now = new Date('2026-03-02T10:00:01Z').getTime();
    const next = getNextFireTime([{ cron: '0 * * * *' }, { cron: '* * * * *' }], now);
    expect(next).toBe(new Date('2026-03-02T10:01:00Z').getTime());
  });

  it('returns null for empty schedules', () => {
    expect(getNextFireTime([], Date.now())).toBe(null);
  });

  it('skips invalid cron expressions and returns valid ones', () => {
    const now = new Date('2026-03-02T10:30:00Z').getTime();
    const next = getNextFireTime([{ cron: 'invalid' }, { cron: '* * * * *' }], now);
    expect(next).toBe(new Date('2026-03-02T10:31:00Z').getTime());
  });

  it('returns null when all expressions are invalid', () => {
    expect(getNextFireTime([{ cron: 'bad' }, { cron: 'worse' }], Date.now())).toBe(null);
  });
});

describe('chunkMessages', () => {
  it('returns an empty array for an empty input', () => {
    expect(chunkMessages([], 100)).toEqual([]);
  });

  it('returns a single chunk when items.length <= size', () => {
    const items = [1, 2, 3];
    expect(chunkMessages(items, 100)).toEqual([[1, 2, 3]]);
  });

  it('returns a single chunk when items.length === size', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const chunks = chunkMessages(items, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(100);
  });

  it('splits items into multiple chunks of size 100 (CF Queues cap)', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkMessages(items, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
    // Order is preserved across chunks.
    expect(chunks[0][0]).toBe(0);
    expect(chunks[1][0]).toBe(100);
    expect(chunks[2][0]).toBe(200);
    expect(chunks[2][49]).toBe(249);
  });

  it('handles exact multiples of the chunk size', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const chunks = chunkMessages(items, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
  });

  it('throws when size < 1', () => {
    expect(() => chunkMessages([1, 2, 3], 0)).toThrow();
    expect(() => chunkMessages([1, 2, 3], -1)).toThrow();
  });
});

describe('CronScheduler.alarm', () => {
  it('enqueues one delivery for jobs sharing the same expression', async () => {
    const ctx = makeStubCtx({
      state: {
        workerName: 'worker',
        schedules: [
          { name: 'first', cron: '* * * * *' },
          { name: 'second', cron: '* * * * *' },
        ],
        proxyToken: 'token',
      },
    });
    const sendBatch = vi.fn(async (_batch?: unknown) => {});
    const scheduler = makeScheduler(ctx, { CRON_FIRES_QUEUE: { sendBatch } });
    await scheduler.alarm();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch.mock.calls[0][0]).toHaveLength(1);
  });

  type StubCtx = ReturnType<typeof makeStubCtx>;

  function makeStubCtx(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    let alarmTime: number | null = null;
    return {
      storage: {
        get: vi.fn(async (k: string) => store.get(k)),
        put: vi.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        delete: vi.fn(async (k: string) => store.delete(k)),
        deleteAll: vi.fn(async () => store.clear()),
        getAlarm: vi.fn(async () => alarmTime),
        setAlarm: vi.fn(async (t: number) => {
          alarmTime = t;
        }),
        deleteAlarm: vi.fn(async () => {
          alarmTime = null;
        }),
      },
    };
  }

  function makeScheduler(
    ctx: StubCtx,
    env: { CRON_FIRES_QUEUE: { sendBatch: (batch?: unknown) => Promise<void> } },
  ) {
    // Bypass the real DurableObject constructor wiring in the mock above
    return new CronScheduler(
      ctx as unknown as DurableObjectState,
      env as unknown as ApiEnv['Bindings'],
    );
  }

  it('throws when ALL sendBatch chunks fail (DO alarm framework will retry)', async () => {
    // At-most-once contract: when no fires were enqueued, throwing surfaces
    // the failure to the DO runtime so it retries with backoff. Safe because
    // nothing succeeded — there is no double-fire risk.
    const ctx = makeStubCtx({
      state: {
        workerName: 'user-foo',
        schedules: [{ name: 'job', cron: '* * * * *' }],
        proxyToken: 'tok',
      },
    });
    const sendBatch = vi.fn(async () => {
      throw new Error('queues api outage');
    });
    const env = { CRON_FIRES_QUEUE: { sendBatch } };

    const s = makeScheduler(ctx, env);
    await expect(s.alarm()).rejects.toThrow(/all sendBatch chunks failed/);
    // setAlarm must NOT have been called — we want the runtime to retry the
    // current alarm rather than advance past it.
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('does not throw on partial sendBatch failure (avoid double-fire on success chunks)', async () => {
    // 200 messages → 2 chunks. One succeeds, one fails. Re-running would
    // double-fire the successful chunk, so we accept the loss and proceed.
    const schedules = Array.from({ length: 200 }, (_, i) => ({
      name: `job${i}`,
      cron: `0,${i % 60} 0,${Math.floor(i / 60)} * * *`,
    }));
    const ctx = makeStubCtx({
      state: { workerName: 'user-foo', schedules, proxyToken: 'tok' },
    });
    let n = 0;
    const sendBatch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return; // first chunk succeeds
      }
      throw new Error('partial failure'); // second chunk fails
    });
    const env = { CRON_FIRES_QUEUE: { sendBatch } };

    const s = makeScheduler(ctx, env);
    await expect(
      s.alarm({ scheduledTime: Date.UTC(2026, 0, 1), isRetry: false, retryCount: 0 }),
    ).resolves.toBeUndefined();
    expect(sendBatch).toHaveBeenCalledTimes(2);
    // scheduleNextAlarm must run on partial success
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('schedules next alarm on full success', async () => {
    const ctx = makeStubCtx({
      state: {
        workerName: 'user-foo',
        schedules: [{ name: 'job', cron: '* * * * *' }],
        proxyToken: 'tok',
      },
    });
    const sendBatch = vi.fn(async () => {});
    const env = { CRON_FIRES_QUEUE: { sendBatch } };

    const s = makeScheduler(ctx, env);
    await expect(s.alarm()).resolves.toBeUndefined();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('uses alarmInfo.scheduledTime for matching and queue body when provided', async () => {
    // Workerd retries `alarm()` after a throw — `Date.now()` would read the
    // retry instant, which (for sparse crons that cross a minute boundary on
    // retry) yields no matches and silently drops the original firing. So
    // pin both `cronMatchesMinute` and the queue-message `scheduledTime`
    // to `alarmInfo.scheduledTime` so the same cron minute is preserved.
    //
    // Setup: hourly cron (`0 * * * *`). The "real" scheduled minute is
    // 10:00:00 UTC (matches). Mock `Date.now()` to 10:30:00 UTC (does NOT
    // match). Matching still succeeds and the queued message carries
    // scheduledTime=10:00:00.
    const scheduledTime = new Date('2026-03-02T10:00:00Z').getTime();
    const wallClock = new Date('2026-03-02T10:30:00Z').getTime();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(wallClock);
    try {
      const ctx = makeStubCtx({
        state: {
          workerName: 'user-foo',
          schedules: [{ name: 'top', cron: '0 * * * *' }],
          proxyToken: 'tok',
        },
      });
      const sentBatches: Array<Array<{ body: { scheduledTime: number } }>> = [];
      const sendBatch = vi.fn(async (batch?: unknown) => {
        sentBatches.push(batch as Array<{ body: { scheduledTime: number } }>);
      });
      const env = { CRON_FIRES_QUEUE: { sendBatch } };

      const s = makeScheduler(ctx, env);
      await expect(
        s.alarm({ isRetry: true, retryCount: 1, scheduledTime }),
      ).resolves.toBeUndefined();

      // The hourly cron matched only because we used scheduledTime — confirm
      // a fire was enqueued AND that its scheduledTime pins to the original
      // cron minute, not Date.now().
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(sentBatches[0]).toHaveLength(1);
      expect(sentBatches[0][0].body.scheduledTime).toBe(scheduledTime);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('falls back to Date.now() when alarmInfo is omitted', async () => {
    // Backwards-compat with older runtimes that don't pass AlarmInvocationInfo.
    const wallClock = new Date('2026-03-02T10:00:00Z').getTime();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(wallClock);
    try {
      const ctx = makeStubCtx({
        state: {
          workerName: 'user-foo',
          schedules: [{ name: 'top', cron: '0 * * * *' }],
          proxyToken: 'tok',
        },
      });
      const sentBatches: Array<Array<{ body: { scheduledTime: number } }>> = [];
      const sendBatch = vi.fn(async (batch?: unknown) => {
        sentBatches.push(batch as Array<{ body: { scheduledTime: number } }>);
      });
      const env = { CRON_FIRES_QUEUE: { sendBatch } };

      const s = makeScheduler(ctx, env);
      await expect(s.alarm()).resolves.toBeUndefined();
      expect(sendBatch).toHaveBeenCalledOnce();
      expect(sentBatches[0][0].body.scheduledTime).toBe(wallClock);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('all-fail with retryCount >= ALARM_RETRY_BUDGET schedules next alarm and does not throw', async () => {
    // Workerd alarm retries are capped at ~6. If we keep throwing past the
    // cap, the alarm is permanently dropped and the DO is left with active
    // schedules but no alarm — only a deploy or manual `/sync` recovers it.
    // Once the workerd budget is about to exhaust, abandon this firing,
    // schedule the next cron minute, and return cleanly so the DO stays
    // armed for the next window.
    const ctx = makeStubCtx({
      state: {
        workerName: 'user-foo',
        schedules: [{ name: 'job', cron: '* * * * *' }],
        proxyToken: 'tok',
      },
    });
    const sendBatch = vi.fn(async () => {
      throw new Error('queues api outage');
    });
    const env = { CRON_FIRES_QUEUE: { sendBatch } };

    const s = makeScheduler(ctx, env);
    // retryCount=5 hits the budget — accept the loss and schedule the next.
    await expect(
      s.alarm({ isRetry: true, retryCount: 5, scheduledTime: Date.now() }),
    ).resolves.toBeUndefined();
    // setAlarm must have been called so the DO stays armed.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('all-fail with retryCount < ALARM_RETRY_BUDGET still throws (workerd retries)', async () => {
    // Within the workerd retry budget, throwing is correct: the runtime
    // retries the alarm with backoff, and `alarmInfo.scheduledTime` keeps
    // the retry pointed at the original cron minute.
    const ctx = makeStubCtx({
      state: {
        workerName: 'user-foo',
        schedules: [{ name: 'job', cron: '* * * * *' }],
        proxyToken: 'tok',
      },
    });
    const sendBatch = vi.fn(async () => {
      throw new Error('queues api outage');
    });
    const env = { CRON_FIRES_QUEUE: { sendBatch } };

    const s = makeScheduler(ctx, env);
    await expect(
      s.alarm({ isRetry: true, retryCount: 2, scheduledTime: Date.now() }),
    ).rejects.toThrow(/all sendBatch chunks failed/);
    // setAlarm must NOT have been called — runtime retains current alarm
    // for retry.
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });
});
