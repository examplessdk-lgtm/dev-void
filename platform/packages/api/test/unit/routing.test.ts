import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyRoutingSuspension,
  buildProjectAccountJson,
  buildRoutingJson,
  buildStaticRoutingJson,
  computeDispatchLimits,
  projectAccountKey,
  refreshProjectKvForUser,
  setProjectsRoutingSuspension,
} from '../../src/routing.ts';
import { PLAN_LIMITS, type PlanLimits } from '../../src/tiers.ts';
import type { DeployManifest } from '../../src/types.ts';

function createKvStore(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  puts: Array<string>;
  kv: KVNamespace;
} {
  const store = new Map(Object.entries(initial));
  const puts: Array<string> = [];
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
      puts.push(key);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { store, puts, kv };
}

describe('computeDispatchLimits', () => {
  function planWith(overrides: Partial<PlanLimits>): PlanLimits {
    return { ...PLAN_LIMITS.free, ...overrides };
  }

  it('matches the historical inline expression for every plan when the manifest has no limits', () => {
    for (const planLimits of Object.values(PLAN_LIMITS)) {
      const legacy =
        planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
          ? {
              ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
              ...(planLimits.subRequestsPerInvocation > 0
                ? { subRequests: planLimits.subRequestsPerInvocation }
                : {}),
            }
          : null;
      expect(computeDispatchLimits(planLimits, undefined)).toEqual(legacy);
      expect(computeDispatchLimits(planLimits, null)).toEqual(legacy);
      expect(computeDispatchLimits(planLimits, {})).toEqual(legacy);
    }
  });

  it('returns null when both plan values are 0 and there is no override', () => {
    expect(computeDispatchLimits(PLAN_LIMITS.custom, undefined)).toBeNull();
  });

  it('omits the key whose plan value is 0 (no override)', () => {
    expect(
      computeDispatchLimits(planWith({ cpuMsPerRequest: 0, subRequestsPerInvocation: 50 }), null),
    ).toEqual({ subRequests: 50 });
    expect(
      computeDispatchLimits(planWith({ cpuMsPerRequest: 10, subRequestsPerInvocation: 0 }), null),
    ).toEqual({ cpuMs: 10 });
  });

  it('passes an override below the plan ceiling through', () => {
    expect(computeDispatchLimits(PLAN_LIMITS.pro, { cpuMs: 500 })).toEqual({
      cpuMs: 500,
      subRequests: 1000,
    });
  });

  it('clamps an override above the plan ceiling to the ceiling', () => {
    expect(computeDispatchLimits(PLAN_LIMITS.pro, { cpuMs: 60_000 })).toEqual({
      cpuMs: 30_000,
      subRequests: 1000,
    });
  });

  it('passes any override through when the ceiling is 0 (custom plan)', () => {
    expect(computeDispatchLimits(PLAN_LIMITS.custom, { cpuMs: 123_456 })).toEqual({
      cpuMs: 123_456,
    });
  });

  it('allows an override lower than the plan default', () => {
    // Free default cpuMs is 10; an explicit 5 wins over the default.
    expect(computeDispatchLimits(PLAN_LIMITS.free, { cpuMs: 5 })).toEqual({
      cpuMs: 5,
      subRequests: 50,
    });
  });

  it('falls back to the plan default when a stored override is out of domain', () => {
    // A rollback replays a stored manifest, and a manifest stored before
    // ingest validated `limits` can carry values ingest now rejects. They
    // must not erase (0) or corrupt (negative, fractional) the plan cap.
    for (const cpuMs of [0, -5, 3.7, 2 ** 53, '10' as unknown as number]) {
      expect(computeDispatchLimits(PLAN_LIMITS.free, { cpuMs })).toEqual({
        cpuMs: 10,
        subRequests: 50,
      });
    }
  });

  it('always sources subRequests from the plan, override or not', () => {
    expect(computeDispatchLimits(planWith({ subRequestsPerInvocation: 77 }), { cpuMs: 5 })).toEqual(
      { cpuMs: 5, subRequests: 77 },
    );
    expect(computeDispatchLimits(planWith({ subRequestsPerInvocation: 77 }), undefined)).toEqual({
      cpuMs: 10,
      subRequests: 77,
    });
  });
});

