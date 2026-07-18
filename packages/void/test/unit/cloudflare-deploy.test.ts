import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resolveRequiredAuthSchemaViaSubprocess } from '../../src/cli/auth-schema-probe.ts';
import {
  assertMigrationsProduceAuthSchema,
  assertNoConfigOverrideInProjectDotenv,
  checkWranglerMigrationApplySet,
  compareWranglerMigrationPaths,
  computeDesiredCloudflareResources,
  resolveDeployBuildConfig,
  runCloudflareDeploy,
  validateAuthMigrationSchema,
  verifyGeneratedDeployConfig,
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
    // `d1 migrations list` (the post-apply pending verify) must print wrangler's affirmative
    // "no pending" sentinel under the pinned WRANGLER_LOG=log, else the B3 check fails closed.
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'list') {
      return { ...cleanExit, stdout: '✅ No migrations to apply!\n' };
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
    // The stubbed build never writes dist/ssr/wrangler.json, so the real config
    // verification would have nothing to read — pass it by default; dedicated tests
    // exercise the real verifier and the fail-closed branch.
    verifyDeployConfig: () => ({ ok: true }),
    // Stub the migration gate so orchestration tests never spawn drizzle-kit; dedicated
    // tests inject a throwing stub (drift) or exercise the real pure gates (journal /
    // destructive) directly.
    assertMigrationsDeployable: () => {
      trace.push('migrate-gate');
    },
    // Stub the migration apply-set equality gate so orchestration tests need no on-disk
    // migration dir; a dedicated suite exercises the real `checkWranglerMigrationApplySet`.
    checkMigrationApplySet: async () => ({ ok: true }),
    // Stub auth-schema validation so orchestration tests never load Better Auth; dedicated
    // tests exercise the real `validateAuthMigrationSchema` + `assertMigrationsProduceAuthSchema`.
    validateAuthMigrations: async () => {},
    // Stub the effective build-config resolver so orchestration tests never load Vite.
    resolveBuildConfig: () => ({ mode: 'production', envDir: undefined }),
    ...overrides,
  };
  return { deps, trace, wranglerArgs, exitCalls };
}

/** A worker-bearing D1 app fixture with a fully-provisioned wrangler.jsonc. */
function d1Project(
  wrangler: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'myapp' }),
    'void.json': JSON.stringify({}),
    'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    'wrangler.jsonc': JSON.stringify(wrangler, null, 2),
    ...extraFiles,
  });
}

