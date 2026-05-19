import {
  Sandbox,
  getSandbox as getCloudflareSandbox,
  type SandboxOptions,
} from '@cloudflare/sandbox';
import { getRawRuntimeEnv } from './env-raw.ts';
import { requireRuntimeBinding } from './env.ts';

export { Sandbox };
export type { SandboxOptions };

export const DEFAULT_SANDBOX_ID = 'default';
export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const SANDBOX_USAGE_QUEUE_BINDING = 'USAGE_EVENTS_QUEUE';
export const SANDBOX_GATE_BINDING = '__VOID_PROXY';

// 5 min balances queue write volume against the crash-loss accounting window:
// at most one heartbeat-interval of container runtime is lost if the DO dies
// between flushes (orphan recovery in onStart() picks up the rest).
export const HEARTBEAT_MS: number = 5 * 60_000;

export type VoidSandboxOptions = SandboxOptions & { binding?: string };

export type SandboxUsageEvent = Readonly<{
  // requests/responseBytes are literal zeros so the platform's existing
  // `groupEventsByUser` consumer (which expects `UsageEvent`) can ingest
  // sandbox runtime events without a separate shape.
  requests: 0;
  responseBytes: 0;
  userId?: string;
  projectId?: string;
  slug?: string;
  sandboxRuntimeSeconds: number;
  sandboxInstanceId: string;
}>;

/**
 * Thrown by `getSandbox()` when the platform gate denies a new acquire because
 * the user has hit a concurrency or runtime budget cap. Surface this to the
 * caller so they can render a friendly error; do not retry transparently.
 */
export class SandboxLimitError extends Error {
  override readonly name = 'SandboxLimitError';
  readonly reason: 'concurrency' | 'runtime_budget';

  constructor(reason: 'concurrency' | 'runtime_budget', message?: string) {
    super(message ?? `Sandbox limit reached: ${reason}`);
    this.reason = reason;
  }
}

let sandboxBindingName = DEFAULT_SANDBOX_BINDING;

export function __setSandboxBindingName(bindingName: string): void {
  sandboxBindingName = bindingName;
}

// --- Storage keys ---

const STORAGE_KEY_START_TS = '__voidStartTs';
const STORAGE_KEY_LAST_FLUSH_TS = '__voidLastFlushTs';

// --- Internal helpers ---

function getUsageContext(): { userId?: string; projectId?: string; slug?: string } {
  // Resolve the raw env so we can read platform-injected bindings that the
  // public `getRuntimeBinding()` helper intentionally hides from user code.
  const runtimeEnv = getRawRuntimeEnv();
  return {
    userId: runtimeEnv.__VOID_USER_ID as string | undefined,
    projectId: runtimeEnv.__PROJECT_ID as string | undefined,
    slug: runtimeEnv.__VOID_PROJECT_SLUG as string | undefined,
  };
}

function getSandboxInstanceId(ctx: DurableObjectState): string {
  return ctx.id.name ?? ctx.id.toString();
}

/**
 * Flush the accumulated runtime delta to the usage queue. No-op when the
 * usage-queue binding is not bound (e.g. local dev without the platform
 * proxy). Errors are swallowed and logged — usage emission must never crash
 * the sandbox lifecycle.
 */
async function emitRuntimeSeconds(
  ctx: DurableObjectState,
  sandboxRuntimeSeconds: number,
): Promise<void> {
  if (sandboxRuntimeSeconds <= 0) {
    return;
  }
  const runtimeEnv = getRawRuntimeEnv();
  const queue = runtimeEnv[SANDBOX_USAGE_QUEUE_BINDING] as Queue<SandboxUsageEvent> | undefined;
  if (!queue) {
    return;
  }
  const event: SandboxUsageEvent = {
    requests: 0,
    responseBytes: 0,
    sandboxRuntimeSeconds,
    sandboxInstanceId: getSandboxInstanceId(ctx),
    ...getUsageContext(),
  };
  try {
    await queue.send(event);
  } catch (error) {
    // Best-effort metering — never break the sandbox on queue failure.
    console.error('[void/sandbox] failed to emit usage event:', error);
  }
}

/**
 * Resolve the `{ gate, projectId, aiToken }` triple needed to call a gate
 * route. Returns `null` when any piece is missing — local dev (no proxy
 * binding) and partial deploys (binding present but identity vars absent)
 * both fall through to the no-op path so a missing platform setup never
 * blocks sandbox acquisition.
 *
 * Wire field is named `aiToken` because the shared proxy auth middleware
 * (packages/proxy/src/index.ts) verifies HMAC against `body.aiToken` for
 * every route. Naming it `proxyToken` here would diverge from the existing
 * AI/ISR convention without changing the on-the-wire contract.
 */