describe('buildRoutingJson', () => {
  const base = {
    workerName: 'user-app',
    projectId: 'proj_1',
    userId: 'user_1',
    manifest: null,
    deploymentId: 'dep_1',
    dispatchLimits: null,
  };

  it('omits assetManifestId and assetConfig when not provided', () => {
    const parsed = JSON.parse(buildRoutingJson(base));
    expect(parsed.assetManifestId).toBeUndefined();
    expect(parsed.assetConfig).toBeUndefined();
  });

  it('emits assetManifestId when provided', () => {
    const parsed = JSON.parse(buildRoutingJson({ ...base, assetManifestId: 'dep_1' }));
    expect(parsed.assetManifestId).toBe('dep_1');
  });

  it('emits assetConfig when provided', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'none' });
  });

  it('keeps staticDeploymentId absent (WfP entries must not be misclassified)', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.staticDeploymentId).toBeUndefined();
  });

  it('passes manifest.pages through to the routing blob', () => {
    const pages = [{ pattern: '/a' }, { pattern: '/b/:x', revalidate: 60 }];
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        manifest: { type: 'void', ssr: true, pages } as unknown as DeployManifest,
      }),
    );
    expect(parsed.pages).toEqual(pages);
  });

  it('omits pages when the manifest has none', () => {
    const parsed = JSON.parse(
      buildRoutingJson({ ...base, manifest: { type: 'void' } as unknown as DeployManifest }),
    );
    expect(parsed.pages).toBeUndefined();
  });

  it('passes manifest.pathRevalidate through to the routing blob', () => {
    const pathRevalidate = { '/blog/private': 0, '/blog/*': 3600 };
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        manifest: { type: 'void', ssr: true, pathRevalidate } as unknown as DeployManifest,
      }),
    );
    expect(parsed.pathRevalidate).toEqual(pathRevalidate);
  });

  it('omits pathRevalidate when the manifest has none or it is empty', () => {
    expect(
      JSON.parse(
        buildRoutingJson({ ...base, manifest: { type: 'void' } as unknown as DeployManifest }),
      ).pathRevalidate,
    ).toBeUndefined();
    expect(
      JSON.parse(
        buildRoutingJson({
          ...base,
          manifest: { type: 'void', pathRevalidate: {} } as unknown as DeployManifest,
        }),
      ).pathRevalidate,
    ).toBeUndefined();
  });
});

describe('buildStaticRoutingJson', () => {
  it('still emits staticDeploymentId (unchanged behavior)', () => {
    const parsed = JSON.parse(
      buildStaticRoutingJson({
        projectId: 'proj_1',
        userId: 'user_1',
        deploymentId: 'dep_1',
        assetConfig: { not_found_handling: 'single-page-application' },
        manifest: null,
      }),
    );
    expect(parsed.staticDeploymentId).toBe('dep_1');
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(parsed.assetManifestId).toBeUndefined();
  });
});

describe('projectAccountKey', () => {
  it('namespaces the project id under the `project:` prefix the proxy reads', () => {
    expect(projectAccountKey('proj_1')).toBe('project:proj_1');
  });
});

describe('buildProjectAccountJson', () => {
  it('emits camelCase `userId` and `plan` so packages/proxy/src/sandbox.ts can parse it', () => {
    expect(buildProjectAccountJson({ userId: 'user_1', plan: 'pro' })).toBe(
      JSON.stringify({ userId: 'user_1', plan: 'pro' }),
    );
  });
});

