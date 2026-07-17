import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  computeDesiredCloudflareResources,
  runCloudflareDeploy,
  type CloudflareDeployDeps,
  type DeployWranglerRun,
  type DeployWranglerRunResult,
} from '../../src/cli/deploy.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';
import type { ProvisionResult } from '../../src/cli/provision.ts';
import { readConfig } from '../../src/config.ts';

const tmpDir = join(import.meta.dirname, '.tmp-cf-deploy-test');

/** Write a project fixture: a map of relative path → file contents. */
function makeProject(files: Record<string, string>): string {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmpDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return tmpDir;
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const silentCliLog: CliLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  path: null,
  close: async () => {},
};

/** Synthetic real ids (shape-valid) for drift/provision fixtures. */
const REAL_D1_ID = '52b3bbc7-c473-4b26-9486-1345f5de61c4';
const REAL_KV_ID = '7c07b54c9f2a4d1e8b3f6a0c153aa11a';

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

const cleanExit: DeployWranglerRunResult = {
  status: 0,
  stdout: '',
  stderr: '',
  signal: null,
  error: null,
};

/**
 * Build a seam bag whose default seams all PASS, recording a call trace so tests
 * assert ordering + that later steps are skipped on an exit. Individual seams are
 * overridable per test.
 */
function harness(overrides: Partial<CloudflareDeployDeps> = {}): {
  deps: CloudflareDeployDeps;
  trace: Array<string>;
  wranglerArgs: Array<Array<string>>;
  exitCalls: Array<number>;
} {
  const trace: Array<string> = [];
  const wranglerArgs: Array<Array<string>> = [];
  const exitCalls: Array<number> = [];
  const runWrangler: DeployWranglerRun = (args) => {
    wranglerArgs.push(args);
    trace.push(`wrangler:${args[0]}`);
    if (args[0] === 'whoami') {
      return { ...cleanExit, stdout: '{"loggedIn":true}' };
    }
    return cleanExit;
  };
  const deps: CloudflareDeployDeps = {
    isCI: false,
    exit: (code: number) => {
      exitCalls.push(code);
      throw new ExitError(code);
    },
    runWrangler,
    runBuild: () => {
      trace.push('build');
    },
    provision: (async (_root, configPath): Promise<ProvisionResult> => {
      trace.push('provision');
      return { resources: [], configPath, accountIdWritten: false };
    }) as CloudflareDeployDeps['provision'],
    collectPlaintextVarWarnings: (async () => {
      trace.push('warn');
      return { secretKeys: [], totalVarKeys: 0 };
    }) as CloudflareDeployDeps['collectPlaintextVarWarnings'],
    validateSelfHostProdEnv: (async () => {
      trace.push('gate');
      return { hasSchema: false, remoteSecretNames: null };
    }) as CloudflareDeployDeps['validateSelfHostProdEnv'],
    ...overrides,
  };
  return { deps, trace, wranglerArgs, exitCalls };
}

/** A worker-bearing D1 app fixture with a fully-provisioned wrangler.jsonc. */
function d1Project(wrangler: Record<string, unknown>): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'myapp' }),
    'void.json': JSON.stringify({}),
    'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    'wrangler.jsonc': JSON.stringify(wrangler, null, 2),
  });
}

const PROVISIONED_D1 = {
  account_id: 'acc123',
  name: 'myapp',
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: REAL_D1_ID,
      migrations_dir: './db/migrations',
    },
  ],
};

// ---------------------------------------------------------------------------
// Desired set (from source, pre-build)
// ---------------------------------------------------------------------------

describe('computeDesiredCloudflareResources — desired set from source', () => {
  it('maps D1/KV/R2 from the import walk and queues from the scanner', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
      'queues/jobs.ts': `export default {};`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({ binding: 'DB', name: 'myapp-db' });
    expect(desired.kvNamespaces).toEqual([{ binding: 'KV', title: 'myapp-kv' }]);
    expect(desired.r2).toEqual({ binding: 'STORAGE', bucketName: 'myapp-storage' });
    expect(desired.queues).toEqual(['jobs']);
    expect(desired.hyperdrive).toBeUndefined();
  });

  it('desires Hyperdrive (not D1) for a PostgreSQL app', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toBeUndefined();
    expect(desired.hyperdrive?.binding).toBe('HYPERDRIVE');
    expect(desired.hyperdrive?.name).toBe('pgapp-hyperdrive');
  });

  it('desires ISR_CACHE (KV) when a page uses `revalidate`', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'israpp' }),
      'void.json': JSON.stringify({}),
      'pages/index.tsx': `export default () => null;`,
      'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
    });
    const { desired, reasons } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces.map((k) => k.binding)).toContain('ISR_CACHE');
    expect(reasons.get('ISR_CACHE')).toMatch(/revalidate/);
  });

  it('reuses the stored database_name from wrangler.jsonc', async () => {
    const root = d1Project({
      d1_databases: [{ binding: 'DB', database_name: 'legacy-db', database_id: REAL_D1_ID }],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe('legacy-db');
  });
});

