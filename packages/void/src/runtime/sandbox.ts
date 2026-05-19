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
  // Resolve the raw env so we can read platform-injected `__VOID_*` bindings
  // that the public `getRuntimeBinding()` helper intentionally hides from
  // user code (see env.ts).
  const runtimeEnv = getRawRuntimeEnv();
  return {
    userId: runtimeEnv.__VOID_USER_ID as string | undefined,
    projectId: runtimeEnv.__VOID_PROJECT_ID as string | undefined,
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
 * Fire-and-forget release notification to the gate so it can drop the active
 * lease counter. Failure is silent — the gate maintains its own TTL fallback.
 */
function notifyGateRelease(ctx: DurableObjectState): void {
  const runtimeEnv = getRawRuntimeEnv();
  const gate = runtimeEnv[SANDBOX_GATE_BINDING] as Fetcher | undefined;
  if (!gate) {
    return;
  }
  const sandboxId = getSandboxInstanceId(ctx);
  void gate
    .fetch('https://gate/sandbox/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId }),
    })
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
    const prevStart = await this.ctx.storage.get<number>(STORAGE_KEY_START_TS);
    const prevFlush = await this.ctx.storage.get<number>(STORAGE_KEY_LAST_FLUSH_TS);

    // Crash recovery: if a stale start timestamp survives in storage, the
    // previous instance died without onStop firing. Emit one reconciliation
    // event covering the orphaned window so usage isn't undercounted, then
    // reset the timestamps for the new run.
    const orphanedAnchor = prevFlush ?? prevStart;
    if (orphanedAnchor !== undefined && orphanedAnchor < now) {
      const sandboxRuntimeSeconds = (now - orphanedAnchor) / 1000;
      await emitRuntimeSeconds(this.ctx, sandboxRuntimeSeconds);
    }

    await this.ctx.storage.put(STORAGE_KEY_START_TS, now);
    await this.ctx.storage.put(STORAGE_KEY_LAST_FLUSH_TS, now);
    await this.ctx.storage.setAlarm(now + HEARTBEAT_MS);

    await super.onStart();
  }

  override async alarm(alarmProps?: { isRetry: boolean; retryCount: number }): Promise<void> {
    // Container's alarm() dispatches any scheduled() tasks. Run it first so
    // upstream behaviour (idle timeouts, user-scheduled work) is preserved
    // before we layer our metering heartbeat on top.
    await super.alarm(alarmProps);

    const lastFlush = await this.ctx.storage.get<number>(STORAGE_KEY_LAST_FLUSH_TS);
    if (typeof lastFlush !== 'number') {
      // Heartbeat fired without an active start window (DO was hibernated
      // or never onStart'd). Nothing to meter.
      return;
    }
    const now = Date.now();
    const sandboxRuntimeSeconds = Math.max(0, (now - lastFlush) / 1000);
    await emitRuntimeSeconds(this.ctx, sandboxRuntimeSeconds);
    await this.ctx.storage.put(STORAGE_KEY_LAST_FLUSH_TS, now);
    await this.ctx.storage.setAlarm(now + HEARTBEAT_MS);
  }

  // Sandbox narrows Container's `onStop(params)` to zero-arg — exitCode/reason aren't visible here.
  override async onStop(): Promise<void> {
    await this.flushFinal();
    notifyGateRelease(this.ctx);
    await super.onStop();
  }

  override async onActivityExpired(): Promise<void> {
    await this.flushFinal();
    notifyGateRelease(this.ctx);
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
 * When the gate binding (`__VOID_PROXY` by default) is present, we POST to
 * `https://gate/sandbox/acquire` first. A `409` response means the user has
 * exceeded a budget — we throw `SandboxLimitError` so the caller can render
 * a clear message. Any other non-OK status is treated as "gate unavailable"
 * and we fall through to returning the stub so a broken gate doesn't break
 * sandbox access entirely.
 *
 * When the gate binding is absent (local dev), the gate check is skipped
 * entirely and we return the stub directly.
 */
export async function getSandbox<T extends Sandbox = Sandbox>(
  id: string = DEFAULT_SANDBOX_ID,
  options?: VoidSandboxOptions,
): Promise<T> {
  const { binding = sandboxBindingName, ...sandboxOptions } = options ?? {};

  const runtimeEnv = getRawRuntimeEnv();
  const gate = runtimeEnv[SANDBOX_GATE_BINDING] as Fetcher | undefined;
  if (gate) {
    const res = await gate.fetch('https://gate/sandbox/acquire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId: id }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      const reason =
        body.reason === 'concurrency' || body.reason === 'runtime_budget'
          ? body.reason
          : 'concurrency';
      throw new SandboxLimitError(reason);
    }
    // Non-409 non-OK responses fall through: the gate is best-effort, and
    // refusing to return a stub on a gate hiccup would be worse than letting
    // the request proceed. The gate's own lease TTL backstops accounting.
  }

  const namespace = requireRuntimeBinding<DurableObjectNamespace<T>>(binding);
  return getCloudflareSandbox<T>(namespace, id, {
    normalizeId: true,
    ...sandboxOptions,
  });
}

export const sandbox: { get: typeof getSandbox } = {
  get: getSandbox,
};
