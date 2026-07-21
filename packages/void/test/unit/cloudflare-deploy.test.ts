import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { log } from '@clack/prompts';
import { dirname, join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  assertMigrationsProduceAuthSchema,
  assertNoConfigOverrideInProjectDotenv,
  checkWranglerMigrationApplySet,
  compareWranglerMigrationPaths,
  computeDesiredCloudflareResources,
  deployChildEnv,
  runCloudflareDeploy,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  validateAuthMigrationSchema,
  verifyGeneratedDeployConfig,
  type CloudflareDeployDeps,
  type DeployWranglerRun,
  type DeployWranglerRunResult,
  type EmittedWorkerVarsResult,
} from '../../src/cli/deploy.ts';
import {
  resolveEnvSchemaFactsViaSubprocess,
  validateEmittedVarsViaSubprocess,
  type EnvSchemaProbeResult,
  type EnvSchemaProbeSpawnResult,
} from '../../src/cli/env-schema-probe.ts';
import type { SelfHostEnvContext, SelfHostSchemaFacts } from '../../src/cli/env-validation.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';
import { provisionCloudflareResources, type ProvisionResult } from '../../src/cli/provision.ts';
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
/** A second shape-valid D1 id, so a tampered config can point at a DIFFERENT database. */
const OTHER_D1_ID = '11111111-2222-3333-4444-555555555555';
const REAL_KV_ID = '7c07b54c9f2a4d1e8b3f6a0c153aa11a';
/** A second shape-valid KV id, so a two-namespace config can be distinct. */
const OTHER_KV_ID = '3f9a1c2d4e5b6a7c8d9e0f1a2b3c4d5e';

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

/** No-schema (nothing-to-gate) env-insensitive facts. */
const NO_SCHEMA_FACTS: SelfHostSchemaFacts = { hasSchema: false, requiredKeys: [], secretKeys: [] };

/** A default-passing env-schema probe result (no schema → nothing to gate). */
function okSchemaFacts(overrides: Partial<SelfHostSchemaFacts> = {}): EnvSchemaProbeResult {
  return { kind: 'ok', facts: { ...NO_SCHEMA_FACTS, ...overrides } };
}

/** A default emitted-vars read (empty vars — a worker that ships no plaintext vars). */
function emittedVars(vars: Record<string, unknown> = {}): EmittedWorkerVarsResult {
  return { ok: true, vars };
}

/** Absolute src paths for runtime imports inside spawned-child env.ts fixtures. */
const srcEnvPublic = join(import.meta.dirname, '..', '..', 'src', 'runtime', 'env-public.ts');
const srcEnvHelpers = join(import.meta.dirname, '..', '..', 'src', 'runtime', 'env-helpers.ts');

/**
 * Wrangler's FULL credential env-var set, canonical names + deprecated `CF_*` aliases.
 * Mirrors `WRANGLER_AUTH_CREDENTIAL_ENV_VARS` in deploy.ts. Every child that runs untrusted
 * project code (env-schema probes, `vite build`, `drizzle-kit generate`) must see NONE of
 * these; the wrangler runner must still see ALL of them.
 */
const WRANGLER_AUTH_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'WRANGLER_R2_SQL_AUTH_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
];

/** Set every wrangler credential on the parent for the duration of `run`, then restore. */
async function withWranglerCredentials(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of WRANGLER_AUTH_VARS) {
    saved[name] = process.env[name];
    process.env[name] = `secret-${name}`;
  }
  try {
    await run();
  } finally {
    for (const name of WRANGLER_AUTH_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  }
}

/**
 * Write a `.void/better-auth-schema.ts` fixture whose `migrationSchema` literal matches the
 * shape the build emits (`JSON.stringify(resolveVoidAuthMigrationSchema(...), null, 2)`), so
 * the post-build auth check reads ground truth exactly as it would after a real build.
 */
/**
 * A field of the emitted artifact. A bare string is the plain case; the object form carries the
 * `required` / `unique` / `references` metadata the real build emits (see
 * `playground/kitchen-sink/.void/better-auth-schema.ts`, e.g. `user.email` is
 * `{ required: true, unique: true }` and `session.userId` references `user.id`).
 *
 * `required` defaults to true because that is what the real build emits for all but a handful
 * of optional fields (`user.image`, `session.ipAddress`, …).
 */
type AuthSchemaField =
  | string
  | {
      name: string;
      required?: boolean;
      unique?: boolean;
      references?: { table: string; field: string; onDelete?: string };
    };

function writeAuthSchemaArtifact(
  root: string,
  tables: Array<{ name: string; fields: Array<AuthSchemaField> }>,
): void {
  const migrationSchema = {
    dialect: 'sqlite',
    idStrategy: 'text',
    tables: tables.map((t, i) => ({
      name: t.name,
      order: i + 1,
      fields: Object.fromEntries(
        t.fields.map((f) => {
          const field = typeof f === 'string' ? { name: f } : f;
          return [
            field.name,
            {
              type: 'string',
              required: field.required !== false,
              unique: field.unique === true,
              index: false,
              bigint: false,
              ...(field.references ? { references: field.references } : {}),
            },
          ];
        }),
      ),
    })),
  };
  const dir = join(root, '.void');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'better-auth-schema.ts'),
    `// Auto-generated fixture\nexport const migrationSchema = ${JSON.stringify(migrationSchema, null, 2)} as const;\n`,
  );
}

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
    // Stub the isolated env-schema probe so orchestration tests never spawn a child; the
    // env-insensitive facts (required names + `.secret()` flags) are returned inline. Silent
    // (no trace) — it runs pre-build and is not a step these tests order around.
    resolveSchemaFacts: (() => okSchemaFacts()) as CloudflareDeployDeps['resolveSchemaFacts'],
    // Stub the isolated emitted-var validation probe (F3) so orchestration tests never spawn a
    // child; by default nothing is invalid. Only invoked when the schema facts declare a schema.
    // Dedicated tests inject a failing set to exercise the invalid-value fail-closed path.
    validateEmittedVars: (async () => ({
      kind: 'invalid-keys',
      invalidKeys: [],
    })) as CloudflareDeployDeps['validateEmittedVars'],
    // Stub the emitted-vars read so orchestration tests need no real dist/ssr/wrangler.json;
    // dedicated tests inject the REAL vars a build would emit. Silent.
    readEmittedWorkerVars: (() => emittedVars()) as CloudflareDeployDeps['readEmittedWorkerVars'],
    // Parent-side gate discharge (the wrangler `secret list` comparison). Dedicated tests
    // inject a throwing stub or exercise the real derive+discharge units directly.
    dischargeSelfHostEnv: (async () => {
      trace.push('gate');
      return { hasSchema: false, remoteSecretNames: null };
    }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
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

/**
 * A minimal `vite.config.ts` carrying a `void:env` plugin STUB that mirrors how the real
 * plugin (index.ts) captures the RAW (unnormalized) envDir and exposes it via
 * `api.getVoidDeployBuildConfig`. `envDirExpr` is spliced verbatim as the config's `envDir`
 * (e.g. `"'.'"`, `'import.meta.dirname'`), so the real probe exercises the build's own
 * `join(root, rawEnvDir)` guard without pulling the full void pipeline into the child.
 */
function viteConfigWithVoidEnvStub(envDirExpr: string): string {
  return [
    `let captured;`,
    `export default {`,
    `  envDir: ${envDirExpr},`,
    `  plugins: [`,
    `    {`,
    `      name: 'void:env',`,
    `      api: { getVoidDeployBuildConfig: () => captured },`,
    `      config(userConfig, { mode }) {`,
    `        const raw =`,
    `          typeof userConfig.envDir === 'string' && userConfig.envDir.length > 0`,
    `            ? userConfig.envDir`,
    `            : undefined;`,
    `        captured = { mode, envDir: raw };`,
    `      },`,
    `    },`,
    `  ],`,
    `};`,
  ].join('\n');
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

/**
 * The non-id bindings a real Class-A build emits into `dist/ssr/wrangler.json` (see
 * `playground/kitchen-sink/dist/ssr/wrangler.json`): `ai`, `queues`, `durable_objects`,
 * `migrations`, `new_sqlite_classes`, `containers`, `vars`, `assets`, `triggers`, `rules`,
 * `observability`, `main`, `compatibility_date/flags`, plus the ~20 empty arrays wrangler
 * always materializes. The binding-identity check MUST ignore every one of these and inspect
 * ONLY the four id-bearing arrays (`d1_databases`/`kv_namespaces`/`r2_buckets`/`hyperdrive`).
 */
const KITCHEN_SINK_NON_ID_BINDINGS = {
  ai: { binding: 'AI' },
  queues: {
    producers: [{ binding: 'JOBS', queue: 'jobs' }],
    consumers: [{ queue: 'jobs', max_batch_size: 10 }],
  },
  durable_objects: {
    bindings: [
      { name: 'SANDBOX', class_name: 'Sandbox' },
      { name: 'WS', class_name: 'ChatRoom' },
    ],
  },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
  containers: [{ class_name: 'Sandbox', image: './Dockerfile' }],
  vars: { __VOID_AI_GATEWAY: 'my-gateway', PUBLIC_FLAG: 'on' },
  assets: { directory: './dist/client', binding: 'ASSETS' },
  triggers: { crons: ['0 0 * * *'] },
  rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
  observability: { enabled: true },
  main: './dist/ssr/index.js',
  compatibility_date: '2025-01-01',
  compatibility_flags: ['nodejs_compat'],
  services: [],
  vectorize: [],
  workflows: [],
  dispatch_namespaces: [],
  analytics_engine_datasets: [],
  hyperdrive: [],
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
// PostgreSQL checked-in migration guard: this backend applies only remote D1
// (SQLite) migrations — the remote-migrate step is gated on `desired.d1`, which
// a pg app never has. The managed platform DOES apply a pg app's migrations over
// Hyperdrive at deploy, so a pg app WITH checked-in migrations must be rejected
// (else it would ship against an unmigrated database), while a pg app WITHOUT
// migrations (externally-managed schema) is still deployable.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — PostgreSQL checked-in migration guard', () => {
  /** A worker-bearing pg app with a provisioned Hyperdrive config (drift-clean). */
  function pgProject(extraFiles: Record<string, string> = {}): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'pgapp' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(
        {
          account_id: 'acc123',
          name: 'pgapp',
          hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
        },
        null,
        2,
      ),
      ...extraFiles,
    });
  }

  it('rejects a pg app that has checked-in migrations BEFORE any account operation', async () => {
    // The remote-migrate path is gated on `desired.d1`; a pg app desires `hyperdrive` instead, so
    // its db/migrations/*.sql would never run here and the worker would hit an unmigrated database.
    // (Reverting the guard lets this app build + deploy against an unmigrated DB.)
    const root = pgProject({
      'db/migrations/0000_init.sql': 'CREATE TABLE notes (id integer primary key);',
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Rejected pre-account-op: no whoami/provision/build/deploy seam ran.
    expect(wranglerArgs).toEqual([]);
    expect(trace).toEqual([]);
  });

  it('still deploys a pg app WITHOUT checked-in migrations (external schema — no false-reject)', async () => {
    const root = pgProject();
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    // Reached the upload, and no D1 migrate ran (a pg app has no desired.d1).
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(false);
  });

  it('leaves a D1/SQLite app with checked-in migrations on the remote-D1 migrate path', async () => {
    // The guard keys on the postgresql dialect, so a SQLite app with migrations is untouched.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suffixed resource names: the `-kv` / `-isr-cache` suffix carries the whole
// distinction between the two KV namespaces, so the 63-char cap must eat the
// worker name, never the suffix.
// ---------------------------------------------------------------------------

/** A deterministic worker name of `length` chars from the repeating [a-z0-9] alphabet. */
function workerNameOfLength(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join('');
}

/** Cloudflare's rule for these names: lowercase [a-z0-9-], no leading/trailing dash, ≤63. */
const CF_NAME_RULE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A KV + ISR app (both namespaces desired) whose root config pins `workerName`. */
function kvAndIsrProject(workerName: string, wrangler: Record<string, unknown> = {}): string {
  return makeProject({
    'package.json': JSON.stringify({ name: 'longapp' }),
    'void.json': JSON.stringify({}),
    'wrangler.jsonc': JSON.stringify(
      { account_id: 'acc123', name: workerName, ...wrangler },
      null,
      2,
    ),
    'routes/index.ts': `export const GET = (c) => c.env.KV.get('k');`,
    'pages/index.tsx': `export default () => null;`,
    'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
  });
}

describe('computeDesiredCloudflareResources — suffixed names survive the 63-char cap', () => {
  // 61 is already over budget for `-isr-cache`; 62+ used to lose BOTH suffixes, so
  // `KV` and `ISR_CACHE` asked for one title and landed on one namespace.
  for (const length of [61, 62, 63, 70, 100]) {
    it(`keeps KV and ISR_CACHE on distinct titles for a ${length}-char worker name`, async () => {
      const workerName = workerNameOfLength(length);
      const root = kvAndIsrProject(workerName);
      const { desired } = await computeDesiredCloudflareResources(
        root,
        readConfig(root),
        join(root, 'wrangler.jsonc'),
      );
      const titles = new Map(desired.kvNamespaces.map((kv) => [kv.binding, kv.title]));
      // The base is trimmed to whatever the suffix (plus its dash) leaves of the 63.
      expect(titles.get('KV')).toBe(`${workerName.slice(0, 63 - 'kv'.length - 1)}-kv`);
      expect(titles.get('ISR_CACHE')).toBe(
        `${workerName.slice(0, 63 - 'isr-cache'.length - 1)}-isr-cache`,
      );
      expect(titles.get('KV')).not.toBe(titles.get('ISR_CACHE'));
      for (const title of titles.values()) {
        expect(title).toMatch(CF_NAME_RULE);
        expect(title.length).toBe(63);
      }
    });
  }

  it('caps the D1 / R2 / Hyperdrive names too, keeping each suffix intact', async () => {
    const workerName = workerNameOfLength(80);
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'longapp' }),
      'void.json': JSON.stringify({}),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: workerName }, null, 2),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.d1?.name).toBe(`${workerName.slice(0, 63 - 'db'.length - 1)}-db`);
    expect(desired.r2?.bucketName).toBe(
      `${workerName.slice(0, 63 - 'storage'.length - 1)}-storage`,
    );
    for (const name of [desired.d1?.name, desired.r2?.bucketName]) {
      expect(name).toMatch(CF_NAME_RULE);
      expect(name?.length).toBe(63);
    }

    const pgRoot = makeProject({
      'package.json': JSON.stringify({ name: 'longpg' }),
      'void.json': JSON.stringify({ database: 'pg' }),
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: workerName }, null, 2),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
    });
    const pg = await computeDesiredCloudflareResources(
      pgRoot,
      readConfig(pgRoot),
      join(pgRoot, 'wrangler.jsonc'),
    );
    expect(pg.desired.hyperdrive?.name).toBe(
      `${workerName.slice(0, 63 - 'hyperdrive'.length - 1)}-hyperdrive`,
    );
    expect(pg.desired.hyperdrive?.name).toMatch(CF_NAME_RULE);
  });

  it('leaves a normal (short) worker name byte-for-byte as it was', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
      'pages/index.tsx': `export default () => null;`,
      'pages/index.server.ts': `export const revalidate = 60;\nexport const loader = () => ({});`,
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces).toEqual([
      { binding: 'KV', title: 'myapp-kv' },
      { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
    ]);
    expect(desired.d1?.name).toBe('myapp-db');
    expect(desired.r2?.bucketName).toBe('myapp-storage');
  });
});