/** One non-destructive checked-in migration so the remote migrate path runs. */
const INIT_MIGRATION = {
  'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
};

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
    expect(desired.d1).toEqual({
      binding: 'DB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
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

  it('ignores a synced placeholder database_name paired with the local id', async () => {
    // A not-yet-provisioned entry: `database_id: "local"` with a placeholder name.
    // The stored name must NOT become the prod DB identity — derive the worker name.
    const root = d1Project({
      d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe('myapp-db');
  });

  it('honors inference.bindings overrides (disabled D1, custom KV, forced R2)', async () => {
    // Route uses env.DB/KV/STORAGE, but void.json disables D1 and renames KV — the
    // desired set must match the build (which consumes the same overrides), so D1 is
    // absent and KV uses the custom binding name.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({
        inference: { bindings: { db: false, kv: 'MYKV', storage: true } },
      }),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toBeUndefined();
    expect(desired.kvNamespaces).toEqual([{ binding: 'MYKV', title: 'myapp-kv' }]);
    expect(desired.r2).toEqual({ binding: 'STORAGE', bucketName: 'myapp-storage' });
  });

  it('forces D1 with a custom binding via inference.bindings', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ inference: { bindings: { db: 'MYDB' } } }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({
      binding: 'MYDB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
  });

  it('desires D1 for a migration-only SQLite app (no env.DB use, no auth)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_init.sql': `CREATE TABLE t (id INTEGER PRIMARY KEY);`,
    });
    const { desired, reasons } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1).toEqual({
      binding: 'DB',
      name: 'myapp-db',
      migrationsDir: './db/migrations',
    });
    expect(reasons.get('DB')).toMatch(/migrations/);
  });

  it('does not require Hyperdrive for a pg app with no DB use, auth, or migrations', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.hyperdrive).toBeUndefined();
    expect(desired.d1).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Orchestration flow
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — app-class guard (narrowed to full Void apps)', () => {
  it('rejects a configured static/SPA app with exit(1) and never runs wrangler', async () => {
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

  it('rejects an UNCONFIGURED Vite SPA (no void.json appType) via the managed detectPreset classifier', async () => {
    // resolveStaticDeployPreset returns null here (no --dir, no configured appType), so the
    // old guard let this slip; detectPreset structurally classifies it as an SPA (vite dep,
    // no backend files) and this fork now rejects it.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'viteapp', dependencies: { vite: '6.0.0' } }),
      'void.json': JSON.stringify({}),
      'index.html': '<!doctype html><div id="app"></div>',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('rejects a bare --spa deploy before any account op', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', spa: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('rejects a --dir static deploy before any account op', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', dir: 'dist' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('rejects a bare project with no Void backend files (positive full-Void assertion)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'bare' }),
      'void.json': JSON.stringify({}),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('rejects a PostgreSQL app with auth enabled (pg + auth) before any account op', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgauth' }),
      'void.json': JSON.stringify({ database: 'pg', auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected at the pg+auth guard (after the desired set, before whoami/provision).
    expect(trace).toEqual([]);
  });

  it('rejects a pages app with output:"static" (SSG) — the signal the build itself branches on', async () => {
    // Real-shape: the static-pages playground config — `output: "static"` + a `pages/` dir.
    // `detectPreset` returns null (no SSG dep / no root index.html) and `pages/` satisfies
    // `hasBackendFiles`, so without the `output === 'static'` signal this reaches account/build.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'ssgapp' }),
      'void.json': JSON.stringify({
        output: 'static',
        worker: { compatibility_date: '2026-02-12' },
      }),
      'pages/index.vue': `<template><div>hi</div></template>`,
      'pages/index.server.ts': `export const loader = () => ({});`,
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // NO account / build seam ran.
    expect(trace).toEqual([]);
  });

  it('A1: rejects a project whose D1 binding sets a custom migrations_pattern before any account op', async () => {
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
          migrations_pattern: 'db/migrations/**/*.sql',
        },
      ],
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected at the custom-pattern guard (after the desired set, before whoami/provision).
    expect(trace).toEqual([]);
  });

  it('rejects a WebSocket / Durable Object app (.ws.ts route) before any account op', async () => {
    // A `.ws.ts` route makes the build emit a `new_classes` (KV-backed) DO migration, which a
    // fresh Cloudflare account refuses to create — reject via the SAME `scanWebSocketRoutesSync`
    // scan the build's DO emission uses.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'wsapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'routes/chat/[room].ws.ts': `import { defineRoom } from 'void/ws';\nexport default defineRoom({});`,
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

  it('proceeds through gate → migrate → verify → warn → gate → build → deploy when fully provisioned', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const { deps, trace, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toEqual([
      'wrangler:whoami',
      'migrate-gate',
      'wrangler:d1', // migrations apply
      'wrangler:d1', // migrations list (pending verify)
      'warn',
      'gate',
      'build',
      'wrangler:deploy',
    ]);
    // migrate targets the stored db name with --remote + pinned config
    const d1Calls = wranglerArgs.filter((a) => a[0] === 'd1');
    expect(d1Calls[0]).toEqual([
      'd1',
      'migrations',
      'apply',
      'myapp-db',
      '--remote',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    // the post-apply pending verification lists remote migrations for the same target
    expect(d1Calls[1]).toEqual([
      'd1',
      'migrations',
      'list',
      'myapp-db',
      '--remote',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    // deploy follows the .wrangler/deploy redirect, pins the top-level env, disables
    // wrangler's own implicit provisioning + auto-create + framework autoconfig.
    expect(wranglerArgs.find((a) => a[0] === 'deploy')).toEqual([
      'deploy',
      '--env=',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      '--autoconfig=false',
    ]);
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

describe('runCloudflareDeploy — D1 migrations_dir gate', () => {
  it('fails closed (no `d1 migrations apply`) when migrations_dir is absent', async () => {
    // Real D1 id (drift passes) + a checked-in migration, but the entry declares no
    // migrations_dir — running wrangler would default to `./migrations` and apply an
    // unrelated folder.
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      },
      INIT_MIGRATION,
    );
    const { deps, wranglerArgs, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — full Void app queues', () => {
  it('rejects a framework app (with a queue) via the framework guard before any account op', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'fwapp',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'fwapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Guard fires before preflight/provision — nothing ran.
    expect(trace).toEqual([]);
  });

  it('lets a full Void app with a queue proceed (queues wire through the build)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
    });
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — CI queue provision gate', () => {
  it('fails closed on a queue under CI --provision (queues cannot be proven created)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness({ isCI: true });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Gated after preflight, before provisioning — no `queues create`.
    expect(trace).toEqual(['wrangler:whoami']);
    expect(trace).not.toContain('provision');
  });
});

describe('runCloudflareDeploy — skipped desired resource is fatal', () => {
  it('fails closed when the provisioner skips a desired Hyperdrive; never builds/deploys', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'pgapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness({
      provision: (async (_root, configPath): Promise<ProvisionResult> => {
        trace.push('provision');
        return {
          resources: [
            {
              kind: 'hyperdrive',
              binding: 'HYPERDRIVE',
              name: 'pgapp-hyperdrive',
              action: 'skipped',
              reason: 'no connection string provided',
            },
          ],
          configPath,
          accountIdWritten: false,
        };
      }) as CloudflareDeployDeps['provision'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('provision');
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — generated config verification', () => {
  it('fails closed after build when the generated config mismatches; never deploys', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      verifyDeployConfig: () => ({ ok: false, reason: 'account mismatch' }),
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('build'); // build ran
    expect(trace).not.toContain('wrangler:deploy'); // deploy blocked
  });
});

describe('runCloudflareDeploy — non-Cloudflare target guard', () => {
  for (const target of ['node', 'bun', 'deno'] as const) {
    it(`rejects the "${target}" target before any account/provision op`, async () => {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'nodeapp' }),
        'void.json': JSON.stringify({ target }),
        'routes/index.ts': `export const GET = () => new Response('ok');`,
        'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'nodeapp' }, null, 2),
      });
      const { deps, trace, exitCalls } = harness();
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      // Rejected before the desired set + any wrangler/provision call.
      expect(trace).toEqual([]);
    });
  }
});

describe('runCloudflareDeploy — worker-name override (WRANGLER_CI_OVERRIDE_NAME)', () => {
  it('fails closed when a project dotenv declares WRANGLER_CI_OVERRIDE_NAME', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env': 'WRANGLER_CI_OVERRIDE_NAME=other-worker\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Fenced during preflight (before whoami) — nothing ran.
    expect(trace).toEqual([]);
  });

  it('ignores an ambient WRANGLER_CI_OVERRIDE_NAME — deploys the derived (non-override) name', async () => {
    const saved = process.env.WRANGLER_CI_OVERRIDE_NAME;
    process.env.WRANGLER_CI_OVERRIDE_NAME = 'evil-name';
    try {
      // Root config has NO top-level name → the worker name is derived from package.json,
      // NOT the ambient override.
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'myapp' }),
        'void.json': JSON.stringify({}),
        'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
        'wrangler.jsonc': JSON.stringify(
          {
            account_id: 'acc123',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'myapp-db',
                database_id: REAL_D1_ID,
                migrations_dir: './db/migrations',
              },
            ],
          },
          null,
          2,
        ),
      });
      let deployedWorker: unknown;
      const cliLog: CliLogger = {
        ...silentCliLog,
        info(event: string, fields?: Record<string, unknown>) {
          if (event === 'cloudflare_deploy_end') {
            deployedWorker = fields?.worker;
          }
        },
      };
      const { deps, trace } = harness();
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, cliLog, deps);
      expect(trace).toContain('wrangler:deploy');
      expect(deployedWorker).toBe('myapp');
      // The pinned root config name is the derived name, never the override.
      const written = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')) as {
        name?: string;
      };
      expect(written.name).toBe('myapp');
    } finally {
      if (saved === undefined) {
        delete process.env.WRANGLER_CI_OVERRIDE_NAME;
      } else {
        process.env.WRANGLER_CI_OVERRIDE_NAME = saved;
      }
    }
  });
});

