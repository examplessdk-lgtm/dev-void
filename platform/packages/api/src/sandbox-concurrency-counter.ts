import { DurableObject } from 'cloudflare:workers';
import type { ApiEnv } from './env.ts';

// --- Exported constants (used by tests + the proxy caller) ---

/**
 * Entries older than this are considered stale and swept by the alarm.
 * Set deliberately longer than any reasonable sandbox session — if a sandbox
 * has been "held" for more than an hour without an explicit `release`, the
 * caller most likely crashed mid-session and the slot would otherwise leak.
 */
export const STALE_MS = 60 * 60_000;

/** How often the alarm sweeps stale entries. */
export const RECONCILE_INTERVAL_MS = 60 * 60_000;

// --- Storage shape ---

type Entry = { acquiredAt: number };

type EntriesMap = Record<string, Entry>;

const STORAGE_KEY = 'entries';

// --- RPC result types ---

export type AcquireResult = { ok: true } | { ok: false; reason: 'concurrency' };

export type RefreshResult = { ok: true } | { ok: false; reason: 'not_held' };

/**
 * Per-account counter for live sandbox containers.
 *
 * The DO is intentionally storage-only: it does not query the platform DB or
 * KV. The caller (the proxy worker) is responsible for plan lookups and KV
 * `sandbox-block:{userId}` checks before invoking `acquire`. Keeping this DO
 * stateless aside from its in-memory/persisted slot map keeps it cheap and
 * avoids cross-binding chatter on the hot path.
 *
 * Addressing convention: callers derive the DO id with
 * `idFromName('account:${userId}')`. The DO itself does not know its userId
 * — the caller passes the plan limit in to `acquire`, so the DO only ever
 * compares against an opaque integer.
 */
export class SandboxConcurrencyCounter extends DurableObject<ApiEnv['Bindings']> {
  private entries: EntriesMap | null = null;

  private async getEntries(): Promise<EntriesMap> {
    if (this.entries) {
      return this.entries;
    }
    const stored = await this.ctx.storage.get<EntriesMap>(STORAGE_KEY);
    this.entries = stored ?? {};
    return this.entries;
  }

  private async saveEntries(entries: EntriesMap): Promise<void> {
    this.entries = entries;
    await this.ctx.storage.put(STORAGE_KEY, entries);
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (!current) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  /**
   * Try to claim a sandbox slot for `sandboxInstanceId`.
   *
   * `planLimit` is the per-account cap (`PlanLimits.sandboxMaxConcurrentInstances`).
   * A value of `0` follows the project's standard "0 means unlimited"
   * convention used elsewhere in `tiers.ts` / `isWithinLimit`.
   *
   * Idempotent: if `sandboxInstanceId` is already held, the call refreshes
   * its `acquiredAt` timestamp (which keeps the alarm sweep from reaping a
   * still-live session) and returns `{ ok: true }` without double-counting.
   */
  async acquire(sandboxInstanceId: string, planLimit: number): Promise<AcquireResult> {
    const entries = await this.getEntries();

    // Idempotent refresh — don't double-count an already-held slot. Avoids
    // a leak when the proxy retries `acquire` for the same sandbox after a
    // transient network error.
    if (entries[sandboxInstanceId]) {
      entries[sandboxInstanceId] = { acquiredAt: Date.now() };
      await this.saveEntries(entries);
      await this.ensureAlarm();
      return { ok: true };
    }

    const count = Object.keys(entries).length;
    // 0 means unlimited (matches tiers.isWithinLimit semantics).
    if (planLimit !== 0 && count >= planLimit) {
      return { ok: false, reason: 'concurrency' };
    }

    entries[sandboxInstanceId] = { acquiredAt: Date.now() };
    await this.saveEntries(entries);
    await this.ensureAlarm();
    return { ok: true };
  }

  /**
   * Heartbeat refresh for a slot the caller still believes it holds. Touches
   * `acquiredAt` to the current time so the `STALE_MS` alarm sweep doesn't
   * reap a long-running but still-live session.
   *
   * Deliberately does NOT re-check `planLimit` — the user's plan may have
   * changed since acquire, but in-flight sandboxes are not retroactively
   * suspended; only new acquires see the updated cap.
   *
   * Returns `{ ok: false, reason: 'not_held' }` if the slot is unknown
   * (already swept or never acquired). Refresh does NOT auto-acquire: the
   * caller treats this as a heartbeat ping that won't recover the session,
   * which keeps the DO's accounting simple (no surprise re-claim that
   * bypasses the planLimit check on the acquire path).
   */
  async refresh(sandboxInstanceId: string): Promise<RefreshResult> {
    const entries = await this.getEntries();
    if (!entries[sandboxInstanceId]) {
      return { ok: false, reason: 'not_held' };
    }
    entries[sandboxInstanceId] = { acquiredAt: Date.now() };
    await this.saveEntries(entries);
    await this.ensureAlarm();
    return { ok: true };
  }

  /**
   * Release the slot held by `sandboxInstanceId`. Idempotent: missing ids
   * are a no-op so the proxy can call `release` from both happy-path and
   * cleanup code paths without coordination.
   */
  async release(sandboxInstanceId: string): Promise<void> {
    const entries = await this.getEntries();
    if (!(sandboxInstanceId in entries)) {
      return;
    }
    delete entries[sandboxInstanceId];
    await this.saveEntries(entries);
  }

  /**
   * Sweep stale entries — anything older than `STALE_MS` is assumed to be a
   * leaked slot (caller crashed without `release`). Re-arms itself so the
   * DO continues reconciling as long as it has live entries; once empty,
   * we let the alarm lapse to keep the DO cold.
   */
  async alarm(): Promise<void> {
    const entries = await this.getEntries();
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.acquiredAt < now - STALE_MS) {
        delete entries[id];
        changed = true;
      }
    }
    if (changed) {
      await this.saveEntries(entries);
    }

    // Re-arm only while we still have entries to watch. An empty DO doesn't
    // need to wake itself — the next `acquire` will set the alarm again.
    if (Object.keys(entries).length > 0) {
      await this.ctx.storage.setAlarm(now + RECONCILE_INTERVAL_MS);
    }
  }
}
