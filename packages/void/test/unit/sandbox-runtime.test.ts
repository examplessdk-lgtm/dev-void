import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `vi.mock` is hoisted above all imports, so the @cloudflare/sandbox mock
// must be installed before we import the runtime module. We expose a swappable
// `getSandboxImpl` so individual tests can change its behaviour without
// re-stubbing the module.
let getSandboxImpl: (...args: ReadonlyArray<unknown>) => unknown = () => ({});

vi.mock('@cloudflare/sandbox', () => {
  class FakeSandbox {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    onStart(): Promise<void> {
      return Promise.resolve();
    }
    onStop(): Promise<void> {
      return Promise.resolve();
    }
    onActivityExpired(): Promise<void> {
      return Promise.resolve();
    }
    alarm(_props?: { isRetry: boolean; retryCount: number }): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    Sandbox: FakeSandbox,
    getSandbox: (...args: ReadonlyArray<unknown>) => getSandboxImpl(...args),
  };
});

// Inline storage stand-in for `DurableObjectState.storage`.
type StorageMap = Map<string, unknown>;
function createMockCtx(idName?: string) {
  const storage: StorageMap = new Map();
  const alarms: Array<number> = [];
  return {
    id: {
      name: idName,
      toString: () => idName ?? 'do-id-stringified',
    },
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
      setAlarm: vi.fn(async (when: number) => {
        alarms.push(when);
      }),
      getAlarm: vi.fn(async () => alarms[alarms.length - 1] ?? null),
    },
    _storageMap: storage,
    _alarms: alarms,
  };
}

describe('runtime sandbox: getSandbox()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    getSandboxImpl = () => ({});
  });

  it('returns the DO stub when no gate binding is present (local dev)', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox } = await import('../../src/runtime/sandbox.ts');

    const namespaceMarker = Symbol('namespace');
    const stub = { __returned: true };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    await envContext.run({ SANDBOX: { __ns: namespaceMarker } }, async () => {
      const result = await getSandbox('my-id');
      expect(result).toBe(stub);
    });

    expect(stubFn).toHaveBeenCalledOnce();
    // Stub was called with (namespace, id, options).
    const callArgs = stubFn.mock.calls[0];
    expect((callArgs[0] as { __ns: symbol }).__ns).toBe(namespaceMarker);
    expect(callArgs[1]).toBe('my-id');
    expect(callArgs[2]).toMatchObject({ normalizeId: true });
  });

  it('returns the DO stub when the gate returns 200', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox } = await import('../../src/runtime/sandbox.ts');

    const stub = { __with_gate: true };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 200 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
      },
      async () => {
        const result = await getSandbox('sb-1');
        expect(result).toBe(stub);
      },
    );

    expect(gateFetch).toHaveBeenCalledOnce();
    const callArgs = gateFetch.mock.calls[0];
    const url = callArgs[0] as string;
    const init = callArgs[1] as RequestInit;
    expect(url).toBe('https://gate/sandbox/acquire');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ sandboxId: 'sb-1' });
  });

  it('throws SandboxLimitError(concurrency) when the gate denies with 409', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, SandboxLimitError } = await import('../../src/runtime/sandbox.ts');

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) =>
        new Response(JSON.stringify({ reason: 'concurrency' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
      },
      async () => {
        await expect(getSandbox('sb-x')).rejects.toBeInstanceOf(SandboxLimitError);
        await expect(getSandbox('sb-x')).rejects.toMatchObject({ reason: 'concurrency' });
      },
    );
  });

  it('throws SandboxLimitError(runtime_budget) when the gate denies with that reason', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, SandboxLimitError } = await import('../../src/runtime/sandbox.ts');

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) =>
        new Response(JSON.stringify({ reason: 'runtime_budget' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
      },
      async () => {
        const err = await getSandbox('sb-x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SandboxLimitError);
        expect((err as InstanceType<typeof SandboxLimitError>).reason).toBe('runtime_budget');
      },
    );
  });

  it('falls through and returns the DO stub when the gate responds non-409 non-OK (fail-open)', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox } = await import('../../src/runtime/sandbox.ts');

    const stub = { __fail_open: true };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response('upstream blew up', { status: 500 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
      },
      async () => {
        // Documents the deliberate fail-open behaviour: a broken gate must not
        // block sandbox acquisition. The gate's lease TTL backstops accounting.
        const result = await getSandbox('sb-any');
        expect(result).toBe(stub);
      },
    );

    expect(gateFetch).toHaveBeenCalledOnce();
    expect(stubFn).toHaveBeenCalledOnce();
  });
});