describe('runCloudflareDeploy — build-config override (finding 2 / 4 fences)', () => {
  it('fails closed when .env.production declares CLOUDFLARE_ENV', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.production': 'CLOUDFLARE_ENV=staging\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed when .env.production declares CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.production': 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=./alt.jsonc\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed on a .env. transport redirect (reused provisioner fence)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
      '.env.': 'CLOUDFLARE_API_BASE_URL=https://evil.example.com\n',
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });

  it('fails closed on an ambient CLOUDFLARE_ENV (non-top-level target)', async () => {
    const saved = process.env.CLOUDFLARE_ENV;
    process.env.CLOUDFLARE_ENV = 'staging';
    try {
      const root = d1Project(PROVISIONED_D1);
      const { deps, trace, exitCalls } = harness();
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(trace).toEqual([]);
    } finally {
      if (saved === undefined) {
        delete process.env.CLOUDFLARE_ENV;
      } else {
        process.env.CLOUDFLARE_ENV = saved;
      }
    }
  });
});

describe('assertNoConfigOverrideInProjectDotenv', () => {
  it('rejects WRANGLER_CI_OVERRIDE_NAME in a wrangler --env= dotenv file', () => {
    const root = makeProject({ '.env': 'WRANGLER_CI_OVERRIDE_NAME=x\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(root, 'linux')).toThrow(
      /WRANGLER_CI_OVERRIDE_NAME/,
    );
  });

  it('rejects CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH in the vite production set', () => {
    const rootA = makeProject({ '.env.production': 'CLOUDFLARE_ENV=prod\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(rootA, 'linux')).toThrow(/CLOUDFLARE_ENV/);
    const rootB = makeProject({
      '.env.production.local': 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=./alt.jsonc\n',
    });
    expect(() => assertNoConfigOverrideInProjectDotenv(rootB, 'linux')).toThrow(
      /CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH/,
    );
  });

  it('passes when no override selectors are declared', () => {
    const root = makeProject({ '.env': 'FOO=bar\n', '.env.production': 'BAZ=qux\n' });
    expect(() => assertNoConfigOverrideInProjectDotenv(root, 'linux')).not.toThrow();
  });
});

describe('runCloudflareDeploy — D1 migrate targets the unique validated entry', () => {
  it('fails closed when an earlier alias entry shares the migrate token', async () => {
    // Two D1 entries share database_name "myapp-db" with DIFFERENT migrations_dir. The
    // gate validated binding DB, but wrangler would first-match the earlier OLD entry.
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [
          {
            binding: 'OLD',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './legacy',
          },
          {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      },
      INIT_MIGRATION,
    );
    const { deps, wranglerArgs, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('migrates by the unique token even when the validated entry is not first', async () => {
    const root = d1Project(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [
          {
            binding: 'OLD',
            database_name: 'legacy-db',
            database_id: REAL_D1_ID,
            migrations_dir: './legacy',
          },
          {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: REAL_D1_ID,
            migrations_dir: './db/migrations',
          },
        ],
      },
      INIT_MIGRATION,
    );
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // Targets the validated entry's own unique database_name (resolves to DB, not OLD).
    // `.find` returns the first d1 call — the apply (the list verify follows it).
    expect(wranglerArgs.find((a) => a[0] === 'd1')).toEqual([
      'd1',
      'migrations',
      'apply',
      'myapp-db',
      '--remote',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — wrangler implicit provisioning disabled on deploy', () => {
  it('passes both disable-flags for an R2 app that passes local drift (no auto-create)', async () => {
    // R2 bucket_name present locally (drift passes) but may be absent remotely — deploy
    // must NOT let wrangler auto-create it.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'r2app' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.STORAGE.put('a', 'b');`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'r2app',
          r2_buckets: [{ binding: 'STORAGE', bucket_name: 'r2app-storage' }],
        },
        null,
        2,
      ),
    });
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(wranglerArgs.find((a) => a[0] === 'deploy')).toEqual([
      'deploy',
      '--env=',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      '--autoconfig=false',
    ]);
  });
});

describe('verifyGeneratedDeployConfig', () => {
  function deployConfigProject(generated: Record<string, unknown>): string {
    return makeProject({
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify(generated),
    });
  }

  function deployConfigProjectWithRoot(
    generated: Record<string, unknown>,
    root: Record<string, unknown>,
  ): string {
    return makeProject({
      'wrangler.jsonc': JSON.stringify(root),
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify(generated),
    });
  }

  it('passes when account_id and name match the pinned target', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp' });
    expect(verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' })).toEqual(
      {
        ok: true,
      },
    );
  });

  it('fails when the generated account_id differs (named-env redirect)', () => {
    const root = deployConfigProject({ account_id: 'other-acc', name: 'myapp' });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/account_id/);
  });

  it('fails when the generated worker name differs (e.g. env-suffixed name)', () => {
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp-prod' });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/worker name/);
  });

  it('fails closed when the deploy config was not emitted', () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'myapp' }) });
    const result = verifyGeneratedDeployConfig(root, { accountId: 'acc123', workerName: 'myapp' });
    expect(result.ok).toBe(false);
  });

  it('fails when a flattened config swaps a binding identity (same account/name)', () => {
    // Same account_id + name, but the generated D1 database_id differs from the root
    // config's provisioned id — a flattened named-env / alternate-config binding set.
    const OTHER_D1_ID = '11111111-2222-3333-4444-555555555555';
    const root = deployConfigProjectWithRoot(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
      },
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      },
    );
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      rootConfigPath: join(root, 'wrangler.jsonc'),
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identity|flattened/);
  });

  it('fails when the generated config drops a provisioned binding entirely', () => {
    const root = deployConfigProjectWithRoot(
      { account_id: 'acc123', name: 'myapp', d1_databases: [] },
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      },
    );
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      rootConfigPath: join(root, 'wrangler.jsonc'),
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it('passes when the generated binding identities match the root config', () => {
    const root = deployConfigProjectWithRoot(
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
        kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      },
      {
        account_id: 'acc123',
        name: 'myapp',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
        kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      },
    );
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      rootConfigPath: join(root, 'wrangler.jsonc'),
      desired: {
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        queues: [],
      },
    });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Managed deploy must NOT eagerly load the provision lifecycle (proper-lockfile
// → signal-exit patches process.emit / reallyExit ON IMPORT). deploy.ts is
// imported by cli.ts for every deploy, so its module-scope import of
// ./provision.ts must be TYPE-ONLY; the runtime values load via a dynamic
// import() inside the Cloudflare fork only. Assert that at the source level so a
// regression re-introducing a static runtime import fails fast (a real
// module-registry check would be polluted by this test file's own provision
// import, and a subprocess check would be slow/flaky).
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — managed path does not import the provision module', () => {
  const deploySource = readFileSync(join(import.meta.dirname, '../../src/cli/deploy.ts'), 'utf-8');

  it('imports ./provision.ts as TYPE-ONLY at module scope (dynamic import inside the fork)', () => {
    // Every static `... from './provision.ts'` at module scope must be `import type`.
    // `[^']*?` keeps each clause from spanning across a previous `from '...'`.
    const staticImports = [
      ...deploySource.matchAll(/^import\s+([^']*?)\s+from\s+'\.\/provision\.ts';/gm),
    ];
    expect(staticImports.length).toBeGreaterThan(0);
    for (const [, clause] of staticImports) {
      expect(clause.startsWith('type')).toBe(true);
    }
  });

  it('loads the provision module via a dynamic import()', () => {
    expect(deploySource).toMatch(/await import\('\.\/provision\.ts'\)/);
  });
});

// ---------------------------------------------------------------------------
// Framework-class guard (finding 6): only Class-A framework SSR coheres with
// this backend (full Void plugin stack + CF Vite plugin). Class B/C get a
// lighter Void composition that emits no worker artifact here — reject early.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — framework guard (all framework SSR deferred in v1)', () => {
  it('rejects a Class B/C framework SSR app before any account operation', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'skapp',
        dependencies: { '@sveltejs/kit': '2.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'skapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected before preflight — no whoami, no build, no deploy.
    expect(trace).toEqual([]);
  });

  it('rejects a Class-A framework SSR app before any account operation (narrowed in v1)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        name: 'tsapp',
        dependencies: { '@tanstack/react-start': '1.0.0' },
      }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'tsapp' }, null, 2),
    });
    const { deps, trace, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The whole framework path is deferred — rejected before any account op.
    expect(trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stale deploy pointer (finding 4): the pointer is deleted before building, so a
// build that emits no fresh one (auto-static / Class B/C) can never upload old
// code — the verification fails closed on the missing pointer.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — stale deploy pointer', () => {
  it('fails closed (no deploy) when the build emits no fresh pointer over a stale one', async () => {
    const root = d1Project(PROVISIONED_D1);
    // Plant a STALE pointer + target that WOULD pass the account/name identity check.
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'wrangler.json'),
      JSON.stringify({ account_id: 'acc123', name: 'myapp' }),
    );
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    // A build that does NOT re-create the pointer (a non-CF/static build class).
    const { deps, trace, exitCalls } = harness({
      runBuild: () => {
        trace.push('build');
      },
      // Use the REAL verifier so the deleted-then-not-recreated pointer fails closed.
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// Env-only account pin (finding 7): the CF plugin copies account_id only from the
// root config, so the reconciled account is persisted there before the build —
// making the documented CLOUDFLARE_ACCOUNT_ID pin actually reach deploy.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — env-only account pin', () => {
  it('persists CLOUDFLARE_ACCOUNT_ID into the root config and reaches deploy without --provision', async () => {
    const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_ACCOUNT_ID = 'env-acc-999';
    try {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'myapp' }),
        'void.json': JSON.stringify({}),
        'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
        // Root config has NO account_id — only the env var pins the account.
        'wrangler.jsonc': JSON.stringify(
          {
            name: 'myapp',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'myapp-db',
                database_id: REAL_D1_ID,
                migrations_dir: './db/migrations',
              },
            ],
          },
          null,
          2,
        ),
      });
      const { deps, trace } = harness();
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
      // Reaches deploy (does not false-stop on a missing generated account_id)...
      expect(trace).toContain('wrangler:deploy');
      // ...because the env pin was persisted into the root config the build reads.
      const written = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')) as {
        account_id?: string;
      };
      expect(written.account_id).toBe('env-acc-999');
    } finally {
      if (saved === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = saved;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Migrations dir/intent + auth tables (finding 5)
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — migrations dir / count / auth', () => {
  it('carries the sourceDir-aware config-relative migrations_dir into the desired set', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ sourceDir: 'src' }),
      'src/routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify({ name: 'myapp' }, null, 2),
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.migrationsDir).toBe('./src/db/migrations');
  });

  it('runs the drift/journal gate but skips the wrangler apply when a D1 app has no migrations', async () => {
    const root = d1Project(PROVISIONED_D1); // migrations_dir set, but NO .sql files
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // B2: the managed drift/journal gate runs for EVERY D1 app (a schema.ts with no
    // generated migration is drift), but wrangler 4.107 hard-fails on an empty/absent
    // folder — so the apply/list is skipped.
    expect(trace).toContain('migrate-gate');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed for an auth app whose auth tables are not in checked-in migrations', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'authapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'authapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    // Use the REAL schema validator (auth app with NO migrations → no tables → rejects),
    // exercising the isolated-subprocess probe + in-memory-SQLite path end to end.
    const { deps, trace, exitCalls } = harness({
      validateAuthMigrations: validateAuthMigrationSchema,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected at the auth guard (3d — after the transport/account pin, before whoami/provision).
    expect(trace).toEqual([]);
  });

  it('lets an auth app proceed when its migrations produce the required auth schema', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp' }),
      'void.json': JSON.stringify({ auth: {} }),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'db/migrations/0000_auth.sql': `CREATE TABLE "user" (id text primary key);`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'authapp',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'authapp-db',
              database_id: REAL_D1_ID,
              migrations_dir: './db/migrations',
            },
          ],
        },
        null,
        2,
      ),
    });
    // The schema validator is stubbed (harness default) — dedicated tests exercise the real
    // schema check; here we assert the guard lets a satisfied auth app proceed to deploy.
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// B5: auth schema derived from resolveVoidAuthMigrationSchema, validated by
// applying migrations to an in-memory SQLite DB (not a CREATE TABLE token search)
// ---------------------------------------------------------------------------

