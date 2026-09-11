import { DurableObject } from 'cloudflare:workers';
import { createDb, suspendUser, unsuspendUserIfReason, type Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { queryProjectAiUsage } from './routes/usage.ts';
import { sandboxBlockKey, setProjectsRoutingSuspension } from './routing.ts';
import { REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED } from './suspension.ts';
import { getPlanLimits, isWithinLimit } from './tiers.ts';

// --- Exported types ---

export type CounterState = {
  totalRequests: number;
  totalNeurons: number;
  totalSandboxSeconds: number;
  plan: string;
  billingPeriodStart: string; // ISO date
  requestsSuspended: boolean;
  aiSuspended: boolean;
  sandboxRuntimeSuspended: boolean;
  projectSlugs: Record<string, string>; // projectId → slug
};

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
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
  };
}

// --- UsageCounter Durable Object ---

export class UsageCounter extends DurableObject<ApiEnv['Bindings']> {
  private state: CounterState | null = null;

  private async getState(): Promise<CounterState> {
    if (this.state) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<CounterState>('state');
    // Backfill defaults so DOs with pre-sandbox state load cleanly.
    this.state = stored ? { ...defaultState(), ...stored } : defaultState();
    return this.state;
  }

  private async saveState(state: CounterState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request: Request): Promise<Response> {
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
    };
    const state = await this.getState();

    // Sum incoming requests
    const incomingRequests = body.events.reduce((sum, e) => sum + e.requests, 0);
    state.totalRequests += incomingRequests;

    // Sum incoming sandbox runtime seconds. Treat missing as 0 so request-only
    // events from non-sandbox workers don't perturb the counter.
    // At-least-once delivery can re-add up to one heartbeat window (~5 min) on
    // retry; acceptable for a soft cap.
    const incomingSandboxSeconds = body.events.reduce(
      (sum, e) => sum + (e.sandboxRuntimeSeconds ?? 0),
      0,
    );
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

    // Evaluate request limit. Flip the latch only AFTER the KV/DB writes succeed:
    // getState() caches and returns the same object on a queue retry, so flipping
    // first then throwing on a write would make the retry skip this (now-true)
    // branch and persist enforcement as done while the writes never ran. (Requests
    // self-heal via the `/init` re-stamp, but ordering it the same as sandbox keeps
    // the two paths consistent.)
    const exceedsLimit = evaluateRequestLimit(state, 0); // already added above
    if (exceedsLimit && !state.requestsSuspended) {
      await Promise.all([
        this.suspendProjects(getDb(), state.projectSlugs, REASON_REQUESTS_EXCEEDED),
        suspendUser(getDb(), body.userId, REASON_REQUESTS_EXCEEDED),
      ]);
      state.requestsSuspended = true;
    }

    // Evaluate sandbox runtime limit. Latch AFTER the writes for the same reason —
    // and here it is load-bearing: there is NO `/init` re-stamp for sandbox-block,
    // so a latch persisted true with a failed block write would leave an over-budget
    // account serving sandbox traffic unblocked until the next limit re-evaluation.
    const exceedsSandbox = evaluateSandboxRuntimeLimit(state, 0); // already added above
    if (exceedsSandbox && !state.sandboxRuntimeSuspended) {
      await Promise.all([
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

    await this.saveState(state);

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

    // Run all external (KV/DB) cleanup BEFORE mutating the cached state. getState()
    // returns the same cached object on a retry, and the rollover guard above keys
    // on billingPeriodStart, so mutating it (or any latch) before a throwing await
    // would make the retried call short-circuit as `rolled: false` and strand the
    // half-finished cleanup. Deferring every cached mutation until after the awaits
    // succeed keeps the retry re-entering the rollover body until cleanup completes
    // (the KV deletes / unsuspend are idempotent).
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
      await Promise.all([
        this.env.ROUTING.delete(sandboxBlockKey(body.userId)),
        unsuspendUserIfReason(db, body.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
    }

    // All external cleanup succeeded — now mutate the cached state and persist.
    state.totalRequests = 0;
    state.totalNeurons = 0;
    state.totalSandboxSeconds = 0;
    state.plan = body.plan;
    state.billingPeriodStart = body.billingPeriodStart;
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
      // Delete BEFORE flipping the cached `aiSuspended` latch. getState() caches
      // and returns the same object on a retry; if a delete throws after the flip,
      // saveState is never reached but the in-memory latch is already false, so the
      // retried call skips this branch and persists `aiSuspended: false` with the
      // remaining ai-block keys stranded. Deleting first keeps the latch true until
      // every key is gone, so a retry re-enters and finishes the (idempotent) cleanup.
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
   * Trivial set-and-save, so no `blockConcurrencyWhile` is needed (no non-storage
   * await between read+save).
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
    const state = await this.getState();
    const limits = getPlanLimits(state.plan);

    // Skip if plan has unlimited AI
    if (limits.aiNeuronsPerMonth === 0) {
      return;
    }

    // Skip if no projects
    const projectIds = Object.keys(state.projectSlugs);
    if (projectIds.length === 0) {
      return;
    }

    // Query AI Gateway for each project's neuron usage
    const since = new Date(state.billingPeriodStart);
    let totalNeurons = 0;
    for (const projectId of projectIds) {
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
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