function resolveGateIdentity(): { gate: Fetcher; projectId: string; aiToken: string } | null {
  const runtimeEnv = getRawRuntimeEnv();
  const gate = runtimeEnv[SANDBOX_GATE_BINDING] as Fetcher | undefined;
  if (!gate) {
    return null;
  }
  const projectId = runtimeEnv.__PROJECT_ID as string | undefined;
  const aiToken = runtimeEnv.__VOID_PROXY_TOKEN as string | undefined;
  if (!projectId || !aiToken) {
    return null;
  }
  return { gate, projectId, aiToken };
}

/**
 * Release notification to the gate so it can drop the active lease counter.
 * Returns the in-flight fetch as a Promise (errors swallowed) so callers can
 * route it through `ctx.waitUntil()` and keep it alive past lifecycle
 * teardown. Failure is silent — the gate maintains its own TTL fallback.
 */
function notifyGateRelease(ctx: DurableObjectState): Promise<void> {
  const identity = resolveGateIdentity();
  if (!identity) {
    return Promise.resolve();
  }
  const sandboxId = getSandboxInstanceId(ctx);
  return identity.gate
    .fetch('https://gate/sandbox/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: identity.projectId,
        aiToken: identity.aiToken,
        sandboxId,
      }),
    })
    .then(() => undefined)
    .catch(() => {
      // Best-effort — the gate has its own lease-expiry safety net.
    });
}

// --- VoidPlatformSandbox ---

/**
 * Sandbox variant that participates in Void platform metering: it records
 * container runtime seconds into DO storage, emits periodic heartbeats to
 * the usage queue, and notifies the gate when the container stops.
 *
 * Generated code from `void inference` wires user `Sandbox` subclasses to
 * extend this class on platform deploys so per-tenant accounting works
 * without user opt-in. On local dev (no usage-queue / gate bindings), all
 * overrides degrade to no-ops and the sandbox behaves like the upstream
 * `Sandbox` class.
 */
export class VoidPlatformSandbox<Env = unknown> extends Sandbox<Env> {
  override async onStart(): Promise<void> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<number>([
      STORAGE_KEY_START_TS,
      STORAGE_KEY_LAST_FLUSH_TS,
    ]);

    // Crash recovery: if a stale start timestamp survives in storage, the
    // previous instance died without onStop firing. Emit one reconciliation
    // event covering the orphaned window so usage isn't undercounted, then
    // reset the timestamps for the new run.
    const orphanedAnchor =
      stored.get(STORAGE_KEY_LAST_FLUSH_TS) ?? stored.get(STORAGE_KEY_START_TS);
    if (orphanedAnchor !== undefined && orphanedAnchor < now) {
      const sandboxRuntimeSeconds = (now - orphanedAnchor) / 1000;
      await emitRuntimeSeconds(this.ctx, sandboxRuntimeSeconds);
    }

    await super.onStart();

    // Persist start/flush timestamps and arm the heartbeat alarm only AFTER
    // super.onStart() succeeds. If super throws (container failed to start),
    // we must not leave anchors behind — the next onStart() would treat them
    // as an orphaned window and bill wall-clock time during which no
    // container ever ran. Re-read the clock so timestamps reflect the actual
    // container-ready instant rather than the pre-super entry point.
    //
    // Heartbeat alarm is set after super for the same single-alarm-slot
    // reason the alarm() override relies on: upstream Sandbox/Container may
    // arm its own alarm (e.g. for sleepAfter idle management) and clobber
    // ours if we set it first.
    const startedAt = Date.now();
    await this.ctx.storage.put({
      [STORAGE_KEY_START_TS]: startedAt,
      [STORAGE_KEY_LAST_FLUSH_TS]: startedAt,
    });
    await this.ctx.storage.setAlarm(startedAt + HEARTBEAT_MS);
  }

  override async alarm(alarmProps?: { isRetry: boolean; retryCount: number }): Promise<void> {
    // Container's alarm() dispatches any scheduled() tasks. Run it first so
    // upstream behaviour (idle timeouts, user-scheduled work) is preserved
    // before we layer our metering heartbeat on top.
    await super.alarm(alarmProps);

    const lastFlush = await this.ctx.storage.get<number>(STORAGE_KEY_LAST_FLUSH_TS);
    if (typeof lastFlush !== 'number') {
      // Heartbeat fired without an active start window — nothing to meter
      // and no reason to re-arm (onStart() will set the alarm again).
      return;
    }
    const now = Date.now();
    const sandboxRuntimeSeconds = Math.max(0, (now - lastFlush) / 1000);
    await emitRuntimeSeconds(this.ctx, sandboxRuntimeSeconds);
    await Promise.all([
      this.ctx.storage.put(STORAGE_KEY_LAST_FLUSH_TS, now),
      this.ctx.storage.setAlarm(now + HEARTBEAT_MS),
    ]);
  }

  // Sandbox narrows Container's `onStop(params)` to zero-arg — exitCode/reason aren't visible here.
  override async onStop(): Promise<void> {
    await this.flushFinal();
    // Route the release POST through waitUntil so it survives lifecycle
    // teardown. A bare `void fetch(...)` here can be canceled when the hook
    // returns, stranding the gate's acquire counter until TTL sweep — the
    // exact false-concurrency-denial path this metering layer must avoid.
    this.ctx.waitUntil(notifyGateRelease(this.ctx));
    await super.onStop();
  }

  override async onActivityExpired(): Promise<void> {
    await this.flushFinal();
    this.ctx.waitUntil(notifyGateRelease(this.ctx));
    await super.onActivityExpired();
  }

  private async flushFinal(): Promise<void> {
    const lastFlush = await this.ctx.storage.get<number>(STORAGE_KEY_LAST_FLUSH_TS);
    if (typeof lastFlush === 'number') {
      const sandboxRuntimeSeconds = Math.max(0, (Date.now() - lastFlush) / 1000);
      await emitRuntimeSeconds(this.ctx, sandboxRuntimeSeconds);
    }
    await this.ctx.storage.delete(STORAGE_KEY_START_TS);
    await this.ctx.storage.delete(STORAGE_KEY_LAST_FLUSH_TS);
  }
}