// ---------------------------------------------------------------------------
// Orchestration flow
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — app-class guard', () => {
  it('rejects a static/SPA app with exit(1) and never runs wrangler', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'spaapp' }),
      'void.json': JSON.stringify({ inference: { appType: 'spa' } }),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });
});

describe('runCloudflareDeploy — preflight', () => {
  it('exits when wrangler is unauthenticated (whoami --json nonzero)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      runWrangler: (args) => {
        trace.push(`wrangler:${args[0]}`);
        if (args[0] === 'whoami') {
          return { status: 1, stdout: '{"loggedIn":false}', stderr: '', signal: null, error: null };
        }
        return cleanExit;
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual(['wrangler:whoami']); // stopped right after the auth probe
  });

  it('exits when no account is pinned (no account_id, no CLOUDFLARE_ACCOUNT_ID)', async () => {
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const root = d1Project({ ...PROVISIONED_D1, account_id: undefined });
      const { deps, exitCalls } = harness();
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
    } finally {
      if (savedAccount === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      }
    }
  });
});

describe('runCloudflareDeploy — drift check (no --provision)', () => {
  it('blocks with exit(1) when a desired resource is missing, naming it; never builds/deploys', async () => {
    // App also uses KV (env.KV) but wrangler.jsonc only has the D1 → KV drifts.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // whoami ran (preflight), but no migrate/build/deploy.
    expect(trace).toEqual(['wrangler:whoami']);
  });

  it('proceeds through migrate → warn → gate → build → deploy when fully provisioned', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toEqual([
      'wrangler:whoami',
      'wrangler:d1',
      'warn',
      'gate',
      'build',
      'wrangler:deploy',
    ]);
    // migrate targets the stored db name with --remote + pinned config
    const migrate = wranglerArgs.find((a) => a[0] === 'd1');
    expect(migrate).toEqual([
      'd1',
      'migrations',
      'apply',
      'myapp-db',
      '--remote',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    // deploy is bare (follows the .wrangler/deploy redirect)
    expect(wranglerArgs.find((a) => a[0] === 'deploy')).toEqual(['deploy']);
  });
});

describe('runCloudflareDeploy — provision path', () => {
  it('calls the provisioner with the correctly-built desired set', async () => {
    let captured: unknown;
    const root = d1Project(PROVISIONED_D1);
    const { deps } = harness({
      provision: (async (_root, configPath, desired): Promise<ProvisionResult> => {
        captured = desired;
        return { resources: [], configPath, accountIdWritten: false };
      }) as CloudflareDeployDeps['provision'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps);
    expect(captured).toMatchObject({
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [],
      queues: [],
    });
  });
});

describe('runCloudflareDeploy — CI provision gate', () => {
  it('fails closed under CI when the committed config is incomplete', async () => {
    // Needs KV but the committed config only has D1 → not a provable no-op.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const { deps, trace, exitCalls } = harness({ isCI: true });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual(['wrangler:whoami']); // gated before provisioning
  });

  it('allows a provable no-op under CI when the committed config already covers everything', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
      'wrangler.jsonc': JSON.stringify(
        { ...PROVISIONED_D1, kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }] },
        null,
        2,
      ),
    });
    const { deps, trace } = harness({ isCI: true });
    await runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps);
    expect(trace).toContain('provision');
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — secrets gate', () => {
  it('warns about a plaintext secret-looking key without blocking', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace } = harness({
      collectPlaintextVarWarnings: (async () => {
        trace.push('warn');
        return {
          secretKeys: [{ key: 'API_TOKEN', reason: 'heuristic' as const }],
          totalVarKeys: 3,
        };
      }) as CloudflareDeployDeps['collectPlaintextVarWarnings'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy'); // warning is non-fatal
  });

  it('blocks with exit(1) when the gate throws (missing required secret); never deploys', async () => {
    const { SelfHostEnvValidationError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      validateSelfHostProdEnv: (async () => {
        trace.push('gate');
        throw new SelfHostEnvValidationError('env: missing required secret STRIPE_KEY', {
          valid: false,
          missing: ['STRIPE_KEY'],
          invalid: [],
          values: new Map(),
        });
      }) as CloudflareDeployDeps['validateSelfHostProdEnv'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('renders the first-deploy structured error and exits', async () => {
    const { SelfHostFirstDeployError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, exitCalls } = harness({
      validateSelfHostProdEnv: (async () => {
        throw new SelfHostFirstDeployError('worker not deployed yet', ['STRIPE_KEY'], 1);
      }) as CloudflareDeployDeps['validateSelfHostProdEnv'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
  });
});

describe('runCloudflareDeploy — pg/Hyperdrive app skips D1 migrations', () => {
  it('does not call `d1 migrations apply` for a PostgreSQL app', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'pgapp',
          hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
        },
        null,
        2,
      ),
    });
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('wrangler:deploy');
  });
});
