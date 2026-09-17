import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `vi.mock` is hoisted above all imports, so the @cloudflare/sandbox mock
// must be installed before we import the runtime module. We expose a swappable
// `getSandboxImpl` so individual tests can change its behaviour without
// re-stubbing the module.
//
function opaqueId(seed: string): string {
  const encoded = [...seed].map((character) => character.codePointAt(0)!.toString(16)).join('');
  return encoded.repeat(Math.ceil(64 / encoded.length)).slice(0, 64);
}

// A real DurableObjectId exposes the optional human-readable name and a
// namespace-specific 64-digit opaque string. The gate must use the latter.
function makeDefaultStub(...args: ReadonlyArray<unknown>): {
  id: { name: string | undefined; toString: () => string };
} {
  const callerId = args[1] as string | undefined;
  const options = args[2] as { normalizeId?: boolean } | undefined;
  const effectiveId = callerId && options?.normalizeId ? callerId.toLowerCase() : callerId;
  return {
    id: {
      name: effectiveId,
      toString: () => opaqueId(`namespace:${effectiveId ?? 'default'}`),
    },
  };
}
let getSandboxImpl: (...args: ReadonlyArray<unknown>) => unknown = makeDefaultStub;

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
function createMockCtx(idName?: string, idString = opaqueId(`namespace:${idName ?? 'default'}`)) {
  const storage: StorageMap = new Map();
  const alarms: Array<number> = [];
  const waitUntilTasks: Array<Promise<unknown>> = [];
  return {
    id: {
      name: idName,
      toString: () => idString,
    },
    storage: {
      get: vi.fn(async (keyOrKeys: string | Array<string>) => {
        if (Array.isArray(keyOrKeys)) {
          const result = new Map<string, unknown>();
          for (const k of keyOrKeys) {
            if (storage.has(k)) {
              result.set(k, storage.get(k));
            }
          }
          return result;
        }
        return storage.get(keyOrKeys);
      }),
      put: vi.fn(async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === 'string') {
          storage.set(keyOrEntries, value);
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) {
            storage.set(k, v);
          }
        }
      }),
      delete: vi.fn(async (keyOrKeys: string | Array<string>) => {
        if (Array.isArray(keyOrKeys)) {
          let count = 0;
          for (const k of keyOrKeys) {
            if (storage.delete(k)) {
              count++;
            }
          }
          return count;
        }
        return storage.delete(keyOrKeys);
      }),
      setAlarm: vi.fn(async (when: number) => {
        alarms.push(when);
      }),
      getAlarm: vi.fn(async () => alarms[alarms.length - 1] ?? null),
    },
    // Stand-in for `DurableObjectState.waitUntil` — captures the promise so
    // tests can await it and observe lifecycle-spawned fetches (e.g. the gate
    // release POST issued from onStop/onActivityExpired).
    waitUntil: vi.fn((p: Promise<unknown>) => {
      waitUntilTasks.push(p);
    }),
    _storageMap: storage,
    _alarms: alarms,
    _waitUntilTasks: waitUntilTasks,
  };
}