// --- getSandbox ---

/**
 * Resolve the platform-provided sandbox stub for the given id, optionally
 * coordinating with the platform gate to enforce per-user concurrency and
 * runtime budgets.
 *
 * When the gate binding (`__VOID_PROXY` by default) is present AND the
 * platform's `__PROJECT_ID` + `__VOID_PROXY_TOKEN` identity vars are
 * available, we POST to `https://gate/sandbox/acquire` with the HMAC-signed
 * body the shared proxy auth middleware expects. A `409` response means the
 * user has exceeded a budget — we throw `SandboxLimitError` so the caller
 * can render a clear message. Any other non-OK status (or a thrown transport
 * error from the service binding) is treated as "gate unavailable" and we
 * fall through to returning the stub so a broken gate doesn't break sandbox
 * access entirely.
 *
 * When the gate binding is absent (local dev) or the identity vars are
 * missing (partial deploy), the gate check is skipped entirely and we
 * return the stub directly.
 *
 * The stub is constructed BEFORE calling the gate so we can derive the
 * normalized DO name (`stub.id.name`) and pass it to the gate as the
 * `sandboxId`. This keeps acquire and release using the same key — without
 * it, mixed-case caller ids (e.g. `MyProject-123`) would acquire a lease
 * under the raw id but release it under the normalized lowercase form that
 * `ctx.id.name` reports inside the DO, leaking the lease until TTL.
 * Constructing the stub does NOT start a container — that only happens on
 * the first method call against the stub.
 */
export async function getSandbox<T extends Sandbox = Sandbox>(
  id: string = DEFAULT_SANDBOX_ID,
  options?: VoidSandboxOptions,
): Promise<T> {
  const { binding = sandboxBindingName, ...sandboxOptions } = options ?? {};

  const namespace = requireRuntimeBinding<DurableObjectNamespace<T>>(binding);
  const stub = getCloudflareSandbox<T>(namespace, id, {
    normalizeId: true,
    ...sandboxOptions,
  });
  // Use the stub's normalized DO id (matches what `ctx.id.name` reports
  // inside the DO) so acquire and release agree on the lease key.
  const sandboxId = (stub as unknown as DurableObjectStub).id.name ?? id;

  const identity = resolveGateIdentity();
  if (identity) {
    try {
      const res = await identity.gate.fetch('https://gate/sandbox/acquire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: identity.projectId,
          aiToken: identity.aiToken,
          sandboxId,
        }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        const reason =
          body.reason === 'concurrency' || body.reason === 'runtime_budget'
            ? body.reason
            : 'concurrency';
        throw new SandboxLimitError(reason);
      }
      // Non-OK non-409 falls through: a broken gate must not block sandbox
      // acquisition; the gate's lease TTL backstops accounting.
    } catch (error) {
      if (error instanceof SandboxLimitError) {
        throw error;
      }
      // Transport errors get the same fail-open treatment as a non-OK response.
    }
  }

  return stub;
}

export const sandbox: { get: typeof getSandbox } = {
  get: getSandbox,
};