describe('assertMigrationsProduceAuthSchema', () => {
  const required = [
    { table: 'user', columns: ['id', 'email', 'name'] },
    { table: 'session', columns: ['id', 'userId'] },
  ];

  it('passes when every required table + column is produced by the migrations', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE user (id text primary key, email text, name text);\nCREATE TABLE session (id text primary key, userId text);',
        },
      ],
      required,
    );
    // no throw
  });

  it('rejects when a required table is missing (token search would miss a renamed/commented one)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: 'CREATE TABLE user (id text, email text, name text);' }],
        required,
      ),
    ).rejects.toThrow(/session/);
  });

  it('rejects when a required column is missing (only presence of the table is not enough)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: 'CREATE TABLE user (id text, email text, name text);\nCREATE TABLE session (id text);',
          },
        ],
        required,
      ),
    ).rejects.toThrow(/session.*userId|userId/);
  });

  it('is not fooled by a CREATE TABLE inside a comment or string (real apply, not a regex)', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: `CREATE TABLE user (id text, email text, name text);\n-- CREATE TABLE session (id text, userId text);`,
          },
        ],
        required,
      ),
    ).rejects.toThrow(/session/);
  });

  it('rejects when a migration cannot be applied to a fresh SQLite database', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: 'THIS IS NOT VALID SQL;' }],
        required,
      ),
    ).rejects.toThrow(/could not be applied/);
  });
});