describe('runtime sandbox: getSandbox()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    getSandboxImpl = makeDefaultStub;
  });

  it('returns the DO stub when no gate binding is present (local dev)', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox } = await import('../../src/runtime/sandbox.ts');

    const namespaceMarker = Symbol('namespace');
    const stub = {
      __returned: true,
      id: { name: 'my-id', toString: () => opaqueId('local:my-id') },
    };
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

    const sandboxInstanceId = opaqueId('deployment-a:sb-1');
    const stub = {
      __with_gate: true,
      id: { name: 'sb-1', toString: () => sandboxInstanceId },
    };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 200 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-1',
        __VOID_PROXY_TOKEN: 'token-1',
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
    // Body must carry the HMAC-verifiable {projectId, aiToken} pair the
    // proxy auth middleware requires, alongside the caller's sandboxId.
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'proj-1',
      aiToken: 'token-1',
      sandboxId: sandboxInstanceId,
    });
  });

  it('sends distinct opaque identities for the same name in different DO namespaces', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox } = await import('../../src/runtime/sandbox.ts');

    const deploymentAId = '1'.repeat(64);
    const deploymentBId = '2'.repeat(64);
    const stubs = [
      { id: { name: 'default', toString: () => deploymentAId } },
      { id: { name: 'default', toString: () => deploymentBId } },
    ];
    getSandboxImpl = () => stubs.shift();
    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 200 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-shared-name',
        __VOID_PROXY_TOKEN: 'token-shared-name',
      },
      async () => {
        await getSandbox();
        await getSandbox();
      },
    );

    const sandboxIds = gateFetch.mock.calls.map((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string) as { sandboxId: string };
      return body.sandboxId;
    });
    expect(sandboxIds).toEqual([deploymentAId, deploymentBId]);
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
        __PROJECT_ID: 'proj-1',
        __VOID_PROXY_TOKEN: 'token-1',
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
        __PROJECT_ID: 'proj-1',
        __VOID_PROXY_TOKEN: 'token-1',
      },
      async () => {
        const err = await getSandbox('sb-x').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SandboxLimitError);
        expect((err as InstanceType<typeof SandboxLimitError>).reason).toBe('runtime_budget');
      },
    );
  });

  it('fails closed when the managed gate responds non-409 non-OK', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, SandboxUnavailableError } = await import('../../src/runtime/sandbox.ts');

    const stub = {
      __fail_open: true,
      id: { name: 'sb-any', toString: () => opaqueId('deployment-a:sb-any') },
    };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response('upstream blew up', { status: 500 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-1',
        __VOID_PROXY_TOKEN: 'token-1',
      },
      async () => {
        await expect(getSandbox('sb-any')).rejects.toBeInstanceOf(SandboxUnavailableError);
      },
    );

    expect(gateFetch).toHaveBeenCalledOnce();
    expect(stubFn).toHaveBeenCalledOnce();
  });

  it('fails closed when the managed gate fetch throws', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, SandboxUnavailableError } = await import('../../src/runtime/sandbox.ts');

    const stub = {
      __fail_open_throw: true,
      id: { name: 'sb-throw', toString: () => opaqueId('deployment-a:sb-throw') },
    };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(async (..._args: ReadonlyArray<unknown>) => {
      throw new Error('service binding unreachable');
    });

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-1',
        __VOID_PROXY_TOKEN: 'token-1',
      },
      async () => {
        await expect(getSandbox('sb-throw')).rejects.toBeInstanceOf(SandboxUnavailableError);
      },
    );

    expect(gateFetch).toHaveBeenCalledOnce();
    expect(stubFn).toHaveBeenCalledOnce();
  });

  it('uses the opaque DO identity as the gate sandboxId so acquire matches release', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');

    // The name remains useful for addressing inside one namespace, but the
    // opaque id is what distinguishes the same name across deployments.
    const CALLER_ID = 'MyProject-123';
    const NORMALIZED_ID = 'myproject-123';
    const INSTANCE_ID = opaqueId('deployment-b:myproject-123');

    const stub = {
      __normalized: true,
      id: { name: NORMALIZED_ID, toString: () => INSTANCE_ID },
    };
    getSandboxImpl = (..._args: ReadonlyArray<unknown>) => stub;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 200 }),
    );

    let releaseCtx: ReturnType<typeof createMockCtx> | undefined;
    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-norm',
        __VOID_PROXY_TOKEN: 'token-norm',
      },
      async () => {
        // 1. Acquire with the mixed-case caller id.
        await getSandbox(CALLER_ID);

        // 2. Release via the DO lifecycle — ctx.id exposes the same opaque id.
        releaseCtx = createMockCtx(NORMALIZED_ID, INSTANCE_ID);
        const env = {
          __VOID_PROXY: { fetch: gateFetch },
          __PROJECT_ID: 'proj-norm',
          __VOID_PROXY_TOKEN: 'token-norm',
        };
        const sandbox = new VoidPlatformSandbox(releaseCtx as never, env as never);
        await sandbox.onStop();
      },
    );

    // Release is routed through ctx.waitUntil() — drain the captured promise
    // so the gate fetch lands before we assert on it.
    await Promise.all(releaseCtx?._waitUntilTasks ?? []);

    expect(gateFetch).toHaveBeenCalledTimes(2);
    const acquireBody = JSON.parse((gateFetch.mock.calls[0][1] as RequestInit).body as string) as {
      sandboxId: string;
    };
    const releaseBody = JSON.parse((gateFetch.mock.calls[1][1] as RequestInit).body as string) as {
      sandboxId: string;
    };
    expect(acquireBody.sandboxId).toBe(INSTANCE_ID);
    expect(releaseBody.sandboxId).toBe(INSTANCE_ID);
    expect(acquireBody.sandboxId).toBe(releaseBody.sandboxId);
  });

  it('fails closed when a managed deployment is missing an identity binding', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { getSandbox, SandboxUnavailableError } = await import('../../src/runtime/sandbox.ts');

    const stub = {
      __no_token: true,
      id: { name: 'sb-skip', toString: () => opaqueId('deployment-a:sb-skip') },
    };
    const stubFn = vi.fn((..._args: ReadonlyArray<unknown>) => stub);
    getSandboxImpl = stubFn;

    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 200 }),
    );

    await envContext.run(
      {
        SANDBOX: { __ns: true },
        __VOID_PROXY: { fetch: gateFetch },
        __PROJECT_ID: 'proj-1',
        // __VOID_PROXY_TOKEN intentionally absent
      },
      async () => {
        await expect(getSandbox('sb-skip')).rejects.toBeInstanceOf(SandboxUnavailableError);
      },
    );

    expect(gateFetch).not.toHaveBeenCalled();
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

  it('blocks a raw managed Durable Object start when the gate disables Sandbox', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox, SandboxUnavailableError } =
      await import('../../src/runtime/sandbox.ts');
    const { Sandbox } = await import('@cloudflare/sandbox');
    const upstreamStart = vi.spyOn(
      Sandbox.prototype as { onStart: () => Promise<void> },
      'onStart',
    );
    const gateFetch = vi.fn(async () => new Response('managed Sandbox disabled', { status: 501 }));
    const env = {
      __VOID_PROXY: { fetch: gateFetch },
      __PROJECT_ID: 'proj-disabled',
      __VOID_PROXY_TOKEN: 'token-disabled',
    };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(createMockCtx('raw-disabled') as never, env as never);
      await expect(sandbox.onStart()).rejects.toBeInstanceOf(SandboxUnavailableError);
    });

    expect(gateFetch).toHaveBeenCalledOnce();
    expect(upstreamStart).not.toHaveBeenCalled();
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
    expect(event.sandboxInstanceId).toBe(opaqueId('namespace:sandbox-instance-B'));
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
    const env = {
      __VOID_PROXY: { fetch: gateFetch },
      __PROJECT_ID: 'proj-release',
      __VOID_PROXY_TOKEN: 'token-release',
    };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
      vi.advanceTimersByTime(1_000);
      await expect(sandbox.onStop()).resolves.toBeUndefined();
    });

    // The release POST is routed through `ctx.waitUntil()` (so it survives
    // lifecycle teardown). Awaiting the captured promise both confirms the
    // hook handed us one and lets us assert on the in-flight fetch.
    expect(ctx._waitUntilTasks.length).toBe(1);
    await Promise.all(ctx._waitUntilTasks);
    expect(gateFetch).toHaveBeenCalledTimes(2);
    expect(gateFetch.mock.calls[0][0]).toBe('https://gate/sandbox/acquire');
    const releaseCall = gateFetch.mock.calls[1];
    expect(releaseCall[0]).toBe('https://gate/sandbox/release');
    // Same {projectId, aiToken, sandboxId} contract as /acquire — the shared
    // proxy auth middleware protects both routes.
    const releaseInit = releaseCall[1] as RequestInit;
    expect(JSON.parse(releaseInit.body as string)).toEqual({
      projectId: 'proj-release',
      aiToken: 'token-release',
      sandboxId: opaqueId('namespace:sandbox-instance-C'),
    });
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

  it('onStart() clears orphan anchor before super.onStart() so a failed super does not re-bill on retry', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');
    const { Sandbox } = await import('@cloudflare/sandbox');

    const ctx = createMockCtx('sandbox-instance-orphan-throw');
    // Pre-populate an orphan anchor 10s in the past, simulating a previous
    // instance that crashed without firing onStop.
    const ORPHAN_LAG_MS = 10_000;
    const orphanedAnchor = Date.now() - ORPHAN_LAG_MS;
    ctx._storageMap.set('__voidStartTs', orphanedAnchor);
    ctx._storageMap.set('__voidLastFlushTs', orphanedAnchor);

    const queueSend = vi.fn(async (..._args: ReadonlyArray<unknown>) => undefined);
    const env = { USAGE_EVENTS_QUEUE: { send: queueSend } };

    // First onStart(): the orphan reconciliation event must be emitted and
    // the anchors cleared BEFORE super throws. We assert both pieces so a
    // future regression that delays the delete after super gets caught.
    const onStartSpy = vi
      .spyOn(Sandbox.prototype as { onStart: () => Promise<void> }, 'onStart')
      .mockRejectedValueOnce(new Error('container failed to start'));

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await expect(sandbox.onStart()).rejects.toThrow('container failed to start');
    });

    // One reconciliation event for the orphan window.
    expect(queueSend).toHaveBeenCalledOnce();
    // Anchors cleared in storage despite super throwing — this is the bug fix.
    expect(ctx._storageMap.has('__voidStartTs')).toBe(false);
    expect(ctx._storageMap.has('__voidLastFlushTs')).toBe(false);

    // Second onStart() retry with super now succeeding. There must NOT be a
    // second reconciliation event because storage no longer holds an orphan
    // anchor — this is the double-billing the fix prevents.
    onStartSpy.mockResolvedValueOnce();

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await expect(sandbox.onStart()).resolves.toBeUndefined();
    });

    // Still just the original single emit — no extra reconciliation.
    expect(queueSend).toHaveBeenCalledOnce();
    // Fresh start anchors written by the successful retry.
    expect(typeof ctx._storageMap.get('__voidStartTs')).toBe('number');
    expect(typeof ctx._storageMap.get('__voidLastFlushTs')).toBe('number');
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

  it('alarm() fires a fire-and-forget refresh POST to the gate via waitUntil', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox, HEARTBEAT_MS } = await import('../../src/runtime/sandbox.ts');

    const ctx = createMockCtx('sandbox-instance-refresh');
    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const env = {
      __VOID_PROXY: { fetch: gateFetch },
      __PROJECT_ID: 'proj-refresh',
      __VOID_PROXY_TOKEN: 'token-refresh',
    };

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await sandbox.onStart();
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await sandbox.alarm();
    });

    // Refresh is routed through ctx.waitUntil() so it survives the alarm
    // hook returning. Drain the captured promise before asserting on the
    // in-flight fetch.
    expect(ctx._waitUntilTasks.length).toBe(1);
    await Promise.all(ctx._waitUntilTasks);

    expect(gateFetch).toHaveBeenCalledTimes(2);
    expect(gateFetch.mock.calls[0][0]).toBe('https://gate/sandbox/acquire');
    const refreshCall = gateFetch.mock.calls[1];
    expect(refreshCall[0]).toBe('https://gate/sandbox/refresh');
    const refreshInit = refreshCall[1] as RequestInit;
    expect(refreshInit.method).toBe('POST');
    // Same {projectId, aiToken, sandboxId} shape as acquire/release — the
    // shared HMAC auth middleware protects all three routes.
    expect(JSON.parse(refreshInit.body as string)).toEqual({
      projectId: 'proj-refresh',
      aiToken: 'token-refresh',
      sandboxId: opaqueId('namespace:sandbox-instance-refresh'),
    });
  });

  it('onStart() releases the gate lease via waitUntil when super.onStart() throws', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { VoidPlatformSandbox } = await import('../../src/runtime/sandbox.ts');
    const { Sandbox } = await import('@cloudflare/sandbox');

    const ctx = createMockCtx('sandbox-instance-startup-fail');
    const gateFetch = vi.fn(
      async (..._args: ReadonlyArray<unknown>) => new Response(null, { status: 204 }),
    );
    const env = {
      __VOID_PROXY: { fetch: gateFetch },
      __PROJECT_ID: 'proj-fail',
      __VOID_PROXY_TOKEN: 'token-fail',
    };

    // Make super.onStart() reject — getSandbox() already POSTed /acquire
    // before the first DO method call, so neither onStop nor
    // onActivityExpired will fire for this instance. Without a release here
    // the slot leaks until the gate's STALE_MS sweep.
    vi.spyOn(
      Sandbox.prototype as { onStart: () => Promise<void> },
      'onStart',
    ).mockRejectedValueOnce(new Error('container failed to start'));

    await envContext.run(env, async () => {
      const sandbox = new VoidPlatformSandbox(ctx as never, env as never);
      await expect(sandbox.onStart()).rejects.toThrow('container failed to start');
    });

    // Release routed through waitUntil — drain it and assert on the fetch.
    expect(ctx._waitUntilTasks.length).toBe(1);
    await Promise.all(ctx._waitUntilTasks);

    expect(gateFetch).toHaveBeenCalledTimes(2);
    expect(gateFetch.mock.calls[0][0]).toBe('https://gate/sandbox/acquire');
    const releaseCall = gateFetch.mock.calls[1];
    expect(releaseCall[0]).toBe('https://gate/sandbox/release');
    const releaseInit = releaseCall[1] as RequestInit;
    expect(JSON.parse(releaseInit.body as string)).toEqual({
      projectId: 'proj-fail',
      aiToken: 'token-fail',
      sandboxId: opaqueId('namespace:sandbox-instance-startup-fail'),
    });
  });
});
