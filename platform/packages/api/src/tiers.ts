export type PlanId = 'free' | 'solo' | 'pro' | 'sponsored' | 'custom';

export type PlanLimits = Readonly<{
  /** Max requests per month (0 = unlimited) */
  requestsPerMonth: number;
  /** Max CPU milliseconds per request (0 = unlimited) */
  cpuMsPerRequest: number;
  /** Highest cpuMs a project may request via its deploy manifest (0 = no ceiling) */
  maxCpuMsPerRequest: number;
  /** Max sub-requests per invocation (0 = unlimited) */
  subRequestsPerInvocation: number;
  /** Max deploys per day (0 = unlimited) */
  deploysPerDay: number;
  /** Max D1 storage in bytes (0 = unlimited) */
  d1StorageBytes: number;
  /** Max R2 storage in bytes (0 = unlimited) */
  r2StorageBytes: number;
  /** Max KV storage in bytes (0 = unlimited) */
  kvStorageBytes: number;
  /** Max AI neurons per month (0 = unlimited) */
  aiNeuronsPerMonth: number;
  /** Max retained deployment scripts (0 = unlimited) */
  retainedDeployments: number;
  /** Max container-runtime seconds per billing month (0 = unlimited) */
  sandboxRuntimeSecondsPerMonth: number;
  /** Max simultaneous live sandbox containers (0 = unlimited) */
  sandboxMaxConcurrentInstances: number;
  /** Max simultaneous in-flight deploy builds (0 = unlimited) */
  concurrentBuilds: number;
  /** Max wall-clock minutes per build before timeout (0 = unlimited) */
  buildTimeoutMinutes: number;
}>;

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    requestsPerMonth: 3_000_000,
    cpuMsPerRequest: 10,
    maxCpuMsPerRequest: 10,
    subRequestsPerInvocation: 50,
    deploysPerDay: 100,
    d1StorageBytes: 1 * GB,
    r2StorageBytes: 5 * GB,
    kvStorageBytes: 1 * GB,
    aiNeuronsPerMonth: 100_000,
    retainedDeployments: 1,
    // 0 = unlimited in PlanLimits convention, so 1 effectively disables sandbox for free users.
    sandboxRuntimeSecondsPerMonth: 1,
    sandboxMaxConcurrentInstances: 1,
    concurrentBuilds: 1,
    buildTimeoutMinutes: 10,
  },
  solo: {
    requestsPerMonth: 10_000_000,
    cpuMsPerRequest: 30,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 50,
    deploysPerDay: 500,
    d1StorageBytes: 5 * GB,
    r2StorageBytes: 25 * GB,
    kvStorageBytes: 5 * GB,
    aiNeuronsPerMonth: 300_000,
    retainedDeployments: 5,
    sandboxRuntimeSecondsPerMonth: 30 * 3600,
    sandboxMaxConcurrentInstances: 2,
    concurrentBuilds: 2,
    buildTimeoutMinutes: 15,
  },
  pro: {
    requestsPerMonth: 100_000_000,
    cpuMsPerRequest: 50,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 3000,
    d1StorageBytes: 10 * GB,
    r2StorageBytes: 100 * GB,
    kvStorageBytes: 25 * GB,
    aiNeuronsPerMonth: 500_000,
    retainedDeployments: 25,
    sandboxRuntimeSecondsPerMonth: 200 * 3600,
    sandboxMaxConcurrentInstances: 10,
    concurrentBuilds: 3,
    buildTimeoutMinutes: 15,
  },
  sponsored: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 50,
    maxCpuMsPerRequest: 30_000,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
    aiNeuronsPerMonth: 0,
    retainedDeployments: 0,
    sandboxRuntimeSecondsPerMonth: 0,
    sandboxMaxConcurrentInstances: 0,
    concurrentBuilds: 6,
    buildTimeoutMinutes: 20,
  },
  custom: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 0,
    maxCpuMsPerRequest: 0,
    subRequestsPerInvocation: 0,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
    aiNeuronsPerMonth: 0,
    retainedDeployments: 0,
    sandboxRuntimeSecondsPerMonth: 0,
    sandboxMaxConcurrentInstances: 0,
    concurrentBuilds: 0,
    buildTimeoutMinutes: 0,
  },
};

/** Static deployments use a fixed retention limit across all tiers (KV/R2-backed, not WfP). */
export const STATIC_RETENTION_LIMIT = 100;

/** Returns plan limits, defaulting to free tier for unknown plans. */
export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanId] ?? PLAN_LIMITS.free;
}

/** Build container for free plans: `standard-3` (2 vCPU / 8 GiB / 16 GB, `BuildManager`). */
export const BUILD_INSTANCE_FREE = 'standard-3';
/** Build container for paid plans: `standard-4` (4 vCPU / 12 GiB / 20 GB, `BuildManagerLarge`). */
export const BUILD_INSTANCE_LARGE = 'standard-4';

/** Container instance size used for a plan's deploy builds. */
export type BuildInstanceType = typeof BUILD_INSTANCE_FREE | typeof BUILD_INSTANCE_LARGE;

/**
 * Returns the build container instance type for a plan, defaulting to the free
 * (smaller, cheaper) container.
 *
 * This value is BOTH the persisted size-of-record (written to the
 * `builds.instance_type` DB column) AND the routing key that selects which
 * container-enabled DO class — and thus which static container size — the build
 * runs on. `@cloudflare/containers@0.3.3` has no per-start sizing, so each size
 * is a distinct DO class with a fixed `instance_type` in wrangler.jsonc;
 * `buildManagerNamespace` (build-namespace.ts) maps this value to the class:
 * `BUILD_INSTANCE_LARGE` → `BuildManagerLarge` (standard-4), everything else →
 * the base `BuildManager` (standard-3).
 */
export function getBuildInstanceType(plan: PlanId): BuildInstanceType {
  switch (plan) {
    case 'free':
      return BUILD_INSTANCE_FREE;
    case 'solo':
    case 'pro':
    case 'sponsored':
    case 'custom':
      return BUILD_INSTANCE_LARGE;
    default:
      return BUILD_INSTANCE_FREE;
  }
}

/** Checks if current usage is within the limit. 0 = unlimited. */
export function isWithinLimit(limit: number, current: number): boolean {
  return limit === 0 || current < limit;
}

/**
 * Returns the start of the user's current billing period based on their
 * signup anniversary day. Clamps to the last day of the month for short
 * months (e.g. signup Jan 31 → Feb 28 in non-leap years).
 */
export function getCurrentBillingPeriodStart(billingCycleStart: string | null | undefined): Date {
  // Handle missing or invalid billing_cycle_start (e.g. legacy rows before column existed)
  if (!billingCycleStart) {
    return new Date();
  }
  // Normalize timestamp format (also handles legacy rows with space separator, no Z)
  const normalized = billingCycleStart.includes('T')
    ? billingCycleStart
    : billingCycleStart.replace(' ', 'T') + 'Z';
  const signup = new Date(normalized);
  if (isNaN(signup.getTime())) {
    return new Date();
  }
  const anchorDay = signup.getUTCDate();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  // Try current month first
  const lastDayThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayThisMonth = Math.min(anchorDay, lastDayThisMonth);
  const candidate = new Date(Date.UTC(year, month, dayThisMonth));

  if (candidate <= now) {
    return candidate;
  }

  // Fall back to previous month
  const lastDayPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayPrevMonth = Math.min(anchorDay, lastDayPrevMonth);
  return new Date(Date.UTC(year, month - 1, dayPrevMonth));
}