// ---------------------------------------------------------------------------
// F5: auth schema derived in an ISOLATED SUBPROCESS under the build's EFFECTIVE mode +
// the scrubbed build env (no arbitrary project code runs in the credential-bearing parent)
// ---------------------------------------------------------------------------

describe('F5: isolated auth-schema subprocess', () => {
  // Fixture auth config that (a) RENAMES the user table from an env var (so the effective mode
  // is observable in the result), and (b) reveals whether the child's process.env carries CF
  // Access (so a scrubbed env is observable). `import type ... from "void/auth"` is stripped by
  // node — no runtime resolution needed — while satisfying findVoidAuthConfig's detector.
  const AUTH_CONFIG = [
    `import type { VoidAuthConfig } from 'void/auth';`,
    `const config: VoidAuthConfig = ({ defaults, env }) => ({`,
    `  ...defaults,`,
    `  user: {`,
    `    modelName: process.env.CF_ACCESS_CLIENT_ID`,
    `      ? 'LEAKED'`,
    `      : ((env.AUTH_TABLE as string) ?? 'user'),`,
    `  },`,
    `});`,
    `export default config;`,
  ].join('\n');

  function authRenameProject(): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'authapp', type: 'module' }),
      'void.json': JSON.stringify({ auth: { providers: ['email'] } }),
      'auth.config.ts': AUTH_CONFIG,
      '.env.production': 'AUTH_TABLE=user\n',
      '.env.staging': 'AUTH_TABLE=members\n',
    });
  }

  it('derives the schema under the EFFECTIVE mode (production `user` vs staging `members`)', async () => {
    const root = authRenameProject();
    const env = { ...process.env };
    delete env.CF_ACCESS_CLIENT_ID;
    const input = {
      root,
      authConfigPath: join(root, 'auth.config.ts'),
      dialect: 'sqlite' as const,
      providers: ['email'],
      envDir: undefined,
    };
    const staging = await resolveRequiredAuthSchemaViaSubprocess(
      { ...input, mode: 'staging' },
      env,
    );
    expect(staging.map((t) => t.table)).toContain('members');
    expect(staging.map((t) => t.table)).not.toContain('user');

    const production = await resolveRequiredAuthSchemaViaSubprocess(
      { ...input, mode: 'production' },
      env,
    );
    expect(production.map((t) => t.table)).toContain('user');
    expect(production.map((t) => t.table)).not.toContain('members');
  });

  it('runs under the passed env — a scrubbed env hides CF Access from the auth code', async () => {
    const root = authRenameProject();
    const input = {
      root,
      authConfigPath: join(root, 'auth.config.ts'),
      dialect: 'sqlite' as const,
      providers: ['email'],
      mode: 'production',
      envDir: undefined,
    };
    // With CF Access present in the child env, the arbitrary auth code CAN read it (LEAKED).
    const leaked = await resolveRequiredAuthSchemaViaSubprocess(input, {
      ...process.env,
      CF_ACCESS_CLIENT_ID: 'super-secret',
    });
    expect(leaked.map((t) => t.table)).toContain('LEAKED');
    // Scrubbed (as the orchestrator passes it) → the credential is absent in the child.
    const scrubbed = { ...process.env };
    delete scrubbed.CF_ACCESS_CLIENT_ID;
    const clean = await resolveRequiredAuthSchemaViaSubprocess(input, scrubbed);
    expect(clean.map((t) => t.table)).not.toContain('LEAKED');
    expect(clean.map((t) => t.table)).toContain('user');
  });

  it('fails closed when the child cannot resolve the schema (bad auth config)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'authapp', type: 'module' }),
      'void.json': JSON.stringify({ auth: {} }),
      'auth.config.ts': `import type { X } from 'void/auth';\nthrow new Error('boom in auth config');\nexport default {};`,
    });
    await expect(
      resolveRequiredAuthSchemaViaSubprocess(
        {
          root,
          authConfigPath: join(root, 'auth.config.ts'),
          dialect: 'sqlite',
          providers: null,
          mode: 'production',
          envDir: undefined,
        },
        { ...process.env },
      ),
    ).rejects.toThrow(/boom in auth config|exited with code/);
  });

  it('the orchestrator derives auth under the SCRUBBED env + the EFFECTIVE mode/envDir', async () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    process.env.CF_ACCESS_CLIENT_ID = 'leak-me';
    process.env.CF_ACCESS_CLIENT_SECRET = 'leak-me-too';
    try {
      const root = makeProject({
        'package.json': JSON.stringify({ name: 'authapp' }),
        'void.json': JSON.stringify({ auth: { providers: ['email'] } }),
        'routes/index.ts': `export const GET = () => new Response('ok');`,
        'wrangler.jsonc': JSON.stringify(
          {
            account_id: 'acc123',
            name: 'authapp',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'authapp-db',
                database_id: REAL_D1_ID,
                migrations_dir: './db/migrations',
              },
            ],
          },
          null,
          2,
        ),
        ...INIT_MIGRATION,
      });
      let seen: { mode?: string; envDir?: string; env?: NodeJS.ProcessEnv } | undefined;
      const { deps } = harness({
        resolveBuildConfig: () => ({ mode: 'staging', envDir: 'config' }),
        validateAuthMigrations: (async (
          _root: string,
          _paths: unknown,
          _vc: unknown,
          _migrations: unknown,
          opts: { mode: string; envDir: string | undefined; env: NodeJS.ProcessEnv },
        ) => {
          seen = { mode: opts.mode, envDir: opts.envDir, env: opts.env };
        }) as CloudflareDeployDeps['validateAuthMigrations'],
      });
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
      // Effective mode + envDir from the shared build-config resolver.
      expect(seen?.mode).toBe('staging');
      expect(seen?.envDir).toBe('config');
      // The child env the arbitrary auth code runs under has CF Access scrubbed.
      expect(seen?.env?.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(seen?.env?.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    } finally {
      if (savedId === undefined) {
        delete process.env.CF_ACCESS_CLIENT_ID;
      } else {
        process.env.CF_ACCESS_CLIENT_ID = savedId;
      }
      if (savedSecret === undefined) {
        delete process.env.CF_ACCESS_CLIENT_SECRET;
      } else {
        process.env.CF_ACCESS_CLIENT_SECRET = savedSecret;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Remote D1 migration safety gates (finding 2)
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — remote migration gates', () => {
  it('fails closed before applying when the deploy migration gate throws (drift/journal/destructive)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      assertMigrationsDeployable: () => {
        throw new Error('Schema drift detected between your Drizzle schema and db/migrations/.');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Gate fires BEFORE apply — no d1 call, no build/deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('runs the real gate: a destructive migration without the pragma fails closed', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'db/migrations/0000_init.sql': 'DROP TABLE notes;',
    });
    // No db/schema.ts → the drift check short-circuits (no drizzle-kit spawn); the real
    // destructive-op validation runs and rejects the un-pragma'd DROP.
    const { deps, wranglerArgs, exitCalls } = harness({ assertMigrationsDeployable: undefined });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
  });

  it('fails closed when remote still has pending migrations after apply (declined prompt)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const localTrace: Array<string> = [];
    const { deps, exitCalls } = harness({
      runWrangler: (args) => {
        localTrace.push(`wrangler:${args[0]}:${args[2] ?? ''}`);
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true}' };
        }
        // `apply` exits 0 (a declined no-op); `list` still reports pending.
        if (args[0] === 'd1' && args[2] === 'list') {
          return { ...cleanExit, stdout: 'Migrations to be applied:\n0000_init' };
        }
        return cleanExit;
      },
      runBuild: () => {
        localTrace.push('build');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Reached the list-verify, then failed closed before building/deploying.
    expect(localTrace).toContain('wrangler:d1:list');
    expect(localTrace).not.toContain('build');
  });

  it('fails closed when the pending-verify prints NO recognizable marker (B3, reduced log level)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const localTrace: Array<string> = [];
    const { deps, exitCalls } = harness({
      runWrangler: (args) => {
        localTrace.push(`wrangler:${args[0]}:${args[2] ?? ''}`);
        if (args[0] === 'whoami') {
          return { ...cleanExit, stdout: '{"loggedIn":true}' };
        }
        // Both `apply` and `list` exit 0 with EMPTY stdout — the failure mode when an
        // ambient WRANGLER_LOG suppressed the sentinel. Require the affirmative marker.
        return cleanExit;
      },
      runBuild: () => {
        localTrace.push('build');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Never trusts an absent marker — fails closed before build/deploy.
    expect(localTrace).toContain('wrangler:d1:list');
    expect(localTrace).not.toContain('build');
  });

  it('fails closed (B1) when wrangler would apply a stray seed.sql not in the validated set', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
      // `collectMigrations` skips seed.sql, but wrangler's `*.sql` glob would apply it.
      'db/migrations/seed.sql': `INSERT INTO notes VALUES (1);`,
    });
    // Use the REAL apply-set gate (override the harness stub) so it enumerates the dir.
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      checkMigrationApplySet: checkWranglerMigrationApplySet,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected before any `d1 migrations apply` and before build/deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('build');
  });
});