describe('computeDesiredCloudflareResources — KV bindings may not share a namespace', () => {
  it('fails closed when two KV bindings already point at one namespace id', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: REAL_KV_ID },
      ],
    });
    const error = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    ).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('"KV"');
    expect(error?.message).toContain('"ISR_CACHE"');
    expect(error?.message).toContain(REAL_KV_ID);
    expect(error?.message).toMatch(/share one namespace/);
    expect(error?.message).toMatch(/fresh namespace/);
  });

  it('accepts two KV bindings on distinct namespace ids', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: OTHER_KV_ID },
      ],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces.map((kv) => kv.binding)).toEqual(['KV', 'ISR_CACHE']);
  });

  it('ignores unprovisioned placeholder ids (a synced local-dev config is not a collision)', async () => {
    const root = kvAndIsrProject(workerNameOfLength(70), {
      kv_namespaces: [
        { binding: 'KV', id: 'local' },
        { binding: 'ISR_CACHE', id: 'local' },
      ],
    });
    const { desired } = await computeDesiredCloudflareResources(
      root,
      readConfig(root),
      join(root, 'wrangler.jsonc'),
    );
    expect(desired.kvNamespaces).toHaveLength(2);
  });
});

describe('computeDesiredCloudflareResources — provisioned resources are never re-created', () => {
  it('reuses the ids/names already in the config for a long-named app (no wrangler call)', async () => {
    // The derivation changed for long worker names, so prove the renamed desired set
    // still resolves to the SAME resources through the provisioner's read-first.
    const workerName = workerNameOfLength(70);
    const root = kvAndIsrProject(workerName, {
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'legacy-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
        },
      ],
      kv_namespaces: [
        { binding: 'KV', id: REAL_KV_ID },
        { binding: 'ISR_CACHE', id: OTHER_KV_ID },
      ],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'legacy-bucket' }],
    });
    writeFileSync(
      join(root, 'routes/index.ts'),
      `export const GET = async (c) => {
        await c.env.KV.get('k');
        await c.env.STORAGE.put('a', 'b');
        return c.env.DB.prepare('SELECT 1').first();
      };`,
    );
    const configPath = join(root, 'wrangler.jsonc');
    const { desired } = await computeDesiredCloudflareResources(root, readConfig(root), configPath);
    // Stored names win over the derivation, so nothing points at a new resource.
    expect(desired.d1?.name).toBe('legacy-db');
    expect(desired.r2?.bucketName).toBe('legacy-bucket');

    const calls: Array<Array<string>> = [];
    const result = await provisionCloudflareResources(root, configPath, desired, {
      runWrangler: (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', status: 0 };
      },
      log: { info: () => {}, warn: () => {} },
    });
    // Read-first everywhere: no list, no create — the recorded resources are kept.
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'legacy-db', action: 'reused', id: REAL_D1_ID },
      {
        kind: 'kv',
        binding: 'KV',
        name: `${workerName.slice(0, 60)}-kv`,
        action: 'reused',
        id: REAL_KV_ID,
      },
      {
        kind: 'kv',
        binding: 'ISR_CACHE',
        name: `${workerName.slice(0, 53)}-isr-cache`,
        action: 'reused',
        id: OTHER_KV_ID,
      },
      { kind: 'r2', binding: 'STORAGE', name: 'legacy-bucket', action: 'reused' },
    ]);
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

  it('A1: rejects a PRESENT-but-EMPTY migrations_pattern ("") before any account op', async () => {
    // `migrations_pattern: ""` is present-but-empty. readStoredResourceName collapses it to
    // `undefined` (== absent), so a length-based guard would wave it through as "default" — but
    // wrangler 4.107 takes its non-default branch for ANY value that is not `undefined`, so an
    // empty pattern diverges from the flat `*.sql` set this backend validates. Reject on presence.
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: REAL_D1_ID,
          migrations_dir: './db/migrations',
          migrations_pattern: '',
        },
      ],
    });
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Reached NO whoami / provision / migration / build seam — rejected pre-account.
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
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

  it('proceeds through whoami → build → gate → migrate-gate → remote-migrate → deploy when fully provisioned', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.DB.prepare('SELECT 1').first();`,
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
      'wrangler.jsonc': JSON.stringify(PROVISIONED_D1, null, 2),
    });
    const { deps, trace, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // The BUILD runs BEFORE the secret gate (ground-truth validation reads the real emitted
    // artifact); the LOCAL migration gate runs AFTER the build (against the post-build files),
    // and the REMOTE D1 apply runs after that (a failed gate never mutates D1).
    expect(trace).toEqual([
      'wrangler:whoami',
      'build',
      'gate',
      'migrate-gate',
      'wrangler:d1', // migrations apply (after the gate)
      'wrangler:d1', // migrations list (pending verify)
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
  it('warns about a plaintext secret-looking key in the REAL emitted vars without blocking', async () => {
    const root = d1Project(PROVISIONED_D1);
    // The warning classifies the REAL vars the build baked into dist/ssr/wrangler.json (ground
    // truth). A secret-looking key is non-fatal — the deploy still proceeds.
    const { deps, trace } = harness({
      readEmittedWorkerVars: (() =>
        emittedVars({
          API_TOKEN: 'sk-live-xyz',
          APP_NAME: 'demo',
        })) as CloudflareDeployDeps['readEmittedWorkerVars'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy'); // warning is non-fatal
  });

  it('blocks with exit(1) when the gate discharge throws (missing required secret); never deploys or migrates remote', async () => {
    const { SelfHostEnvValidationError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      dischargeSelfHostEnv: (async () => {
        trace.push('gate');
        throw new SelfHostEnvValidationError('env: missing required secret STRIPE_KEY', {
          valid: false,
          missing: ['STRIPE_KEY'],
          invalid: [],
          values: new Map(),
        });
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The build ran BEFORE the gate (ground truth), but the gate failing blocks the REMOTE D1
    // apply AND the deploy — no account mutation past the build.
    expect(trace).toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
  });

  it('renders the first-deploy structured error and exits', async () => {
    const { SelfHostFirstDeployError } = await import('../../src/cli/env-validation.ts');
    const root = d1Project(PROVISIONED_D1);
    const { deps, exitCalls } = harness({
      dischargeSelfHostEnv: (async () => {
        throw new SelfHostFirstDeployError('worker not deployed yet', ['STRIPE_KEY'], 1);
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
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
    // The migrations_dir gate runs POST-build now (against the live files), so the build ran —
    // but it fails closed before any `d1 migrations apply` and before the deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
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

describe('runCloudflareDeploy — pre-build queue existence probe', () => {
  /** A worker-bearing app desiring exactly one queue (`jobs`), fully config-provisioned. */
  function queueProject(): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'queues/jobs.ts': `export default {};`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
    });
  }

  /**
   * The default harness plus a scripted `queues info` reply, so a test drives the
   * REAL classifier with the exact output wrangler would print. Every other wrangler
   * call keeps the harness behaviour (and its arg/trace recording).
   */
  function queueHarness(
    probe: (name: string) => DeployWranglerRunResult,
    overrides: Partial<CloudflareDeployDeps> = {},
  ): ReturnType<typeof harness> {
    const h = harness(overrides);
    const base = h.deps.runWrangler as DeployWranglerRun;
    h.deps.runWrangler = (args, opts) => {
      const passthrough = base(args, opts);
      return args[0] === 'queues' && args[1] === 'info' ? probe(args[2] as string) : passthrough;
    };
    return h;
  }

  it('probes each desired queue by name before the build', async () => {
    const root = queueProject();
    const { deps, wranglerArgs, trace } = queueHarness((name) => ({
      ...cleanExit,
      stdout: `Queue Name: ${name}\n`,
    }));
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    const probeArgs = wranglerArgs.find((a) => a[0] === 'queues');
    expect(probeArgs).toEqual([
      'queues',
      'info',
      'jobs',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    // The probe runs at step 4 — ahead of the build and everything downstream of it.
    expect(trace.indexOf('wrangler:queues')).toBeLessThan(trace.indexOf('build'));
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed naming the queue when the probe confirms it does not exist', async () => {
    const root = queueProject();
    const { deps, trace, exitCalls } = queueHarness((name) => ({
      ...cleanExit,
      status: 1,
      stderr: `✘ [ERROR] Queue "${name}" does not exist.\n`,
    }));
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (msg: string) => {
      messages.push(msg);
    };
    try {
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      log.error = restore;
    }
    expect(exitCalls).toEqual([1]);
    // Nothing past step 4 ran: no build, no remote D1 apply, no upload.
    expect(trace).toEqual(['wrangler:whoami', 'wrangler:queues']);
    const joined = messages.join('\n');
    expect(joined).toContain('jobs');
    expect(joined).toContain('--provision');
    expect(joined).toContain('wrangler queues create jobs');
  });

  it('proceeds when the probe fails for a reason other than the queue being absent', async () => {
    const root = queueProject();
    // An auth failure is NOT absence — blocking here would be a false positive, and
    // `wrangler deploy` still rejects a genuinely missing queue before uploading.
    const { deps, trace } = queueHarness(() => ({
      ...cleanExit,
      status: 1,
      stderr: '✘ [ERROR] A request to the Cloudflare API failed [code: 10000]\n',
    }));
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('proceeds when a killed probe merely buffered a not-found line', async () => {
    const root = queueProject();
    // A signal-killed child never ran to completion, so its buffered text is not proof.
    const { deps, trace } = queueHarness((name) => ({
      ...cleanExit,
      status: 1,
      signal: 'SIGKILL',
      stderr: `✘ [ERROR] Queue "${name}" does not exist.\n`,
    }));
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    expect(trace).toContain('wrangler:deploy');
  });

  it('never probes when the app desires no queues', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
  });

  it('never probes under --provision (the provisioner creates the queue itself)', async () => {
    const root = queueProject();
    const { deps, wranglerArgs, trace } = queueHarness(() => ({
      ...cleanExit,
      status: 1,
      stderr: '✘ [ERROR] Queue "jobs" does not exist.\n',
    }));
    await runCloudflareDeploy(root, { backend: 'cloudflare', provision: true }, silentCliLog, deps);
    expect(trace).toContain('provision');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(trace).toContain('wrangler:deploy');
  });
});

describe('runCloudflareDeploy — pre-build queue name validation', () => {
  /**
   * A worker-bearing app whose desired queues come from the given `queues/` filenames.
   * Queue names are the filenames verbatim (`queues/scan.ts` strips only the extension),
   * so this fixture is how an adversarial name actually reaches the deploy.
   */
  function queueNameProject(...fileNames: Array<string>): string {
    return makeProject({
      'package.json': JSON.stringify({ name: 'qapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = () => new Response('ok');`,
      'wrangler.jsonc': JSON.stringify({ account_id: 'acc123', name: 'qapp' }, null, 2),
      ...Object.fromEntries(fileNames.map((f) => [`queues/${f}`, `export default {};`])),
    });
  }

  /** Run the deploy capturing `log.error` output, restoring the real logger after. */
  async function runCapturingErrors(
    root: string,
    deps: CloudflareDeployDeps,
  ): Promise<Array<string>> {
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (msg: string) => {
      messages.push(msg);
    };
    try {
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      log.error = restore;
    }
    return messages;
  }

  it('fails closed on a leading-dash name before the build, the D1 apply, or the probe', async () => {
    // `queues/--help.ts` yields the literal name `--help`, which wrangler would parse as a
    // FLAG: `queues info --help` exits 0 printing usage, which the probe reads as
    // inconclusive and waves through. The name gate must stop it before that.
    const root = queueNameProject('--help.ts');
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    const joined = messages.join('\n');
    expect(joined).toContain('--help');
    expect(joined).toContain('queues/');
    expect(joined).toContain('begin and end with a letter or digit');
    // Nothing past the gate ran: no probe, no build, no remote D1 apply, no upload.
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toEqual(['wrangler:whoami']);
  });

  it('rejects a shell-significant name by the grammar', async () => {
    // The runner uses `spawnSync` with `shell: false`, so `$(touch marker)` was never
    // executable — the point is that an invalid name can no longer reach wrangler's argv
    // or the printed `wrangler queues create <name>` guidance at all.
    const root = queueNameProject('$(touch marker).ts');
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    const joined = messages.join('\n');
    expect(joined).toContain('$(touch marker)');
    // The absent-queue branch's `wrangler queues create <name>` guidance is never reached.
    expect(joined).not.toContain('wrangler queues create');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
    expect(trace).toEqual(['wrangler:whoami']);
    // Belt and braces: no subshell ever ran.
    expect(existsSync(join(root, 'marker'))).toBe(false);
  });

  it('reports every invalid queue name together rather than dying on the first', async () => {
    const root = queueNameProject('--help.ts', '$(touch marker).ts', 'jobs.ts');
    const { deps, wranglerArgs, exitCalls } = harness();
    const messages = await runCapturingErrors(root, deps);

    expect(exitCalls).toEqual([1]);
    // ONE batched message naming BOTH offenders — and not the valid sibling.
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message).toContain('  • --help (queue)');
    expect(message).toContain('  • $(touch marker) (queue)');
    expect(message).not.toContain('• jobs');
    expect(wranglerArgs.some((a) => a[0] === 'queues')).toBe(false);
  });

  it('lets a valid queue name through to the probe unchanged', async () => {
    const root = queueNameProject('jobs.ts');
    const { deps, wranglerArgs, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // The gate is transparent to a legal name: the probe still runs, pre-build, for `jobs`.
    expect(wranglerArgs.find((a) => a[0] === 'queues')).toEqual([
      'queues',
      'info',
      'jobs',
      '-c',
      join(root, 'wrangler.jsonc'),
      '--env=',
    ]);
    expect(trace.indexOf('wrangler:queues')).toBeLessThan(trace.indexOf('build'));
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

describe('runCloudflareDeploy — build-config override fences', () => {
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
    // The migrate-target gate runs POST-build now, so the build ran — but it fails closed
    // before any `d1 migrations apply` and before the deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
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

  it('fails when the generated binding identity differs from the pinned snapshot', () => {
    // Same account_id + name, but the generated D1 database_id differs from the identity
    // pinned before the build — a flattened named-env / alternate-config binding set, OR a
    // build that rewrote the id. The snapshot (not a root re-read) is the ground truth.
    const desired = { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identity|flattened|tampered/);
  });

  it('fails when the generated config drops a pinned binding entirely', () => {
    const desired = { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', d1_databases: [] });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it('passes when the generated binding identities match the pinned snapshot', () => {
    const desired = {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
      queues: [],
    };
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired,
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when a non-D1 binding identity (R2 / Hyperdrive) differs from the snapshot', () => {
    // R2 (bucket_name) and Hyperdrive (id) are pinned the same way D1 is — the snapshot +
    // verify logic is uniform across kinds, so both must be caught.
    const r2Desired = {
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      kvNamespaces: [],
      queues: [],
    };
    const r2Snapshot = snapshotBindingIdentities({
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const r2Root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'someone-elses-bucket' }],
    });
    expect(
      verifyGeneratedDeployConfig(r2Root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: r2Desired,
        bindingIdentitySnapshot: r2Snapshot,
      }).ok,
    ).toBe(false);

    const hyperDesired = {
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
      kvNamespaces: [],
      queues: [],
    };
    const hyperSnapshot = snapshotBindingIdentities({
      hyperdrive: [{ binding: 'HYPERDRIVE', id: REAL_KV_ID }],
    });
    const hyperRoot = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      hyperdrive: [{ binding: 'HYPERDRIVE', id: OTHER_KV_ID }],
    });
    expect(
      verifyGeneratedDeployConfig(hyperRoot, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: hyperDesired,
        bindingIdentitySnapshot: hyperSnapshot,
      }).ok,
    ).toBe(false);
  });

  it('passes with the full non-id binding set a real build emits (allow-list is exercised)', () => {
    // The critical no-regression shape: every id-bearing binding matches the snapshot, and the
    // artifact ALSO carries the ai/queues/DO/vars/empty-array bindings a real Class-A build emits.
    // None of those non-id bindings is in the snapshot, yet the check must not reject them.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ...KITCHEN_SINK_NON_ID_BINDINGS,
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: {
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
        queues: ['jobs'],
      },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when the artifact declares an id-bearing binding absent from the snapshot (build ADD)', () => {
    // Only DB was pinned pre-build; the artifact ADDS an EXTRA_KV the snapshot never saw. The
    // per-desired loop only walks {DB}, so completeness is what rejects this.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      kv_namespaces: [{ binding: 'EXTRA_KV', id: OTHER_KV_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_KV/);
  });

  it('fails when a NON-desired binding id in the artifact diverges from the snapshot', () => {
    // A hand-declared, non-desired EXTRA_DB is pinned pre-build; the artifact rewrites its id.
    // The desired loop never inspects EXTRA_DB — completeness catches the divergence.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: REAL_D1_ID },
      ],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTRA_DB/);
  });

  it('passes when a NON-desired binding present in the snapshot is unchanged in the artifact', () => {
    // The legitimate-extra case: a user hand-declared EXTRA_DB, it was pinned pre-build, and the
    // build left it untouched — completeness must NOT false-positive on a legitimate extra.
    const snapshot = snapshotBindingIdentities({
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      d1_databases: [
        { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
      ],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: [] },
      bindingIdentitySnapshot: snapshot,
    });
    expect(result).toEqual({ ok: true });
  });

  // --- Passthrough-denylist completeness (fields Void never emits) + queue ⊆ desired ---

  it('passes the full kitchen-sink shape (empty resource arrays, DO/containers, desired queues)', () => {
    // The critical no-regression: a real Class-A artifact carries empty denylist arrays
    // (services/vectorize/…), durable_objects/containers/migrations, and a queues block whose
    // names Void derived from source. NONE may be rejected by the new assertions.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      ...KITCHEN_SINK_NON_ID_BINDINGS,
      d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { d1: { binding: 'DB', name: 'myapp-db' }, kvNamespaces: [], queues: ['jobs'] },
      bindingIdentitySnapshot: snapshotBindingIdentities({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
      }),
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(KITCHEN_SINK_NON_ID_BINDINGS),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when the build injects a services binding absent from the root snapshot', () => {
    // Root had no `services` pre-build; the artifact adds one binding to another same-account
    // worker — a capability the source never asked for. (Reverting assertion A lets it through.)
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      services: [{ binding: 'EVIL', service: 'someone-elses-worker' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/services/);
    expect(result.reason).toMatch(/injected/);
  });

  it('fails closed when the build injects a secrets_store_secrets or dispatch_namespaces entry', () => {
    for (const field of ['secrets_store_secrets', 'dispatch_namespaces'] as const) {
      const root = deployConfigProject({
        account_id: 'acc123',
        name: 'myapp',
        [field]: [{ binding: 'INJECTED' }],
      });
      const result = verifyGeneratedDeployConfig(root, {
        accountId: 'acc123',
        workerName: 'myapp',
        desired: { kvNamespaces: [], queues: [] },
        passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(new RegExp(field));
    }
  });

  it('passes a user hand-declared services binding present in the root snapshot, unchanged', () => {
    // The legitimate-extra case: a user's own `services` binding was present before the build and
    // the build left it untouched — completeness must NOT false-positive on a legit pass-through.
    const rootConfig = { services: [{ binding: 'MY_SVC', service: 'my-other-worker' }] };
    const root = deployConfigProject({ account_id: 'acc123', name: 'myapp', ...rootConfig });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed when the build injects a queue producer not in desired.queues', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      queues: { producers: [{ binding: 'Q', queue: 'exfil' }], consumers: [] },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/queue/);
    expect(result.reason).toMatch(/exfil/);
  });

  it('passes emitted queues whose producer AND consumer names are all in desired.queues', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      queues: {
        producers: [{ binding: 'JOBS', queue: 'jobs' }],
        consumers: [{ queue: 'jobs', max_batch_size: 10 }],
      },
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: ['jobs'] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('does NOT reject an unknown/future resource field the emitted artifact declares (fail-open)', () => {
    // A field not on the denylist must never false-positive — a future wrangler resource field
    // Void does not know about is simply not asserted.
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      some_future_resource: [{ binding: 'NEW_THING' }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });

  it('does NOT reject durable_objects / containers in the emitted artifact (DO/sandbox out of scope)', () => {
    const root = deployConfigProject({
      account_id: 'acc123',
      name: 'myapp',
      durable_objects: { bindings: [{ name: 'WS', class_name: 'ChatRoom' }] },
      containers: [{ class_name: 'Sandbox', image: './Dockerfile' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
    });
    const result = verifyGeneratedDeployConfig(root, {
      accountId: 'acc123',
      workerName: 'myapp',
      desired: { kvNamespaces: [], queues: [] },
      passthroughIdentitySnapshot: snapshotPassthroughIdentities({}),
    });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Binding-identity pin: the id-bearing binding identities are snapshotted from the
// root config AFTER provision/drift resolves them and BEFORE the (untrusted) build.
// A compromised build dependency can only edit FILES (its credentials are scrubbed),
// so it could rewrite `wrangler.jsonc`'s `d1_databases[DB].database_id` — keeping the
// binding + database_name — to redirect the privileged remote migrate / deploy to a
// DIFFERENT same-account resource. The migrate assert (step 9) and the emitted-config
// check (step 10) both compare against the pre-build snapshot, mirroring the account_id pin.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — id-bearing binding identity pin', () => {
  /** The deploy pointer + emitted top-level config the CF plugin leaves behind after a build. */
  function writeEmittedDeployArtifact(root: string, generated: Record<string, unknown>): void {
    mkdirSync(join(root, '.wrangler', 'deploy'), { recursive: true });
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, '.wrangler', 'deploy', 'config.json'),
      JSON.stringify({ configPath: '../../dist/ssr/wrangler.json' }),
    );
    writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify(generated));
  }

  /** Read → mutate → rewrite the root wrangler.jsonc, standing in for a tampering build plugin. */
  function rewriteRootConfig(
    root: string,
    mutate: (config: Record<string, unknown>) => void,
  ): void {
    const configPath = join(root, 'wrangler.jsonc');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    mutate(config);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  /** The emitted top-level config a non-tampered build of PROVISIONED_D1 would leave. */
  const EMITTED_D1 = {
    account_id: 'acc123',
    name: 'myapp',
    d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
  };

  it('passes a normal deploy where the build leaves the pinned binding ids unchanged', async () => {
    // The critical no-regression case: provision-written id present pre-build, unchanged by the
    // build → the migrate assert AND the emitted-config check both match the snapshot.
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => writeEmittedDeployArtifact(root, EMITTED_D1),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    // The remote migrate ran (identity pin matched) and the deploy proceeded.
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('fails closed BEFORE the remote migrate when the build rewrites the D1 database_id', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        // Keep binding + database_name + migrations_dir; swap ONLY the id — the token still
        // resolves, so wrangler would migrate a DIFFERENT same-account database.
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[0].database_id = OTHER_D1_ID;
        });
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The migrate seam was NOT invoked — no `d1 migrations apply`, no `d1 migrations list` — and
    // nothing deployed. (Reverting the pin lets `d1 migrations apply` run against the wrong DB.)
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build rewrites the D1 id in BOTH the root config and the artifact', async () => {
    // No checked-in migrations → the remote-migrate assert is skipped, so the tamper must be
    // caught at step 10. A CONSISTENT rewrite (root + emitted both carry the new id) would defeat
    // a post-build root re-read; the pre-build snapshot still catches it. (Reverting the pin —
    // which compared the artifact against a post-build root re-read — lets this deploy.)
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[0].database_id = OTHER_D1_ID;
        });
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: OTHER_D1_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build consistently rewrites a KV namespace id', async () => {
    // A non-D1 id-bearing binding (KV) rewritten in BOTH root + artifact — caught at step 10
    // against the snapshot, exactly as D1 is. No migrations → the D1 migrate seam is skipped.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({}),
      'routes/index.ts': `export const GET = (c) => c.env.KV.get('k') ?? c.env.DB.prepare('SELECT 1').first();`,
      'wrangler.jsonc': JSON.stringify(
        {
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
          kv_namespaces: [{ binding: 'KV', id: REAL_KV_ID }],
        },
        null,
        2,
      ),
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        rewriteRootConfig(root, (c) => {
          (c.kv_namespaces as Array<Record<string, unknown>>)[0].id = OTHER_KV_ID;
        });
        writeEmittedDeployArtifact(root, {
          account_id: 'acc123',
          name: 'myapp',
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID }],
          kv_namespaces: [{ binding: 'KV', id: OTHER_KV_ID }],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('still rejects a build that swaps the account_id in the emitted config (account pin intact)', async () => {
    // The account_id defense must survive the refactor: the real verifier still fails closed on a
    // mismatched emitted account_id, before the binding-identity block runs.
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => writeEmittedDeployArtifact(root, { ...EMITTED_D1, account_id: 'other-acc' }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes a normal deploy whose artifact carries the full non-id binding set (ai/queues/DO/…)', async () => {
    // No-regression at the full-flow level: the pinned DB id is unchanged AND the emitted artifact
    // carries every non-id binding a real Class-A build emits. The completeness check must wave the
    // ai/queues/DO/vars/empty-array bindings through and let the deploy proceed. The `queues/jobs.ts`
    // source makes the emitted `jobs` queue a Void-derived binding (desired ⊇ emitted), as a real
    // build's queues always are.
    const root = d1Project(PROVISIONED_D1, {
      ...INIT_MIGRATION,
      'queues/jobs.ts': 'export default {};',
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, { ...KITCHEN_SINK_NON_ID_BINDINGS, ...EMITTED_D1 }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'd1' && a[2] === 'apply')).toBe(true);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('passes when a user-declared EXTRA id-bearing binding is present pre-build and unchanged', async () => {
    // A hand-declared, non-desired EXTRA_KV is in the root config BEFORE the build (so the widened
    // snapshot pins it) and the build leaves it untouched — the deploy must NOT be blocked.
    const root = d1Project({
      ...PROVISIONED_D1,
      kv_namespaces: [{ binding: 'EXTRA_KV', id: REAL_KV_ID }],
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          kv_namespaces: [{ binding: 'EXTRA_KV', id: REAL_KV_ID }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
  });

  it('fails closed at the emitted-config check when the build ADDS an id-bearing binding absent from the snapshot', async () => {
    // The root config (and thus the pre-build snapshot) has ONLY DB. The build injects an EXTRA_KV
    // into the emitted artifact — a same-account data store the deployed worker would gain access
    // to. The per-desired loop only walks {DB}; completeness is what rejects the injected binding.
    // (Reverting the completeness check lets EXTRA_KV through and the deploy runs.)
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          kv_namespaces: [{ binding: 'EXTRA_KV', id: OTHER_KV_ID }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The deploy seam was NOT invoked — the injected binding never reached `wrangler deploy`.
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build rewrites a NON-desired binding id', async () => {
    // A hand-declared, non-desired EXTRA_DB is pinned pre-build (widened snapshot). The build
    // rewrites its id in BOTH the root config and the emitted artifact — a consistent rewrite a
    // post-build root re-read could not catch, and one the per-desired {DB} loop never inspects.
    // Only the pre-build snapshot + completeness catch it. (Reverting the check lets the deploy run.)
    const root = d1Project({
      ...PROVISIONED_D1,
      d1_databases: [
        ...PROVISIONED_D1.d1_databases,
        { binding: 'EXTRA_DB', database_name: 'extra', database_id: REAL_KV_ID },
      ],
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () => {
        rewriteRootConfig(root, (c) => {
          (c.d1_databases as Array<Record<string, unknown>>)[1].database_id = OTHER_D1_ID;
        });
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          d1_databases: [
            { binding: 'DB', database_name: 'myapp-db', database_id: REAL_D1_ID },
            { binding: 'EXTRA_DB', database_name: 'extra', database_id: OTHER_D1_ID },
          ],
        });
      },
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build injects a services binding', async () => {
    // The root config (and pre-build passthrough snapshot) has NO services. The build injects a
    // services binding to another same-account worker into the emitted artifact — a capability the
    // deployed worker would gain that the source never asked for. No checked-in migrations, so the
    // catch happens at step 10. (Reverting assertion A lets EVIL through and the deploy runs.)
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          services: [{ binding: 'EVIL', service: 'someone-elses-worker' }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The deploy seam was NOT invoked — the injected binding never reached `wrangler deploy`.
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('fails closed at the emitted-config check when the build injects a queue not in the desired set', async () => {
    // No queues/ source → desired.queues is empty. The build injects a queue producer into the
    // emitted artifact. (Reverting assertion B lets the injected queue deploy.)
    const root = d1Project(PROVISIONED_D1);
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          queues: { producers: [{ binding: 'Q', queue: 'exfil' }], consumers: [] },
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(false);
  });

  it('passes when a user hand-declared passthrough binding (services) is present pre-build and unchanged', async () => {
    // A hand-declared services binding is in the root config BEFORE the build (so the passthrough
    // snapshot pins it) and the build leaves it untouched — the deploy must NOT be blocked.
    const root = d1Project({
      ...PROVISIONED_D1,
      services: [{ binding: 'MY_SVC', service: 'my-other-worker' }],
    });
    const { deps, wranglerArgs, exitCalls } = harness({
      runBuild: () =>
        writeEmittedDeployArtifact(root, {
          ...EMITTED_D1,
          services: [{ binding: 'MY_SVC', service: 'my-other-worker' }],
        }),
      verifyDeployConfig: verifyGeneratedDeployConfig,
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(exitCalls).toEqual([]);
    expect(wranglerArgs.some((a) => a[0] === 'deploy')).toBe(true);
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

  it('loads the env-schema probe via a dynamic import() (never a static module-scope import)', () => {
    // deploy.ts must only `import type` from the probe at module scope; the runtime helper
    // loads via dynamic import() inside the fork, so a managed deploy never pulls the probe in.
    const staticImports = [
      ...deploySource.matchAll(/^import\s+([^']*?)\s+from\s+'\.\/env-schema-probe\.ts';/gm),
    ];
    for (const [, clause] of staticImports) {
      expect(clause.startsWith('type')).toBe(true);
    }
    expect(deploySource).toMatch(/await import\('\.\/env-schema-probe\.ts'\)/);
  });

  it('the env-schema probe imports env-validation only dynamically and no backend statically', () => {
    // The probe is imported (dynamically) during a self-host deploy, but a plain LIBRARY import of
    // it (the parent-side helper) must not eagerly evaluate env-validation (which pulls Vite / the
    // env stack), and it must never statically pull Vite / provision / Better Auth / proper-lockfile
    // into any bundle.
    const probeSource = readFileSync(
      join(import.meta.dirname, '../../src/cli/env-schema-probe.ts'),
      'utf-8',
    );
    // env-validation is loaded dynamically only — its static import is TYPE-only.
    const staticEnvValidation = new RegExp(
      "^import\\s+(?!type\\b)[^;]*?\\s+from\\s+'\\./env-validation\\.ts';",
      'gm',
    );
    expect(probeSource).not.toMatch(staticEnvValidation);
    expect(probeSource).toContain("await import('./env-validation.ts')");
    // No static backend imports at all (Vite / provision / Better Auth / proper-lockfile).
    expect(probeSource).not.toMatch(/from\s+'vite'/);
    expect(probeSource).not.toMatch(/from\s+'\.\/provision\.ts'/);
    expect(probeSource).not.toMatch(/better-auth/);
    expect(probeSource).not.toMatch(/proper-lockfile/);
  });
});

// ---------------------------------------------------------------------------
// Framework-class guard: only Class-A framework SSR coheres with
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
// Stale deploy pointer: the pointer is deleted before building, so a
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
// Env-only account pin: the CF plugin copies account_id only from the
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
// Migrations dir/intent + auth tables
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
    // Simulate the build's generated auth schema (ground truth) requiring a `user` table, with
    // NO checked-in migration to create it → the REAL post-build auth check fails closed
    // (applying the migrations to in-memory SQLite leaves `user` absent).
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email'] }]);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      validateAuthMigrations: validateAuthMigrationSchema,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The auth check runs POST-build (against ground truth); it blocks the remote migrate + deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
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
  /** A required column with no constraint attached — presence is all that is asserted. */
  const col = (column: string): { column: string; unique: boolean } => ({ column, unique: false });

  const required = [
    { table: 'user', columns: [col('id'), col('email'), col('name')] },
    { table: 'session', columns: [col('id'), col('userId')] },
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

  // -------------------------------------------------------------------------
  // Constraints, not just names. Void ships no auth migration scaffolder, so a
  // hand-written `db/schema.ts` + `void db generate` can produce every correct
  // NAME while omitting Drizzle's opt-in `.unique()` / `.references()`.
  // -------------------------------------------------------------------------

  /** `user.email` unique + `session.userId` → `user.id`, as the real build emits them. */
  const constrained = [
    {
      table: 'user',
      columns: [col('id'), { column: 'email', unique: true }, col('name')],
    },
    {
      table: 'session',
      columns: [
        col('id'),
        { column: 'userId', unique: false, references: { table: 'user', column: 'id' } },
      ],
    },
  ];

  const USER_WITH_UNIQUE_EMAIL =
    'CREATE TABLE "user" (id text primary key, email text UNIQUE, name text);';
  const SESSION_WITH_FK =
    'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id) ON DELETE CASCADE);';

  it('rejects when the migrations create the right names but no UNIQUE constraint on user.email', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/UNIQUE.*email|email/);
  });

  it('names the offending table and column when the UNIQUE constraint is missing', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  it('accepts a column-level UNIQUE (the spelling Drizzle emits inline)', async () => {
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('accepts a separate CREATE UNIQUE INDEX (the spelling the managed path emits)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
            'CREATE UNIQUE INDEX "user_email_unique_idx" ON "user" (email);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('does not require a particular unique index name', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
            'CREATE UNIQUE INDEX "totally_unrelated_name" ON "user" (email);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('does not accept a NON-unique index as satisfying a UNIQUE requirement', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE INDEX "user_email_idx" ON "user" (email);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/UNIQUE constraint on column\(s\): email/);
  });

  it('does not accept a COMPOSITE unique index as making the column unique on its own', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE UNIQUE INDEX "user_email_name_idx" ON "user" (email, name);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/UNIQUE constraint on column\(s\): email/);
  });

  it('rejects when the session foreign key to user is missing', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${USER_WITH_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "session" (id text primary key, userId text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  it('rejects a foreign key that points at the wrong parent table', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${USER_WITH_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "account" (id text primary key);\n' +
              'CREATE TABLE "session" (id text primary key, userId text REFERENCES "account"(id));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/table "session" column "userId" is missing a foreign key/);
  });

  it('accepts an implicit REFERENCES to the parent primary key (no column named)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user");',
        },
      ],
      constrained,
    );
  });

  it('does not assert the onDelete action (ON DELETE SET NULL still satisfies the reference)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id) ON DELETE SET NULL);',
        },
      ],
      constrained,
    );
  });

  it('does not assert column TYPE (SQLite is dynamically typed — a valid schema must not be rejected)', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text primary key, email blob UNIQUE, name numeric);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('does not require a non-unique index the emitted schema marks as index: true', async () => {
    // `session.userId` is `index: true` in the real artifact, but that is a performance
    // property — migrations without the index are still correct.
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('reports every constraint problem at once, naming each table.column', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text primary key, email text, name text);\n' +
              'CREATE TABLE "session" (id text primary key, userId text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/user.*email[\s\S]*session.*userId|session.*userId[\s\S]*user.*email/);
  });

  // -------------------------------------------------------------------------
  // Identifier CASING. SQLite resolves identifiers case-insensitively, but
  // `sqlite_master.name` and every PRAGMA echo back the casing the migration
  // DECLARED. A migration written as `CREATE TABLE "User" ("Email" TEXT UNIQUE)`
  // is fully functional — lowercase SELECTs resolve, the UNIQUE constraint
  // enforces — so the gate must not reject it as missing.
  // -------------------------------------------------------------------------

  const CASED_USER = 'CREATE TABLE "User" ("Id" text primary key, "Email" text, "Name" text);';
  const CASED_USER_UNIQUE_EMAIL =
    'CREATE TABLE "User" ("Id" text primary key, "Email" text UNIQUE, "Name" text);';
  const CASED_SESSION_WITH_FK =
    'CREATE TABLE "Session" ("Id" text primary key, "UserId" text REFERENCES "User"("Id"));';

  it('accepts tables and columns declared in a different case than the emitted schema', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql: `${CASED_USER}\nCREATE TABLE "Session" ("Id" text primary key, "UserId" text);`,
        },
      ],
      required,
    );
  });

  it('accepts a column-level UNIQUE declared on a differently-cased column', async () => {
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${CASED_USER_UNIQUE_EMAIL}\n${CASED_SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('accepts a separate CREATE UNIQUE INDEX over a differently-cased column', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${CASED_USER}\n` +
            'CREATE UNIQUE INDEX "User_Email_Unique" ON "User" ("Email");\n' +
            `${CASED_SESSION_WITH_FK}`,
        },
      ],
      constrained,
    );
  });

  it('accepts a differently-cased single-column PRIMARY KEY as satisfying UNIQUE', async () => {
    // `Email` carries the PRIMARY KEY here — that is what makes it satisfy the `unique`
    // requirement, and it is the point of this test. `Id` is then declared UNIQUE so the
    // session foreign key still has a valid parent key to point at; without that the
    // migration would produce a schema SQLite rejects at runtime, which is a different
    // failure and is covered by its own tests below.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "User" ("Id" text UNIQUE, "Email" text primary key, "Name" text);\n' +
            `${CASED_SESSION_WITH_FK}`,
        },
      ],
      constrained,
    );
  });

  it('still fails closed on a genuinely missing table, naming it as the schema declares it', async () => {
    await expect(
      assertMigrationsProduceAuthSchema([{ name: '0000.sql', sql: CASED_USER }], required),
    ).rejects.toThrow(/table "session" is not created by any checked-in migration/);
  });

  it('still fails closed on a genuinely missing column, naming it as the schema declares it', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: `${CASED_USER}\nCREATE TABLE "Session" ("Id" text primary key);`,
          },
        ],
        required,
      ),
    ).rejects.toThrow(/table "session" is missing column\(s\): userId/);
  });

  it('still fails closed on a missing UNIQUE constraint when only the casing differs', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [{ name: '0000.sql', sql: `${CASED_USER}\n${CASED_SESSION_WITH_FK}` }],
        constrained,
      ),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  it('still fails closed on a missing foreign key when only the casing differs', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${CASED_USER_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "Session" ("Id" text primary key, "UserId" text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  // -------------------------------------------------------------------------
  // PARENT KEY VALIDITY, decided by SQLite itself (`PRAGMA foreign_key_check`)
  // rather than by re-deriving its rules here. A parent key must be a PRIMARY
  // KEY, or a UNIQUE index that MATCHES the reference (collation included); an
  // omitted target column resolves only to the parent's PRIMARY KEY. Anything
  // else yields a foreign key that `CREATE TABLE` accepts, that
  // `PRAGMA foreign_key_list` echoes back as valid, and that fails at PREPARE
  // time under `foreign_keys=ON` — i.e. auth broken in production after a
  // green deploy.
  // -------------------------------------------------------------------------

  /** The parent key is a UNIQUE index, but declared under a DIFFERENT collation. */
  it('fails closed when the parent id is only unique under a differing COLLATE', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text NOT NULL, email text UNIQUE, name text);\n' +
              'CREATE UNIQUE INDEX "user_id_nocase" ON "user" (id COLLATE NOCASE);\n' +
              SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('fails closed when the parent id is an ordinary, non-unique column', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql: 'CREATE TABLE "user" (id text, email text UNIQUE, name text);\n' + SESSION_WITH_FK,
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('fails closed on an implicit REFERENCES to a parent that is UNIQUE but not the PRIMARY KEY', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              'CREATE TABLE "user" (id text NOT NULL UNIQUE, email text UNIQUE, name text);\n' +
              'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user");',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('still fails closed when the child declares no foreign key at all (the pragma alone would pass it)', async () => {
    // `PRAGMA foreign_key_check` validates only foreign keys that EXIST, so a child with
    // none comes back clean. The presence check has to stand on its own.
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${USER_WITH_UNIQUE_EMAIL}\n` +
              'CREATE TABLE "session" (id text primary key, userId text);',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  it('accepts a parent PRIMARY KEY with an explicit reference', async () => {
    await assertMigrationsProduceAuthSchema(
      [{ name: '0000.sql', sql: `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}` }],
      constrained,
    );
  });

  it('accepts a parent that is UNIQUE (not PRIMARY KEY) with an explicit reference', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text NOT NULL UNIQUE, email text UNIQUE, name text);\n' +
            SESSION_WITH_FK,
        },
      ],
      constrained,
    );
  });

  it('accepts an INTEGER PRIMARY KEY rowid alias as the parent key', async () => {
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id integer primary key, email text UNIQUE, name text);\n' +
            'CREATE TABLE "session" (id text primary key, userId integer REFERENCES "user"(id));',
        },
      ],
      constrained,
    );
  });

  // -------------------------------------------------------------------------
  // An auth reference must be its OWN single-column foreign key. SQLite applies
  // MATCH SIMPLE: a COMPOSITE foreign key is skipped ENTIRELY whenever any of
  // its child columns is NULL, so a composite constraint that merely happens to
  // include the required column still lets an orphaned auth row in. `PRAGMA
  // foreign_key_list` returns one row per COLUMN (rows of one constraint share
  // an `id`), so a per-row match would accept it through a single member, and
  // `PRAGMA foreign_key_check` cannot catch it either — it reports orphaned
  // DATA, and the freshly-migrated database holds no rows.
  // -------------------------------------------------------------------------

  const COMPOSITE_PARENT =
    'CREATE TABLE "user" (id text NOT NULL, tenant text, email text UNIQUE, name text, ' +
    'PRIMARY KEY (id, tenant));';

  it('fails closed when the reference is only covered by a multi-column foreign key', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${COMPOSITE_PARENT}\n` +
              'CREATE TABLE "session" (id text primary key, userId text NOT NULL, tenant text, ' +
              'FOREIGN KEY (userId, tenant) REFERENCES "user"(id, tenant));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /table "session" column "userId" references "user"\."id" only as part of a MULTI-COLUMN foreign key/,
    );
  });

  it('explains that a composite foreign key is skipped when a child column is NULL', async () => {
    await expect(
      assertMigrationsProduceAuthSchema(
        [
          {
            name: '0000.sql',
            sql:
              `${COMPOSITE_PARENT}\n` +
              'CREATE TABLE "session" (id text primary key, userId text NOT NULL, tenant text, ' +
              'FOREIGN KEY (userId, tenant) REFERENCES "user"(id, tenant));',
          },
        ],
        constrained,
      ),
    ).rejects.toThrow(
      /skips a composite foreign key entirely when any of its child columns is NULL[\s\S]*needs its own single-column foreign key on "userId"/,
    );
  });

  it('accepts a single-column foreign key on a table that also declares a composite one', async () => {
    // The composite constraint is unrelated to the auth reference; the single-column foreign
    // key on `userId` is what satisfies it, and grouping by constraint id must not lose it.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n` +
            'CREATE TABLE "tenant" (org text NOT NULL, region text NOT NULL, PRIMARY KEY (org, region));\n' +
            'CREATE TABLE "session" (id text primary key, userId text REFERENCES "user"(id), ' +
            'org text, region text, FOREIGN KEY (org, region) REFERENCES "tenant"(org, region));',
        },
      ],
      constrained,
    );
  });

  it('does not fail on an unrelated application table with its own broken foreign key', async () => {
    // The gate is scoped to the auth tables; a user's own schema problem elsewhere is not
    // this check's business and must not block a deploy on the auth path.
    await assertMigrationsProduceAuthSchema(
      [
        {
          name: '0000.sql',
          sql:
            `${USER_WITH_UNIQUE_EMAIL}\n${SESSION_WITH_FK}\n` +
            'CREATE TABLE "widget" (id text primary key, tag text);\n' +
            'CREATE TABLE "widget_tag" (id text primary key, tag text REFERENCES "widget"(tag));',
        },
      ],
      constrained,
    );
  });
});