describe('refreshProjectKvForUser', () => {
  function createKv(): { puts: Array<[string, string]>; kv: KVNamespace } {
    const puts: Array<[string, string]> = [];
    const kv = {
      put: async (key: string, value: string) => {
        puts.push([key, value]);
      },
    } as unknown as KVNamespace;
    return { puts, kv };
  }

  it('rewrites a project entry per project the user owns', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue({
      id: 'user_1',
      plan: 'pro',
    } as Awaited<ReturnType<typeof import('../../src/db.ts').getUser>>);
    vi.spyOn(await import('../../src/db.ts'), 'getProjectsByUserId').mockResolvedValue([
      { id: 'proj_a' },
      { id: 'proj_b' },
    ] as unknown as Awaited<ReturnType<typeof import('../../src/db.ts').getProjectsByUserId>>);

    await refreshProjectKvForUser(db, kv, 'user_1');

    expect(puts).toHaveLength(2);
    const keys = puts.map(([k]) => k).sort();
    expect(keys).toEqual(['project:proj_a', 'project:proj_b']);
    for (const [, value] of puts) {
      expect(JSON.parse(value)).toEqual({ userId: 'user_1', plan: 'pro' });
    }
    vi.restoreAllMocks();
  });

  it('no-ops when the user is missing (treats deletion as nothing to refresh)', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue(null);
    await refreshProjectKvForUser(db, kv, 'ghost');
    expect(puts).toEqual([]);
    vi.restoreAllMocks();
  });

  it('no-ops when the user owns zero projects (avoids a wasted KV roundtrip)', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue({
      id: 'user_1',
      plan: 'free',
    } as Awaited<ReturnType<typeof import('../../src/db.ts').getUser>>);
    vi.spyOn(await import('../../src/db.ts'), 'getProjectsByUserId').mockResolvedValue([]);
    await refreshProjectKvForUser(db, kv, 'user_1');
    expect(puts).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('applyRoutingSuspension', () => {
  it('stamps suspended on each existing key and skips keys with no entry', async () => {
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ workerName: 'w', projectId: 'p' }),
      'domain:a.com': JSON.stringify({ workerName: 'w', projectId: 'p' }),
    });
    await applyRoutingSuspension(kv, ['slug-a', 'domain:a.com', 'domain:missing.com'], {
      op: 'suspend',
      reason: 'requests_exceeded',
      force: false,
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBe('requests_exceeded');
    expect(JSON.parse(store.get('domain:a.com')!).suspended).toBe('requests_exceeded');
    expect(store.has('domain:missing.com')).toBe(false);
  });

  it('clears suspended (unsuspend, matchReason=null) while leaving other fields intact', async () => {
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ workerName: 'w', projectId: 'p', suspended: 'requests_exceeded' }),
    });
    await applyRoutingSuspension(kv, ['slug-a'], { op: 'unsuspend', matchReason: null });
    const entry = JSON.parse(store.get('slug-a')!);
    expect(entry.suspended).toBeUndefined();
    expect(entry.workerName).toBe('w');
  });

  it('skips the KV write when the value already carries the same reason', async () => {
    const { kv, puts } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'p', suspended: 'requests_exceeded' }),
    });
    await applyRoutingSuspension(kv, ['slug-a'], {
      op: 'suspend',
      reason: 'requests_exceeded',
      force: false,
    });
    expect(puts).toEqual([]);
  });

  it('skips the KV write when clearing an entry that has no suspended flag', async () => {
    const { kv, puts } = createKvStore({ 'slug-a': JSON.stringify({ projectId: 'p' }) });
    await applyRoutingSuspension(kv, ['slug-a'], { op: 'unsuspend', matchReason: null });
    expect(puts).toEqual([]);
  });

  // --- reason precedence: usage paths must never clobber an admin suspension ---

  it('non-force suspend does NOT overwrite a different (admin) reason already present', async () => {
    const { store, kv, puts } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'p', suspended: 'admin_suspended' }),
    });
    await applyRoutingSuspension(kv, ['slug-a'], {
      op: 'suspend',
      reason: 'requests_exceeded',
      force: false,
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBe('admin_suspended');
    expect(puts).toEqual([]);
  });

  it('force suspend DOES overwrite a different reason (admin action is authoritative)', async () => {
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'p', suspended: 'requests_exceeded' }),
    });
    await applyRoutingSuspension(kv, ['slug-a'], {
      op: 'suspend',
      reason: 'admin_suspended',
      force: true,
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBe('admin_suspended');
  });

  it('unsuspend with matchReason only clears the matching reason, preserving others', async () => {
    const { store, kv, puts } = createKvStore({
      'admin-route': JSON.stringify({ projectId: 'p', suspended: 'admin_suspended' }),
      'usage-route': JSON.stringify({ projectId: 'p', suspended: 'requests_exceeded' }),
    });
    await applyRoutingSuspension(kv, ['admin-route', 'usage-route'], {
      op: 'unsuspend',
      matchReason: 'requests_exceeded',
    });
    expect(JSON.parse(store.get('admin-route')!).suspended).toBe('admin_suspended');
    expect(JSON.parse(store.get('usage-route')!).suspended).toBeUndefined();
    expect(puts).toEqual(['usage-route']);
  });
});