// ---------------------------------------------------------------------------
// B1: the exact set wrangler will apply must equal the gated source set
// ---------------------------------------------------------------------------

describe('checkWranglerMigrationApplySet', () => {
  function configFor(dir: string, pattern?: string): Record<string, unknown> {
    const entry: Record<string, unknown> = { binding: 'DB', migrations_dir: dir };
    if (pattern) {
      entry.migrations_pattern = pattern;
    }
    return { d1_databases: [entry] };
  }

  it('passes when the configured dir + files equal the gated set', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/0001_more.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [
        { name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' },
        { name: '0001_more.sql', sql: 'CREATE TABLE b (id integer);' },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an extra seed.sql wrangler would apply that the gated set excludes', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/seed.sql': 'INSERT INTO a VALUES (1);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('seed.sql');
    }
  });

  it('rejects when the configured migrations_dir does not exist', async () => {
    const root = makeProject({ 'wrangler.jsonc': '{}' });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./nope'),
      'DB',
      './nope',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('does not exist');
    }
  });

  it('rejects when a file content differs between the config dir and the gated copy', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id text);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('content differs');
    }
  });

  it('A1: rejects when wrangler would apply in a DIFFERENT order (unpadded numeric prefix)', async () => {
    // `2_*.sql` and `10_*.sql` sort DIFFERENTLY for wrangler (numeric: 2 < 10) than for Void's
    // collectMigrations (lexicographic: "10" < "2"). The set is equal but the apply ORDER
    // diverges, so remote D1 would receive them out of the validated order — reject.
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/2_early.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/10_late.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      // collectMigrations' lexicographic order: 10_late before 2_early.
      [
        { name: '10_late.sql', sql: 'CREATE TABLE b (id integer);' },
        { name: '2_early.sql', sql: 'CREATE TABLE a (id integer);' },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('DIFFERENT order');
    }
  });

  it('A1: passes with zero-padded prefixes (numeric order == lexicographic order)', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0002_early.sql': 'CREATE TABLE a (id integer);',
      'db/migrations/0010_late.sql': 'CREATE TABLE b (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations'),
      'DB',
      './db/migrations',
      [
        { name: '0002_early.sql', sql: 'CREATE TABLE a (id integer);' },
        { name: '0010_late.sql', sql: 'CREATE TABLE b (id integer);' },
      ],
    );
    expect(result.ok).toBe(true);
  });

  it('A1: fails closed (defense in depth) if a custom migrations_pattern slips through', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', 'db/migrations/**/*.sql'),
      'DB',
      './db/migrations',
      [{ name: '0000_init.sql', sql: 'CREATE TABLE a (id integer);' }],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('custom migrations_pattern');
    }
  });
});

