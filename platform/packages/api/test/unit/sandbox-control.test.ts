import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  checkpoint: vi.fn(),
  capability: vi.fn(),
}));
vi.mock('../../src/plans.ts', async () => {
  const { getPlanLimits } = await import('../../src/tiers.ts');
  return { resolvePlanLimits: vi.fn(async (_db: unknown, plan: string) => getPlanLimits(plan)) };
});

vi.mock('../../src/db.ts', () => ({
  createDb: () => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: mocks.authority,
    };
    return { select: () => query };
  },
}));
vi.mock('../../src/sandbox-drain.ts', () => ({ readSandboxDrainCheckpoint: mocks.checkpoint }));
vi.mock('../../src/capabilities.ts', () => ({ getPlatformCapabilities: mocks.capability }));
vi.mock('../../src/routing.ts', () => ({ sandboxBlockKey: (id: string) => `sandbox-block:${id}` }));

import { SandboxControl } from '../../src/sandbox-control.ts';

const identity = {
  projectId: 'project',
  deploymentId: 'deployment',
  userId: 'owner',
  slug: 'old-slug',
};
function authority() {
  return {
    project: {
      id: identity.projectId,
      user_id: identity.userId,
      slug: 'current-slug',
      status: 'active',
      active_deployment_id: identity.deploymentId,
    },
    deployment: {
      id: identity.deploymentId,
      project_id: identity.projectId,
      status: 'live',
      admission_protocol: 3,
      manifest: JSON.stringify({ sandbox: { runtime: { protocol: 1 } } }),
    },
    owner: { id: identity.userId, plan: 'solo', suspended_reason: null as string | null },
    candidateFresh: false,
  };
}
function setup(props: unknown = identity) {
  const counter = {
    reserve: vi.fn(async () => ({ ok: true })),
    started: vi.fn(async () => ({ ok: true })),
    heartbeat: vi.fn(async () => ({ ok: true })),
    stopped: vi.fn(async () => {}),
  };
  const routing = { get: vi.fn(async (_key: string): Promise<string | null> => null) };
  const namespace = { idFromName: vi.fn((id: string) => id), get: vi.fn(() => counter) };
  const env = {
    HYPERDRIVE: { connectionString: 'test' },
    ROUTING: routing,
    SANDBOX_CONCURRENCY_COUNTER: namespace,
    PLATFORM_TRAFFIC_STATE: 'active',
  };
  const ctx = { props };
  const control = new SandboxControl(ctx as never, env as never);
  Object.assign(control, { ctx, env });
  return { control, counter, routing, namespace, env };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue([authority()]);
  mocks.checkpoint.mockResolvedValue({ state: 'complete', admission_protocol: 3 });
  mocks.capability.mockReturnValue({ sandbox: true });
});