describe('setProjectsRoutingSuspension', () => {
  it('stamps the slug AND every domain route with a live KV entry — including a crash-window pending domain', async () => {
    // `tryActivateDomain` writes `domain:<host>` to KV BEFORE flipping the DB row
    // to `active`; a crash between leaves a `pending` row whose KV route is still
    // served by dispatch. Suspension must stamp it too, or the project keeps
    // serving past the cap on that hostname. A pending domain with NO KV route
    // (the normal case) is a harmless no-op — applyRoutingSuspension skips it.
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'proj_a' }),
      'domain:active.com': JSON.stringify({ projectId: 'proj_a' }),
      'domain:crash-pending.com': JSON.stringify({ projectId: 'proj_a' }),
    });
    vi.spyOn(await import('../../src/db.ts'), 'getDomainsByProjectIds').mockResolvedValue(
      new Map([
        [
          'proj_a',
          [
            { project_id: 'proj_a', hostname: 'active.com', status: 'active' },
            { project_id: 'proj_a', hostname: 'crash-pending.com', status: 'pending' },
            // Pending domain with no published KV route — must not error.
            { project_id: 'proj_a', hostname: 'no-route-pending.com', status: 'pending' },
          ],
        ],
      ]) as unknown as Awaited<ReturnType<typeof import('../../src/db.ts').getDomainsByProjectIds>>,
    );
    const db = {} as Parameters<typeof setProjectsRoutingSuspension>[1];
    await setProjectsRoutingSuspension(kv, db, [{ id: 'proj_a', slug: 'slug-a' }], {
      op: 'suspend',
      reason: 'requests_exceeded',
      force: false,
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBe('requests_exceeded');
    expect(JSON.parse(store.get('domain:active.com')!).suspended).toBe('requests_exceeded');
    expect(JSON.parse(store.get('domain:crash-pending.com')!).suspended).toBe('requests_exceeded');
    expect(store.has('domain:no-route-pending.com')).toBe(false);
    vi.restoreAllMocks();
  });

  it('clears the slug and active domain entries (unsuspend, matchReason=null)', async () => {
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'proj_a', suspended: 'requests_exceeded' }),
      'domain:active.com': JSON.stringify({ projectId: 'proj_a', suspended: 'requests_exceeded' }),
    });
    vi.spyOn(await import('../../src/db.ts'), 'getDomainsByProjectIds').mockResolvedValue(
      new Map([
        ['proj_a', [{ project_id: 'proj_a', hostname: 'active.com', status: 'active' }]],
      ]) as unknown as Awaited<ReturnType<typeof import('../../src/db.ts').getDomainsByProjectIds>>,
    );
    const db = {} as Parameters<typeof setProjectsRoutingSuspension>[1];
    await setProjectsRoutingSuspension(kv, db, [{ id: 'proj_a', slug: 'slug-a' }], {
      op: 'unsuspend',
      matchReason: null,
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBeUndefined();
    expect(JSON.parse(store.get('domain:active.com')!).suspended).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('reason-scoped clear preserves an admin suspension on the slug AND domain routes', async () => {
    const { store, kv } = createKvStore({
      'slug-a': JSON.stringify({ projectId: 'proj_a', suspended: 'admin_suspended' }),
      'domain:active.com': JSON.stringify({ projectId: 'proj_a', suspended: 'admin_suspended' }),
    });
    vi.spyOn(await import('../../src/db.ts'), 'getDomainsByProjectIds').mockResolvedValue(
      new Map([
        ['proj_a', [{ project_id: 'proj_a', hostname: 'active.com', status: 'active' }]],
      ]) as unknown as Awaited<ReturnType<typeof import('../../src/db.ts').getDomainsByProjectIds>>,
    );
    const db = {} as Parameters<typeof setProjectsRoutingSuspension>[1];
    await setProjectsRoutingSuspension(kv, db, [{ id: 'proj_a', slug: 'slug-a' }], {
      op: 'unsuspend',
      matchReason: 'requests_exceeded',
    });
    expect(JSON.parse(store.get('slug-a')!).suspended).toBe('admin_suspended');
    expect(JSON.parse(store.get('domain:active.com')!).suspended).toBe('admin_suspended');
    vi.restoreAllMocks();
  });

  it('no-ops without a domains query when given zero projects', async () => {
    const { kv, puts } = createKvStore({});
    const spy = vi.spyOn(await import('../../src/db.ts'), 'getDomainsByProjectIds');
    const db = {} as Parameters<typeof setProjectsRoutingSuspension>[1];
    await setProjectsRoutingSuspension(kv, db, [], {
      op: 'suspend',
      reason: 'requests_exceeded',
      force: false,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    vi.restoreAllMocks();
  });
});