describe('compareWranglerMigrationPaths (wrangler 4.107 numeric-prefix comparator)', () => {
  it('sorts by leading numeric prefix (2 before 10), matching wrangler', () => {
    const sorted = ['10_b.sql', '2_a.sql', '1_z.sql'].sort(compareWranglerMigrationPaths);
    expect(sorted).toEqual(['1_z.sql', '2_a.sql', '10_b.sql']);
  });

  it('places a non-numeric segment (seed.sql) after all numeric-prefixed ones', () => {
    const sorted = ['seed.sql', '0001_a.sql', '0000_b.sql'].sort(compareWranglerMigrationPaths);
    expect(sorted).toEqual(['0000_b.sql', '0001_a.sql', 'seed.sql']);
  });
});

// ---------------------------------------------------------------------------
// Custom Vite envDir threaded to the secret units (finding 3)
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — effective build mode/envDir', () => {
  it('passes the build-resolved mode + envDir to the secret warn + gate units', async () => {
    const root = d1Project(PROVISIONED_D1);
    const seen: {
      warn?: { mode?: string; envDir?: string };
      gate?: { mode?: string; envDir?: string };
    } = {};
    const { deps } = harness({
      // The real resolver runs `resolveConfig` under the sanitized env; here we assert the
      // orchestrator threads whatever it returns (a staging mode + a custom envDir) to BOTH
      // units — the pair the build itself will observe.
      resolveBuildConfig: () => ({ mode: 'staging', envDir: 'config' }),
      collectPlaintextVarWarnings: (async (
        _root: string,
        opts: { mode?: string; envDir?: string },
      ) => {
        seen.warn = { mode: opts.mode, envDir: opts.envDir };
        return { secretKeys: [], totalVarKeys: 0 };
      }) as CloudflareDeployDeps['collectPlaintextVarWarnings'],
      validateSelfHostProdEnv: (async (_root: string, opts: { mode?: string; envDir?: string }) => {
        seen.gate = { mode: opts.mode, envDir: opts.envDir };
        return { hasSchema: false, remoteSecretNames: null };
      }) as CloudflareDeployDeps['validateSelfHostProdEnv'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // Both units validate against the SAME (mode, envDir) the build ships from.
    expect(seen.warn).toEqual({ mode: 'staging', envDir: 'config' });
    expect(seen.gate).toEqual({ mode: 'staging', envDir: 'config' });
  });

  it('fails closed when the build config cannot be resolved (never validates a wrong env set)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      resolveBuildConfig: () => {
        throw new Error('invalid vite.config.ts');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Resolved before the secret gate + build.
    expect(trace).not.toContain('gate');
    expect(trace).not.toContain('build');
  });

  // F4: the REAL resolver runs the full `resolveConfig` config-hook pipeline. A later plugin
  // that returns a different `envDir` folds into `resolved.envDir`, but the build's `void:env`
  // hook loaded its dotenv from the value IT observed (the root) — a seam-only test can't catch
  // this, so exercise the real resolver end-to-end and prove preflight == build.
  it('F4: reads the void:env HOOK-TIME envDir, not the final resolved.envDir a later plugin sets', async () => {
    const srcIndex = join(import.meta.dirname, '..', '..', 'src', 'index.ts');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'f4app', type: 'module' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'f4app' }, null, 2),
      'vite.config.ts': [
        `import { voidPlugin } from ${JSON.stringify(srcIndex)};`,
        `export default {`,
        `  plugins: [`,
        `    voidPlugin(),`,
        `    { name: 'later-envdir', config() { return { envDir: 'some/other/dir' }; } },`,
        `  ],`,
        `};`,
      ].join('\n'),
    });
    const resolved = await resolveDeployBuildConfig(root, { ...process.env });
    // The later plugin makes resolved.envDir = '<root>/some/other/dir', but void:env loaded
    // from the root — the preflight must use the hook-time value (root → undefined).
    expect(resolved).toEqual({ mode: 'production', envDir: undefined });
  });
});

// ---------------------------------------------------------------------------
// wrangler framework autoconfig / OpenNext delegation disabled (finding 1)
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — wrangler autoconfig disabled', () => {
  it('always passes --autoconfig=false so a framework marker cannot delegate the deploy', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'onext' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      // An OpenNext-style marker: wrangler's autoconfig would otherwise delegate the
      // deploy to another tool. --autoconfig=false makes that impossible.
      'open-next.config.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'onext' }, null, 2),
    });
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    const deployArgs = wranglerArgs.find((a) => a[0] === 'deploy');
    expect(deployArgs).toContain('--autoconfig=false');
  });
});