describe('private SandboxControl authority', () => {
  it('derives owner, deployment and accounting identity exclusively from immutable binding props', async () => {
    const { control, counter, namespace } = setup();
    expect(await control.reserve('instance', 'run')).toEqual({ ok: true });
    expect(namespace.idFromName).toHaveBeenCalledWith('account:owner');
    expect(counter.reserve).toHaveBeenCalledWith(
      JSON.stringify(['project', 'deployment', 'instance']),
      'run',
      2,
      { projectId: 'project', userId: 'owner', slug: 'current-slug' },
    );
  });

  it.each([1, 2])('authorizes controller protocol %s', async (protocol) => {
    const row = authority();
    row.deployment.manifest = JSON.stringify({ sandbox: { runtime: { protocol } } });
    mocks.authority.mockResolvedValue([row]);
    const { control } = setup();
    expect(await control.reserve('instance', 'run')).toEqual({ ok: true });
  });

  it('fails closed when invoked without the private binding identity', async () => {
    const { control, counter } = setup({});
    expect(await control.reserve('instance', 'run')).toEqual({ ok: false, reason: 'unavailable' });
    expect(counter.reserve).not.toHaveBeenCalled();
    await expect(control.stopped('instance', 'run')).rejects.toThrow(
      'Invalid Sandbox controller identity',
    );
  });

  it.each(['reserve', 'started', 'heartbeat'] as const)(
    'live-checks authority for every %s',
    async (action) => {
      const row = authority();
      const { control, counter } = setup();
      expect(await control[action]('instance', 'run')).toEqual({ ok: true });
      row.project.user_id = 'new-owner';
      mocks.authority.mockResolvedValue([row]);
      expect(await control[action]('instance', 'run')).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(counter[action]).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['deleting', 'retained', 'failed', 'legacy', 'untrusted-marker'] as const)(
    'denies %s deployments',
    async (kind) => {
      const row = authority();
      if (kind === 'deleting') {
        row.project.status = 'deleting';
      }
      if (kind === 'retained') {
        row.project.active_deployment_id = 'next-deployment';
      }
      if (kind === 'failed') {
        row.deployment.status = 'failed';
      }
      if (kind === 'legacy') {
        row.deployment.manifest = JSON.stringify({ sandbox: {} });
      }
      if (kind === 'untrusted-marker') {
        row.deployment.admission_protocol = 2;
      }
      mocks.authority.mockResolvedValue([row]);
      const { control, counter } = setup();
      expect(await control.reserve('instance', 'run')).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(counter.reserve).not.toHaveBeenCalled();
    },
  );

  it.each(['prerendering', 'cutover'])(
    'permits a fresh %s candidate and revokes it when its fence becomes stale',
    async (status) => {
      const row = authority();
      row.project.active_deployment_id = 'previous-deployment';
      row.deployment.status = status;
      row.candidateFresh = true;
      mocks.authority.mockResolvedValue([row]);
      const { control } = setup();
      expect(await control.reserve('instance', 'run')).toEqual({ ok: true });
      row.candidateFresh = false;
      expect(await control.heartbeat('instance', 'run')).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    },
  );

  it.each([
    null,
    { state: 'draining', admission_protocol: 3 },
    { state: 'complete', admission_protocol: 2 },
  ])('requires completed trusted admission: %j', async (checkpoint) => {
    mocks.checkpoint.mockResolvedValue(checkpoint);
    const { control, counter } = setup();
    expect(await control.reserve('instance', 'run')).toEqual({ ok: false, reason: 'unavailable' });
    expect(counter.reserve).not.toHaveBeenCalled();
  });

  it('rejects platform disable and capability disable before touching account capacity', async () => {
    const { control, counter, env } = setup();
    env.PLATFORM_TRAFFIC_STATE = 'sandbox-drain';
    expect(await control.heartbeat('instance', 'run')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    env.PLATFORM_TRAFFIC_STATE = 'active';
    mocks.capability.mockReturnValue({ sandbox: false });
    expect(await control.heartbeat('instance', 'run')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(counter.heartbeat).not.toHaveBeenCalled();
  });

  it('enforces runtime budget from database suspension or the account budget gate', async () => {
    const { control, counter, routing } = setup();
    const row = authority();
    row.owner.suspended_reason = 'sandbox_runtime_exceeded';
    mocks.authority.mockResolvedValue([row]);
    expect(await control.heartbeat('instance', 'run')).toEqual({
      ok: false,
      reason: 'runtime_budget',
    });
    row.owner.suspended_reason = null;
    routing.get.mockImplementation(async (key) => (key === 'sandbox-block:owner' ? '1' : null));
    expect(await control.reserve('instance', 'run')).toEqual({
      ok: false,
      reason: 'runtime_budget',
    });
    expect(counter.reserve).not.toHaveBeenCalled();
  });

  it('uses the new plan on heartbeat and denies manually suspended owners', async () => {
    const { control, counter } = setup();
    const row = authority();
    row.owner.plan = 'free';
    mocks.authority.mockResolvedValue([row]);
    await control.heartbeat('instance', 'run');
    expect(counter.heartbeat).toHaveBeenCalledWith(
      JSON.stringify(['project', 'deployment', 'instance']),
      'run',
      1,
    );
    row.owner.suspended_reason = 'admin';
    expect(await control.heartbeat('instance', 'run')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('propagates authority outages so the controller must stop, without admitting capacity', async () => {
    mocks.authority.mockRejectedValueOnce(new Error('database unavailable'));
    const { control, counter } = setup();
    await expect(control.reserve('instance', 'run')).rejects.toThrow('database unavailable');
    expect(counter.reserve).not.toHaveBeenCalled();
  });

  it('allows confirmed stop after project deletion or platform/database shutdown', async () => {
    mocks.authority.mockRejectedValue(new Error('database unavailable'));
    mocks.checkpoint.mockRejectedValue(new Error('database unavailable'));
    const { control, counter, env } = setup();
    env.PLATFORM_TRAFFIC_STATE = 'sandbox-drain';
    await control.stopped('instance', 'run');
    expect(counter.stopped).toHaveBeenCalledWith(
      JSON.stringify(['project', 'deployment', 'instance']),
      'run',
    );
    expect(mocks.authority).not.toHaveBeenCalled();
  });
});