// ---------------------------------------------------------------------------
// The post-build auth-schema check reads the schema the BUILD generated
// (`.void/better-auth-schema.ts`, ground truth) and asserts the checked-in
// migrations produce it — applied to in-memory SQLite, not a token search.
// ---------------------------------------------------------------------------

describe("validateAuthMigrationSchema — reads the build's generated auth schema", () => {
  // The real build emits every auth column NOT NULL except a handful of optional ones (see
  // `playground/kitchen-sink/.void/better-auth-schema.ts`), and always
  // `.primaryKey().notNull()` for `id` — so these fixtures spell that out.
  const USER =
    'CREATE TABLE "user" (id text primary key not null, email text not null UNIQUE, name text not null);';
  const SESSION_EXPLICIT_FK =
    'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user"(id));';
  const SESSION_IMPLICIT_FK =
    'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user");';

  it('passes when the checked-in migrations produce the emitted schema', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email', 'name'] }]);
    // Applying the migration to in-memory SQLite yields `user(id, email, name)` — the exact
    // emitted schema — so the check resolves (no throw).
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, email text not null, name text not null);',
      },
    ]);
  });

  it('fails closed when a required column is missing from the checked-in migrations', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['email', 'name'] }]);
    await expect(
      // Creates `user` WITHOUT the required `name` column → fails closed against ground truth.
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id text primary key not null, email text not null);',
        },
      ]),
    ).rejects.toThrow(/table "user" is missing column\(s\): name/);
  });

  it('fails closed when the build did not emit the auth-schema artifact', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    // No writeAuthSchemaArtifact — the build produced no schema to read as ground truth.
    await expect(validateAuthMigrationSchema(root, [])).rejects.toThrow(
      /did not emit|better-auth-schema/,
    );
  });

  /** The emitted artifact as the real build writes it: unique email + session → user FK. */
  function writeConstrainedAuthArtifact(root: string): void {
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
      {
        name: 'session',
        fields: [
          { name: 'userId', references: { table: 'user', field: 'id', onDelete: 'cascade' } },
        ],
      },
    ]);
  }

  it('fails closed when the migrations create every name but drop the unique email constraint', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // Every table and column name is correct — only `.unique()` was never applied.
          sql:
            'CREATE TABLE "user" (id text primary key not null, email text not null, name text not null);\n' +
            SESSION_EXPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(/table "user" is missing a UNIQUE constraint on column\(s\): email/);
  });

  // -------------------------------------------------------------------------
  // The implicit `id`. It is absent from the emitted artifact's `fields` (see
  // `playground/kitchen-sink/.void/better-auth-schema.ts` — `user` starts at `name`),
  // so the synthesized descriptor is the only thing representing it. SQLite only
  // accepts a UNIQUELY CONSTRAINED parent key: point a foreign key at an ordinary
  // column and `CREATE TABLE` succeeds, `PRAGMA foreign_key_list` still reports the
  // constraint, and then every statement touching the child fails at prepare time
  // with `foreign key mismatch` under `foreign_keys=ON` — which D1 always enforces.
  // -------------------------------------------------------------------------

  const ID_MUST_BE_UNIQUE = /table "user" column "id" must be the PRIMARY KEY/;

  it('fails closed when an auth table id is an ordinary column (its foreign keys would be dead)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // Every name, the unique email and the session FK are all present — only `user.id`
          // was never marked `.primaryKey()`, which SQLite accepts at DDL time and rejects
          // at runtime.
          sql:
            'CREATE TABLE "user" (id text not null, email text not null UNIQUE, name text not null);\n' +
            SESSION_EXPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it("names SQLite's runtime failure mode so the message is actionable", async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        { name: '0000.sql', sql: 'CREATE TABLE "user" (id text not null, name text not null);' },
      ]),
    ).rejects.toThrow(/foreign key mismatch/);
  });

  it('accepts `id text primary key not null` (the spelling the real build emits)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      { name: '0000.sql', sql: `${USER}\n${SESSION_EXPLICIT_FK}` },
    ]);
  });

  it('accepts a UNIQUE id — SQLite takes any unique parent key, not only a PRIMARY KEY', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, name text not null);\n' +
          SESSION_EXPLICIT_FK,
      },
    ]);
  });

  it('accepts the `integer primary key` rowid alias (which materializes no index_list row)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id integer primary key, name text not null);',
      },
    ]);
  });

  it('does not accept a COMPOSITE unique index as making id a usable parent key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text not null, name text not null);\n' +
            'CREATE UNIQUE INDEX "user_id_name_idx" ON "user" (id, name);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it('does not accept a PARTIAL unique index as making id a usable parent key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql:
            'CREATE TABLE "user" (id text not null, name text not null);\n' +
            'CREATE UNIQUE INDEX "user_id_idx" ON "user" (id) WHERE name IS NOT NULL;',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_UNIQUE);
  });

  it('fails closed when the migrations create every name but drop the session foreign key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: `${USER}\nCREATE TABLE "session" (id text primary key not null, userId text not null);`,
        },
      ]),
    ).rejects.toThrow(
      /table "session" column "userId" is missing a foreign key referencing "user"\."id"/,
    );
  });

  it('passes when the migrations reproduce the emitted constraints', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          `${USER}\n` +
          'CREATE TABLE "session" (id text primary key not null, userId text not null REFERENCES "user"(id) ON DELETE CASCADE);',
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // An omitted foreign-key target column (`REFERENCES "user"`). SQLite resolves it
  // ONLY to the parent's single-column PRIMARY KEY — a merely UNIQUE parent key works
  // for an EXPLICIT `REFERENCES "user"(id)` but not for the shorthand, and a composite
  // PRIMARY KEY cannot serve as the target either. `PRAGMA foreign_key_list` reports
  // `to: null` in every one of those cases with no indication that anything is wrong,
  // so the parent's own `table_info` is the only place the answer lives.
  // -------------------------------------------------------------------------

  const IMPLICIT_FK_NOT_PK = /references "user" without naming a target column/;

  it('fails closed on an implicit REFERENCES when the parent id is UNIQUE but not the PRIMARY KEY', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `user.id` is a perfectly good parent key for an explicit reference, but the
          // shorthand below resolves to a PRIMARY KEY that does not exist.
          sql:
            'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, name text not null);\n' +
            SESSION_IMPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(IMPLICIT_FK_NOT_PK);
  });

  it('accepts an implicit REFERENCES when the parent id IS the primary key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      { name: '0000.sql', sql: `${USER}\n${SESSION_IMPLICIT_FK}` },
    ]);
  });

  it('still accepts an EXPLICIT REFERENCES to a UNIQUE-only parent id', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, name text not null);\n' +
          SESSION_EXPLICIT_FK,
      },
    ]);
  });

  it('fails closed on an implicit REFERENCES to a parent with a COMPOSITE primary key', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeConstrainedAuthArtifact(root);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `id` carries its own UNIQUE constraint, so it passes the identity check — the
          // only problem left is that the shorthand cannot resolve to `PRIMARY KEY (id, name)`.
          sql:
            'CREATE TABLE "user" (id text not null unique, email text not null UNIQUE, ' +
            'name text not null, PRIMARY KEY (id, name));\n' +
            SESSION_IMPLICIT_FK,
        },
      ]),
    ).rejects.toThrow(IMPLICIT_FK_NOT_PK);
  });

  // -------------------------------------------------------------------------
  // NOT NULL. SQLite permits NULL in any PRIMARY KEY column that is not the INTEGER
  // rowid alias — a file-format compatibility quirk — so `id text primary key` alone
  // accepts rows with no identity, and more than one of them, because NULLs never
  // collide under a unique constraint.
  // -------------------------------------------------------------------------

  const ID_MUST_BE_NOT_NULL = /table "user" column "id" must be declared NOT NULL/;

  it('fails closed when the id is a nullable PRIMARY KEY (SQLite accepts NULL identities)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id text primary key, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('accepts `id text primary key not null`', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, name text not null);',
      },
    ]);
  });

  it('accepts `id integer primary key` — the rowid alias can never hold NULL', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // `PRAGMA table_info` reports `notnull = 0` here, but SQLite assigns a rowid on a NULL
    // insert, so the column is effectively NOT NULL — rejecting it would break a common,
    // legitimate schema.
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id integer primary key, name text not null);',
      },
    ]);
  });

  it('accepts `id integer primary key asc` — also a true rowid alias', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // `ASC` on an INTEGER PRIMARY KEY is the plain alias spelled out; SQLite materializes no
    // primary-key index for it and assigns a rowid on a NULL insert.
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id integer primary key asc, name text not null);',
      },
    ]);
  });

  it('fails closed on `id integer primary key desc` — declared INTEGER, but not the rowid alias', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // A SQLite quirk: `DESC` makes this an ORDINARY primary key, so a NULL insert stores NULL
    // and the table accepts rows with no identity. `PRAGMA table_info` reports it exactly like
    // the real alias (`type = INTEGER`, `pk = 1`, `notnull = 0`) — only the `origin = 'pk'`
    // row SQLite materializes in `PRAGMA index_list` tells them apart.
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id integer primary key desc, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('does not extend the rowid-alias exception to `int primary key` (which really does store NULL)', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    // Only an exact `INTEGER` declared type makes a primary key the rowid alias.
    await expect(
      validateAuthMigrationSchema(root, [
        { name: '0000.sql', sql: 'CREATE TABLE "user" (id int primary key, name text not null);' },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('does not extend the rowid-alias exception to `bigint primary key`', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [{ name: 'user', fields: ['name'] }]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          sql: 'CREATE TABLE "user" (id bigint primary key, name text not null);',
        },
      ]),
    ).rejects.toThrow(ID_MUST_BE_NOT_NULL);
  });

  it('still treats `id integer primary key` as the alias when the table carries other unique indexes', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
    ]);
    // The discriminator is the index ORIGIN, not the index COUNT: a column-level UNIQUE adds an
    // `origin = 'u'` row and a `CREATE UNIQUE INDEX` an `origin = 'c'` row, neither of which
    // stops the primary key from being the rowid alias.
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql:
          'CREATE TABLE "user" (id integer primary key, email text not null UNIQUE, name text not null);\n' +
          'CREATE UNIQUE INDEX "user_name_idx" ON "user" (name);',
      },
    ]);
  });

  it('fails closed when a required emitted field is declared nullable', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: [{ name: 'email', unique: true }, 'name'] },
    ]);
    await expect(
      validateAuthMigrationSchema(root, [
        {
          name: '0000.sql',
          // `email` keeps its UNIQUE constraint and its name — only NOT NULL was dropped.
          sql: 'CREATE TABLE "user" (id text primary key not null, email text UNIQUE, name text not null);',
        },
      ]),
    ).rejects.toThrow(
      /table "user" is missing a NOT NULL constraint on column\(s\): email \(the emitted auth schema marks them required\)/,
    );
  });

  it('does not require NOT NULL for a field the emitted schema marks optional', async () => {
    const root = makeProject({ 'package.json': JSON.stringify({ name: 'authapp' }) });
    // `user.image` is `required: false` in the real artifact.
    writeAuthSchemaArtifact(root, [
      { name: 'user', fields: ['name', { name: 'image', required: false }] },
    ]);
    await validateAuthMigrationSchema(root, [
      {
        name: '0000.sql',
        sql: 'CREATE TABLE "user" (id text primary key not null, name text not null, image text);',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Remote D1 migration safety gates
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
    // The gate runs POST-build now (against the live files), so the build ran — but it fires
    // BEFORE the remote apply: no d1 call, no deploy.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
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
    // The remote apply/list runs AFTER the build now; reached the list-verify, then failed
    // closed before DEPLOYING (the build already ran, but the deploy never does).
    expect(localTrace).toContain('wrangler:d1:list');
    expect(localTrace).toContain('build');
    expect(localTrace).not.toContain('wrangler:deploy');
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
    // Never trusts an absent marker — fails closed before DEPLOY (the build already ran).
    expect(localTrace).toContain('wrangler:d1:list');
    expect(localTrace).toContain('build');
    expect(localTrace).not.toContain('wrangler:deploy');
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
    // The apply-set gate runs POST-build now (it enumerates the live dir), so the build ran —
    // but it rejects before any `d1 migrations apply`.
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).toContain('build');
  });
});