describe('runtime sandbox: VoidPlatformSandbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('onStart() records start timestamp in storage even when no usage queue is bound', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox, HEARTBEAT_MS } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-A');
    const env = {};

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await expect(sandbox.onStart()).resolves.toBeUndefined();
    });

    const startTs = ctx._storageMap.get('__voidStartTs');
    const lastFlushTs = ctx._storageMap.get('__voidLastFlushTs');
    expect(typeof startTs).toBe('number');
    expect(typeof lastFlushTs).toBe('number');
    expect(ctx._alarms.length).toBe(1);
    expect(ctx._alarms[0]).toBe((startTs as number) + HEARTBEAT_MS);
  });

  it('onStart() followed by onStop() emits one runtime event with sandboxRuntimeSeconds > 0', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-B');
    const queueSend = vi.fn(async (..._args: ReadonlyArray<unknown>) => undefined);
    const env = {
      USAGE_EVENTS_QUEUE: { send: queueSend },
    };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
      // Advance wall-clock so the elapsed runtime is observable.
      vi.advanceTimersByTime(7_500);
      await sandbox.onStop();
    });

    expect(queueSend).toHaveBeenCalledOnce();
    const event = queueSend.mock.calls[0][0] as {
      sandboxRuntimeSeconds: number;
      sandboxInstanceId: string;
      requests: number;
      responseBytes: number;
    };
    expect(event.sandboxRuntimeSeconds).toBeGreaterThan(0);
    expect(event.sandboxInstanceId).toBe('sandbox-instance-B');
    expect(event.requests).toBe(0);
    expect(event.responseBytes).toBe(0);
    // Storage cleared on stop.
    expect(ctx._storageMap.has('__voidStartTs')).toBe(false);
    expect(ctx._storageMap.has('__voidLastFlushTs')).toBe(false);
  });

  it('onStop() with no usage-queue binding does not throw and still notifies gate if present', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-C');
    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 204 }),
    );
    const env = { __VOID_PROXY: { fetch: gateFetch } };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
      vi.advanceTimersByTime(1_000);
      await expect(sandbox.onStop()).resolves.toBeUndefined();
    });

    // Flush the microtask queue so the fire-and-forget POST runs. The release
    // call is a synchronous `void gate.fetch(...)` — it lands as a microtask,
    // not a timer, so `vi.runAllTimersAsync()` would not advance it.
    await Promise.resolve();
    expect(gateFetch).toHaveBeenCalledOnce();
    expect(gateFetch.mock.calls[0][0]).toBe('https://gate/sandbox/release');
  });

  it('onStart() emits a single reconciliation event when storage holds an orphaned anchor', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-orphan');
    // Simulate a crash: the previous instance wrote an anchor 10s ago and
    // never got to onStop. The new onStart() should pick up the orphaned
    // window and emit one reconciliation event.
    const ORPHAN_LAG_MS = 10_000;
    const now = Date.now();
    const orphanedAnchor = now - ORPHAN_LAG_MS;
    ctx._storageMap.set('__voidStartTs', orphanedAnchor);
    ctx._storageMap.set('__voidLastFlushTs', orphanedAnchor);

    const queueSend = vi.fn(async (..._args: ReadonlyArray<unknown>) => undefined);
    const env = { USAGE_EVENTS_QUEUE: { send: queueSend } };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
    });

    expect(queueSend).toHaveBeenCalledOnce();
    const event = queueSend.mock.calls[0][0] as { sandboxRuntimeSeconds: number };
    expect(event.sandboxRuntimeSeconds).toBe(ORPHAN_LAG_MS / 1000);
    // Anchors reset to the new "now".
    expect(ctx._storageMap.get('__voidStartTs')).toBe(now);
    expect(ctx._storageMap.get('__voidLastFlushTs')).toBe(now);
  });

  it('alarm() emits a heartbeat delta and re-arms the next alarm', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox, HEARTBEAT_MS } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-D');
    const queueSend = vi.fn(async (..._args: ReadonlyArray<unknown>) => undefined);
    const env = { USAGE_EVENTS_QUEUE: { send: queueSend } };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await sandbox.alarm();
    });

    expect(queueSend).toHaveBeenCalledOnce();
    const event = queueSend.mock.calls[0][0] as { sandboxRuntimeSeconds: number };
    // Heartbeat delta should be ~HEARTBEAT_MS / 1000 seconds.
    expect(event.sandboxRuntimeSeconds).toBeCloseTo(HEARTBEAT_MS / 1000, 0);
    // Alarm re-armed: at least one extra setAlarm beyond the onStart() one.
    expect(ctx._alarms.length).toBeGreaterThanOrEqual(2);
  });
});
