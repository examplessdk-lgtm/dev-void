import { DurableObject } from 'cloudflare:workers';
import { createDb, suspendUser, unsuspendUserIfReason, type Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { queryProjectAiUsage } from './routes/usage.ts';
import { sandboxBlockKey, setProjectsRoutingSuspension } from './routing.ts';
import { REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED } from './suspension.ts';
import { getPlanLimits, isWithinLimit } from './tiers.ts';
import { SANDBOX_USAGE_RETENTION_MS } from './usage-auth.ts';

// --- Exported types ---

export type CounterState = {
  totalRequests: number;
  totalNeurons: number;
  totalSandboxSeconds: number;
  plan: string;
  billingPeriodStart: string; // ISO date
  billingPeriodInitialized?: boolean;
  requestsSuspended: boolean;
  aiSuspended: boolean;
  sandboxRuntimeSuspended: boolean;
  projectSlugs: Record<string, string>; // projectId → slug
};

const SANDBOX_WATERMARK_PREFIX = 'sandbox-usage:watermark:';
const SANDBOX_PRUNE_CURSOR_KEY = 'sandbox-usage:prune-cursor';
const SANDBOX_PRUNE_BATCH_SIZE = 64;

async function sandboxWatermarkKey(leaseId: string, from: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([leaseId, from])),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${SANDBOX_WATERMARK_PREFIX}${hash}`;
}

export type UsageEvent = Readonly<{
  projectId: string;
  userId: string;
  slug: string;
  requests: number;
  responseBytes: number;
  status?: number;
  failureKind?:
    | 'platform-static-asset-timeout'
    | 'platform-static-asset-error'
    | 'platform-static-asset-missing';
  sandboxRuntimeSeconds?: number;
  sandboxInstanceId?: string;
  /** Cumulative server-owned lease generation; from stays fixed across heartbeats. */
  sandboxMeteredFrom?: number;
  sandboxMeteredThrough?: number;
}>;

// --- Pure functions (exported for unit testing) ---

/** Returns true if adding incomingRequests would exceed the plan's requestsPerMonth limit. */
export function evaluateRequestLimit(state: CounterState, incomingRequests: number): boolean {
  const limits = getPlanLimits(state.plan);
  return !isWithinLimit(limits.requestsPerMonth, state.totalRequests + incomingRequests);
}

/** Returns true if totalNeurons exceeds the plan's aiNeuronsPerMonth limit. Works for ALL plans. */
export function evaluateAiLimit(state: CounterState): boolean {
  const limits = getPlanLimits(state.plan);
  return !isWithinLimit(limits.aiNeuronsPerMonth, state.totalNeurons);
}

/** Returns true if adding incomingSeconds would exceed the plan's sandboxRuntimeSecondsPerMonth limit. */
export function evaluateSandboxRuntimeLimit(state: CounterState, incomingSeconds: number): boolean {
  const limits = getPlanLimits(state.plan);
  return !isWithinLimit(
    limits.sandboxRuntimeSecondsPerMonth,
    state.totalSandboxSeconds + incomingSeconds,
  );
}

// --- Default state ---

function defaultState(): CounterState {
  return {
    totalRequests: 0,
    totalNeurons: 0,
    totalSandboxSeconds: 0,
    plan: 'free',
    billingPeriodStart: new Date().toISOString(),
    billingPeriodInitialized: false,
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
  };
}

async function settleWrites(writes: Array<Promise<unknown>>): Promise<void> {
  // A rejected write must not release the operation queue while a sibling
  // write can still land and undo the next operation's suspension decision.
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

// --- UsageCounter Durable Object ---

export class UsageCounter extends DurableObject<ApiEnv['Bindings']> {
  private state: CounterState | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // External suspension writes and AI queries open the DO input gate. Keep
    // each request/alarm in order through its durable save, including retries.
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async getState(): Promise<CounterState> {
    if (!this.state) {
      const stored = await this.ctx.storage.get<CounterState>('state');
      // Backfill defaults so DOs with pre-sandbox state load cleanly.
      this.state = stored
        ? {
            ...defaultState(),
            ...stored,
            billingPeriodInitialized: stored.billingPeriodInitialized ?? true,
          }
        : defaultState();
    }
    // Every operation edits its own copy. Neither a failed external write nor
    // a failed storage put may silently commit totals/latches to the cache.
    return {
      ...this.state,
      projectSlugs: { ...this.state.projectSlugs },
    };
  }

  private async saveState(
    state: CounterState,
    watermarks: ReadonlyMap<string, number> = new Map(),
  ): Promise<boolean> {
    const cutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const hasWatermarks = await this.ctx.storage.transaction(async (transaction) => {
      // Receipts live in separate bounded-size records. Never evict a fresh
      // generation to make room: its next cumulative frame would rebill it.
      for (const [key, through] of watermarks) {
        await transaction.put(key, through);
      }

      // Advance a durable cursor through at most one page per operation.
      // Hash ordering is unrelated to age, so wrap after the last page and
      // eventually revisit every receipt without ever scanning the full set.
      const cursor = await transaction.get<string>(SANDBOX_PRUNE_CURSOR_KEY);
      const page = await transaction.list<number>({
        prefix: SANDBOX_WATERMARK_PREFIX,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: SANDBOX_PRUNE_BATCH_SIZE,
      });
      const expired = Array.from(page, ([key, through]) => (through < cutoff ? key : null)).filter(
        (key) => key !== null,
      );
      if (expired.length > 0) {
        await transaction.delete(expired);
      }
      if (page.size === SANDBOX_PRUNE_BATCH_SIZE) {
        await transaction.put(SANDBOX_PRUNE_CURSOR_KEY, Array.from(page.keys()).at(-1)!);
      } else {
        await transaction.delete(SANDBOX_PRUNE_CURSOR_KEY);
      }

      // Counters, receipts, and pruning progress commit together. Publishing
      // the isolate cache afterwards also keeps a rejected commit retryable.
      await transaction.put('state', state);
      return page.size > expired.length || page.size === SANDBOX_PRUNE_BATCH_SIZE || !!cursor;
    });
    this.state = state;
    return hasWatermarks;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/record') {
      return this.handleRecord(request);
    }
    if (request.method === 'POST' && path === '/rollover') {
      return this.handleRollover(request);
    }
    if (request.method === 'POST' && path === '/init') {
      return this.handleInit(request);
    }
    if (request.method === 'POST' && path === '/reevaluate-sandbox') {
      return this.handleReevaluateSandbox(request);
    }
    if (request.method === 'POST' && path === '/clear-suspension') {
      return this.handleClearSuspension();
    }
    if (request.method === 'GET' && path === '/state') {
      return this.handleGetState();
    }

    return new Response('not found', { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      events: ReadonlyArray<UsageEvent>;
      plan?: string;
      userId: string;
      billingPeriodStart?: string;
    };
    const state = await this.getState();
    // A new counter can first see an interval after that interval has ended.
    // Its construction time is not the account's billing-period boundary.
    if (!state.billingPeriodInitialized && body.billingPeriodStart) {
      if (!Number.isFinite(Date.parse(body.billingPeriodStart))) {
        return Response.json({ error: 'invalid billing period' }, { status: 400 });
      }
      state.billingPeriodStart = body.billingPeriodStart;
      state.billingPeriodInitialized = true;
    }

    // Sum incoming requests
    const incomingRequests = body.events.reduce((sum, e) => sum + e.requests, 0);
    state.totalRequests += incomingRequests;

    // The API-owned producer sends cumulative intervals with a stable start
    // per lease generation. A high watermark handles retries and out-of-order
    // delivery, while a new generation excludes idle time between leases.
    const periodStart = state.billingPeriodInitialized ? Date.parse(state.billingPeriodStart) : 0;
    const watermarkCutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const watermarks = new Map<string, number>();
    let incomingSandboxSeconds = 0;
    for (const event of body.events) {
      const leaseId = event.sandboxInstanceId;
      const from = event.sandboxMeteredFrom;
      const through = event.sandboxMeteredThrough;
      if (
        !leaseId ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(through) ||
        through! <= from! ||
        through! < watermarkCutoff
      ) {
        continue;
      }
      const key = await sandboxWatermarkKey(leaseId, from!);
      const previous = watermarks.get(key) ?? (await this.ctx.storage.get<number>(key)) ?? from!;
      const billFrom = Math.max(
        previous,
        from!,
        Number.isFinite(periodStart) ? periodStart : from!,
        // Receipts older than retention may already be pruned. A cumulative
        // frame must not revive their billed prefix after a long delivery gap.
        watermarkCutoff,
      );
      if (through! > billFrom) {
        incomingSandboxSeconds += (through! - billFrom) / 1000;
      }
      watermarks.set(key, Math.max(previous, through!));
    }
    state.totalSandboxSeconds += incomingSandboxSeconds;

    // Update projectSlugs map
    for (const event of body.events) {
      state.projectSlugs[event.projectId] = event.slug;
    }

    // Update plan if provided
    if (body.plan) {
      state.plan = body.plan;
    }

    // Lazily create one db handle shared by any suspension paths below.
    let db: ReturnType<typeof createDb> | undefined;
    const getDb = (): ReturnType<typeof createDb> => {
      db ??= createDb(this.env.HYPERDRIVE.connectionString);
      return db;
    };

    // Commit each suspension latch only after every enforcement write succeeds.
    const exceedsLimit = evaluateRequestLimit(state, 0); // already added above
    if (exceedsLimit && !state.requestsSuspended) {
      await settleWrites([
        this.suspendProjects(getDb(), state.projectSlugs, REASON_REQUESTS_EXCEEDED),
        suspendUser(getDb(), body.userId, REASON_REQUESTS_EXCEEDED),
      ]);
      state.requestsSuspended = true;
    }

    const exceedsSandbox = evaluateSandboxRuntimeLimit(state, 0); // already added above
    if (exceedsSandbox && !state.sandboxRuntimeSuspended) {
      await settleWrites([
        this.env.ROUTING.put(sandboxBlockKey(body.userId), '1'),
        suspendUser(getDb(), body.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
      state.sandboxRuntimeSuspended = true;
    }

    // Schedule AI alarm if not already set
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
    }

    await this.saveState(state, watermarks);

    return Response.json({
      totalRequests: state.totalRequests,
      suspended: state.requestsSuspended,
      totalSandboxSeconds: state.totalSandboxSeconds,
      sandboxRuntimeSuspended: state.sandboxRuntimeSuspended,
    });
  }

  private async handleRollover(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      billingPeriodStart: string;
      plan: string;
      userId: string;
    };
    const state = await this.getState();

    // Only act if billingPeriodStart differs
    if (state.billingPeriodStart === body.billingPeriodStart) {
      return Response.json({
        rolled: false,
        unsuspendRequests: false,
        unsuspendAi: false,
        // The authoritative request-suspension latch, returned on EVERY response
        // (not just rollovers) so the scheduler can reconcile the KV `suspended`
        // marker against it each pass — see processUserRollover in index.ts.
        requestsSuspended: state.requestsSuspended,
        projectSlugs: state.projectSlugs,
      });
    }

    const wasRequestsSuspended = state.requestsSuspended;
    const wasAiSuspended = state.aiSuspended;
    const wasSandboxRuntimeSuspended = state.sandboxRuntimeSuspended;

    // Finish idempotent external cleanup before committing the new period.
    // A failure leaves the cached and persisted period unchanged for retry.
    if (wasAiSuspended) {
      // The alarm's delete branch requires aiSuspended to still be true AND returns
      // early for unlimited-AI plans, so without this the proxy keeps 429ing AI
      // routes after rollover.
      for (const projectId of Object.keys(state.projectSlugs)) {
        await this.env.ROUTING.delete(`ai-block:${projectId}`);
      }
    }
    if (wasSandboxRuntimeSuspended) {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      await settleWrites([
        this.env.ROUTING.delete(sandboxBlockKey(body.userId)),
        unsuspendUserIfReason(db, body.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
    }

    // All external cleanup succeeded — persist the operation's new state.
    state.totalRequests = 0;
    state.totalNeurons = 0;
    state.totalSandboxSeconds = 0;
    state.plan = body.plan;
    state.billingPeriodStart = body.billingPeriodStart;
    state.billingPeriodInitialized = true;
    if (wasRequestsSuspended) {
      state.requestsSuspended = false;
    }
    if (wasAiSuspended) {
      state.aiSuspended = false;
    }
    if (wasSandboxRuntimeSuspended) {
      state.sandboxRuntimeSuspended = false;
    }

    await this.saveState(state);

    return Response.json({
      rolled: true,
      unsuspendRequests: wasRequestsSuspended,
      unsuspendAi: wasAiSuspended,
      // Post-rollover latch (false after a request rollover). Returned every
      // response so the scheduler reconciles KV against it each pass — see
      // processUserRollover in index.ts.
      requestsSuspended: state.requestsSuspended,
      projectSlugs: state.projectSlugs,
    });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      plan: string;
      billingPeriodStart: string;
      projectSlugs: Record<string, string>;
    };
    const state = await this.getState();

    // Merge projectSlugs
    Object.assign(state.projectSlugs, body.projectSlugs);
    state.plan = body.plan;
    state.billingPeriodStart = body.billingPeriodStart;
    state.billingPeriodInitialized = true;

    // Re-suspend any newly added project slugs if user is currently suspended
    if (state.requestsSuspended) {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      await this.suspendProjects(db, state.projectSlugs, REASON_REQUESTS_EXCEEDED);
    }
    if (state.aiSuspended) {
      for (const projectId of Object.keys(state.projectSlugs)) {
        await this.env.ROUTING.put(`ai-block:${projectId}`, '1');
      }
    }

    await this.saveState(state);
    return Response.json({ ok: true });
  }

  /**
   * Admin plan changes: optimistically clear ALL in-memory usage latches so the
   * next handleRecord (and the AI alarm) re-evaluates against the new plan.
   * Drops request + sandbox + AI — a plan change can lift any cap, and leaving
   * `requestsSuspended` set would make the next `/init` re-stamp the routes the
   * plan-change route just cleared. AI normally self-heals via the alarm, but
   * the alarm returns early for unlimited-AI plans, so a capped→unlimited-AI
   * upgrade needs the ai-block keys cleared here (projectId-keyed, owned by the
   * DO). The plan-change route deletes the userId-keyed sandbox-block.
   */
  private async handleReevaluateSandbox(request: Request): Promise<Response> {
    const body = (await request.json()) as { plan: string };
    const state = await this.getState();
    state.plan = body.plan;
    state.requestsSuspended = false;
    state.sandboxRuntimeSuspended = false;
    if (state.aiSuspended) {
      // Keep the durable latch set until every idempotent delete succeeds.
      for (const projectId of Object.keys(state.projectSlugs)) {
        await this.env.ROUTING.delete(`ai-block:${projectId}`);
      }
      state.aiSuspended = false;
    }
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  /**
   * Admin unsuspend: drop the request + sandbox suspension latches. The admin
   * route clears the corresponding KV routes concurrently with this call and the
   * DB reason only after this succeeds; resetting the latches here stops the next
   * billing-reconcile `/init` from re-stamping the routes (the `requestsSuspended`
   * branch) and lets the next `/record` re-evaluate against current usage. AI
   * self-heals via the alarm, so `aiSuspended` is intentionally left untouched.
   * This is a latch reset only — no counters change (unlike a billing rollover).
   * Shares the operation queue so an in-flight record cannot restore the latch.
   */
  private async handleClearSuspension(): Promise<Response> {
    const state = await this.getState();
    state.requestsSuspended = false;
    state.sandboxRuntimeSuspended = false;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    return Response.json(state);
  }

  // --- AI alarm handler ---

  async alarm(): Promise<void> {
    return this.serialize(() => this.handleAlarm());
  }

  private async handleAlarm(): Promise<void> {
    const state = await this.getState();
    const limits = getPlanLimits(state.plan);

    const projectIds = Object.keys(state.projectSlugs);
    // Unlimited/no-project accounts still need bounded receipt cleanup. Keep
    // waking only while the scan may have retained or not-yet-visited records.
    if (limits.aiNeuronsPerMonth === 0 || projectIds.length === 0) {
      if (await this.saveState(state)) {
        await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
      }
      return;
    }

    // Query AI Gateway for each project's neuron usage
    const since = new Date(state.billingPeriodStart);
    let totalNeurons = 0;
    for (const projectId of projectIds) {
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        this.env.AI_GATEWAY_ID ?? 'void',
        projectId,
        since,
      );
      totalNeurons += result.neurons;
    }

    state.totalNeurons = totalNeurons;

    // Evaluate AI limit
    const exceedsAi = evaluateAiLimit(state);
    if (exceedsAi && !state.aiSuspended) {
      state.aiSuspended = true;
      // Write ai-block KV keys for each project
      for (const projectId of projectIds) {
        await this.env.ROUTING.put(`ai-block:${projectId}`, '1');
      }
    } else if (!exceedsAi && state.aiSuspended) {
      state.aiSuspended = false;
      // Delete ai-block KV keys
      for (const projectId of projectIds) {
        await this.env.ROUTING.delete(`ai-block:${projectId}`);
      }
    }

    await this.saveState(state);

    // Re-schedule alarm for 15 minutes later
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }

  // --- Private helpers ---

  private async suspendProjects(
    db: Db,
    projectSlugs: Record<string, string>,
    reason: string,
  ): Promise<void> {
    // Stamp `suspended` on each project's slug route AND its active custom-domain
    // routes — dispatch enforces suspension from all of them, so a slug-only
    // stamp left over-limit projects serving on their custom domains.
    //
    // `force: false`: a usage suspension must never overwrite an admin
    // suspension already on the route. If an admin suspended the user first, the
    // route carries `admin_suspended` and this leaves it intact (the admin
    // reason already blocks dispatch; downgrading it to `requests_exceeded`
    // would let the next admin unsuspend silently un-block an admin action).
    const projects = Object.entries(projectSlugs).map(([id, slug]) => ({ id, slug }));
    await setProjectsRoutingSuspension(this.env.ROUTING, db, projects, {
      op: 'suspend',
      reason,
      force: false,
    });
  }
}