// ---------------------------------------------------------------------------
// B1: the exact set wrangler will apply must equal the gated source set
// ---------------------------------------------------------------------------

describe('checkWranglerMigrationApplySet', () => {
  function configFor(dir: string, pattern?: string): Record<string, unknown> {
    const entry: Record<string, unknown> = { binding: 'DB', migrations_dir: dir };
    // `!== undefined` (not truthiness) so an explicit EMPTY pattern (`""`) is set —
    // a present-but-empty pattern is still custom and must be rejected.
    if (pattern !== undefined) {
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

  it('A1: fails closed (defense in depth) on a PRESENT-but-EMPTY migrations_pattern ("")', async () => {
    const root = makeProject({
      'wrangler.jsonc': '{}',
      'db/migrations/0000_init.sql': 'CREATE TABLE a (id integer);',
    });
    const result = await checkWranglerMigrationApplySet(
      join(root, 'wrangler.jsonc'),
      configFor('./db/migrations', ''),
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
// Post-build ground-truth secret gate: the parent builds the values-free context
// from the REAL emitted `vars` + the env-insensitive required names, then
// discharges it. A required secret shipped EMPTY fails closed post-build; a
// pre-build schema-probe failure fails closed before any account op.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — post-build ground-truth secret gate', () => {
  it('discharges a context DERIVED from the REAL emitted vars + env-insensitive required names', async () => {
    const root = d1Project(PROVISIONED_D1);
    let captured: SelfHostEnvContext | undefined;
    const { deps, trace } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['STRIPE_KEY'],
          secretKeys: ['STRIPE_KEY'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({ APP_NAME: 'demo' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      dischargeSelfHostEnv: (async (ctx: SelfHostEnvContext) => {
        trace.push('gate');
        captured = ctx;
        return { hasSchema: true, remoteSecretNames: ['STRIPE_KEY'] };
      }) as CloudflareDeployDeps['dischargeSelfHostEnv'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // STRIPE_KEY is absent from the emitted vars → the gate sees it as absentRequired (the
    // remote secret discharges it); nothing is present-empty/invalid.
    expect(captured).toEqual({
      hasSchema: true,
      presentEmptyRequired: [],
      presentEmptySources: {},
      absentRequired: ['STRIPE_KEY'],
      invalidKeys: [],
    });
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed when a required secret is shipped EMPTY in the REAL vars (shadows the remote secret)', async () => {
    const root = d1Project(PROVISIONED_D1);
    // Use the REAL discharge (dischargeSelfHostEnv undefined) so the present-empty fence runs.
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['STRIPE_KEY'],
          secretKeys: ['STRIPE_KEY'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({ STRIPE_KEY: '' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      dischargeSelfHostEnv: undefined,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The gate runs POST-build (ground truth), so the build already ran; a shipped-empty
    // required secret fails closed BEFORE any wrangler secret list and before deploy.
    expect(trace).toContain('build');
    expect(trace).not.toContain('wrangler:deploy');
    expect(wranglerArgs.some((a) => a[0] === 'secret')).toBe(false);
  });

  it('fails closed when a required secret is shipped NULL in the REAL vars (shadows like empty)', async () => {
    const root = d1Project(PROVISIONED_D1);
    // A parsed wrangler.json var can be `null`; the schema validators bucket null as "missing"
    // (not "invalid"), so without the empty-shadow fence it would slip past every gate while
    // still shadowing the remote secret. Use the REAL discharge so the fence runs.
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['STRIPE_KEY'],
          secretKeys: ['STRIPE_KEY'],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({ STRIPE_KEY: null })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      dischargeSelfHostEnv: undefined,
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'secret')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('fails closed when the build emits a MALFORMED vars field (array/scalar)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      // A present-but-non-object `vars` must fail closed, never normalize to an empty map.
      readEmittedWorkerVars: (() => ({
        ok: false,
        reason: 'the generated wrangler config has a malformed "vars" field (expected an object).',
      })) as CloudflareDeployDeps['readEmittedWorkerVars'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('fails closed pre-build when the env-schema probe throws (never validates a wrong schema)', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      resolveSchemaFacts: (() => {
        throw new Error('cannot import env.ts');
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Derived pre-build — before whoami / provision / build.
    expect(trace).toEqual([]);
  });

  it('fails closed (values-free) pre-build when the probe reports a schema-load failure', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = harness({
      resolveSchemaFacts: (() => ({
        kind: 'schema-error',
        reason: 'schema-load-failed',
      })) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// envDir / mode narrowing — a custom Vite envDir (the build reads `.env*` from a
// non-root dir but generates the auth schema from root) or a non-production build
// mode is unsupported in v1, REJECTED pre-account by the facts probe.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — envDir / mode narrowing (rejected pre-account)', () => {
  it('rejects a custom Vite envDir pre-account — no whoami / provision / build (REAL probe)', async () => {
    const savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-transform-types']
      .filter(Boolean)
      .join(' ');
    try {
      // A REAL vite.config sets a custom envDir; the facts probe resolves the config in the
      // isolated subprocess, reads the effective envDir, and rejects before any account op.
      const root = d1Project(PROVISIONED_D1, {
        'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
        'vite.config.ts': `export default { envDir: './cfg' };`,
        'cfg/.gitkeep': '',
      });
      const { deps, trace, wranglerArgs, exitCalls } = harness({ resolveSchemaFacts: undefined });
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      // Pre-account: nothing ran — no whoami, no provision, no build, no deploy.
      expect(trace).toEqual([]);
      expect(wranglerArgs).toEqual([]);
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    }
  });

  it('rejects an ABSOLUTE envDir equal to the project root pre-account — the build mis-loads it (REAL probe)', async () => {
    const savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-transform-types']
      .filter(Boolean)
      .join(' ');
    try {
      // Vite normalizes `envDir` via `path.resolve(root, envDir)`, so an ABSOLUTE envDir equal
      // to the root collapses to `resolved.root` and Vite's own view would ACCEPT. But the build
      // loads worker vars with `join(root, rawEnvDir)`, which DUPLICATES an absolute path
      // (`/proj/proj`) → the build reads vars from the wrong dir. The probe now reads the RAW
      // envDir the `void:env` hook captured and rejects via the build's own computation, before
      // any account op. `import.meta.dirname` in the config === the project root (absolute).
      const root = d1Project(PROVISIONED_D1, {
        'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
        'vite.config.ts': viteConfigWithVoidEnvStub('import.meta.dirname'),
      });
      const { deps, trace, wranglerArgs, exitCalls } = harness({ resolveSchemaFacts: undefined });
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
      expect(exitCalls).toEqual([1]);
      // Pre-account: nothing ran — no whoami, no provision, no build, no deploy.
      expect(trace).toEqual([]);
      expect(wranglerArgs).toEqual([]);
    } finally {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    }
  });

  it('rejects a non-production build mode pre-account — no whoami / provision / build', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, wranglerArgs, exitCalls } = harness({
      // The probe resolves mode from the config; a non-production mode selects a different
      // `.env.<mode>` set than this backend validates → reject before any account op. Only the
      // fixed reason code crosses the boundary (no raw mode/envDir string).
      resolveSchemaFacts: (() => ({
        kind: 'reject',
        reason: 'non-production-mode',
      })) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NODE_ENV pin — the facts probe evaluates env.ts under the build's environment
// (NODE_ENV=production), so a required set conditioned on NODE_ENV matches the
// built worker's, and the parent passes that pinned env to the probe.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — schema probe runs under the build NODE_ENV', () => {
  it('passes NODE_ENV=production to the probe env', async () => {
    const root = d1Project(PROVISIONED_D1);
    let capturedNodeEnv: string | undefined = 'UNSET';
    const { deps } = harness({
      resolveSchemaFacts: ((_input, env) => {
        capturedNodeEnv = env.NODE_ENV;
        return okSchemaFacts();
      }) as CloudflareDeployDeps['resolveSchemaFacts'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    // The build sets NODE_ENV=production; the probe env is pinned to match so a schema
    // conditioned on NODE_ENV derives the SAME required set the build would.
    expect(capturedNodeEnv).toBe('production');
  });

  it('pins NODE_ENV=production for the BUILD too (vite only defaults it when unset)', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    // An ambient NODE_ENV=development would otherwise make `vite build` evaluate a development
    // schema while the probe (pinned production) derives a production one.
    process.env.NODE_ENV = 'development';
    let buildNodeEnv: string | undefined = 'UNSET';
    try {
      const root = d1Project(PROVISIONED_D1);
      const { deps } = harness({
        runBuild: (env) => {
          buildNodeEnv = env.NODE_ENV;
        },
      });
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
      expect(buildNodeEnv).toBe('production');
    } finally {
      if (savedNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = savedNodeEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// `vite build` runs UNTRUSTED project code (the user's config, every plugin, env.ts)
// and authenticates against nothing, so it gets the same credential scrub as the
// isolated probes. The wrangler runner must keep them — whoami / d1 migrations apply
// / deploy are the calls that actually need an account credential.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — wrangler credentials reach only the wrangler runner', () => {
  it('the BUILD child env carries none of the wrangler auth credentials', async () => {
    let buildEnvSeen: NodeJS.ProcessEnv = {};
    await withWranglerCredentials(async () => {
      const root = d1Project(PROVISIONED_D1);
      const { deps } = harness({
        runBuild: (env) => {
          buildEnvSeen = { ...env };
        },
      });
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    });
    for (const name of WRANGLER_AUTH_VARS) {
      expect(buildEnvSeen[name]).toBeUndefined();
    }
  });

  it('the wrangler runner env DOES still carry them (whoami / migrate / deploy need them)', async () => {
    await withWranglerCredentials(async () => {
      // Run a deploy first so the fork's memoized provision module is loaded — the sync
      // `deployChildEnv` reads it, exactly as `createDeployWranglerRunner` does.
      const root = d1Project(PROVISIONED_D1);
      const { deps } = harness();
      await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);

      const runnerEnv = deployChildEnv('acc123', 'https://api.cloudflare.com/client/v4');
      for (const name of WRANGLER_AUTH_VARS) {
        expect(runnerEnv[name]).toBe(`secret-${name}`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Emitted-value validation (invalid required value) — a required var shipped with
// a MALFORMED value fails the deploy closed BEFORE any remote mutation, not only at
// worker boot.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — invalid emitted value fails closed pre-remote', () => {
  const invalidPortHarness = (overrides: Partial<CloudflareDeployDeps> = {}) =>
    harness({
      resolveSchemaFacts: (() =>
        okSchemaFacts({
          hasSchema: true,
          requiredKeys: ['PORT'],
          secretKeys: [],
        })) as CloudflareDeployDeps['resolveSchemaFacts'],
      readEmittedWorkerVars: (() =>
        emittedVars({ PORT: 'not-a-number' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      // Use the REAL discharge so the invalidKeys folded in by the probe actually fail closed.
      dischargeSelfHostEnv: undefined,
      ...overrides,
    });

  it('fails closed (no remote apply / deploy) when a required emitted value is schema-invalid', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = invalidPortHarness({
      // The probe reports PORT invalid — it ships a present, non-empty, malformed value.
      validateEmittedVars: (async () => ({
        kind: 'invalid-keys',
        invalidKeys: ['PORT'],
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Caught POST-build (ground truth) but BEFORE any remote D1 apply, secret list, or deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(wranglerArgs.some((a) => a[0] === 'secret')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('proceeds when the required emitted value is schema-valid', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace } = invalidPortHarness({
      readEmittedWorkerVars: (() =>
        emittedVars({ PORT: '8080' })) as CloudflareDeployDeps['readEmittedWorkerVars'],
      // No key is invalid; PORT is present & non-empty so the gate makes no wrangler call.
      validateEmittedVars: (async () => ({
        kind: 'invalid-keys',
        invalidKeys: [],
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('wrangler:deploy');
  });

  it('fails closed when the emitted-value validation probe reports a schema error', async () => {
    const root = d1Project(PROVISIONED_D1);
    const { deps, trace, exitCalls } = invalidPortHarness({
      validateEmittedVars: (async () => ({
        kind: 'schema-error',
        reason: 'schema-validation-error',
      })) as CloudflareDeployDeps['validateEmittedVars'],
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).not.toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// Post-build migration re-check — the local migration gates run AFTER the build,
// against the LIVE post-build files, so a build that adds/rewrites migration SQL
// can never reach remote D1 ungated.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — migration gates re-checked post-build', () => {
  it('catches a migration the build REWRITES to be destructive (fails closed before remote apply)', async () => {
    const root = d1Project(PROVISIONED_D1, {
      // Pre-build the migration is a clean, non-destructive CREATE TABLE — it would pass a
      // pre-build gate. No db/schema.ts, so the drift check short-circuits (no drizzle-kit).
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
    });
    // Use the REAL migration gate (not the harness stub) so the post-build destructive check runs.
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      assertMigrationsDeployable: undefined,
      runBuild: () => {
        trace.push('build');
        // A build plugin rewrites the migration to a destructive, un-pragma'd DROP AFTER the
        // pre-build point — exactly the window the post-build re-check closes.
        writeFileSync(join(root, 'db/migrations/0000_init.sql'), 'DROP TABLE notes;');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // The build ran, but the post-build gate rejected the destructive migration before the
    // remote D1 apply and before the deploy.
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('catches a stray .sql the build ADDS to migrations_dir (apply-set mismatch, fails closed)', async () => {
    const root = d1Project(PROVISIONED_D1, {
      'db/migrations/0000_init.sql': `CREATE TABLE notes (id integer primary key);`,
    });
    // Use the REAL apply-set gate so it enumerates the LIVE dir after the build.
    const { deps, wranglerArgs, trace, exitCalls } = harness({
      checkMigrationApplySet: checkWranglerMigrationApplySet,
      runBuild: () => {
        trace.push('build');
        // The build adds a stray seed.sql: collectMigrations skips it but wrangler's *.sql glob
        // would apply it — the post-build apply-set check catches the extra file.
        writeFileSync(join(root, 'db/migrations/seed.sql'), 'INSERT INTO notes VALUES (1);');
      },
    });
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toContain('build');
    expect(wranglerArgs.some((a) => a[0] === 'd1')).toBe(false);
    expect(trace).not.toContain('wrangler:deploy');
  });

  it('applies the post-build migrations in the normal case (build leaves them untouched)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    // REAL migration gate; the untouched migration passes post-build and is applied.
    const { deps, wranglerArgs, trace } = harness({ assertMigrationsDeployable: undefined });
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
    const d1Calls = wranglerArgs.filter((a) => a[0] === 'd1');
    expect(d1Calls[0]?.slice(0, 3)).toEqual(['d1', 'migrations', 'apply']);
    expect(trace).toContain('wrangler:deploy');
  });
});

// ---------------------------------------------------------------------------
// The REAL env-schema probe subprocess. The parent runs NO project code —
// importing the user's env.ts happens in the child, whose framed result is
// written to a DEDICATED fd (fd 3) so noisy stdout can't truncate it, and the
// child sees ONLY the passed (scrubbed) env — never the parent's credentials.
// ---------------------------------------------------------------------------

describe('env-schema probe (real subprocess)', () => {
  // The probe spawns a plain `node` on THIS repo's SOURCE `.ts`. `env-public.ts` (imported at
  // runtime to read the registered schema) uses a TS parameter property, which Node's default
  // strip-only mode rejects — so enable full type transform for the child, mirroring how
  // production runs the compiled `dist`. `provisionEnv`/`deployChildEnv` never scrub NODE_OPTIONS.
  const withTransform = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...base,
    NODE_OPTIONS: [base.NODE_OPTIONS, '--experimental-transform-types'].filter(Boolean).join(' '),
  });

  it('derives required + `.secret()` facts and the fd-3 result survives noisy stdout', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // A huge stdout write proves the fd-3 result channel is not truncated by env.ts noise.
        `console.log('x'.repeat(200000));`,
        `export default defineEnv({ STRIPE_KEY: string().secret(), API_URL: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts.hasSchema).toBe(true);
      expect(r.facts.requiredKeys).toContain('STRIPE_KEY');
      expect(r.facts.requiredKeys).toContain('API_URL');
      expect(r.facts.secretKeys).toEqual(['STRIPE_KEY']);
    }
  });

  it('runs env.ts under the PASSED env — a scrubbed env hides CF Access from project code', async () => {
    const leakFile = join(tmpDir, 'env-leak.json');
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
        `  token: process.env.CLOUDFLARE_API_TOKEN ?? null,`,
        `  id: process.env.CF_ACCESS_CLIENT_ID ?? null,`,
        `}));`,
        `export default defineEnv({ FOO: string() });`,
      ].join('\n'),
    });
    const env = withTransform({ ...process.env });
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CF_ACCESS_CLIENT_ID;
    await resolveEnvSchemaFactsViaSubprocess({ root }, env);
    const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as {
      token: string | null;
      id: string | null;
    };
    // The child only ever sees the PASSED env — the scrubbed keys read as null.
    expect(leaked.token).toBeNull();
    expect(leaked.id).toBeNull();
  });

  it('the orchestrator scrubs CLOUDFLARE_API_TOKEN + CF Access before spawning the probe', async () => {
    const savedToken = process.env.CLOUDFLARE_API_TOKEN;
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    const savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.CLOUDFLARE_API_TOKEN = 'super-secret-token';
    process.env.CF_ACCESS_CLIENT_ID = 'super-secret-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'super-secret-secret';
    // The orchestrator copies process.env (unscrubbed NODE_OPTIONS) into the probe child env, so
    // enable full type transform for the plain-node child running SOURCE .ts (see withTransform).
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-transform-types']
      .filter(Boolean)
      .join(' ');
    const leakFile = join(tmpDir, 'orchestrator-leak.json');
    try {
      // The env.ts LEAKS the three parent creds to a file; the orchestrator spawns the REAL
      // probe (resolveSchemaFacts undefined → default subprocess seam) under a scrubbed env.
      const root = d1Project(PROVISIONED_D1, {
        'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
        'env.ts': [
          `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
          `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
          `import { writeFileSync } from 'node:fs';`,
          `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
          `  token: process.env.CLOUDFLARE_API_TOKEN ?? null,`,
          `  id: process.env.CF_ACCESS_CLIENT_ID ?? null,`,
          `  secret: process.env.CF_ACCESS_CLIENT_SECRET ?? null,`,
          `}));`,
          `export default defineEnv({ FOO: string() });`,
        ].join('\n'),
      });
      await runCloudflareDeploy(
        root,
        { backend: 'cloudflare' },
        silentCliLog,
        harness({ resolveSchemaFacts: undefined }).deps,
      );
      const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as {
        token: string | null;
        id: string | null;
        secret: string | null;
      };
      // The child (project env.ts) ran under the scrubbed env — none of the parent's creds.
      expect(leaked.token).toBeNull();
      expect(leaked.id).toBeNull();
      expect(leaked.secret).toBeNull();
    } finally {
      if (savedToken === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = savedToken;
      }
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
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    }
  });

  it('a broken env.ts fails closed with a VALUES-FREE classification — no raw child output echoed', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': `throw new Error('SUPER_SECRET_LEAK_9999');\nexport default {};`,
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('schema-error');
    // The values-free boundary drops the original message, so the leak never reaches the result.
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET_LEAK_9999');
  });

  it('parses ONLY the dedicated fd-3 result channel (injected spawn)', async () => {
    const facts = { hasSchema: true, requiredKeys: ['X'], secretKeys: [] };
    const okSpawn = (): EnvSchemaProbeSpawnResult => ({
      status: 0,
      fd3: JSON.stringify({ kind: 'ok', facts }),
      error: null,
      signal: null,
    });
    const r = await resolveEnvSchemaFactsViaSubprocess(
      { root: tmpDir },
      { ...process.env },
      okSpawn,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts).toEqual(facts);
    }
    // A nonzero child exit fails closed (values-free) — the parent never trusts a partial result.
    const failSpawn = (): EnvSchemaProbeSpawnResult => ({
      status: 1,
      fd3: '',
      error: null,
      signal: null,
    });
    await expect(
      resolveEnvSchemaFactsViaSubprocess({ root: tmpDir }, { ...process.env }, failSpawn),
    ).rejects.toThrow(/exited with code/);
  });

  it('rejects a custom Vite envDir (resolves the config in the child, reads the effective envDir)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'vite.config.ts': `export default { envDir: './cfg' };`,
      'cfg/.gitkeep': '',
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      // Only the fixed reason code crosses the boundary — never the raw resolved envDir string.
      expect(r.reason).toBe('custom-envdir');
      expect(JSON.stringify(r)).not.toContain('cfg');
    }
  });

  it('rejects an ABSOLUTE envDir equal to the root (build`s join(root, rawEnvDir) duplicates it)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      // `import.meta.dirname` in the config === the project root (absolute). Vite normalizes it
      // back to `resolved.root` (would ACCEPT), but the build's `join(root, <absolute root>)`
      // duplicates the path — the probe reads the RAW envDir and rejects via that computation.
      'vite.config.ts': viteConfigWithVoidEnvStub('import.meta.dirname'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.reason).toBe('custom-envdir');
      // Only the fixed reason code crosses the boundary — never the raw (absolute) envDir string.
      expect(JSON.stringify(r)).not.toContain(root);
    }
  });

  it('accepts envDir: "." (the root-relative dot resolves to the project root)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ API_URL: string() });`,
      ].join('\n'),
      // `join(root, '.') === root` and `resolve(root, '.') === root` — both views accept.
      'vite.config.ts': viteConfigWithVoidEnvStub(`'.'`),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('ok');
  });

  it('accepts the default (root) envDir + production mode', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ API_URL: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('ok');
  });

  it('derives the required set under the PASSED NODE_ENV (matches the production build)', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // PROD_SECRET is required only when NODE_ENV === 'production' — exactly the vector the
        // pinned probe env closes.
        `const prod = process.env.NODE_ENV === 'production' ? { PROD_SECRET: string() } : {};`,
        `export default defineEnv({ API_URL: string(), ...prod });`,
      ].join('\n'),
    });
    const under = async (nodeEnv: string): Promise<Array<string>> => {
      const env = withTransform({ ...process.env, NODE_ENV: nodeEnv });
      const r = await resolveEnvSchemaFactsViaSubprocess({ root }, env);
      return r.kind === 'ok' ? [...r.facts.requiredKeys].sort() : [`<${r.kind}>`];
    };
    // Under production (the pinned build env), PROD_SECRET is required — matching the worker.
    expect(await under('production')).toEqual(['API_URL', 'PROD_SECRET']);
    // Under a non-production env it would NOT be — proving the pin is what makes them agree.
    expect(await under('development')).toEqual(['API_URL']);
  });

  it('validate-emitted: reports the schema-INVALID emitted values by key name only', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { number, string } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ PORT: number(), API_URL: string() });`,
      ].join('\n'),
      // The build's emitted worker vars: PORT is present but malformed, API_URL is fine.
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify({
        vars: { PORT: 'not-a-number', API_URL: 'https://example.com' },
      }),
    });
    const r = await validateEmittedVarsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('invalid-keys');
    if (r.kind === 'invalid-keys') {
      expect(r.invalidKeys).toEqual(['PORT']);
    }
  });

  it('validate-emitted: no invalid keys when every emitted value validates', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { number } from ${JSON.stringify(srcEnvHelpers)};`,
        `export default defineEnv({ PORT: number() });`,
      ].join('\n'),
      '.wrangler/deploy/config.json': JSON.stringify({
        configPath: '../../dist/ssr/wrangler.json',
      }),
      'dist/ssr/wrangler.json': JSON.stringify({ vars: { PORT: '8080' } }),
    });
    const r = await validateEmittedVarsViaSubprocess({ root }, withTransform({ ...process.env }));
    expect(r.kind).toBe('invalid-keys');
    if (r.kind === 'invalid-keys') {
      expect(r.invalidKeys).toEqual([]);
    }
  });

  it('the child env carries NONE of the full wrangler-auth credential set (all aliases scrubbed)', async () => {
    const savedNodeOptions = process.env.NODE_OPTIONS;
    // The FULL wrangler-auth credential set + aliases set on the parent; a d1 app whose
    // env.ts leaks them.
    const authVars = WRANGLER_AUTH_VARS;
    const saved: Record<string, string | undefined> = {};
    for (const name of authVars) {
      saved[name] = process.env[name];
      process.env[name] = `secret-${name}`;
    }
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-transform-types']
      .filter(Boolean)
      .join(' ');
    const leakFile = join(tmpDir, 'auth-scrub-leak.json');
    try {
      const root = d1Project(PROVISIONED_D1, {
        'package.json': JSON.stringify({ name: 'myapp', type: 'module' }),
        'env.ts': [
          `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
          `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
          `import { writeFileSync } from 'node:fs';`,
          `writeFileSync(${JSON.stringify(leakFile)}, JSON.stringify({`,
          ...authVars.map((name) => `  ${name}: process.env[${JSON.stringify(name)}] ?? null,`),
          `}));`,
          `export default defineEnv({ FOO: string() });`,
        ].join('\n'),
      });
      await runCloudflareDeploy(
        root,
        { backend: 'cloudflare' },
        silentCliLog,
        harness({ resolveSchemaFacts: undefined }).deps,
      );
      const leaked = JSON.parse(readFileSync(leakFile, 'utf-8')) as Record<string, string | null>;
      // The probe needs no credentials — the child sees none of them, canonical OR alias.
      for (const name of authVars) {
        expect(leaked[name]).toBeNull();
      }
    } finally {
      for (const name of authVars) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    }
  });

  it('a child that prints secrets to stdout AND stderr cannot leak them — the fd-3 result still parses', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'envapp', type: 'module' }),
      'env.ts': [
        `import { defineEnv } from ${JSON.stringify(srcEnvPublic)};`,
        `import { string } from ${JSON.stringify(srcEnvHelpers)};`,
        // Both channels are IGNORED by the parent (stdio fds 1+2), so this noise reaches nothing.
        `console.log('STDOUT_SECRET_7777');`,
        `console.error('STDERR_SECRET_8888');`,
        `export default defineEnv({ API_URL: string() });`,
      ].join('\n'),
    });
    const r = await resolveEnvSchemaFactsViaSubprocess({ root }, withTransform({ ...process.env }));
    // fd 3 is a separate pipe, so the result parses cleanly despite the stdout/stderr noise…
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.facts.requiredKeys).toContain('API_URL');
    }
    // …and neither printed secret rides along in the framed result.
    expect(JSON.stringify(r)).not.toContain('STDOUT_SECRET_7777');
    expect(JSON.stringify(r)).not.toContain('STDERR_SECRET_8888');
  });
});

// ---------------------------------------------------------------------------
// wrangler framework autoconfig / OpenNext delegation disabled
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `--skip-build` — every gate on this path reads the artifact `vite build`
// emits, so there is nothing to validate without a build. Reject the combination
// instead of silently ignoring the flag.
// ---------------------------------------------------------------------------

describe('runCloudflareDeploy — --skip-build is rejected', () => {
  it('rejects --skip-build pre-account — no whoami / provision / build / migrate / deploy', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(root, { backend: 'cloudflare', skipBuild: true }, silentCliLog, deps),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    // Pre-account: no seam ran at all.
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('rejects --skip-build even with --provision (nothing is provisioned)', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace, wranglerArgs, exitCalls } = harness();
    await expect(
      runCloudflareDeploy(
        root,
        { backend: 'cloudflare', skipBuild: true, provision: true },
        silentCliLog,
        deps,
      ),
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitCalls).toEqual([1]);
    expect(trace).toEqual([]);
    expect(wranglerArgs).toEqual([]);
  });

  it('explains that this backend validates the build artifact', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const messages: Array<string> = [];
    const restore = log.error;
    log.error = (msg: string) => {
      messages.push(msg);
    };
    try {
      const { deps } = harness();
      await expect(
        runCloudflareDeploy(root, { backend: 'cloudflare', skipBuild: true }, silentCliLog, deps),
      ).rejects.toBeInstanceOf(ExitError);
    } finally {
      log.error = restore;
    }
    const joined = messages.join('\n');
    expect(joined).toContain('--skip-build');
    expect(joined).toContain('--backend cloudflare');
    expect(joined).toMatch(/validat/i);
  });

  it('leaves the build running when --skip-build is absent', async () => {
    const root = d1Project(PROVISIONED_D1, INIT_MIGRATION);
    const { deps, trace } = harness();
    await runCloudflareDeploy(root, { backend: 'cloudflare' }, silentCliLog, deps);
    expect(trace).toContain('build');
  });
});

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
