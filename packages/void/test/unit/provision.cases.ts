import {
  existsSync,
  mkdir,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpath,
  realpathSync,
  rmdir,
  rmdirSync,
  rmSync,
  stat,
  symlinkSync,
  utimes,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe as vitestDescribe, expect, it } from 'vite-plus/test';
import type { CloudflareOperation } from '../../../deploy-cloudflare/src/operations.ts';
import {
  operationFixtureArgs,
  operationFixtureRequest,
  operationFixtureResult,
} from '../../../deploy-cloudflare/test/operation-fixture.ts';
import { encodeCloudflareOperation } from '../../src/cli/cloudflare-process.ts';
import {
  acquireProvisionLock,
  assertNoTransportRedirectInProjectDotenv,
  checkCloudflareProvisionDrift,
  createDefaultRunWrangler,
  enableD1ReadReplicationViaApi,
  isAlreadyGoneKillError,
  normalizeRunWranglerResult,
  provisionCloudflareResources as provisionCloudflareResourcesImpl,
  provisionEnv,
  resolveProperLockfileKey,
  resolvePinnedApiBaseUrl,
  WranglerQuarantineError,
  type DesiredResourceSet,
  type ProvisionOptions,
  type RunWrangler,
  type RunWranglerResult,
} from '../../src/cli/provision.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import { getProvisionTestShard, type ProvisionTestShard } from './provision-test-shard.ts';

const activeTestShard = getProvisionTestShard();

function shardForDescribe(name: string): ProvisionTestShard {
  if (name.startsWith('normalizeRunWranglerResult')) {
    return 'runner-signals';
  }
  if (name.startsWith('createDefaultRunWrangler')) {
    return name.includes('hard timeout') || name.includes('confirmed child termination')
      ? 'runner-timeouts'
      : 'runner-signals';
  }
  if (name.startsWith('withListerDeadline') || name.includes('Hyperdrive lister deadline')) {
    return 'runner-timeouts';
  }
  if (name.startsWith('acquireProvisionLock')) {
    return name.includes('durable sidecar') || name.includes('sidecar DIRECTORY')
      ? 'lock-durability'
      : 'lock-recovery';
  }
  if (
    name.includes('whole-provision cross-process lock') ||
    name.includes('quarantine retains the whole-provision lock') ||
    name.includes('dangling-symlink lock identity')
  ) {
    return 'locking';
  }
  return 'resources';
}

function describe(name: string, factory: () => void): void {
  if (shardForDescribe(name) === activeTestShard) {
    vitestDescribe(name, factory);
  }
}

/**
 * A passthrough of proper-lockfile's callback-style fs seam (mkdir/stat/utimes/rmdir/
 * realpath + a sync rmdir). The unlock-failure test overrides `rmdir` on top of this.
 */
const passthruFs = { mkdir, stat, utimes, rmdir, realpath, rmdirSync };

const tmpDir = join(import.meta.dirname, `.tmp-provision-test-${activeTestShard}`);
const wranglerPath = toSlash(join(tmpDir, 'wrangler.jsonc'));

function setup(content: string): void {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(wranglerPath, content);
}

/**
 * The provisioner requires a resolvable Cloudflare account whenever `desired`
 * implies remote work (the boundary account fence), regardless of injected vs
 * default seams. Real deploys always have one (`CLOUDFLARE_ACCOUNT_ID` or a config
 * `account_id`); mirror that by pinning an ambient account for every test, so the
 * fence is satisfied without threading `accountId` through each call. Tests that
 * exercise the NO-account / reconciliation / different-account paths delete or
 * override it locally (and restore in their own finally / via `afterEach`).
 */
const AMBIENT_ACCOUNT = 'ambient-test-account';
let savedAmbientAccount: string | undefined;

beforeEach(() => {
  savedAmbientAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = AMBIENT_ACCOUNT;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedAmbientAccount === undefined) {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  } else {
    process.env.CLOUDFLARE_ACCOUNT_ID = savedAmbientAccount;
  }
});

function readConfig(): Record<string, unknown> {
  return parseJsoncRaw(readFileSync(wranglerPath, 'utf-8')) as Record<string, unknown>;
}

/** Keep the established lock/race scenarios while provider calls use typed requests. */
function provisionOperationFixture(
  callback: (
    args: Array<string>,
    options: Parameters<RunWrangler>[1],
  ) => RunWranglerResult | Promise<RunWranglerResult>,
): RunWrangler {
  return async (operation, options) => {
    const args = operationFixtureArgs(operation);
    if (operation.type === 'hyperdrive.create') {
      args.splice(3, 0, '--connection-string=' + (options.input ?? ''));
    }
    const result = await callback(args, options);
    const decoded = operationFixtureResult(result);
    if (
      operation.type === 'queues.info' &&
      result.status !== 0 &&
      result.stderr.includes('Queue "' + operation.name + '" does not exist.')
    ) {
      return { ...decoded, failure: 'not-found' };
    }
    return decoded;
  };
}

/** A logger that swallows output (the default one prints to console). */
const silentLog = { info: () => {}, warn: () => {} };

type Handler = { match: RegExp; reply: (sub: string) => RunWranglerResult };

/**
 * Build an injectable runWrangler stub that records every argv ARRAY. Handlers
 * match on the space-joined argv (regex convenience), but `calls` holds the exact
 * argv arrays so tests assert that untrusted values stay single, literal tokens.
 */
function makeRunner(handlers: Array<Handler>): { run: RunWrangler; calls: Array<Array<string>> } {
  const calls: Array<Array<string>> = [];
  const run: RunWrangler = provisionOperationFixture((args) => {
    calls.push(args);
    const sub = args.join(' ');
    for (const handler of handlers) {
      if (handler.match.test(sub)) {
        return handler.reply(sub);
      }
    }
    return { stdout: '', stderr: '', status: 0 };
  });
  return { run, calls };
}

/** True when an argv array is a `wrangler <a> <b> …` invocation of a given kind. */
function isCall(argv: Array<string>, ...prefix: Array<string>): boolean {
  return prefix.every((token, i) => argv[i] === token);
}

const ok = (stdout = ''): RunWranglerResult => ({ stdout, stderr: '', status: 0 });
const fail = (stdout: string, stderr = ''): RunWranglerResult => ({ stdout, stderr, status: 1 });

// Valid-FORMAT synthetic ids for fixtures. The validators require REAL shapes:
// D1 database_id is a hyphenated UUID; KV + Hyperdrive ids are 32-char lowercase hex.
// ASCII-hex of the seed, zero-padded to 32 — deterministic, distinct, and ORDER-PRESERVING
// on equal-length seeds (so lexicographic tie-break assertions stay valid).
function hex32(seed: string): string {
  const raw = Buffer.from(seed, 'utf8').toString('hex').slice(0, 32);
  return (raw + '0'.repeat(32)).slice(0, 32);
}
function uuid(seed: string): string {
  const h = hex32(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Mimic `wrangler <res> create --update-config`: upsert a binding entry by binding. */
function simulateUpdateConfig(
  field: string,
  entry: Record<string, unknown>,
  path = wranglerPath,
): void {
  const cfg = parseJsoncRaw(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const list = Array.isArray(cfg[field]) ? (cfg[field] as Array<Record<string, unknown>>) : [];
  const index = list.findIndex((e) => e.binding === entry.binding);
  if (index >= 0) {
    list[index] = { ...list[index], ...entry };
  } else {
    list.push(entry);
  }
  cfg[field] = list;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

const emptyDesired: DesiredResourceSet = { kvNamespaces: [], queues: [] };

// Resource tests inject Wrangler transport; keep their remote D1 update local too.
// Tests of the actual API path call the implementation directly.
function provisionCloudflareResources(
  ...args: Parameters<typeof provisionCloudflareResourcesImpl>
): ReturnType<typeof provisionCloudflareResourcesImpl> {
  const [root, configPath, desired, opts] = args;
  const replicationStub: ProvisionOptions['enableD1ReadReplication'] = async () => {};
  return provisionCloudflareResourcesImpl(root, configPath, desired, {
    ...opts,
    enableD1ReadReplication:
      opts?.enableD1ReadReplication ?? (opts?.runWrangler ? replicationStub : undefined),
  });
}

describe('D1 read-replication API', () => {
  it('uses the pinned account and endpoint with an authenticated update', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await enableD1ReadReplicationViaApi(
      {
        accountId: 'account-one',
        apiBaseUrl: 'https://api.example.test/client/v4',
        databaseId: uuid('db1'),
      },
      'token-one',
      async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return Response.json({ success: true });
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      `https://api.example.test/client/v4/accounts/account-one/d1/database/${uuid('db1')}`,
    );
    expect(requests[0].init.method).toBe('PUT');
    expect(requests[0].init.headers).toEqual({
      Authorization: 'Bearer token-one',
      'Content-Type': 'application/json',
    });
    expect(requests[0].init.body).toBe(JSON.stringify({ read_replication: { mode: 'auto' } }));
  });

  it('fails closed when Cloudflare rejects the replication update', async () => {
    const update = enableD1ReadReplicationViaApi(
      {
        accountId: 'account-one',
        apiBaseUrl: 'https://api.example.test/client/v4',
        databaseId: uuid('db1'),
      },
      'secret-token',
      async () => Response.json({ success: false }, { status: 403 }),
    );

    await expect(update).rejects.toThrow(/D1 Edit permission/);
  });
});

describe('provisionCloudflareResources — typed operations', () => {
  it('sends a Hyperdrive connection only through stdin while literal public targets stay structured', async () => {
    setup('{}');
    const connection = 'postgres://user:synthetic-password@host/database';
    const operations: Array<CloudflareOperation> = [];
    const inputs: Array<string | undefined> = [];
    const run: RunWrangler = (operation, options) => {
      operations.push(operation);
      inputs.push(options.input);
      simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('typed') });
      return ok();
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { name: 'typed-hd', binding: 'HYPERDRIVE', connectionString: connection },
      },
      { runWrangler: run, listHyperdriveConfigs: async () => [], log: silentLog },
    );
    expect(operations).toEqual([
      {
        type: 'hyperdrive.create',
        name: 'typed-hd',
        binding: 'HYPERDRIVE',
        configPath: wranglerPath,
      },
    ]);
    expect(inputs).toEqual([connection]);
    expect(JSON.stringify(operations)).not.toContain('synthetic-password');
    const encoded = encodeCloudflareOperation(operations[0]!);
    expect(encoded).toHaveLength(1);
    expect(encoded.join(' ')).not.toContain('synthetic-password');
    expect(JSON.parse(encoded[0]!)).toEqual(operations[0]);
  });

  it('adopts structured Queue identity despite misleading human prose', async () => {
    setup('{}');
    const operations: Array<CloudflareOperation> = [];
    const run: RunWrangler = (operation) => {
      operations.push(operation);
      return {
        status: 0,
        stdout: 'Queue "typed-jobs" does not exist.',
        stderr: '',
        data: { name: 'typed-jobs' },
      };
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['typed-jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(operations).toEqual([
      { type: 'queues.info', name: 'typed-jobs', configPath: wranglerPath },
    ]);
  });

  it('creates a Queue from a structured not-found result and verifies the new identity', async () => {
    setup('{}');
    const operations: Array<CloudflareOperation> = [];
    let created = false;
    const run: RunWrangler = (operation) => {
      operations.push(operation);
      if (operation.type === 'queues.create') {
        created = true;
        return ok();
      }
      return created
        ? { ...ok(), data: { name: 'typed-jobs' } }
        : { status: 1, stdout: '', stderr: 'Provider presentation changed.', failure: 'not-found' };
    };
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['typed-jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(operations.map((operation) => operation.type)).toEqual([
      'queues.info',
      'queues.create',
      'queues.info',
    ]);
  });

  it('rejects signal provenance even when structured D1 data looks valid', async () => {
    setup('{}');
    const run: RunWrangler = () => ({
      status: 0,
      stdout: '',
      stderr: '',
      data: [],
      signal: 'SIGTERM',
    });
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { name: 'typed-db', binding: 'DB' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/SIGTERM|failed|invalid/);
  });
});

describe('provisionCloudflareResources — read-first', () => {
  it('enables D1 replication for a reused database before continuing the deploy', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const enabled: Array<unknown> = [];
    const { run } = makeRunner([]);

    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      {
        runWrangler: run,
        log: silentLog,
        enableD1ReadReplication: async (context: unknown) => {
          enabled.push(context);
        },
      },
    );

    expect(enabled).toEqual([
      {
        databaseId: uuid('db1'),
        accountId: AMBIENT_ACCOUNT,
        apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      },
    ]);
  });

  it('does not skip replication when the Wrangler runner is injected', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const requests: Array<string> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return Response.json({ success: true });
    };
    try {
      const { run } = makeRunner([]);
      await provisionCloudflareResourcesImpl(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, apiToken: 'test-token', log: silentLog },
      );
      expect(requests).toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${AMBIENT_ACCOUNT}/d1/database/${uuid('db1')}`,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips D1 create when the binding already has a real database_id (records reused, no wrangler call)', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    // Read-first: no wrangler invocation at all (migrations_dir is filled via the writer).
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: uuid('db1') },
    ]);
  });

  it('does NOT treat a placeholder database_id ("local") as real — proceeds to provision', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls[0]).toEqual(['d1', 'list', '--json', '-c', wranglerPath, '--env=']);
    expect(result.resources[0].action).toBe('created');
  });
});

describe('provisionCloudflareResources — argv injection safety', () => {
  it('passes a Hyperdrive connection string with shell metacharacters as ONE literal argv element', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // & $ ; and a space would all split/inject under a shell — must stay one token.
    const conn = 'postgres://u:p@h/db?sslmode=require&opt=$X;DROP TABLE t';
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    const createCall = calls.find((c) => isCall(c, 'hyperdrive', 'create'));
    expect(createCall).toEqual([
      'hyperdrive',
      'create',
      'myapp-hd',
      `--connection-string=${conn}`,
      '--binding',
      'HYPERDRIVE',
      '--update-config',
      '-c',
      wranglerPath,
      '--env=',
    ]);
    // The whole connection string (with & $ ; and a space) is a SINGLE element.
    expect(createCall!.filter((t) => t.includes('DROP TABLE t'))).toHaveLength(1);
    expect(result.resources[0].action).toBe('created');
  });

  it('passes a config path containing spaces as ONE literal argv element (no shell splitting)', async () => {
    const spacedDir = join(import.meta.dirname, '.tmp provision space');
    const spacedPath = join(spacedDir, 'wrangler.jsonc');
    rmSync(spacedDir, { recursive: true, force: true });
    mkdirSync(spacedDir, { recursive: true });
    writeFileSync(spacedPath, JSON.stringify({ name: 'app' }));
    try {
      const { run, calls } = makeRunner([
        { match: /^d1 list --json/, reply: () => ok('[]') },
        {
          match: /^d1 create /,
          reply: () => {
            simulateUpdateConfig(
              'd1_databases',
              { binding: 'DB', database_name: 'myapp-db', database_id: uuid('created') },
              spacedPath,
            );
            return ok();
          },
        },
      ]);
      const result = await provisionCloudflareResources(
        spacedDir,
        spacedPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      );
      const createCall = calls.find((c) => isCall(c, 'd1', 'create'));
      expect(spacedPath).toContain(' ');
      // The spaced path is the FINAL single element (a shell would have split it).
      expect(createCall).toEqual([
        'd1',
        'create',
        'myapp-db',
        '--binding',
        'DB',
        '--update-config',
        '-c',
        toSlash(spacedPath),
        '--env=',
      ]);
      expect(result.resources[0].action).toBe('created');
    } finally {
      rmSync(spacedDir, { recursive: true, force: true });
    }
  });
});

describe('provisionCloudflareResources — config discovery (fail closed, single file)', () => {
  it('reads a BOM-prefixed config correctly — ids found, no re-provision', async () => {
    setup(
      '﻿' +
        JSON.stringify({
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
        }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    // A BOM must NOT defeat read-first (a fail-open-to-{} parse would re-provision).
    expect(calls.some((c) => c[0] === 'd1')).toBe(false);
    expect(result.resources[0]).toMatchObject({ kind: 'd1', action: 'reused', id: uuid('db1') });
    // BOM survives the writer's migrations_dir fill.
    expect(readFileSync(wranglerPath, 'utf-8').charCodeAt(0)).toBe(0xfeff);
  });

  it('fails closed on a malformed root config — throws, no wrangler calls, no write', async () => {
    const malformed = '{ "name": "x" "d1_databases": [] }'; // missing comma
    setup(malformed);
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/not valid JSON/);
    expect(calls).toEqual([]);
    expect(readFileSync(wranglerPath, 'utf-8')).toBe(malformed);
  });

  it('reads and writes the SAME single resolved file when both wrangler.json and wrangler.jsonc exist', async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const jsoncPath = join(tmpDir, 'wrangler.jsonc');
    const jsonPath = join(tmpDir, 'wrangler.json');
    // The caller pins wrangler.json; the OLD writer rediscovered .jsonc → split-brain.
    writeFileSync(jsonPath, JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    writeFileSync(jsoncPath, JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const { run } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      jsonPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(result.configPath).toBe(toSlash(jsonPath));
    // The adopted id landed in the passed file (wrangler.json) — NOT split into .jsonc.
    const jsonAfter = parseJsoncRaw(readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
    expect((jsonAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('kv'));
    // wrangler.jsonc is untouched (still the placeholder).
    const jsoncAfter = parseJsoncRaw(readFileSync(jsoncPath, 'utf-8')) as Record<string, unknown>;
    expect((jsoncAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe('local');
  });
});

describe('provisionCloudflareResources — D1', () => {
  it('creates a missing D1 with --update-config then writes migrations_dir', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['d1', 'list', '--json', '-c', wranglerPath, '--env='],
      [
        'd1',
        'create',
        'myapp-db',
        '--binding',
        'DB',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: uuid('created'),
        migrations_dir: './db/migrations',
      },
    ]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'created' },
    ]);
  });

  it('repairs a missing migrations_dir on the read-first reused path (retry convergence, no duplicate D1)', async () => {
    // Simulates a prior run that created the D1 (real id written) then crashed
    // before migrations_dir. The retry takes read-first → reused and must still
    // fill migrations_dir — without re-creating (no duplicate D1).
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]); // read-first — no create, no list
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(1); // no duplicate D1 minted
    expect(d1[0]).toEqual({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: uuid('db1'),
      migrations_dir: './db/migrations',
    });
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: uuid('db1') },
    ]);
  });

  it('adopts an existing D1 found in the account (list hit) — no create, writes id + migrations_dir', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ uuid: uuid('existing'), name: 'myapp-db' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['d1', 'list', '--json', '-c', wranglerPath, '--env=']]);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: uuid('existing'),
        migrations_dir: './db/migrations',
      },
    ]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'adopted', id: uuid('existing') },
    ]);
  });

  it('treats a create-time 7502 (already exists) as adopt — captures the id via d1 info', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => fail('', 'X [ERROR] A database with that name already exists [code: 7502]'),
      },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => ok(JSON.stringify({ uuid: uuid('raced'), name: 'myapp-db' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['d1', 'list', '--json', '-c', wranglerPath, '--env='],
      [
        'd1',
        'create',
        'myapp-db',
        '--binding',
        'DB',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
      ['d1', 'info', 'myapp-db', '--json', '-c', wranglerPath, '--env='],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', database_id: uuid('raced') });
    expect(result.resources[0]).toEqual({
      kind: 'd1',
      binding: 'DB',
      name: 'myapp-db',
      action: 'adopted',
      id: uuid('raced'),
    });
  });

  it('throws on a non-7502 create failure', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/d1 create myapp-db.*failed/s);
  });
});

describe('provisionCloudflareResources — D1 discovery gate + strict validation', () => {
  const d1Desired: DesiredResourceSet = {
    ...emptyDesired,
    d1: { binding: 'DB', name: 'myapp-db' },
  };

  it('fails closed (no create) when `d1 list` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 list.*failed/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('fails closed (no create) on a SIGTERM-killed `d1 list` (normalized to non-zero)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const killed = normalizeRunWranglerResult({
      stdout: '',
      stderr: '',
      status: null,
      signal: 'SIGTERM',
    });
    const { run, calls } = makeRunner([{ match: /^d1 list --json/, reply: () => killed }]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 list.*failed/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no create) on a spawn-error `d1 list` (normalized to non-zero)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const errored = normalizeRunWranglerResult({
      status: null,
      error: new Error('spawn wrangler ENOENT'),
    });
    const { run, calls } = makeRunner([{ match: /^d1 list --json/, reply: () => errored }]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 list.*failed/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no create) when `d1 list` returns truncated JSON (status 0)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[{ "uuid": "a", "name": "myapp-db"') },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/did not return a JSON array/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no create) when a `d1 list` member is malformed — even when it IS the target name', async () => {
    // The target-named member carries NO id → it must NOT be filtered to a false
    // "absent" that mints a duplicate D1.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok(JSON.stringify([{ name: 'myapp-db' }])) },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/D1 database named "myapp-db" with no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('fails closed (no adopt/write) when the collision `d1 info` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, d1Desired, {
        runWrangler: run,
        log: silentLog,
      }),
    ).rejects.toThrow(/d1 info myapp-db.*failed/s);
    // The 7502 create wrote nothing, and the failed info produced no adopt/write.
    expect(readConfig().d1_databases).toBeUndefined();
  });
});

describe('provisionCloudflareResources — KV', () => {
  it('retains a created namespace when typed config is materialized again', async () => {
    setup('{}');
    rmSync(wranglerPath);
    writeFileSync(
      join(tmpDir, 'void.config.ts'),
      `export default { cloudflare: { name: 'app', account_id: '${AMBIENT_ACCOUNT}' } };\n`,
    );
    const generatedPath = materializeCloudflareConfig(tmpDir);
    const namespaceId = hex32('newkv');
    const { run } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: namespaceId }, generatedPath);
          return ok();
        },
      },
    ]);

    await provisionCloudflareResources(
      tmpDir,
      generatedPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'app-kv' }] },
      { runWrangler: run, log: silentLog },
    );

    const lock = JSON.parse(readFileSync(join(tmpDir, 'void.lock.json'), 'utf8')) as {
      resolved: { kv_namespaces: Array<{ binding: string; id: string }> };
    };
    expect(lock.resolved.kv_namespaces).toEqual([{ binding: 'KV', id: namespaceId }]);
    materializeCloudflareConfig(tmpDir);
    const generated = parseJsoncRaw(readFileSync(generatedPath, 'utf8')) as Record<string, unknown>;
    expect(generated.kv_namespaces).toEqual([{ binding: 'KV', id: namespaceId }]);
  });

  it('adopts when the namespace list shows a title match (writes id, no create)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['kv', 'namespace', 'list', '-c', wranglerPath, '--env=']]);
    const kv = readConfig().kv_namespaces as Array<Record<string, unknown>>;
    expect(kv).toEqual([{ binding: 'KV', id: hex32('kv') }]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'adopted', id: hex32('kv') },
    ]);
  });

  it('creates when the namespace list is empty', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'ISR_CACHE', id: hex32('newkv') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['kv', 'namespace', 'list', '-c', wranglerPath, '--env='],
      [
        'kv',
        'namespace',
        'create',
        'myapp-isr',
        '--binding',
        'ISR_CACHE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'ISR_CACHE', name: 'myapp-isr', action: 'created' },
    ]);
  });

  it('fails closed (no create) when `kv namespace list` exits non-zero', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/kv namespace list.*failed/s);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('fails closed (no create) when `kv namespace list` returns non-JSON output', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('not a json list at all') },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a JSON array/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('fails closed (no create) when `kv namespace list` output is truncated', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[{ "id": "a", "title": "myapp-kv"') },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a JSON array/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('picks the lexicographically-smallest id and warns on multiple title matches', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const warnings: Array<string> = [];
    const { run } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () =>
          ok(
            JSON.stringify([
              { id: hex32('zzz'), title: 'myapp-kv' },
              { id: hex32('aaa'), title: 'myapp-kv' },
              { id: hex32('mmm'), title: 'other' },
            ]),
          ),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: { info: () => {}, warn: (m) => warnings.push(m) } },
    );
    // hex32 is order-preserving on equal-length seeds, so hex32('aaa') < hex32('zzz').
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('aaa') });
    expect((readConfig().kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('aaa'));
    expect(
      warnings.some((w) => w.includes('multiple KV namespaces') && w.includes(hex32('aaa'))),
    ).toBe(true);
  });

  it('provisions each KV binding independently (ISR_CACHE + app KV)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: (sub) => {
          const binding = sub.includes('ISR_CACHE') ? 'ISR_CACHE' : 'KV';
          simulateUpdateConfig('kv_namespaces', { binding, id: hex32(binding) });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        kvNamespaces: [
          { binding: 'KV', title: 'myapp-kv' },
          { binding: 'ISR_CACHE', title: 'myapp-isr' },
        ],
      },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources.map((r) => r.action)).toEqual(['created', 'created']);
    const kv = readConfig().kv_namespaces as Array<Record<string, unknown>>;
    expect(kv.map((e) => e.binding).sort()).toEqual(['ISR_CACHE', 'KV']);
    expect(calls.filter((c) => isCall(c, 'kv', 'namespace', 'create'))).toHaveLength(2);
  });
});

describe('provisionCloudflareResources — account_id', () => {
  it('writes top-level account_id via the writer when provided', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
      runWrangler: run,
      accountId: 'acc-123',
      log: silentLog,
    });
    expect(readConfig().account_id).toBe('acc-123');
    expect(result.accountIdWritten).toBe(true);
  });

  it('does not write account_id when not provided (and none resolvable)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // Truly no account anywhere: clear the ambient the harness pins. emptyDesired
    // implies NO remote work, so the fence does not fire and nothing is persisted.
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const { run } = makeRunner([]);
      const result = await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
        runWrangler: run,
        log: silentLog,
      });
      expect(readConfig().account_id).toBeUndefined();
      expect(result.accountIdWritten).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = prev;
      }
    }
  });
});

describe('provisionCloudflareResources — idempotent re-run', () => {
  it('a second run after adoption is a read-first no-op (byte-identical config, no wrangler calls)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const first = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const desired: DesiredResourceSet = {
      ...emptyDesired,
      kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
    };
    await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: first.run,
      log: silentLog,
    });
    const afterFirst = readFileSync(wranglerPath, 'utf-8');

    const second = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, desired, {
      runWrangler: second.run,
      log: silentLog,
    });
    expect(second.calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'reused', id: hex32('kv') },
    ]);
    expect(readFileSync(wranglerPath, 'utf-8')).toBe(afterFirst);
  });
});

describe('provisionCloudflareResources — R2', () => {
  it('reuses when the bucket_name is already real (no wrangler call)', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'reused' },
    ]);
  });

  it('adopts an existing bucket via `r2 bucket info` (status 0) — writes the entry, no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info myapp-uploads --json/,
        reply: () => ok(JSON.stringify({ name: 'myapp-uploads', created: 'x' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
    ]);
    expect(readConfig().r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'adopted' },
    ]);
  });

  it('creates the bucket when `r2 bucket info` reports it does not exist', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', {
            binding: 'STORAGE',
            bucket_name: 'myapp-uploads',
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
      [
        'r2',
        'bucket',
        'create',
        'myapp-uploads',
        '--binding',
        'STORAGE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'created' },
    ]);
  });

  it('creates the bucket on a confirmed not-found signal (CF code 10006)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () =>
          fail('', 'X [ERROR] The bucket you tried to access is not present [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'myapp-uploads' });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(true);
    expect(result.resources[0].action).toBe('created');
  });

  it('does NOT create on an R2 info failure that is not a confirmed not-found (auth/metrics) — surfaces the error', async () => {
    // wrangler 4.131 `r2 bucket info` also runs a metrics/GraphQL query, so an
    // EXISTING bucket can exit non-zero on an auth/metrics failure. The prior
    // "auth error → create" behavior is REVERSED: never create on such a signal.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/r2 bucket info myapp-uploads.*(failed|refusing)/s);
    // No create attempted (the existing bucket must not be duplicated/errored on).
    expect(calls).toEqual([
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json', '-c', wranglerPath, '--env='],
    ]);
  });
});

describe('provisionCloudflareResources — Hyperdrive', () => {
  it('reuses when the hyperdrive binding already has a real id (no wrangler call)', async () => {
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'reused',
        id: hex32('hd'),
      },
    ]);
  });

  it('adopts an existing Hyperdrive config found by name — writes id via the writer, no create', async () => {
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async () => [
          { id: hex32('other-hd'), name: 'someone-else' },
          { id: hex32('existing'), name: 'myapp-hd' },
        ],
      },
    );
    // No wrangler create — existence via the injected REST seam, id via the writer.
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    const hd = readConfig().hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: hex32('existing') }]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'adopted',
        id: hex32('existing'),
      },
    ]);
  });

  it('creates the config when confirmed absent and a connection string is present', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(calls).toEqual([
      [
        'hyperdrive',
        'create',
        'myapp-hd',
        '--connection-string=postgres://u:p@h/db',
        '--binding',
        'HYPERDRIVE',
        '--update-config',
        '-c',
        wranglerPath,
        '--env=',
      ],
    ]);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('fails closed when existence is ambiguous (check throws) and a connection string is present — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            throw new Error('network down');
          },
        },
      ),
    ).rejects.toThrow(/cannot verify whether Hyperdrive config "myapp-hd"/);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
  });

  it('still skips (structured, never creates) when a lister can look but finds nothing', async () => {
    // A lister IS available, so this run COULD have adopted a same-named config; it
    // just did not find one. Nothing can be minted without a connection string, so the
    // structured skip — not a throw — remains the right report for that outcome.
    setup(JSON.stringify({ name: 'app' }));
    const warnings: Array<string> = [];
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        accountId: 'acct',
        runWrangler: run,
        listHyperdriveConfigs: async () => [],
        log: { info: () => {}, warn: (m) => warnings.push(m) },
      },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'skipped',
        reason: 'no connection string provided',
      },
    ]);
    expect(warnings.some((w) => w.includes('skipping Hyperdrive'))).toBe(true);
  });

  it('adopts a same-named config with NO connection string (adoption never needs one)', async () => {
    // Guards the stringless fail-closed fence from over-reaching: a run with no
    // connection string whose lister DOES find a match must still adopt, not throw.
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        accountId: 'acct',
        runWrangler: run,
        listHyperdriveConfigs: async () => [{ id: hex32('adopted'), name: 'myapp-hd' }],
        log: silentLog,
      },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'adopted',
        id: hex32('adopted'),
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hyperdrive needs a Cloudflare API token for its existence check, because
// wrangler exposes no machine-readable Hyperdrive list. `wrangler login` (OAuth)
// covers every OTHER resource, so the missing token has to be reported UP FRONT
// with the exact remedy — not discovered after D1/KV/R2 were already created.
// ---------------------------------------------------------------------------

describe('provisionCloudflareResources — Hyperdrive API token requirement', () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });
  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = savedToken;
    }
  });

  it('fails with an actionable token error BEFORE any account mutation when the config has no id', async () => {
    // A first-time Postgres provision under `wrangler login` (OAuth, no token): the
    // Hyperdrive id is not in the config yet and there is no way to check the account,
    // so the run must stop before the D1 database beside it is created.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          d1: { binding: 'DB', name: 'myapp-db' },
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    // Nothing ran: no `d1 create`, no Hyperdrive call — the account is untouched.
    expect(calls).toEqual([]);
    // The config was not touched either (no account_id pin, no new entries).
    expect(readConfig()).toEqual({ name: 'app' });
  });

  it('names the two remedies: export a token, or put an existing Hyperdrive id in the config', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const error = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog },
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('CLOUDFLARE_API_TOKEN');
    expect(message).toContain('Hyperdrive');
    // Explains WHY a token is needed where `wrangler login` suffices elsewhere.
    expect(message).toMatch(/no machine-readable/i);
    // Remedy 2: create the config yourself and paste its id into wrangler.jsonc.
    expect(message).toContain(wranglerPath);
    expect(message).toMatch(/wrangler login|OAuth/i);
    // The connection string is never echoed into the error.
    expect(message).not.toContain('postgres://');
  });

  it('proceeds with NO token when the Hyperdrive id is already in the config (no REST call)', async () => {
    // The read-first path is pure config I/O: an already-provisioned Postgres app
    // deploys fine under `wrangler login` alone.
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }] }));
    const { run, calls } = makeRunner([]);
    const fetchUrls: Array<string> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      fetchUrls.push(String(url));
      throw new Error('the read-first path must not reach the network');
    }) as typeof fetch;
    let result;
    try {
      result = await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        { runWrangler: run, log: silentLog },
      );
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchUrls).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'reused',
        id: hex32('hd'),
      },
    ]);
  });

  it('runs the existence check unchanged when a token IS resolvable', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'ambient-tok';
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    const urls: Array<string> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    let result;
    try {
      result = await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:p@h/db',
          },
        },
        { runWrangler: run, log: silentLog },
      );
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(true);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('needs no token when a listHyperdriveConfigs seam is injected', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('newhd') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: {
          binding: 'HYPERDRIVE',
          name: 'myapp-hd',
          connectionString: 'postgres://u:p@h/db',
        },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(true);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
  });

  it('fails closed on a MISSING connection string when nothing can look the account up', async () => {
    // No connection string AND no token/lister → this run can neither create nor adopt,
    // so its only reachable outcome is the structured `skipped`, which deploy treats as
    // FATAL. Reaching that costs the user a half-provisioned account, so it stops here.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no DATABASE_URL to create it from/);
    // Nothing ran: no wrangler call, so no resource was created before the rejection.
    expect(calls).toEqual([]);
  });

  it('names DATABASE_URL and the manual adopt route, and does not suggest a dotenv file', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const err = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, log: silentLog },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('wrangler hyperdrive create');
    expect(message).toContain('HYPERDRIVE');
    // The remedy must point at the shell, never at a dotenv file — project-derived env
    // is read only inside the build subprocess, and a shipped .env value would leak.
    expect(message).toMatch(/shell/);
    expect(message).toMatch(/NOT used here/);
  });

  it('fails closed BEFORE the account pin and before any other resource is created', async () => {
    // The whole point of fencing early: a run that also wants KV/R2 must not create
    // them (and must not stamp account_id) only to abort at the Hyperdrive block.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
          r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' },
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, accountId: 'acct-A', log: silentLog },
      ),
    ).rejects.toThrow(/no DATABASE_URL to create it from/);
    // No create seam was invoked at all — KV and R2 were never touched.
    expect(calls).toEqual([]);
    // …and the account was never pinned, so a retry under a different account is still free.
    expect(readConfig().account_id).toBeUndefined();
  });

  it('a hyperdrive already provisioned with a real id needs neither a string nor a token', async () => {
    // The read-first path is pure config I/O — the stringless fence must not touch it.
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'reused',
        id: hex32('hd'),
      },
    ]);
  });
});

describe('provisionCloudflareResources — Queues (resource only)', () => {
  it('reuses a queue that `queues info` finds (no create, never writes queue config)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^queues info jobs/, reply: () => ok('Queue Name: jobs') },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['queues', 'info', 'jobs', '-c', wranglerPath, '--env=']]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'jobs', action: 'reused' }]);
    // Task 4 must NOT write queue producer/consumer entries into the config.
    expect(readConfig().queues).toBeUndefined();
  });

  it('creates a queue that `queues info` reports missing; verifies with a follow-up info probe', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // After `queues create`, the provisioner RE-RUNS `queues info` and only
    // records `created` if it now POSITIVELY confirms the queue (queues write no
    // config, so this is the only backstop against a masked-signal create).
    let created = false;
    const { run, calls } = makeRunner([
      {
        match: /^queues info emails/,
        reply: () =>
          created ? ok('Queue Name: emails') : fail('', 'X [ERROR] Queue "emails" does not exist.'),
      },
      {
        match: /^queues create emails/,
        reply: () => {
          created = true;
          return ok('Created queue emails');
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
    ]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'emails', action: 'created' }]);
    expect(readConfig().queues).toBeUndefined();
  });

  it('handles a mix of existing and missing queues', async () => {
    setup(JSON.stringify({ name: 'app' }));
    let created = false;
    const { run, calls } = makeRunner([
      { match: /^queues info jobs/, reply: () => ok('Queue Name: jobs') },
      {
        match: /^queues info emails/,
        reply: () =>
          created ? ok('Queue Name: emails') : fail('', 'Queue "emails" does not exist.'),
      },
      {
        match: /^queues create emails/,
        reply: () => {
          created = true;
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs', 'emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'emails', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'emails', '-c', wranglerPath, '--env='],
    ]);
    expect(result.resources).toEqual([
      { kind: 'queue', name: 'jobs', action: 'reused' },
      { kind: 'queue', name: 'emails', action: 'created' },
    ]);
  });

  it('throws (does NOT create) when `queues info` fails for a non-missing reason', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('does NOT create on a generic/unrelated "not found" (e.g. Account not found) — fails closed', async () => {
    // The OLD broad `/not found|no such/` regex misread "Account not found" as
    // queue absence and blindly created. It must fail closed instead.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Account not found [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('is name-aware: a "does not exist" for a DIFFERENT queue name is NOT absence for this one', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Queue "some-other-queue" does not exist.'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('creates ONLY on the exact `Queue "<name>" does not exist` signal for THAT name', async () => {
    setup(JSON.stringify({ name: 'app' }));
    let created = false;
    const { run, calls } = makeRunner([
      {
        match: /^queues info jobs/,
        reply: () =>
          created ? ok('Queue Name: jobs') : fail('', 'X [ERROR] Queue "jobs" does not exist.'),
      },
      {
        match: /^queues create jobs/,
        reply: () => {
          created = true;
          return ok('Created queue jobs');
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
    ]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'jobs', action: 'created' }]);
  });

  it('fails closed when a masked-signal `queues create` (wrapper exit 0) did NOT create the queue', async () => {
    // wrangler's bin wrapper maps a signal-killed inner CLI to exit 0. Queues write
    // no config, so the ONLY backstop is the post-create verify probe: a create that
    // reports clean 0 but whose follow-up `queues info` still does not confirm the
    // queue must fail closed (never a false `created`).
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        // Both the initial probe AND the verify probe report the queue absent — the
        // masked-kill create never actually created it.
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Queue "jobs" does not exist.'),
      },
      // A signal-killed inner CLI surfaced as a clean exit 0 by the wrapper.
      { match: /^queues create jobs/, reply: () => ok('') },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not confirm the queue exists afterward/);
    // The verify probe ran (info, create, info) but the queue was never recorded.
    expect(calls).toEqual([
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'create', 'jobs', '-c', wranglerPath, '--env='],
      ['queues', 'info', 'jobs', '-c', wranglerPath, '--env='],
    ]);
  });
});

describe('provisionCloudflareResources — account reconciliation + config pin', () => {
  it('fails closed BEFORE any wrangler/REST call when config account_id differs from opts.accountId', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    let restCalled = false;
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        {
          runWrangler: run,
          accountId: 'requested-acct',
          log: silentLog,
          listHyperdriveConfigs: async () => {
            restCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/account mismatch.*config-acct.*requested-acct/s);
    // No wrangler call and no REST call happened before the fail-closed throw.
    expect(calls).toEqual([]);
    expect(restCalled).toBe(false);
  });

  it('persists account_id BEFORE any remote op so a later different-account retry fails closed', async () => {
    // Run 1 under account A: D1 create writes a real id, THEN a later op fails.
    setup(JSON.stringify({ name: 'app' }));
    const run1 = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('createdA'),
          });
          return ok();
        },
      },
      // A later op fails → the run throws AFTER the D1 id was already written.
      {
        match: /^queues info jobs/,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
        { runWrangler: run1.run, accountId: 'acct-A', log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    // account_id was pinned to A UP FRONT (before D1), alongside the real D1 id.
    const after1 = readConfig();
    expect(after1.account_id).toBe('acct-A');
    expect((after1.d1_databases as Array<Record<string, unknown>>)[0].database_id).toBe(
      uuid('createdA'),
    );

    // Run 2 retries under account B → must fail closed at reconciliation with NO
    // wrangler/REST calls (never rebinds account-A's D1 id under account B).
    let restCalled = false;
    const run2 = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
        {
          runWrangler: run2.run,
          accountId: 'acct-B',
          log: silentLog,
          listHyperdriveConfigs: async () => {
            restCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/account mismatch.*acct-A.*acct-B/s);
    expect(run2.calls).toEqual([]);
    expect(restCalled).toBe(false);
  });

  it('passes -c <configPath> to EVERY wrangler invocation (list, info, create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    let queueCreated = false;
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('created'),
          });
          return ok();
        },
      },
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('newkv') });
          return ok();
        },
      },
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'bucket-b' });
          return ok();
        },
      },
      {
        match: /^queues info /,
        reply: () =>
          queueCreated ? ok('Queue Name: jobs') : fail('', 'Queue "jobs" does not exist.'),
      },
      {
        match: /^queues create /,
        reply: () => {
          queueCreated = true;
          return ok();
        },
      },
    ]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        r2: { binding: 'STORAGE', bucketName: 'bucket-b' },
        queues: ['jobs'],
      },
      { runWrangler: run, log: silentLog },
    );
    // Every wrangler argv threads the ONE resolved config via `-c <configPath>` AND
    // the top-level `--env=` pin.
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf('-c');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(wranglerPath);
      expect(argv[i + 2]).toBe('--env=');
    }
  });

  it('the default Hyperdrive existence REST call targets the effective (config) account id', async () => {
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    const urls: Array<string> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const { run } = makeRunner([]);
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          // Empty connection string → skip AFTER the existence check, so ONLY the
          // REST call runs (no create).
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, apiToken: 'tok', log: silentLog },
      );
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
    // Default (no ambient redirect) → public prod base.
    expect(urls[0]).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\//);
  });
});

describe('provisionCloudflareResources — pinned transport (one base for wrangler + REST)', () => {
  it('resolvePinnedApiBaseUrl mirrors wrangler: default prod, direct override, staging, fedramp', () => {
    expect(resolvePinnedApiBaseUrl({})).toBe('https://api.cloudflare.com/client/v4');
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: 'https://api.example/v9' })).toBe(
      'https://api.example/v9',
    );
    // Deprecated alias honored when the primary is absent.
    expect(resolvePinnedApiBaseUrl({ CF_API_BASE_URL: 'https://cf.example/v4' })).toBe(
      'https://cf.example/v4',
    );
    expect(resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'staging' })).toBe(
      'https://api.staging.cloudflare.com/client/v4',
    );
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' })).toBe(
      'https://api.fed.cloudflare.com/client/v4',
    );
  });

  it('the default Hyperdrive REST lister honors a pinned CLOUDFLARE_API_BASE_URL (not hardcoded prod)', async () => {
    const prev = process.env.CLOUDFLARE_API_BASE_URL;
    process.env.CLOUDFLARE_API_BASE_URL = 'https://api.staging.cloudflare.com/client/v4';
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    const urls: Array<string> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const { run } = makeRunner([]);
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, apiToken: 'tok', log: silentLog },
      );
    } finally {
      globalThis.fetch = origFetch;
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_API_BASE_URL;
      } else {
        process.env.CLOUDFLARE_API_BASE_URL = prev;
      }
    }
    // The REST existence check hit the SAME pinned endpoint wrangler would (staging),
    // not the hardcoded public-prod base.
    expect(urls[0]).toMatch(/^https:\/\/api\.staging\.cloudflare\.com\/client\/v4\//);
    expect(urls[0]).toContain('/accounts/config-acct/hyperdrive/configs');
  });

  it('the lister URL uses the pinned base with wrangler-EXACT concatenation (no trailing-slash trim)', async () => {
    // wrangler 4.131's `performApiFetchBase` fetches
    // `${getCloudflareApiBaseUrl(...)}${resource}${queryString}` with the direct env
    // base used VERBATIM and the resource `/accounts/${accountId}/hyperdrive/configs`
    // interpolated RAW. A base ending in `/` therefore yields `…//accounts/…` for
    // wrangler; the lister must produce the SAME bytes (the old one-sided trim made the
    // existence check and the create hit different endpoints on a custom proxy base).
    const prev = process.env.CLOUDFLARE_API_BASE_URL;
    const pinnedBase = 'https://proxy.example/api/'; // note the trailing slash
    process.env.CLOUDFLARE_API_BASE_URL = pinnedBase;
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    const urls: Array<string> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const { run } = makeRunner([]);
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        { runWrangler: run, apiToken: 'tok', log: silentLog },
      );
    } finally {
      globalThis.fetch = origFetch;
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_API_BASE_URL;
      } else {
        process.env.CLOUDFLARE_API_BASE_URL = prev;
      }
    }
    // Byte-for-byte wrangler's concatenation: `${base}${resource}${queryString}` —
    // the double slash included.
    expect(urls[0]).toBe(
      `${pinnedBase}/accounts/config-acct/hyperdrive/configs?page=1&per_page=100`,
    );
    expect(urls[0]).toContain('/api//accounts/');
  });

  it('the injected lister receives the pinned apiBaseUrl + a deadline AbortSignal in its transport context', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    let seen: { accountId: string; apiBaseUrl: string; signal: AbortSignal } | undefined;
    const { run } = makeRunner([]);
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async (ctx) => {
          seen = ctx;
          return [];
        },
      },
    );
    expect(seen?.accountId).toBe('config-acct');
    expect(seen?.apiBaseUrl).toBe('https://api.cloudflare.com/client/v4');
    // The lister is handed the overall-deadline signal to thread into every fetch.
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('FAILS CLOSED when a project .env sets a transport-redirect var (no wrangler/REST)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    // A repo .env that would redirect wrangler's transport on every command.
    writeFileSync(
      join(tmpDir, '.env'),
      'CLOUDFLARE_API_BASE_URL=https://api.staging.cloudflare.com/client/v4\n',
    );
    let listerCalled = false;
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          d1: { binding: 'DB', name: 'myapp-db' },
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            listerCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/refusing to provision.*\.env.*CLOUDFLARE_API_BASE_URL.*redirect/s);
    // Failed closed BEFORE any remote work.
    expect(calls.length).toBe(0);
    expect(listerCalled).toBe(false);
  });

  it('does NOT fail on a benign project .env without transport-redirect vars', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'DATABASE_URL=postgres://localhost/app\nFOO=bar\n');
    const { run } = makeRunner([
      { match: /^d1 list/, reply: () => ok('[]') },
      {
        match: /^d1 create/,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('db'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'created' },
    ]);
  });
});

describe('provisionCloudflareResources — Hyperdrive discovery (pagination + fail closed)', () => {
  function stubFetch(pages: Array<{ status?: number; body: unknown }>): {
    restore: () => void;
    urls: Array<string>;
  } {
    const urls: Array<string> = [];
    const origFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      const page = pages[Math.min(call, pages.length - 1)];
      call++;
      return new Response(typeof page.body === 'string' ? page.body : JSON.stringify(page.body), {
        status: page.status ?? 200,
      });
    }) as typeof fetch;
    return {
      restore: () => {
        globalThis.fetch = origFetch;
      },
      urls,
    };
  }

  it('follows result_info pagination and adopts a match found on page 2 (no create)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const { restore, urls } = stubFetch([
      {
        body: {
          success: true,
          result: [{ id: hex32('p1a'), name: 'other-1' }],
          result_info: { total_count: 2 },
        },
      },
      {
        body: {
          success: true,
          result: [{ id: hex32('p2hd'), name: 'myapp-hd' }],
          result_info: { total_count: 2 },
        },
      },
    ]);
    try {
      const { run, calls } = makeRunner([]);
      const result = await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, apiToken: 'tok', log: silentLog },
      );
      expect(urls.length).toBe(2); // both pages fetched
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
      const hd = readConfig().hyperdrive as Array<Record<string, unknown>>;
      expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: hex32('p2hd') }]);
      expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('p2hd') });
    } finally {
      restore();
    }
  });

  it('fails closed on a non-2xx envelope (never treats it as absence, no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { restore } = stubFetch([{ status: 500, body: { success: false } }]);
    try {
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            hyperdrive: {
              binding: 'HYPERDRIVE',
              name: 'myapp-hd',
              connectionString: 'postgres://x',
            },
          },
          { runWrangler: run, apiToken: 'tok', log: silentLog },
        ),
      ).rejects.toThrow(/cannot verify whether Hyperdrive config "myapp-hd"/);
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails closed on success:false and on a malformed entry (missing id) — no create', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // success:false first, then a malformed entry — both must fail closed.
    for (const body of [
      { success: false, result: [] },
      { success: true, result: [{ name: 'myapp-hd' }], result_info: { total_count: 1 } },
    ]) {
      const { restore } = stubFetch([{ body }]);
      try {
        const { run, calls } = makeRunner([]);
        await expect(
          provisionCloudflareResources(
            tmpDir,
            wranglerPath,
            {
              ...emptyDesired,
              hyperdrive: {
                binding: 'HYPERDRIVE',
                name: 'myapp-hd',
                connectionString: 'postgres://x',
              },
            },
            { runWrangler: run, apiToken: 'tok', log: silentLog },
          ),
        ).rejects.toThrow(/cannot verify whether Hyperdrive config "myapp-hd"/);
        expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
      } finally {
        restore();
      }
    }
  });

  it('fails closed when two configs share the requested name (ambiguous) — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [
            { id: hex32('hd-1'), name: 'myapp-hd' },
            { id: hex32('hd-2'), name: 'myapp-hd' },
          ],
        },
      ),
    ).rejects.toThrow(/cannot adopt Hyperdrive config "myapp-hd".*share that name/s);
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
  });

  it('fails closed on malformed pagination (missing/premature-empty/duplicate/inconsistent) — never declares absence, no create', async () => {
    // Each case would let the OLD loop stop early and declare "absent" without
    // proving completeness → a same-named config on an unread page becomes a
    // duplicate. All must fail closed BEFORE any create.
    const cases: Array<Array<{ status?: number; body: unknown }>> = [
      // 1. missing result_info.total_count metadata (cannot prove completeness)
      [{ body: { success: true, result: [{ id: 'a', name: 'other' }] } }],
      // 2. premature empty page before all configs are listed
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'other' }],
            result_info: { total_count: 3 },
          },
        },
        { body: { success: true, result: [], result_info: { total_count: 3 } } },
      ],
      // 3. repeated/duplicate id across pages (padding to satisfy a count)
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
      ],
      // 4. inconsistent total_count between pages
      [
        {
          body: {
            success: true,
            result: [{ id: 'a', name: 'x' }],
            result_info: { total_count: 2 },
          },
        },
        {
          body: {
            success: true,
            result: [{ id: 'b', name: 'y' }],
            result_info: { total_count: 5 },
          },
        },
      ],
    ];
    for (const pages of cases) {
      setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
      const { restore } = stubFetch(pages);
      try {
        const { run, calls } = makeRunner([]);
        await expect(
          provisionCloudflareResources(
            tmpDir,
            wranglerPath,
            {
              ...emptyDesired,
              hyperdrive: {
                binding: 'HYPERDRIVE',
                name: 'myapp-hd',
                connectionString: 'postgres://x',
              },
            },
            { runWrangler: run, apiToken: 'tok', log: silentLog },
          ),
        ).rejects.toThrow(/cannot verify whether Hyperdrive config "myapp-hd"/);
        expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
      } finally {
        restore();
      }
    }
  });
});

describe('provisionCloudflareResources — KV/R2 fail closed on schema-valid ambiguity', () => {
  it('KV: fails closed (no create) when the target title matches but the entry has no id', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok(JSON.stringify([{ title: 'myapp-kv' }])) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/namespace titled "myapp-kv" with no valid id/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('KV: fails closed (no create) when the list has a malformed member (null) — never filtered away', async () => {
    // The OLD strict parser filtered `null` out, leaving a false "absent" match →
    // duplicate. The malformed member must reject the WHOLE list instead.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([null, { id: 'other', title: 'someone-else' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/malformed KV namespace entry/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('R2: does NOT adopt when `r2 bucket info` exits 0 but the payload names a different bucket', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => ok(JSON.stringify({ name: 'a-different-bucket' })),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not identify the requested bucket/);
    // Neither adopted nor created — the config is untouched.
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(false);
    expect(readConfig().r2_buckets).toBeUndefined();
  });
});

describe('normalizeRunWranglerResult — signal / spawn-error handling', () => {
  it('treats a SIGTERM-killed child (status null, signal set) as FAILURE, not success', () => {
    const r = normalizeRunWranglerResult({
      stdout: '',
      stderr: '',
      status: null,
      signal: 'SIGTERM',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SIGTERM');
  });

  it('treats a spawn error as FAILURE and surfaces its message', () => {
    const r = normalizeRunWranglerResult({
      status: null,
      error: new Error('spawn wrangler ENOENT'),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ENOENT');
  });

  it('passes a clean exit through unchanged (0 stays success, a real non-zero is preserved)', () => {
    expect(normalizeRunWranglerResult({ status: 0, stdout: 'ok' }).status).toBe(0);
    expect(normalizeRunWranglerResult({ status: 2, stderr: 'boom' }).status).toBe(2);
  });

  it('carries structured signal/error provenance', () => {
    const killed = normalizeRunWranglerResult({ status: null, signal: 'SIGTERM' });
    expect(killed.signal).toBe('SIGTERM');
    expect(killed.error).toBeNull();
    const errored = normalizeRunWranglerResult({ status: null, error: new Error('ENOENT') });
    expect(errored.error).toContain('ENOENT');
    const clean = normalizeRunWranglerResult({ status: 0, stdout: 'ok' });
    expect(clean.signal).toBeNull();
    expect(clean.error).toBeNull();
  });
});

describe('createDefaultRunWrangler — hard timeout kills the REAL process', () => {
  const TIMEOUT_TMP = join(import.meta.dirname, '.tmp-timeout-kill');
  beforeEach(() => {
    rmSync(TIMEOUT_TMP, { recursive: true, force: true });
    mkdirSync(TIMEOUT_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TIMEOUT_TMP, { recursive: true, force: true });
  });

  /** Poll `process.kill(pid, 0)` until the pid is dead (ESRCH) or the deadline passes. */
  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0); // still alive
      } catch {
        return true; // ESRCH → dead
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('a DIRECT hung CLI is SIGKILLed and the runner REJECTS-as-hard-failure within the timeout', async () => {
    // Simulate the post-fix launcher: a direct CLI entry (no wrapper) that ignores SIGTERM
    // and hangs forever.
    const hungCli = join(TIMEOUT_TMP, 'hung-cli.cjs');
    writeFileSync(
      hungCli,
      `process.on('SIGTERM', () => {});\n` + // survives a plain SIGTERM (like the wrapper sends)
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let pid: number | undefined;
    const run = createDefaultRunWrangler(TIMEOUT_TMP, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        pid = child.pid;
      },
      timeoutMs: 400,
    });
    const start = Date.now();
    const result = await run(operationFixtureRequest(['d1', 'list', '--json']), {
      accountId: 'acct',
    });
    const elapsed = Date.now() - start;
    // Settled in bounded time — the runner did NOT hang. The tight ceiling here is a
    // load-tolerant sanity bound (the 400ms internal timer can be delayed on a busy
    // machine); the real "did not hang forever" guard is the outer vitest timeout.
    expect(elapsed).toBeLessThan(15_000);
    // HARD failure: a non-null signal, folded to a non-zero status.
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeded the 400ms command timeout/);
    // No lingering process — the SIGKILL reached the real CLI. Poll for the OUTCOME
    // (dead pid) with a generous bound rather than racing a tight deadline.
    expect(pid).toBeTypeOf('number');
    expect(await waitForDead(pid!, 10_000)).toBe(true);
  }, 20_000);

  it('a WRAPPER that re-spawns a hung grandchild: runner still settles in time AND the grandchild is reaped', async () => {
    // The exact scenario: a `bin/wrangler.js`-style wrapper that
    // spawns an inner CLI with inherited stdio and forwards only SIGTERM (never SIGKILL),
    // mapping a signal-killed child to exit 0. Pre-fix this defeated the timeout (the
    // grandchild survived holding the pipes so `close` never fired). The runner now spawns
    // the launcher in its OWN process group and SIGKILLs the WHOLE group on timeout, then
    // settles immediately — so even a wrapper-plus-hung-grandchild rejects within the
    // timeout with NO lingering process.
    const gcPidFile = join(TIMEOUT_TMP, 'grandchild.pid');
    const grandchild = join(TIMEOUT_TMP, 'grandchild.cjs');
    writeFileSync(
      grandchild,
      `require('fs').writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` + // ignore the wrapper's forwarded SIGTERM
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const wrapper = join(TIMEOUT_TMP, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      `const { spawn } = require('child_process');\n` +
        // Under heavy full-suite fork pressure a single spawn can transiently fail
        // (EAGAIN). Retry so the grandchild reliably establishes — otherwise the wrapper
        // would exit early and the runner would settle via the NORMAL close path (signal
        // null), making the timeout-kill assertion flake. On a hard failure keep the
        // wrapper ALIVE so the runner's timeout+group-SIGKILL path is still exercised.
        `let child;\n` +
        `function launch() {\n` +
        `  try {\n` +
        `    child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['inherit','inherit','inherit'] });\n` +
        `    child.on('error', () => { child = undefined; setTimeout(launch, 50); });\n` +
        `    child.on('exit', (code) => process.exit(code === null ? 0 : code));\n` + // mask signal death as exit 0
        `  } catch { setTimeout(launch, 50); }\n` +
        `}\n` +
        `launch();\n` +
        `process.on('SIGTERM', () => { if (child) child.kill(); });\n` + // forward only SIGTERM (default)
        `process.on('SIGINT', () => { if (child) child.kill(); });\n` +
        `setInterval(() => {}, 1 << 30);\n`, // keep the wrapper alive until the group is killed
    );
    const run = createDefaultRunWrangler(TIMEOUT_TMP, {
      launcher: [process.execPath, wrapper],
      // Generous internal timeout so the wrapper + grandchild reliably establish (and hang)
      // before the timer fires even under load — the timeout-kill path is what we assert.
      timeoutMs: 1_500,
    });
    const start = Date.now();
    const result = await run(operationFixtureRequest(['d1', 'list', '--json']), {
      accountId: 'acct',
    });
    const elapsed = Date.now() - start;
    // Bounded settle (the vitest timeout is the real "did not hang" guard).
    expect(elapsed).toBeLessThan(20_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // The grandchild wrote its pid, then must have been reaped by the process-group kill.
    // Poll for the OUTCOME (dead pgid) with a generous, load-tolerant bound.
    const gcPid = Number(readFileSync(gcPidFile, 'utf-8'));
    expect(Number.isInteger(gcPid)).toBe(true);
    expect(await waitForDead(gcPid, 10_000)).toBe(true);
  }, 25_000);
});

describe('provisionCloudflareResources — account gate + env scrub', () => {
  it('provisionEnv scrubs CLOUDFLARE_ENV + the CF Access token pair and pins the account', () => {
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string): void => {
      saved[k] = process.env[k];
      process.env[k] = v;
    };
    set('CLOUDFLARE_ENV', 'staging');
    set('CF_ACCESS_CLIENT_ID', 'id');
    set('CF_ACCESS_CLIENT_SECRET', 'secret');
    set('CF_ACCESS_TOKEN', 'short-lived-user-jwt');
    try {
      const env = provisionEnv({ accountId: 'acct-X' });
      // CLOUDFLARE_ENV would let wrangler select an env-specific account block.
      expect(env.CLOUDFLARE_ENV).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
      expect(env.CF_ACCESS_TOKEN).toBeUndefined();
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-X');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('provisionEnv scrubs EVERY transport-redirect var and pins the ONE resolved API base', () => {
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string): void => {
      saved[k] = process.env[k];
      process.env[k] = v;
    };
    // Ambient redirect vars that (via wrangler's per-command dotenv reload) could point the
    // transport elsewhere — all must be scrubbed from the child env.
    set('CLOUDFLARE_API_BASE_URL', 'https://evil.example');
    set('CF_API_BASE_URL', 'https://evil2.example');
    set('WRANGLER_API_ENVIRONMENT', 'staging');
    set('CLOUDFLARE_COMPLIANCE_REGION', 'fedramp_high');
    try {
      const env = provisionEnv({
        accountId: 'acct-X',
        apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      });
      expect(env.CF_API_BASE_URL).toBeUndefined();
      expect(env.WRANGLER_API_ENVIRONMENT).toBeUndefined();
      expect(env.CLOUDFLARE_COMPLIANCE_REGION).toBeUndefined();
      // The ONE pinned base overrides any ambient/derived value.
      expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('fails closed (no wrangler/REST) when no account is resolvable on the default path', async () => {
    setup(JSON.stringify({ name: 'app' })); // no account_id
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID; // no ambient account either
    try {
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
          // NO runWrangler injected, NO accountId → the DEFAULT (real) path.
          { log: silentLog },
        ),
      ).rejects.toThrow(/no Cloudflare account is resolvable/);
      // The gate throws BEFORE any wrangler subprocess / REST — nothing persisted.
      expect(readConfig().d1_databases).toBeUndefined();
      expect(readConfig().account_id).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = prev;
      }
    }
  });

  it('persists the AMBIENT account before remote work; a later different-account retry fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_ACCOUNT_ID = 'ambient-A';
    try {
      // Run 1: ambient A (no opts.accountId). D1 create writes a real id, THEN a
      // later op fails → the run throws AFTER account_id was pinned to A up front.
      const run1 = makeRunner([
        { match: /^d1 list --json/, reply: () => ok('[]') },
        {
          match: /^d1 create /,
          reply: () => {
            simulateUpdateConfig('d1_databases', {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: uuid('createdA'),
            });
            return ok();
          },
        },
        {
          match: /^queues info jobs/,
          reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
        },
      ]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
          { runWrangler: run1.run, log: silentLog },
        ),
      ).rejects.toThrow(/queues info jobs.*failed/s);
      const after1 = readConfig();
      expect(after1.account_id).toBe('ambient-A');
      expect((after1.d1_databases as Array<Record<string, unknown>>)[0].database_id).toBe(
        uuid('createdA'),
      );

      // Run 2 retries under account B → reconciliation A≠B fails closed, NO
      // wrangler/REST (never rebinds account-A's real D1 id under account B).
      let restCalled = false;
      const run2 = makeRunner([{ match: /.*/, reply: () => ok() }]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
          {
            runWrangler: run2.run,
            accountId: 'acct-B',
            log: silentLog,
            listHyperdriveConfigs: async () => {
              restCalled = true;
              return [];
            },
          },
        ),
      ).rejects.toThrow(/account mismatch.*ambient-A.*acct-B/s);
      expect(run2.calls).toEqual([]);
      expect(restCalled).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = prev;
      }
    }
  });
});

describe('provisionCloudflareResources — resource-name validation', () => {
  const badNames = ['--help', '--config', '-h'];
  const kinds: Array<{
    label: RegExp;
    desired: (name: string) => DesiredResourceSet;
    createPrefix: Array<string>;
  }> = [
    {
      // badNames all start with "-", so the universal option-injection guard fires FIRST
      // with "refusing to pass an unsafe <label> name", before the grammar check.
      label: /unsafe D1 database name/,
      desired: (name) => ({ ...emptyDesired, d1: { binding: 'DB', name } }),
      createPrefix: ['d1', 'create'],
    },
    {
      label: /unsafe KV namespace name/,
      desired: (name) => ({ ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: name }] }),
      createPrefix: ['kv', 'namespace', 'create'],
    },
    {
      label: /unsafe R2 bucket name/,
      desired: (name) => ({ ...emptyDesired, r2: { binding: 'STORAGE', bucketName: name } }),
      createPrefix: ['r2', 'bucket', 'create'],
    },
    {
      label: /unsafe Hyperdrive config name/,
      desired: (name) => ({
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name, connectionString: 'postgres://x' },
      }),
      createPrefix: ['hyperdrive', 'create'],
    },
    {
      label: /unsafe queue name/,
      desired: (name) => ({ ...emptyDesired, queues: [name] }),
      createPrefix: ['queues', 'create'],
    },
  ];

  it('rejects option-like names for EVERY resource kind before any wrangler call', async () => {
    for (const bad of badNames) {
      for (const kind of kinds) {
        setup(JSON.stringify({ name: 'app' }));
        const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
        await expect(
          provisionCloudflareResources(tmpDir, wranglerPath, kind.desired(bad), {
            runWrangler: run,
            log: silentLog,
            listHyperdriveConfigs: async () => [],
          }),
        ).rejects.toThrow(kind.label);
        // No wrangler invocation at all — the name never reached argv.
        expect(calls).toEqual([]);
      }
    }
  });
});

describe('provisionCloudflareResources — signal-killed probe never authorizes create', () => {
  it('queues: a SIGTERM-killed probe with buffered "does not exist" text fails closed (no create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const killed = normalizeRunWranglerResult({
      stdout: '',
      stderr: 'X [ERROR] Queue "jobs" does not exist.',
      status: null,
      signal: 'SIGTERM',
    });
    const { run, calls } = makeRunner([{ match: /^queues info jobs/, reply: () => killed }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/queues info jobs.*failed/s);
    expect(calls.some((c) => isCall(c, 'queues', 'create'))).toBe(false);
  });

  it('R2: a SIGTERM-killed probe with buffered 10006 text fails closed (no create)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const killed = normalizeRunWranglerResult({
      stdout: '',
      stderr: 'X [ERROR] The bucket is not present [code: 10006]',
      status: null,
      signal: 'SIGTERM',
    });
    const { run, calls } = makeRunner([{ match: /^r2 bucket info /, reply: () => killed }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/r2 bucket info myapp-uploads.*(failed|refusing)/s);
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(false);
  });
});

describe('provisionCloudflareResources — create postcondition', () => {
  it('KV: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      // Success exit, but nothing written to config (simulates a killed child the
      // wrapper masked as exit 0, or a silent partial create).
      { match: /^kv namespace create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected KV namespace .*need a real id/s,
    );
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(true);
    expect(readConfig().kv_namespaces).toBeUndefined();
  });

  it('D1: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected D1 database .*need a real database_id/s,
    );
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('R2: a create that reports success but writes NO bucket fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      { match: /^r2 bucket create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected R2 bucket .*need a real bucket_name/s,
    );
    expect(readConfig().r2_buckets).toBeUndefined();
  });

  it('Hyperdrive: a create that reports success but writes NO id fails closed', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([{ match: /^hyperdrive create /, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      ),
    ).rejects.toThrow(
      /reported success but .* does not hold the expected Hyperdrive config .*need a real id/s,
    );
    expect(readConfig().hyperdrive).toBeUndefined();
  });
});

describe('provisionCloudflareResources — strict D1 identity', () => {
  it('adopts (not create) a list member with uuid:"" but a valid database_id', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        // Empty-string uuid must NOT shadow the valid database_id.
        reply: () =>
          ok(JSON.stringify([{ uuid: '', database_id: uuid('realdb'), name: 'myapp-db' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].database_id).toBe(uuid('realdb'));
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('realdb') });
  });

  it('fails closed when the target-named list member has conflicting non-empty ids (ambiguous)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ uuid: uuid('id-a'), database_id: uuid('id-b'), name: 'myapp-db' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
      // The WHOLE-LIST alias reconciler now rejects the conflicting
      // aliases before the claimant-level check even runs — same fail-closed outcome.
    ).rejects.toThrow(/no valid id.*agreeing on one id/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('rejects a 7502-collision `d1 info` payload with an id but NO name (unverified) — no adopt', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      { match: /^d1 info myapp-db --json/, reply: () => ok(JSON.stringify({ database_id: 'x' })) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a database with a matching name/);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('rejects a 7502-collision `d1 info` payload whose name MISMATCHES the request — no adopt', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      { match: /^d1 create /, reply: () => fail('', 'X [ERROR] already exists [code: 7502]') },
      {
        match: /^d1 info myapp-db --json/,
        reply: () => ok(JSON.stringify({ database_id: 'x', name: 'a-different-db' })),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not return a database with a matching name/);
    expect(readConfig().d1_databases).toBeUndefined();
  });
});

describe('provisionCloudflareResources — top-level env pin via --env=', () => {
  it('pins the top-level env on EVERY wrangler call even when CLOUDFLARE_ENV names a different env/account', async () => {
    // wrangler 4.131 reloads a project `.env`/`.env.local` into process.env on every
    // command, so a project `.env` with `CLOUDFLARE_ENV=staging` would reselect the
    // `env.staging` block (and ITS account) for discovery/create even though
    // `provisionEnv` deleted the var — while `--update-config` patches the TOP-LEVEL
    // config, a cross-account/config split. The reliable pin is the explicit empty
    // `--env=` on every argv: wrangler resolves `args.env ?? getCloudflareEnv()`, and
    // an explicit empty `args.env` short-circuits the `??` so the reloaded
    // CLOUDFLARE_ENV can never select a named env. Assert every call carries it and
    // the pinned account stays the top-level one.
    setup(JSON.stringify({ account_id: 'top-level-acct', name: 'app' }));
    const prevEnv = process.env.CLOUDFLARE_ENV;
    process.env.CLOUDFLARE_ENV = 'staging'; // as if repopulated from a project .env
    try {
      let created = false;
      const { run, calls } = makeRunner([
        { match: /^d1 list --json/, reply: () => ok('[]') },
        {
          match: /^d1 create /,
          reply: () => {
            simulateUpdateConfig('d1_databases', {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: uuid('created'),
            });
            return ok();
          },
        },
        {
          match: /^queues info jobs/,
          reply: () =>
            created ? ok('Queue Name: jobs') : fail('', 'Queue "jobs" does not exist.'),
        },
        {
          match: /^queues create jobs/,
          reply: () => {
            created = true;
            return ok();
          },
        },
      ]);
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' }, queues: ['jobs'] },
        { runWrangler: run, log: silentLog },
      );
      // EVERY invocation forces top-level via the explicit empty `--env=` token, so
      // discovery/create cannot drift to the staging env's account.
      expect(calls.length).toBeGreaterThan(0);
      for (const argv of calls) {
        expect(argv).toContain('--env=');
      }
      // No cross-account drift: the top-level account remains pinned.
      expect(readConfig().account_id).toBe('top-level-acct');
    } finally {
      if (prevEnv === undefined) {
        delete process.env.CLOUDFLARE_ENV;
      } else {
        process.env.CLOUDFLARE_ENV = prevEnv;
      }
    }
  });
});

describe('provisionCloudflareResources — boundary account fence', () => {
  it('fails closed BEFORE any INJECTED seam call when no account is resolvable', async () => {
    // The prior fence was gated on `!opts.runWrangler`, so an INJECTED runWrangler /
    // Hyperdrive lister did remote work with no effective (persisted) account — a
    // partial run under one account, retry under another with no reconciliation. The
    // boundary fence now fires unconditionally.
    setup(JSON.stringify({ name: 'app' })); // no account_id
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID; // no ambient account either
    try {
      let restCalled = false;
      const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            hyperdrive: {
              binding: 'HYPERDRIVE',
              name: 'myapp-hd',
              connectionString: 'postgres://x',
            },
          },
          {
            runWrangler: run, // INJECTED — old fence skipped this path
            log: silentLog,
            listHyperdriveConfigs: async () => {
              restCalled = true;
              return [];
            },
          },
        ),
      ).rejects.toThrow(/no Cloudflare account is resolvable/);
      // No wrangler call, no REST call, and nothing persisted — fence is at the boundary.
      expect(calls).toEqual([]);
      expect(restCalled).toBe(false);
      expect(readConfig().account_id).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = prev;
      }
    }
  });
});

describe('provisionCloudflareResources — absolute config path', () => {
  it('resolves a RELATIVE rootWranglerPath against root (not cwd) so reads + wrangler ops target ONE file', async () => {
    // root !== process.cwd(): a bare relative config path would make Node reads/writes
    // resolve against cwd while the default wrangler (cwd: root) resolves `-c` against
    // root — a split (inspect one file, create against another). The provisioner
    // resolves the path to an ABSOLUTE one against `root` ONCE, up front.
    setup(JSON.stringify({ account_id: 'acct', name: 'app' })); // at tmpDir/wrangler.jsonc
    const relPath = 'wrangler.jsonc'; // relative to root (tmpDir), NOT to process.cwd()
    const abs = join(tmpDir, relPath);
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir, // root — absolute, and different from process.cwd()
      relPath, // RELATIVE config path
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    // Returned + threaded config path is the absolute resolution against root.
    expect(result.configPath).toBe(toSlash(abs));
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf('-c');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(toSlash(abs)); // wrangler `-c` is the SAME absolute file
    }
    // The adopted id landed in root/wrangler.jsonc — the file Node read from too.
    const after = parseJsoncRaw(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
    expect((after.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('kv'));
  });
});

describe('provisionCloudflareResources — one D1 normalizer', () => {
  it('fails closed on CONFLICTING name aliases (name vs database_name) for the requested database', async () => {
    // The exact scenario: a list member claims the requested name via `name` but its
    // `database_name` disagrees. The old two-helper split SELECTED it by `name` yet
    // normalized its identity under `database_name` — adopting a WRONG identity. The one
    // normalizer rejects the conflict (fail closed, no adopt/create).
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'myapp-db', database_name: 'other-db', database_id: uuid('the-id') },
            ]),
          ),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/ambiguous or empty id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(readConfig().d1_databases).toBeUndefined();
  });

  it('fails closed when TWO list entries both match the requested name (ambiguous)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'myapp-db', database_id: uuid('id-1') },
              { name: 'myapp-db', database_id: uuid('id-2') },
            ]),
          ),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/2 D1 databases named/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('adopts the single unambiguous match (agreeing aliases + uuid) — no create', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([{ name: 'myapp-db', database_name: 'myapp-db', uuid: uuid('theid') }]),
          ),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('theid') });
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].database_id).toBe(uuid('theid'));
  });
});

describe('provisionCloudflareResources — transport account context', () => {
  it('threads the reconciled account into EVERY wrangler call AND the Hyperdrive lister', async () => {
    // Config pins the account → it is the reconciled effective account (config wins
    // over the ambient CLOUDFLARE_ACCOUNT_ID). Every seam invocation must receive it.
    setup(JSON.stringify({ account_id: 'reconciled-acct' }));
    const seenRunAccounts: Array<string> = [];
    const seenListAccounts: Array<string> = [];
    const run: RunWrangler = provisionOperationFixture((args, opts) => {
      seenRunAccounts.push(opts.accountId);
      const sub = args.join(' ');
      if (/^d1 list --json/.test(sub)) {
        return ok('[]');
      }
      if (/^d1 create /.test(sub)) {
        simulateUpdateConfig('d1_databases', {
          binding: 'DB',
          database_name: 'myapp-db',
          database_id: uuid('dbid'),
        });
        return ok();
      }
      if (/^kv namespace list/.test(sub)) {
        return ok('[]');
      }
      if (/^kv namespace create /.test(sub)) {
        simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('kvid') });
        return ok();
      }
      return ok();
    });
    await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
        // Empty connection string → only the existence check runs (no create), so the
        // lister IS invoked and records the account it was called with.
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
      },
      {
        runWrangler: run,
        log: silentLog,
        listHyperdriveConfigs: async ({ accountId }) => {
          seenListAccounts.push(accountId);
          return [];
        },
      },
    );
    expect(seenRunAccounts.length).toBeGreaterThan(0);
    for (const acct of seenRunAccounts) {
      expect(acct).toBe('reconciled-acct');
    }
    expect(seenListAccounts).toEqual(['reconciled-acct']);
  });
});

describe('provisionCloudflareResources — boundary duplicate-member guard', () => {
  it('fails closed at entry on a config with duplicate kv_namespaces members — NO wrangler/REST calls', async () => {
    // jsonc-parser.parse() (used by readRootConfig) silently resolves a duplicate to
    // the LAST member, so without the boundary guard a `kv namespace create` could
    // orphan or a reuse be false. The SAME strict detector the writer uses runs at the
    // provisioner boundary — before account persistence, discovery, or any remote work.
    setup(`{
  "account_id": "acct",
  "kv_namespaces": [{ "binding": "KV", "id": "aaa" }],
  "kv_namespaces": [{ "binding": "KV", "id": "bbb" }]
}`);
    let restCalled = false;
    const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            restCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/duplicate key "kv_namespaces"/);
    expect(calls).toEqual([]);
    expect(restCalled).toBe(false);
  });
});

describe('provisionCloudflareResources — Hyperdrive list validation at the caller', () => {
  const hdDesired: DesiredResourceSet = {
    ...emptyDesired,
    hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
  };

  function provisionWithInjectedList(list: Array<unknown>): Promise<unknown> {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([{ match: /.*/, reply: () => ok() }]);
    return provisionCloudflareResources(tmpDir, wranglerPath, hdDesired, {
      runWrangler: run,
      log: silentLog,
      // The injected lister LIES about its return type — the caller-side validator must
      // reject the malformed shape at runtime rather than adopt an empty/garbage id.
      listHyperdriveConfigs: async () => list as never,
    });
  }

  it('fails closed on an injected entry with an EMPTY id — never adopts', async () => {
    await expect(provisionWithInjectedList([{ id: '', name: 'myapp-hd' }])).rejects.toThrow(
      /malformed config entry/,
    );
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a non-object member', async () => {
    await expect(provisionWithInjectedList([null])).rejects.toThrow(/malformed config entry/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a duplicate id across members', async () => {
    await expect(
      provisionWithInjectedList([
        { id: hex32('dup'), name: 'other' },
        { id: hex32('dup'), name: 'myapp-hd' },
      ]),
    ).rejects.toThrow(/duplicate config id/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on 2 configs sharing the requested name (ambiguous)', async () => {
    await expect(
      provisionWithInjectedList([
        { id: hex32('x'), name: 'myapp-hd' },
        { id: hex32('y'), name: 'myapp-hd' },
      ]),
    ).rejects.toThrow(/share that name/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on a NON-matching member with a malformed id (no create)', async () => {
    // A member for a DIFFERENT config carries a bogus (non-hex) id. Previously this passed
    // the whole-list gate (only the name-matched member was format-checked), so an ABSENT
    // target authorized a blind create against a possibly-untrustworthy list. Now every
    // member's id is format-validated up front → fail closed, NO create.
    await expect(
      provisionWithInjectedList([{ id: 'bogus', name: 'someone-else' }]),
    ).rejects.toThrow(/malformed id "bogus".*32-character hex Hyperdrive id/s);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  // A runtime null/undefined/non-array OUTER result must be treated as UNKNOWN
  // (never coerced to "empty" = confirmed absence), so it fails closed BEFORE any
  // create instead of authorizing a blind `hyperdrive create` on a same-named config.
  for (const [label, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['a non-array object', { configs: [] }],
    ['a string', 'nope'],
  ] as const) {
    it(`fails closed (no create) when the lister returns ${label}`, async () => {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([{ match: /.*/, reply: () => ok() }]);
      await expect(
        provisionCloudflareResources(tmpDir, wranglerPath, hdDesired, {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => bad as never,
        }),
      ).rejects.toThrow(/cannot verify whether Hyperdrive config "myapp-hd"/);
      // No blind create, and nothing written to the config.
      expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
      expect(readConfig().hyperdrive).toBeUndefined();
    });
  }
});

describe('provisionCloudflareResources — whole-list id-format gate (D1 + KV, before name filtering)', () => {
  it('D1: a NON-matching list member with a malformed id fails the whole list closed (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      // A different database with a bogus (non-UUID) id. Target "myapp-db" is absent, but
      // the untrustworthy member must reject the list rather than authorize a create.
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'other', database_id: 'bogus' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('KV: a NON-matching list member with a malformed id fails the whole list closed (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ title: 'other', id: 'bogus' }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(false);
  });

  it('D1: a well-formed non-matching member still allows the target to be created (absence is authoritative)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'other', database_id: uuid('other') }])),
      },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('mine'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'created' },
    ]);
  });
});

describe('provisionCloudflareResources — strict duplicate-safe binding reader', () => {
  it('read-first fails closed on DUPLICATE same-binding entries in the target field (not reused)', async () => {
    // Two d1_databases entries share binding "DB" — the old first-match `.find()` would
    // silently pick one and report `reused`. The strict reader fails closed.
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [
          { binding: 'DB', database_id: uuid('a'), database_name: 'myapp-db' },
          { binding: 'DB', database_id: uuid('b'), database_name: 'myapp-db' },
        ],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    // Failed closed before any wrangler call — never reused/created.
    expect(calls.length).toBe(0);
  });

  it('read-first fails closed on a CROSS-TYPE collision (binding used by another field) — not reused', async () => {
    // Binding "DB" is bound to BOTH a d1_databases entry AND a kv_namespaces entry — an
    // undeployable config wrangler rejects. Reading the D1 entry must fail closed (via the
    // reused Task-3 collision collector) rather than report `reused` on a broken config.
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_id: uuid('a'), database_name: 'myapp-db' }],
        kv_namespaces: [{ binding: 'DB', id: hex32('kv') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "DB" in "d1_databases" is also used by a KV Namespace binding/);
    expect(calls.length).toBe(0);
  });

  it('read-first fails closed when a QUEUE PRODUCER collides with the binding (cross-type) — not reused', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        kv_namespaces: [{ binding: 'CACHE', id: hex32('cache') }],
        queues: { producers: [{ binding: 'CACHE', queue: 'jobs' }] },
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'CACHE', title: 'cache' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/binding "CACHE" in "kv_namespaces" is also used by a Queue binding/);
    expect(calls.length).toBe(0);
  });

  it('reuses cleanly when the binding is unique across the worker (no false collision)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_id: uuid('db'), database_name: 'myapp-db' }],
        kv_namespaces: [{ binding: 'CACHE', id: hex32('cache') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: uuid('db') },
    ]);
    // Reused via read-first — no discovery/create.
    expect(calls.some((c) => isCall(c, 'd1', 'list'))).toBe(false);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });
});

describe('provisionCloudflareResources — resource-specific create postcondition', () => {
  it('R2: fails closed when create writes a DIFFERENT bucket_name than requested', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          // create "succeeds" but writes a DIFFERENT bucket than requested (a race /
          // stale --update-config / wrong-account write). bucket_name IS the identity.
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'other-bucket' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected R2 bucket .*bucket_name === "myapp-uploads"/s);
  });

  it('D1: fails closed when create writes a real id but a MISMATCHED database_name', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'other-db',
            database_id: 'real-id',
          });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected D1 database .*database_name === "myapp-db"/s);
  });
});

describe('provisionCloudflareResources — resource-specific real-id validators', () => {
  it('KV: an id of " " is NOT real — runs discovery instead of read-first reuse', async () => {
    setup(JSON.stringify({ account_id: 'acct', kv_namespaces: [{ binding: 'KV', id: ' ' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list/,
        reply: () => ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'list'))).toBe(true);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: hex32('kv') });
  });

  it('D1: an id of "xyz" is NOT real — runs discovery instead of read-first reuse', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: 'xyz' }],
      }),
    );
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'myapp-db', database_id: uuid('db') }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'list'))).toBe(true);
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: uuid('db') });
  });

  it('KV: create postcondition FAILS when --update-config wrote a non-hex id', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create/,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: 'not-a-real-id' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/does not hold the expected KV namespace/);
  });

  it('D1: a correctly-formatted UUID is accepted as read-first reuse (no wrangler call)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0]).toMatchObject({ action: 'reused', id: uuid('db') });
    expect(calls.some((c) => isCall(c, 'd1', 'list'))).toBe(false);
  });
});

describe('provisionCloudflareResources — KV title grammar vs option-injection guard', () => {
  it('accepts a KV title with spaces ("My Own Namespace") and passes it as ONE literal argv element', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create/,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('kv') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'My Own Namespace' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0]).toMatchObject({ kind: 'kv', action: 'created' });
    const createCall = calls.find((c) => isCall(c, 'kv', 'namespace', 'create'));
    expect(createCall).toContain('My Own Namespace'); // single token, not split on spaces
  });

  it('rejects a leading-"-" name for every resource kind before any wrangler call', async () => {
    const desireds = [
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: '--help' }] },
      { ...emptyDesired, d1: { binding: 'DB', name: '-x' } },
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: '-b' } },
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HD', name: '--config', connectionString: 'postgres://x' },
      },
      { ...emptyDesired, queues: ['-q'] },
    ];
    for (const desired of desireds) {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(tmpDir, wranglerPath, desired, {
          runWrangler: run,
          log: silentLog,
        }),
      ).rejects.toThrow(/unsafe|refusing to pass/);
      expect(calls.length).toBe(0);
    }
  });

  it('rejects an R2 bucket name with invalid characters (uppercase/underscore)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'My_Bucket' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/invalid R2 bucket name/);
    expect(calls.length).toBe(0);
  });
});

describe('provisionCloudflareResources — queue name grammar (Cloudflare Queues)', () => {
  const provisionQueue = (name: string): Promise<unknown> => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run, calls } = makeRunner([
      { match: /^queues info /, reply: () => ok(`Queue Name: ${name}`) },
    ]);
    return provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: [name] },
      { runWrangler: run, log: silentLog },
    ).then((r) => {
      // Return the calls so accepted-name tests can assert wrangler was reached.
      (r as { _calls?: unknown })._calls = calls;
      return r;
    });
  };

  // Underscores are NOT allowed; a trailing separator is NOT allowed; > 63 chars rejected.
  for (const bad of ['jobs_v2', 'jobs_', 'jobs-', '_jobs', '-jobs', 'a'.repeat(64)]) {
    it(`rejects the invalid queue name ${JSON.stringify(bad)} before any wrangler call`, async () => {
      setup(JSON.stringify({ account_id: 'acct' }));
      const { run, calls } = makeRunner([]);
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, queues: [bad] },
          { runWrangler: run, log: silentLog },
        ),
      ).rejects.toThrow(/unsafe queue name|invalid queue name/);
      expect(calls.length).toBe(0);
    });
  }

  // Valid: single alphanumeric, 63 chars, and internal dashes.
  for (const good of ['a', 'Q9', 'a'.repeat(63), 'jobs-v2', 'my-queue-1']) {
    it(`accepts the valid queue name ${JSON.stringify(good)} (reaches wrangler)`, async () => {
      const result = (await provisionQueue(good)) as {
        resources: Array<{ kind: string; action: string }>;
        _calls: Array<Array<string>>;
      };
      expect(result.resources).toEqual([{ kind: 'queue', name: good, action: 'reused' }]);
      expect(result._calls.some((c) => isCall(c, 'queues', 'info'))).toBe(true);
    });
  }
});

describe('provisionCloudflareResources — whole-provision cross-process lock (proper-lockfile)', () => {
  // proper-lockfile uses a synthetic adjacent identity without creating that pathname;
  // the actual mutex is a `${target}.lock` DIRECTORY and is removed on release.
  const lockTarget = `${wranglerPath}.void-provision.lock`;
  const recoveryTarget = `${lockTarget}.recovery`;
  const lockMutex = `${lockTarget}.lock`;
  const recoveryMutex = `${recoveryTarget}.lock`;
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('a SECOND in-process provision fails fast with a clear hard error (at most one per process)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('hd-1') });
        return ok();
      }
      return ok();
    });
    const desired = {
      ...emptyDesired,
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
    };
    const opts = {
      runWrangler: run,
      log: silentLog,
      // Keep the first provision ACTIVE long enough that the second demonstrably starts
      // while it runs (the guard is taken synchronously at entry regardless).
      listHyperdriveConfigs: async (): Promise<Array<never>> => {
        await delay(60);
        return [];
      },
    };
    const first = provisionCloudflareResources(tmpDir, wranglerPath, desired, opts);
    // The second provision starts while the first is active → the process-wide guard
    // rejects it OUTRIGHT (no lock contention, no wrangler work, no config read).
    await expect(provisionCloudflareResources(tmpDir, wranglerPath, desired, opts)).rejects.toThrow(
      /a provision is already active in this process.*run provisions sequentially/s,
    );
    const result = await first;
    expect(result.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(createCalls).toBe(1);
    // Mutex always released — no leak; and the slot freed: a THIRD (sequential) run works.
    expect(existsSync(lockMutex)).toBe(false);
    const third = await provisionCloudflareResources(tmpDir, wranglerPath, desired, opts);
    expect(third.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
  });

  it('leaves no persistent marker files and lets different app configs lock concurrently', async () => {
    setup(JSON.stringify({ name: 'app-a' }));
    const otherDir = join(tmpDir, 'other-app');
    const otherConfig = join(otherDir, 'wrangler.jsonc');
    const otherLockTarget = `${otherConfig}.void-provision.lock`;
    const otherRecoveryTarget = `${otherLockTarget}.recovery`;
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(otherConfig, JSON.stringify({ name: 'app-b' }));

    const first = await acquireProvisionLock(wranglerPath, { retries: 0 });
    const second = await acquireProvisionLock(otherConfig, { retries: 0 });
    try {
      // Both are held at once: lock identity is per canonical config, not machine-global.
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(`${otherLockTarget}.lock`)).toBe(true);
      // Synthetic identities never materialize as empty files in either project.
      expect(existsSync(lockTarget)).toBe(false);
      expect(existsSync(recoveryTarget)).toBe(false);
      expect(existsSync(otherLockTarget)).toBe(false);
      expect(existsSync(otherRecoveryTarget)).toBe(false);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }

    expect(existsSync(lockMutex)).toBe(false);
    expect(existsSync(recoveryMutex)).toBe(false);
    expect(existsSync(`${otherLockTarget}.lock`)).toBe(false);
    expect(existsSync(`${otherRecoveryTarget}.lock`)).toBe(false);
  });

  it('two concurrent provisions in SEPARATE processes race — exactly ONE create, the other reuses, mutex released', async () => {
    // With at most one provision per process, concurrent provisioning is a
    // CROSS-process story by definition, so the serialization proof runs two REAL node
    // processes racing the same config under the on-disk whole-provision lock.
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const probe = join(tmpDir, 'race-probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { provisionCloudflareResources } from ${JSON.stringify(provisionUrl)};\n` +
        `const cfgPath = ${JSON.stringify(wranglerPath)};\n` +
        `const run = (args) => {\n` +
        `  if (args.type === 'hyperdrive.create') {\n` +
        `    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));\n` +
        `    cfg.hyperdrive = [{ binding: 'HYPERDRIVE', id: process.argv[2] }];\n` +
        `    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));\n` +
        `  }\n` +
        `  return { stdout: '', stderr: '', status: 0 };\n` +
        `};\n` +
        `provisionCloudflareResources(${JSON.stringify(tmpDir)}, cfgPath, {\n` +
        `  kvNamespaces: [],\n` +
        `  queues: [],\n` +
        `  hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },\n` +
        `}, {\n` +
        `  runWrangler: run,\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `  // Barrier: the winner holds the lock while LISTING, so the loser must block\n` +
        `  // on the on-disk lock (proving the LOCK, not sequencing, serializes them).\n` +
        `  listHyperdriveConfigs: () => new Promise((r) => setTimeout(() => r([]), 300)),\n` +
        `}).then(\n` +
        `  (res) => console.log('ACTION:' + res.resources.find((r) => r.kind === 'hyperdrive').action),\n` +
        `  (err) => { console.log('REJECTED:' + err.message); process.exitCode = 7; },\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const runChild = (id: string): Promise<{ code: number | null; stdout: string }> =>
      new Promise((res) => {
        const child = spawn(process.execPath, [probe, hex32(id)], {
          cwd: tmpDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.on('close', (code) => res({ code, stdout }));
      });
    const [a, b] = await Promise.all([runChild('hd-a'), runChild('hd-b')]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const actions = [a.stdout, b.stdout].map((s) => s.match(/ACTION:(\w+)/)?.[1]).sort();
    // Exactly one create; the loser's read-first (under the lock) reused the winner's id.
    expect(actions).toEqual(['created', 'reused']);
    // Mutex always released — no leak.
    expect(existsSync(lockMutex)).toBe(false);
  }, 30_000);

  it('recovers a STALE/abandoned lock (old mtime, crashed owner) and proceeds', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    // Simulate a crashed owner's abandoned mutex dir whose mtime is well past the 120s
    // stale window, so proper-lockfile compromises + steals it.
    mkdirSync(lockMutex);
    const old = new Date(Date.now() - 300_000);
    utimesSync(lockMutex, old, old);
    const { run } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: hex32('hd-real') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
      },
      { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
    );
    expect(result.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('always releases the lock even when the provision THROWS (no leak)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const { run } = makeRunner([{ match: /^hyperdrive create /, reply: () => fail('', 'boom') }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      ),
    ).rejects.toThrow(/hyperdrive create myapp-hd.*failed/s);
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('acquireProvisionLock serializes — a second acquire waits until the first releases, then proceeds; release always frees it', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const first = await acquireProvisionLock(wranglerPath);
    expect(existsSync(lockMutex)).toBe(true);
    let secondAcquired = false;
    const secondPromise = acquireProvisionLock(wranglerPath).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    // While the first holds the lock the second cannot acquire (it retries/blocks).
    await delay(60);
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    // Release is idempotent and always frees the mutex.
    await second.release();
    await second.release();
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('a provision via a SYMLINK ALIAS contends on the SAME canonical lock and reuses the id written via the real path', async () => {
    // A real config + a symlink alias to it. Both paths hit the SAME underlying file but
    // via DIFFERENT lexical paths. Without realpath canonicalization each derives its
    // own mutex dir (`<lexical>.void-provision.lock.lock`), so an alias provision would not
    // contend on the real path's lock and both could create a duplicate. (Two
    // provisions can no longer race in ONE process — the identity proof is that the
    // alias provision blocks on the CANONICAL mutex, plus create-then-reuse across the
    // two names on the one underlying file.)
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const aliasName = 'wrangler.alias.jsonc';
    symlinkSync(wranglerPath, join(tmpDir, aliasName));
    // Sanity: the alias and the real config canonicalize to the same real file.
    expect(realpathSync(join(tmpDir, aliasName))).toBe(realpathSync(wranglerPath));
    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        simulateUpdateConfig('hyperdrive', {
          binding: 'HYPERDRIVE',
          id: hex32('hd-' + createCalls),
        });
        return ok();
      }
      return ok();
    });
    const makeProv = (
      configArg: string,
      retries?: number,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> =>
      provisionCloudflareResources(
        tmpDir,
        configArg,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          ...(retries !== undefined ? { lockOptions: { retries } } : {}),
        },
      ) as Promise<{ resources: Array<{ kind: string; action: string }> }>;
    // IDENTITY: while the CANONICAL lock is held, an alias-path provision cannot acquire
    // (it resolves to the same mutex — pre-fix it would derive its own and proceed).
    const held = await acquireProvisionLock(realpathSync(wranglerPath));
    await expect(makeProv(aliasName, 0)).rejects.toThrow(/already being held/);
    await held.release();
    // One underlying file: a create via the REAL path is read-first-REUSED via the alias.
    const a = await makeProv(wranglerPath);
    const b = await makeProv(aliasName);
    expect(a.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(b.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
    // The single canonical mutex was released.
    expect(existsSync(`${realpathSync(wranglerPath)}.void-provision.lock.lock`)).toBe(false);
  });

  it('a SECOND first-run under a different account fails closed on the persisted pin, no cross-account write', async () => {
    // Neither run has a config account_id at start. The first run persists its own
    // account and provisions; the second — reading the now-pinned config — fails closed
    // on the A≠B mismatch BEFORE any create, so it never rebinds the winner's resources.
    // (Two provisions can no longer race in ONE process — the guard rejects
    // the second outright — so the reconciliation contract is proven sequentially; the
    // cross-process serialization itself is proven by the child-process race test above.)
    setup(JSON.stringify({ name: 'app' }));
    const savedAmbient = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID; // force reconciliation via opts.accountId only
    try {
      const makeProv = (account: string): Promise<unknown> => {
        const run: RunWrangler = provisionOperationFixture((args) => {
          if (isCall(args, 'd1', 'list')) {
            return ok('[]');
          }
          if (isCall(args, 'd1', 'create')) {
            simulateUpdateConfig('d1_databases', {
              binding: 'DB',
              database_name: 'myapp-db',
              database_id: uuid('db-' + account),
            });
            return ok();
          }
          return ok();
        });
        return provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
          {
            runWrangler: run,
            accountId: account,
            log: silentLog,
            listHyperdriveConfigs: async () => [],
          },
        );
      };
      await makeProv('acct-A');
      await expect(makeProv('acct-B')).rejects.toThrow(/account mismatch/);
      // The config stays pinned to the WINNER, with the winner's D1 id — no
      // cross-account overwrite (the loser never ran a wrangler create).
      const cfg = readConfig();
      expect(cfg.account_id).toBe('acct-A');
      const d1 = (cfg.d1_databases as Array<Record<string, unknown>>)[0];
      expect(d1.database_id).toBe(uuid('db-acct-A'));
      // Mutex released — no leak.
      expect(existsSync(lockMutex)).toBe(false);
    } finally {
      if (savedAmbient === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = savedAmbient;
      }
    }
  });

  it('a wrangler call blocking past a SHORT stale window does NOT let a second process steal the mutex (async heartbeat keeps it fresh)', async () => {
    setup(JSON.stringify({ account_id: 'acct', kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const run: RunWrangler = provisionOperationFixture(async (args) => {
      if (isCall(args, 'kv', 'namespace', 'list')) {
        // blocks (async) longer than the probe below, which is past the 2s stale window
        await delay(2400);
        return ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }]));
      }
      return ok();
    });
    const prov = provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog, lockOptions: { stale: 2000, update: 1000, retries: 0 } },
    );
    // 2.2s into the block — PAST the 2s stale window (proper-lockfile floors stale at 2000
    // and update at 1000, so 2.2s is the minimum that proves freshness). If the async
    // heartbeat did not keep the mutex fresh, a retries:0 acquire would STEAL it; it must
    // be REFUSED instead.
    await delay(2200);
    await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow();
    const result = await prov;
    expect(result.resources[0]).toMatchObject({ kind: 'kv', action: 'adopted', id: hex32('kv') });
    expect(existsSync(lockMutex)).toBe(false);
  }, 15000);

  it('a genuine unlock failure REJECTS the provision (leaked mutex surfaced, not swallowed)', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const failingFs = {
      ...passthruFs,
      rmdir: (_p: string, cb: (e: Error | null) => void) =>
        cb(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    };
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
        log: silentLog,
        lockOptions: { fs: failingFs },
      }),
    ).rejects.toThrow(/failed to release the cross-process provision lock/);
  });

  it('a body failure COMBINED with an unlock failure surfaces BOTH (AggregateError)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    // rmdir fails → the mutex leaks on release; the body also fails (hyperdrive create).
    const failingFs = {
      ...passthruFs,
      rmdir: (_p: string, cb: (e: Error | null) => void) =>
        cb(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    };
    const { run } = makeRunner([
      { match: /^hyperdrive create /, reply: () => fail('', 'boom-body') },
    ]);
    let caught: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          lockOptions: { fs: failingFs },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    const messages = agg.errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join(' || ');
    // BOTH the body (hyperdrive create) error AND the leaked-mutex release error surface.
    expect(messages).toMatch(/hyperdrive create myapp-hd.*failed.*boom-body/s);
    expect(messages).toMatch(/failed to release the cross-process provision lock/);
    // The primary body error is also preserved as `cause` for cause-walking loggers.
    expect((agg.cause as Error).message).toMatch(/hyperdrive create/);
  });
});

describe('provisionCloudflareResources — config compliance_region pins the transport', () => {
  it('resolvePinnedApiBaseUrl honors the config compliance_region (fedramp) with no ambient override', () => {
    // Config says fedramp_high, no CLOUDFLARE_COMPLIANCE_REGION ambient → the FedRAMP base.
    expect(resolvePinnedApiBaseUrl({}, 'fedramp_high')).toBe(
      'https://api.fed.cloudflare.com/client/v4',
    );
    // Config "public" → public base; absent config → public base.
    expect(resolvePinnedApiBaseUrl({}, 'public')).toBe('https://api.cloudflare.com/client/v4');
    expect(resolvePinnedApiBaseUrl({}, undefined)).toBe('https://api.cloudflare.com/client/v4');
  });

  it('resolvePinnedApiBaseUrl fails closed on a config-vs-ambient compliance_region conflict', () => {
    expect(() =>
      resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'public' }, 'fedramp_high'),
    ).toThrow(/conflicting values/);
    // Equal on both sides is fine (no conflict).
    expect(
      resolvePinnedApiBaseUrl({ CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' }, 'fedramp_high'),
    ).toBe('https://api.fed.cloudflare.com/client/v4');
  });

  it('rejects an invalid config compliance_region value', () => {
    expect(() => resolvePinnedApiBaseUrl({}, 'somewhere')).toThrow(
      /one of "public" or "fedramp_high"/,
    );
  });

  it('a fedramp config pins BOTH the wrangler child env AND the Hyperdrive REST lister to the .fed base', async () => {
    const prev = process.env.CLOUDFLARE_COMPLIANCE_REGION;
    delete process.env.CLOUDFLARE_COMPLIANCE_REGION; // no ambient override — config is authoritative
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        compliance_region: 'fedramp_high',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    let seen: { apiBaseUrl: string } | undefined;
    const calls: Array<Array<string>> = [];
    const run: RunWrangler = provisionOperationFixture((args, opts) => {
      calls.push(args);
      // The wrangler child is pinned to the SAME base via its env transport context.
      expect(opts.apiBaseUrl).toBe('https://api.fed.cloudflare.com/client/v4');
      return { stdout: '', stderr: '', status: 0 };
    });
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async (ctx) => {
            seen = ctx;
            return [];
          },
        },
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_COMPLIANCE_REGION;
      } else {
        process.env.CLOUDFLARE_COMPLIANCE_REGION = prev;
      }
    }
    expect(seen?.apiBaseUrl).toBe('https://api.fed.cloudflare.com/client/v4');
  });

  it('fails closed when the config compliance_region conflicts with an ambient CLOUDFLARE_COMPLIANCE_REGION', async () => {
    const prev = process.env.CLOUDFLARE_COMPLIANCE_REGION;
    process.env.CLOUDFLARE_COMPLIANCE_REGION = 'public';
    setup(
      JSON.stringify({
        account_id: 'config-acct',
        compliance_region: 'fedramp_high',
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }],
      }),
    );
    let listerCalled = false;
    const { run } = makeRunner([]);
    try {
      await expect(
        provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            hyperdrive: {
              binding: 'HYPERDRIVE',
              name: 'myapp-hd',
              connectionString: 'postgres://x',
            },
          },
          {
            runWrangler: run,
            log: silentLog,
            listHyperdriveConfigs: async () => {
              listerCalled = true;
              return [];
            },
          },
        ),
      ).rejects.toThrow(/conflicting values/);
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_COMPLIANCE_REGION;
      } else {
        process.env.CLOUDFLARE_COMPLIANCE_REGION = prev;
      }
    }
    // Failed closed before any remote work.
    expect(listerCalled).toBe(false);
  });
});

describe('provisionCloudflareResources — wrangler-exact base resolution order', () => {
  it('an INVALID WRANGLER_API_ENVIRONMENT fails closed (wrangler assertOneOf) instead of pinning prod', () => {
    // wrangler's env factory has choices ["production","staging"]; a present out-of-choices
    // value (typo'd "stagng", or an empty string) throws — never silently public production.
    expect(() => resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'stagng' })).toThrow(
      /WRANGLER_API_ENVIRONMENT.*"production" or "staging".*"stagng"/s,
    );
    expect(() => resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: '' })).toThrow(
      /WRANGLER_API_ENVIRONMENT/,
    );
    // An explicit "production" is a valid choice → the public base.
    expect(resolvePinnedApiBaseUrl({ WRANGLER_API_ENVIRONMENT: 'production' })).toBe(
      'https://api.cloudflare.com/client/v4',
    );
  });

  it('an empty direct base override is honored AS-IS (presence + nullish semantics, like wrangler)', () => {
    // wrangler: `getCloudflareApiBaseUrlFromEnv() ?? derived` — a PRESENT empty string is
    // returned (nullish, not falsy, coalescing) and CLOUDFLARE_* presence beats CF_*.
    expect(resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: '' })).toBe('');
    expect(
      resolvePinnedApiBaseUrl({
        CLOUDFLARE_API_BASE_URL: '',
        CF_API_BASE_URL: 'https://cf.example',
      }),
    ).toBe('');
    expect(resolvePinnedApiBaseUrl({ CF_API_BASE_URL: '' })).toBe('');
  });

  it('provisionEnv pins a resolved EMPTY base into the child env (presence, not truthiness)', () => {
    const env = provisionEnv({ accountId: 'acct', apiBaseUrl: '' });
    // The child wrangler must see the SAME (empty) override the ambient env carried — never
    // a scrubbed env that would silently re-derive the default endpoint (split-brain).
    expect(env.CLOUDFLARE_API_BASE_URL).toBe('');
  });

  it('a direct base + CONFLICTING compliance settings resolves to the direct base (no false reject)', () => {
    // wrangler's `??` short-circuits past getComplianceRegionSubdomain when a direct base is
    // present, so the env-vs-config conflict is never evaluated there.
    expect(
      resolvePinnedApiBaseUrl(
        {
          CLOUDFLARE_API_BASE_URL: 'https://direct.example',
          CLOUDFLARE_COMPLIANCE_REGION: 'public',
        },
        'fedramp_high',
      ),
    ).toBe('https://direct.example');
    // Same for an invalid STAGING selector — unread on the direct branch.
    expect(
      resolvePinnedApiBaseUrl({
        CLOUDFLARE_API_BASE_URL: 'https://direct.example',
        WRANGLER_API_ENVIRONMENT: 'stagng',
      }),
    ).toBe('https://direct.example');
  });

  it('the config compliance_region VALUE is still validated with a direct base present (wrangler config validation)', () => {
    expect(() =>
      resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: 'https://direct.example' }, 'bogus'),
    ).toThrow(/one of "public" or "fedramp_high"/);
  });
});

describe('provisionCloudflareResources — Hyperdrive password never reaches wrangler diagnostics', () => {
  it('provisionEnv scrubs the session-output sinks and PINS sanitized logging', () => {
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string): void => {
      saved[k] = process.env[k];
      process.env[k] = v;
    };
    set('WRANGLER_OUTPUT_FILE_PATH', '/tmp/wrangler-output.json');
    set('WRANGLER_OUTPUT_FILE_DIRECTORY', '/tmp/wrangler-output');
    set('WRANGLER_LOG_SANITIZE', 'false');
    try {
      const env = provisionEnv({ accountId: 'acct' });
      // Output sinks would persist the raw argv (connection string password included).
      expect(env.WRANGLER_OUTPUT_FILE_PATH).toBeUndefined();
      expect(env.WRANGLER_OUTPUT_FILE_DIRECTORY).toBeUndefined();
      // Sanitized logging is PINNED — an ambient `false` is never passed through.
      expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('FAILS CLOSED when a project dotenv declares WRANGLER_OUTPUT_FILE_DIRECTORY (would resurrect the argv leak)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'WRANGLER_OUTPUT_FILE_DIRECTORY=/tmp/wrangler-out\n');
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /refusing to provision.*\.env.*WRANGLER_OUTPUT_FILE_DIRECTORY.*session diagnostics/s,
    );
    expect(calls.length).toBe(0);
  });

  it('FAILS CLOSED when a project dotenv declares WRANGLER_OUTPUT_FILE_PATH', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env.local'), 'WRANGLER_OUTPUT_FILE_PATH=/tmp/out.json\n');
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/WRANGLER_OUTPUT_FILE_PATH/);
    expect(calls.length).toBe(0);
  });

  it('redacts the exact connection string AND URL userinfo passwords from propagated errors', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const { run } = makeRunner([
      {
        // The create fails, ECHOING the connection string (verbatim AND re-rendered).
        match: /^hyperdrive create /,
        reply: () =>
          fail(
            '',
            `X [ERROR] could not connect using ${conn} ` +
              `(also tried mysql://dbuser:sup3r-secret@db.example.com/app)`,
          ),
      },
    ]);
    let thrown: Error | undefined;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    // The password never appears — neither via the verbatim echo nor the re-rendered URL.
    expect(thrown!.message).not.toContain('sup3r-secret');
    expect(thrown!.message).not.toContain(conn);
    expect(thrown!.message).toContain('[REDACTED]');
  });

  it('a seam rejecting a password-bearing plain STRING is redacted before propagation', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const run: RunWrangler = provisionOperationFixture(() =>
      Promise.reject(`hyperdrive create failed for ${conn}`),
    );
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('sup3r-secret');
    expect((thrown as Error).message).not.toContain(conn);
    expect((thrown as Error).message).toContain('[REDACTED]');
  });

  it('a QUARANTINE rejection keeps its identity/metadata while its message is redacted', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const lockMutex = `${wranglerPath}.void-provision.lock.lock`;
    const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
    const conn = 'postgres://dbuser:sup3r-secret@db.example.com:5432/app';
    const quarantineError = new WranglerQuarantineError(
      54321,
      `kill failed while running hyperdrive create --connection-string=${conn}`,
    );
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn },
        },
        { runWrangler: run, log: silentLog, listHyperdriveConfigs: async () => [] },
      );
    } catch (error) {
      thrown = error;
    }
    // The SAME object propagates (identity + pid metadata preserved — not rebuilt), so
    // the provision-level quarantine handling still recognized it and RETAINED the lock.
    expect(thrown).toBe(quarantineError);
    expect((thrown as WranglerQuarantineError).pid).toBe(54321);
    expect((thrown as Error).message).not.toContain('sup3r-secret');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect(existsSync(lockMutex)).toBe(true);
    // Cleanup the retained mutex + sidecar for later tests.
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });

  it('a lister rejecting a plain STRING is redacted in the warning', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const warns: Array<string> = [];
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:leaky-pass@h/db',
          },
        },
        {
          runWrangler: run,
          log: { info: () => {}, warn: (msg) => warns.push(msg) },
          listHyperdriveConfigs: () =>
            Promise.reject('fetch failed for postgres://u:leaky-pass@h/db'),
        },
      ),
    ).rejects.toThrow(/cannot verify/);
    const listerWarn = warns.find((w) => w.includes('existence check'));
    expect(listerWarn).toBeDefined();
    expect(listerWarn).not.toContain('leaky-pass');
    expect(listerWarn).toContain('[REDACTED]');
  });

  it('redacts a userinfo password from the Hyperdrive lister failure warning', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const warns: Array<string> = [];
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: {
            binding: 'HYPERDRIVE',
            name: 'myapp-hd',
            connectionString: 'postgres://u:leaky-pass@h/db',
          },
        },
        {
          runWrangler: run,
          log: { info: () => {}, warn: (msg) => warns.push(msg) },
          listHyperdriveConfigs: async () => {
            throw new Error('fetch failed for postgres://u:leaky-pass@h/db');
          },
        },
      ),
    ).rejects.toThrow(/cannot verify/);
    const listerWarn = warns.find((w) => w.includes('existence check'));
    expect(listerWarn).toBeDefined();
    expect(listerWarn).not.toContain('leaky-pass');
    expect(listerWarn).toContain('[REDACTED]');
  });
});

describe('provisionCloudflareResources — dotenv fence file set + case rule are wrangler-exact', () => {
  const redirect = 'CLOUDFLARE_API_BASE_URL=https://api.staging.cloudflare.com/client/v4\n';

  it('`.dev.vars.local` no longer blocks — wrangler never loads that file', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars.local'), redirect);
    const { run } = makeRunner([
      { match: /^d1 list/, reply: () => ok('[]') },
      {
        match: /^d1 create/,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('db'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0].action).toBe('created');
  });

  it('detects a redirect var in `.dev.vars.` (the empty-env dev-vars file wrangler probes FIRST)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars.'), redirect);
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/refusing to provision.*"\.dev\.vars\.".*CLOUDFLARE_API_BASE_URL/s);
    expect(calls.length).toBe(0);
  });

  it('a benign `.dev.vars.` + a redirect var ONLY in `.dev.vars` is NOT rejected (wrangler never reads the fallback)', async () => {
    // wrangler's `loadDotDevDotVars` probes `.dev.vars.` FIRST for the empty env and
    // falls back to `.dev.vars` ONLY when the first is absent — exactly one file is
    // ever parsed. Pre-fix the fence scanned BOTH, falsely rejecting this config.
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars.'), 'SOME_APP_SECRET=benign\n');
    writeFileSync(join(tmpDir, '.dev.vars'), redirect);
    const { run } = makeRunner([
      { match: /^d1 list/, reply: () => ok('[]') },
      {
        match: /^d1 create/,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('db'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0].action).toBe('created');
  });

  it('a redirect var in the SELECTED `.dev.vars` (no `.dev.vars.` present) IS rejected', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars'), redirect);
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/refusing to provision.*"\.dev\.vars".*CLOUDFLARE_API_BASE_URL/s);
    expect(calls.length).toBe(0);
  });

  it('dev-vars keys are case-SENSITIVE on every platform — a mixed-case spelling never trips the fence', () => {
    // `tryLoadDotDevDotVars` parses via `dotenv.parse` into a PLAIN object;
    // `caseInsensitiveEnv` applies only to wrangler's `loadDotEnv` (.env family). A
    // mixed-case key in dev-vars is a DIFFERENT key for wrangler even on win32.
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.dev.vars'), 'cloudflare_api_base_url=https://evil.example\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).not.toThrow();
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
    // The EXACT spelling still trips it everywhere.
    writeFileSync(join(tmpDir, '.dev.vars'), 'CLOUDFLARE_API_BASE_URL=https://evil.example\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(/\.dev\.vars/);
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).toThrow(/\.dev\.vars/);
  });

  it('compares variable names case-insensitively on win32 (wrangler loads dotenv into a caseInsensitiveEnv there)', () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'cloudflare_api_base_url=https://evil.example\n');
    // Simulated win32: the mixed-case key IS the transport var (case-insensitive env).
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(
      /refusing to provision.*\.env/s,
    );
    // POSIX: env vars are case-sensitive — the lowercase key is a different variable.
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'linux')).not.toThrow();
  });

  it('the win32 case rule also covers the output-file sinks', () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'Wrangler_Output_File_Path=/tmp/out.json\n');
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'win32')).toThrow(
      /session diagnostics/,
    );
    expect(() => assertNoTransportRedirectInProjectDotenv(tmpDir, 'darwin')).not.toThrow();
  });
});

describe('provisionEnv — win32 case-insensitive credential scrub', () => {
  const MIXED_CASE_KEYS = [
    'Wrangler_Output_File_Path', // output sink — would persist the raw argv (password!)
    'wrangler_output_file_directory',
    'cloudflare_api_base_url', // transport redirect
    'Cf_Api_Base_Url',
    'Cloudflare_Env',
    'cf_access_client_id', // CF Access token pair
    'Cf_Access_Client_Secret',
    'Wrangler_Log_Sanitize', // pinned key — a mixed-case 'false' must not shadow the pin
  ] as const;

  function withMixedCaseEnv<T>(fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const key of MIXED_CASE_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = key === 'Wrangler_Log_Sanitize' ? 'false' : 'ambient-value';
    }
    try {
      return fn();
    } finally {
      for (const key of MIXED_CASE_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  }

  it('on win32, EVERY case-insensitive spelling of every scrubbed key set is removed before pinning', () => {
    withMixedCaseEnv(() => {
      const env = provisionEnv({
        accountId: 'acct',
        apiBaseUrl: 'https://api.cloudflare.com/client/v4',
        platform: 'win32',
      });
      // No case variant of any scrubbed key survives — on win32 the child's process.env
      // is case-insensitive, so `Wrangler_Output_File_Path` WOULD be read as
      // WRANGLER_OUTPUT_FILE_PATH and wrangler would write the raw argv (with the
      // Hyperdrive password) to disk.
      for (const key of MIXED_CASE_KEYS) {
        expect(env[key]).toBeUndefined();
      }
      // The canonical pins are present and unshadowed.
      expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
      expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct');
    });
  });

  it('on POSIX, mixed-case spellings are DIFFERENT variables and survive (exact-case scrub only)', () => {
    withMixedCaseEnv(() => {
      const env = provisionEnv({ accountId: 'acct', platform: 'linux' });
      // POSIX env vars are case-sensitive: these spellings are unrelated variables that
      // wrangler never reads as the scrubbed keys — leave them alone.
      expect(env.Wrangler_Output_File_Path).toBe('ambient-value');
      expect(env.cloudflare_api_base_url).toBe('ambient-value');
      // The canonical pins still apply.
      expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
    });
  });
});

describe('provisionCloudflareResources — read-first stored-name identity', () => {
  it('D1: a stored database_name EQUAL to the desired name is reused (as before)', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db1') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0]).toEqual({
      kind: 'd1',
      binding: 'DB',
      name: 'myapp-db',
      action: 'reused',
      id: uuid('db1'),
    });
  });

  it('D1: a stored database_name DIFFERENT from the desired name fails closed (no wrangler call, no reuse)', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'other-db', database_id: uuid('other') }],
      }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /D1 binding "DB".*stores database_name "other-db".*wants database "myapp-db".*contradicts the desired name/s,
    );
    // Fail closed — no discovery/create, config untouched.
    expect(calls).toEqual([]);
    expect((readConfig().d1_databases as Array<Record<string, unknown>>)[0].database_id).toBe(
      uuid('other'),
    );
  });

  it('D1: an entry with a real id but NO database_name keeps ID-only reuse', async () => {
    setup(JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: uuid('db1') }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0].action).toBe('reused');
    expect(result.resources[0].id).toBe(uuid('db1'));
  });

  it('R2: a stored bucket_name EQUAL to the desired name is reused (as before)', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-uploads' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0].action).toBe('reused');
  });

  it('R2: a stored bucket_name DIFFERENT from the desired name fails closed (contradiction, never silent reuse)', async () => {
    setup(
      JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'someone-elses-bucket' }] }),
    );
    const { run, calls } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /R2 binding "STORAGE".*stores bucket_name "someone-elses-bucket".*wants bucket "myapp-uploads".*contradicts the desired bucket/s,
    );
    expect(calls).toEqual([]);
  });

  it('R2: the `default` placeholder bucket_name still takes the discovery path (not a contradiction)', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'myapp-uploads' });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(true);
    expect(result.resources[0].action).toBe('created');
  });

  it('R2: a desired bucket named default reuses the matching stored bucket', async () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0]).toMatchObject({ kind: 'r2', name: 'default', action: 'reused' });
    expect(calls).toEqual([]);
  });
});

describe('provisionCloudflareResources — per-resource placeholder rules', () => {
  it('R2: a stored bucket_name of "local" is a REAL name — a different desired bucket fails closed (no silent rewrite)', async () => {
    // "local" is grammar-valid and is NOT R2's placeholder (only "default" is); the old
    // shared check treated it as a placeholder, skipped the stored-name contradiction
    // gate, and silently REWROTE the entry to the desired bucket.
    setup(
      JSON.stringify({
        account_id: 'acct',
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^r2 bucket info /, reply: () => ok(JSON.stringify({ name: 'myapp-storage' })) },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-storage' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(
      /R2 binding "STORAGE".*stores.*bucket_name "local".*wants bucket "myapp-storage".*contradicts/s,
    );
    // Fail closed: no discovery/create, stored entry untouched.
    expect(calls).toEqual([]);
    expect((readConfig().r2_buckets as Array<Record<string, unknown>>)[0].bucket_name).toBe(
      'local',
    );
  });

  it('R2: a stored bucket_name of "local" EQUAL to the desired bucket is reused (real name, no wrangler call)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'local' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([]);
    expect(result.resources[0]).toEqual({
      kind: 'r2',
      binding: 'STORAGE',
      name: 'local',
      action: 'reused',
    });
  });

  it('R2: a bucket genuinely named "default" is created + verified via the remote probe (no false postcondition failure)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    let created = false;
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () =>
          created
            ? ok(JSON.stringify({ name: 'default' }))
            : fail('', 'X [ERROR] The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          created = true;
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'default' });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
      { runWrangler: run, log: silentLog },
    );
    // Pre-fix the create postcondition rejected `default` as a placeholder and failed a
    // successful create. Post-fix it verifies via the EXACT remote probe instead.
    expect(result.resources[0]).toEqual({
      kind: 'r2',
      binding: 'STORAGE',
      name: 'default',
      action: 'created',
    });
    const infoCalls = calls.filter((c) => isCall(c, 'r2', 'bucket', 'info'));
    expect(infoCalls.length).toBe(2); // the absence probe + the post-create verify probe
  });

  it('R2: a masked-killed create of a bucket named "default" fails closed when the verify probe cannot confirm it', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run } = makeRunner([
      {
        // Absence first, and STILL absent on the verify probe (the create was masked).
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist. [code: 10006]'),
      },
      {
        // The create "succeeds" (exit 0) and even writes the entry — but for the name
        // `default` that entry is indistinguishable from the local-dev placeholder.
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', { binding: 'STORAGE', bucket_name: 'default' });
          return ok();
        },
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'default' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/did not confirm the bucket exists/);
  });

  it('D1/KV: the "local" placeholders still take the discovery path (unchanged)', async () => {
    setup(
      JSON.stringify({
        account_id: 'acct',
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
        kv_namespaces: [{ binding: 'KV', id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('db'),
          });
          return ok();
        },
      },
      { match: /^kv namespace list/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'KV', id: hex32('kv') });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      {
        ...emptyDesired,
        d1: { binding: 'DB', name: 'myapp-db' },
        kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }],
      },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(true);
    expect(calls.some((c) => isCall(c, 'kv', 'namespace', 'create'))).toBe(true);
    expect(result.resources.map((r) => r.action)).toEqual(['created', 'created']);
  });
});

describe('provisionCloudflareResources — D1 whole-list alias reconciliation', () => {
  it('a NON-target member with a valid uuid but a CONFLICTING/malformed database_id rejects the WHOLE list (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        // The exact repro: `uuid` alone validated under the old any-one-alias gate, and
        // normalizeD1 returned `other` before reconciling — so this corrupt member
        // authorized authoritative absence and a create.
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ name: 'other-db', uuid: uuid('other'), database_id: 'bogus' }])),
      },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id.*agreeing on one id/s);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('a NON-target member with TWO valid but DISAGREEING alias UUIDs rejects the whole list (no create)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(
            JSON.stringify([
              { name: 'other-db', uuid: uuid('alias-a'), database_id: uuid('alias-b') },
            ]),
          ),
      },
      { match: /^d1 create /, reply: () => ok() },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });

  it('a member with AGREEING aliases (uuid === database_id) passes the gate; absence stays authoritative', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () =>
          ok(JSON.stringify([{ name: 'other-db', uuid: uuid('same'), database_id: uuid('same') }])),
      },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('mine'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources[0].action).toBe('created');
  });

  it('the TARGET member with a non-string secondary alias (uuid: 123) fails closed as ambiguous — never adopted', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^d1 list --json/,
        reply: () => ok(JSON.stringify([{ name: 'myapp-db', database_id: uuid('db'), uuid: 123 }])),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/no valid id/);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
  });
});

describe('provisionCloudflareResources — quarantine retains the whole-provision lock', () => {
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('a quarantine rejection RETAINS the mutex (not released) and surfaces the quarantine error', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // A runner whose child could not be confirmed dead — the default runner rejects
    // with a quarantine error in that state; injecting the same rejection exercises the
    // provision-level contract: NO release, mutex retained, error surfaced verbatim.
    const quarantineError = new WranglerQuarantineError(43210, 'test: child unconfirmed');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(quarantineError);
    expect((thrown as Error).message).toMatch(/pid 43210/);
    expect((thrown as Error).message).toMatch(/intentionally RETAINED/);
    // THE crux: the mutex directory still exists — the lock was NOT released with a
    // possibly-live wrangler child. (A non-quarantine failure releases it — see the
    // whole-provision lock suite.)
    expect(existsSync(lockMutex)).toBe(true);
    // The quarantine ALSO persisted its owner metadata beside the lock,
    // so later acquisitions gate on the recorded group instead of stealing by age.
    const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
    expect(existsSync(sidecar)).toBe(true);
    const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
    expect(recorded.pid).toBe(43210);
    expect(String(recorded.reason)).toMatch(/pid 43210/);
    // Cleanup: remove the retained mutex + sidecar so later tests can lock again.
    // quarantine() detached the lock from proper-lockfile's tracking, so no
    // heartbeat/compromise callback fires after this removal.
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });

  it('a NON-quarantine failure still releases the mutex (baseline)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { run } = makeRunner([{ match: /^d1 list/, reply: () => fail('', 'boom') }]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/d1 list.*failed/s);
    expect(existsSync(lockMutex)).toBe(false);
  });
});

/**
 * Windows cannot DELIVER a signal to another process. libuv maps SIGTERM/SIGINT/SIGKILL to
 * `TerminateProcess`, which destroys the target immediately WITHOUT running any handler in it,
 * and a synthetic Ctrl-C would need `GenerateConsoleCtrlEvent` (unreachable from Node). The
 * cases carrying this note drive a real child `node` parent with `kill('SIGTERM')` and then
 * assert on that parent's signal-teardown handler — work that only happens under POSIX signal
 * semantics.
 */
const WINDOWS_NO_SIGNALS = 'signal delivery to another process is POSIX-only (see note above)';

describe('createDefaultRunWrangler — parent-signal forwarding awaits confirmed teardown', () => {
  const SIGNAL_TEARDOWN_TMP = join(import.meta.dirname, '.tmp-signal-teardown');
  beforeEach(() => {
    rmSync(SIGNAL_TEARDOWN_TMP, { recursive: true, force: true });
    mkdirSync(SIGNAL_TEARDOWN_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(SIGNAL_TEARDOWN_TMP, { recursive: true, force: true });
  });

  it('SIGTERM to the parent: the child group is confirmed dead BEFORE the parent re-raises and exits', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // A REAL parent process (so the re-raise/exit is observable) runs the runner around a
    // child that exits 250ms AFTER receiving the forwarded SIGTERM. Pre-fix the parent
    // re-raised immediately — it was dead while the child lived on (proper-lockfile's exit
    // hook would strip the mutex under a live child). Post-fix the parent awaits the
    // confirmed teardown, so AT parent exit the child is deterministically gone.
    const pidFile = join(SIGNAL_TEARDOWN_TMP, 'child.pid');
    const childScript = join(SIGNAL_TEARDOWN_TMP, 'slow-exit-child.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(SIGNAL_TEARDOWN_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `run({ type: 'd1.list' }, { accountId: 'acct' }).then(\n` +
        `  (r) => console.log('runner-settled', r.status, r.signal),\n` +
        `  (e) => console.log('runner-rejected', e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: SIGNAL_TEARDOWN_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childPid: number | undefined;
    try {
      // Wait until the grandchild wrote its pid (it is alive and hanging).
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          const raw = readFileSync(pidFile, 'utf-8');
          if (raw.length > 0) {
            childPid = Number(raw);
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(childPid).toBeDefined();
      // Terminate the PARENT. It must forward to the child's group, await the CONFIRMED
      // teardown (the child takes ~250ms to exit), and only then re-raise + die.
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      // The parent died of the re-raised SIGTERM (default action) — not exit 0.
      expect(signal).toBe('SIGTERM');
      // THE crux: at the moment the parent exited, the child was ALREADY dead. Pre-fix
      // (immediate re-raise) the child would still be alive here for another ~250ms.
      let childAlive = true;
      try {
        process.kill(childPid!, 0);
      } catch {
        childAlive = false;
      }
      expect(childAlive).toBe(false);
    } finally {
      // Belt + braces: never leak processes even on assertion failure.
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);
});

describe('createDefaultRunWrangler — normal close confirms the whole GROUP', () => {
  const GROUP_CLOSE_TMP = join(import.meta.dirname, '.tmp-group-close');
  beforeEach(() => {
    rmSync(GROUP_CLOSE_TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    mkdirSync(GROUP_CLOSE_TMP, { recursive: true });
  });
  afterEach(() => {
    // Windows may retain the exited child's cwd handle briefly after the
    // liveness assertion passes. Retry removal without weakening that assertion.
    rmSync(GROUP_CLOSE_TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it('an exit-0 leader that leaves a SAME-GROUP grandchild alive: the runner resolves only after the group is dead', async () => {
    // Pre-fix, a normal `close` resolved IMMEDIATELY without probing the detached
    // process group, so a surviving same-group grandchild (own stdio, so `close` fires
    // at the leader's exit) kept running after the whole-provision lock was released.
    const gcPidFile = join(GROUP_CLOSE_TMP, 'gc.pid');
    const gc = join(GROUP_CLOSE_TMP, 'gc.cjs');
    writeFileSync(
      gc,
      `require('fs').writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const leader = join(GROUP_CLOSE_TMP, 'leader.cjs');
    writeFileSync(
      leader,
      `const { spawn } = require('child_process');\n` +
        `const fs = require('fs');\n` +
        // Same process group (not detached), but its OWN stdio — so the leader's exit
        // fires `close` while the grandchild lives on in the group.
        `const c = spawn(process.execPath, [${JSON.stringify(gc)}], { stdio: 'ignore' });\n` +
        `c.unref();\n` +
        `setInterval(() => {\n` +
        `  if (fs.existsSync(${JSON.stringify(gcPidFile)})) { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }\n` +
        `}, 10);\n`,
    );
    const run = createDefaultRunWrangler(GROUP_CLOSE_TMP, {
      launcher: [process.execPath, leader],
      timeoutMs: 30_000,
    });
    const result = await run(operationFixtureRequest(['d1', 'list', '--json']), {
      accountId: 'acct',
    });
    // The leader's own clean exit is reported faithfully...
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    // ...but ONLY once the whole group is confirmed dead: the surviving grandchild was
    // reaped BEFORE the promise resolved (pre-fix it was still alive here).
    const gcPid = Number(readFileSync(gcPidFile, 'utf-8'));
    expect(Number.isInteger(gcPid)).toBe(true);
    let alive = true;
    try {
      process.kill(gcPid, 0);
    } catch {
      alive = false;
    }
    try {
      process.kill(gcPid, 'SIGKILL'); // belt + braces: never leak on assertion failure
    } catch {
      // already gone
    }
    expect(alive).toBe(false);
  }, 15_000);
});

describe('acquireProvisionLock — quarantine sidecar gate', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('a quarantined mutex is NOT stealable by age while the recorded group lives (fail closed, sidecar atomic)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { spawn } = await import('node:child_process');
    // A REAL live process group standing in for the unconfirmed wrangler child.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      const lock = await acquireProvisionLock(wranglerPath);
      lock.quarantine({ pid: child.pid, reason: 'test quarantine (child unconfirmed)' });
      // The sidecar is complete, valid JSON (atomic tmp+rename — a concurrent gate can
      // never read partial JSON) with no temp-file leftovers.
      const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      expect(recorded).toMatchObject({
        pid: child.pid,
        // Windows has no process groups, so `writeQuarantineSidecar` records `null` there by
        // design and the gate falls back to probing the plain pid.
        pgid: process.platform === 'win32' ? null : child.pid,
        reason: 'test quarantine (child unconfirmed)',
      });
      expect(typeof recorded.quarantinedAt).toBe('string');
      expect(readdirSync(tmpDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(existsSync(lockMutex)).toBe(true);
      // Age the retained mutex FAR past any stale window — pre-fix, proper-lockfile's
      // mtime-stale path deleted + reacquired it here while the child group was alive.
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 }),
      ).rejects.toThrow(
        new RegExp(`QUARANTINED.*process group ${child.pid}.*test quarantine`, 's'),
      );
      // The gate did NOT clear the quarantine (the group still lives).
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    expect(await waitForDead(child.pid!, 10_000)).toBe(true);
  }, 15_000);

  it('once the recorded group is DEAD, the next acquisition clears the sidecar and proceeds', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
    const lock = await acquireProvisionLock(wranglerPath);
    lock.quarantine({ pid: child.pid, reason: 'test quarantine' });
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    expect(await waitForDead(child.pid!, 10_000)).toBe(true);
    // Backdate the retained mutex so proper-lockfile's ordinary stale lifecycle reclaims
    // it promptly (the gate itself never removes the mutex directory by hand).
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockMutex, old, old);
    const second = await acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 5 });
    // The gate probed the recorded group dead → cleared the sidecar → acquisition ran.
    expect(existsSync(sidecar)).toBe(false);
    await second.release();
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('an unreadable/malformed sidecar FAILS CLOSED (cannot verify the recorded owner)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(sidecar, '{ not json');
    await expect(acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 })).rejects.toThrow(
      /QUARANTINED.*an unrecorded process/s,
    );
    expect(existsSync(sidecar)).toBe(true);
  });
});

describe('acquireProvisionLock — the gate runs on EVERY attempt + post-acquire revalidation', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  async function spawnHang(): Promise<import('node:child_process').ChildProcess> {
    const { spawn } = await import('node:child_process');
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
  }

  function reap(child: import('node:child_process').ChildProcess): void {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  it('a waiter that started while the holder was HEALTHY fails closed when the holder quarantines mid-wait', async () => {
    // The prior code gated ONCE before proper-lockfile's internal retry loop: this
    // waiter passed that gate (holder healthy, no sidecar), kept retrying while the
    // holder QUARANTINED (heartbeat detached), then stale-took the retained mutex
    // without ever seeing the sidecar — acquiring while the recorded group was ALIVE.
    setup(JSON.stringify({ name: 'app' }));
    const holder = await acquireProvisionLock(wranglerPath, { stale: 2_000 });
    const child = await spawnHang();
    try {
      const waiter = acquireProvisionLock(wranglerPath, {
        stale: 2_000,
        retries: { retries: 60, factor: 1, minTimeout: 150, maxTimeout: 150 },
      });
      // Let the waiter run a few healthy attempts first, THEN quarantine the holder.
      await new Promise((r) => setTimeout(r, 400));
      holder.quarantine({ pid: child.pid, reason: 'waiter crosses quarantine' });
      // Post-fix the waiter's NEXT attempt re-runs the gate: sidecar + live group →
      // fail closed (never a stale-take of the detached mutex).
      await expect(waiter).rejects.toThrow(/QUARANTINED.*waiter crosses quarantine/s);
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      reap(child);
    }
    expect(await waitForDead(child.pid!, 5_000)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  }, 15_000);

  it('the same waiter PROCEEDS (sidecar cleared) once the recorded group is dead', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const holder = await acquireProvisionLock(wranglerPath, { stale: 2_000 });
    const child = await spawnHang();
    const waiter = acquireProvisionLock(wranglerPath, {
      stale: 2_000,
      retries: { retries: 80, factor: 1, minTimeout: 150, maxTimeout: 150 },
    });
    await new Promise((r) => setTimeout(r, 300));
    // Kill the recorded group FIRST, then quarantine: the sidecar records an
    // already-dead group, so the waiter's next gate deterministically probes it dead
    // (quarantining a live child here would race the waiter's fail-closed gate).
    reap(child);
    expect(await waitForDead(child.pid!, 5_000)).toBe(true);
    holder.quarantine({ pid: child.pid, reason: 'waiter proceeds once dead' });
    // The waiter's next gate probes the recorded group DEAD → clears the sidecar →
    // proper-lockfile's stale lifecycle then reclaims the heartbeat-less mutex.
    const lock = await waiter;
    expect(existsSync(sidecar)).toBe(false);
    await lock.release();
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('post-acquire REVALIDATION: a sidecar appearing DURING acquisition releases the fresh lock and fails closed', async () => {
    // Simulates a holder quarantining between this attempt's gate and the mkdir that
    // acquires the mutex: the fs seam's mkdir drops a sidecar recording a LIVE group
    // just before creating the lock directory.
    setup(JSON.stringify({ name: 'app' }));
    const child = await spawnHang();
    try {
      const seamFs = {
        ...passthruFs,
        mkdir: (...args: Array<unknown>) => {
          writeFileSync(
            sidecar,
            JSON.stringify({
              pid: child.pid,
              pgid: child.pid,
              reason: 'appeared mid-acquisition',
            }),
          );
          (passthruFs.mkdir as (...a: Array<unknown>) => void)(...args);
        },
      };
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0, fs: seamFs }),
      ).rejects.toThrow(/QUARANTINED.*appeared mid-acquisition/s);
      // The freshly-acquired mutex was RELEASED on the failed revalidation (fail
      // closed, no leak, no half-owned lock)…
      expect(existsSync(lockMutex)).toBe(false);
      // …and the sidecar remains for the next acquisition to gate on.
      expect(existsSync(sidecar)).toBe(true);
    } finally {
      reap(child);
    }
    expect(await waitForDead(child.pid!, 5_000)).toBe(true);
    rmSync(sidecar, { force: true });
  });
});

describe('acquireProvisionLock — durable sidecar is a PRECONDITION for quarantine', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;
  // Blocking the sidecar's TEMP path (a directory where the temp file goes) makes the
  // durable write fail while leaving the sidecar path itself absent — exactly the
  // fail-open shape (no durable marker lands anywhere).
  const tmpBlocker = `${sidecar}.tmp-${process.pid}`;

  // A provision-level quarantine whose DURABLE persistence fails arms a
  // process-wide RETENTION WATCHDOG (a module singleton in provision.ts). It resolves
  // ASYNCHRONOUSLY: it clears the mutex / writes the sidecar and THEN — one microtask
  // later (`lock.release().then(resolveWatchdog)`) — frees the process-wide provision
  // slot. Under full-suite load that trailing gap widens, so a test that only waited on
  // the observable mutex/sidecar state could finish while the slot is still taken,
  // tripping the NEXT test's entry guard ("a previous provision … still retaining its
  // lock"). Deterministically drain any lingering watchdog before the next test: poll a
  // benign provision on a THROWAWAY config path (the guard is process-wide, so the probe
  // never touches this suite's lock files) until it gets PAST the slot guard — which
  // happens exactly when the watchdog has resolved.
  async function drainRetentionWatchdog(timeoutMs = 20_000): Promise<void> {
    const probeDir = join(import.meta.dirname, '.tmp-provision-drain');
    const probeCfg = join(probeDir, 'wrangler.jsonc');
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        rmSync(probeDir, { recursive: true, force: true });
        mkdirSync(probeDir, { recursive: true });
        writeFileSync(probeCfg, JSON.stringify({ account_id: 'acct', name: 'drain' }));
        let guardHeld = false;
        try {
          await provisionCloudflareResources(probeDir, probeCfg, emptyDesired, {
            runWrangler: provisionOperationFixture(() => ok('[]')),
            log: silentLog,
          });
        } catch (error) {
          // Only the process-wide slot guard means the watchdog is STILL active; any other
          // outcome (resolve, or an unrelated failure) means it has resolved → slot free.
          guardHeld = /still retaining its lock|already active in this process/.test(
            (error as Error).message,
          );
        }
        if (!guardHeld) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error('retention watchdog did not resolve within the drain window');
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  afterEach(async () => {
    // Belt + braces: no retention watchdog may leak into the next test's provision guard.
    await drainRetentionWatchdog();
  });

  it('a sidecar-write failure keeps the lock TRACKED (heartbeat running, NOT stealable) and throws a hard error', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, { stale: 2_000 });
    try {
      mkdirSync(tmpBlocker);
      expect(() => lock.quarantine({ pid: 99_999, reason: 'sidecar blocked' })).toThrow(
        /intentionally STILL HELD/,
      );
      // No partial/durable marker landed…
      expect(existsSync(sidecar)).toBe(false);
      // …and the lock did NOT detach: wait past the stale window — the still-running
      // heartbeat keeps the mtime fresh, so a contender sees a HELD lock. (Pre-fix the
      // detached, heartbeat-less mutex aged stale here and was stolen while the
      // recorded child lived.) 2.3s is just past proper-lockfile's 2000ms stale floor.
      await new Promise((r) => setTimeout(r, 2_300));
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 }),
      ).rejects.toThrow(/already being held/);
    } finally {
      rmSync(tmpBlocker, { recursive: true, force: true });
      // Still tracked → release works normally and frees the mutex.
      await lock.release();
    }
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('provision level: a persistence failure surfaces BOTH errors, arms the retention watchdog, and resolves by confirming the child DEAD (mutex released cleanly)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // A REAL child that is already dead stands in for the unconfirmed wrangler group.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
    const childPid = child.pid!;
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    {
      const deadline = Date.now() + 10_000;
      let dead = false;
      while (!dead && Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
        } catch {
          dead = true;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(dead).toBe(true);
    }
    const quarantineError = new WranglerQuarantineError(childPid, 'child unconfirmed');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    let thrown: unknown;
    try {
      await provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        {
          runWrangler: run,
          log: silentLog,
          lockOptions: {
            stale: 2_000,
            // PERSISTENT persistence failure — every attempt (including the watchdog's
            // retries) fails, so only the death probe can resolve the retention.
            dirDurability: {
              fsyncSync: () => {
                throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), {
                  code: 'ENOSPC',
                });
              },
            },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toMatch(/intentionally still held/);
    expect((thrown as AggregateError).errors[0]).toBe(quarantineError);
    expect(String((thrown as AggregateError).errors[1])).toMatch(/could not persist/);
    // Immediately after the rejection the mutex is still on disk, HELD (tracked) by
    // this process — never released under the unconfirmed child…
    expect(existsSync(lockMutex)).toBe(true);
    expect(existsSync(sidecar)).toBe(false);
    // …and the RETENTION WATCHDOG (armed by the failure) probes the recorded group,
    // confirms it dead, and releases the mutex CLEANLY — no manual unlock needed. Generous
    // bound: the watchdog's tick is a real timer, delayed under full-suite load.
    const deadline = Date.now() + 15_000;
    while (existsSync(lockMutex) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(lockMutex)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    // The watchdog resolved — a fresh provision may start again (guard freed). Deterministically
    // wait for the process-wide slot to clear first: the watchdog frees it one microtask AFTER
    // the mutex is gone (`release().then(resolveWatchdog)`), and under load that gap widens, so
    // asserting a fresh provision resolves without the drain would race the guard.
    await drainRetentionWatchdog();
    const { run: okRun } = makeRunner([{ match: /^d1 list/, reply: () => ok('[]') }]);
    await expect(
      provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
        runWrangler: okRun,
        log: silentLog,
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it('while the child LIVES, the watchdog retries persistence with backoff and detaches once it succeeds', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    const { spawn } = await import('node:child_process');
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
    let failPersistence = true;
    const quarantineError = new WranglerQuarantineError(live.pid, 'live child');
    const run: RunWrangler = provisionOperationFixture(() => Promise.reject(quarantineError));
    try {
      let thrown: unknown;
      try {
        await provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
          {
            runWrangler: run,
            log: silentLog,
            lockOptions: {
              stale: 2_000,
              dirDurability: {
                fsyncSync: () => {
                  if (failPersistence) {
                    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
                  }
                },
              },
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(sidecar)).toBe(false);
      // The durability problem clears; the watchdog's next retry persists the sidecar
      // and detaches the lock (mutex retained on disk behind the durable marker). Generous
      // bound: the watchdog's retry is a real backoff timer, delayed under full-suite load.
      failPersistence = false;
      const deadline = Date.now() + 15_000;
      while (!existsSync(sidecar) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(sidecar)).toBe(true);
      const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      expect(recorded.pid).toBe(live.pid);
      expect(existsSync(lockMutex)).toBe(true); // retained, now safely detached
      // The retained mutex is guarded by the sidecar: an acquirer fails closed on the
      // live recorded group even with the mutex aged stale.
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 }),
      ).rejects.toThrow(/QUARANTINED/);
    } finally {
      try {
        process.kill(-live.pid!, 'SIGKILL');
      } catch {
        try {
          live.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(lockMutex, { recursive: true, force: true });
      rmSync(sidecar, { force: true });
    }
  }, 30_000);

  it('the watchdog HOLDS the process at natural exit until the child dies, then releases and exits cleanly', async () => {
    // THE repro: on persistence failure the provision rejects with the lock left
    // TRACKED — and proper-lockfile's EXIT SWEEP removes every tracked mutex when the
    // parent naturally exits, leaving the live child with NO mutex and NO sidecar.
    // Post-fix a REFERENCED watchdog holds the (otherwise drained) process open,
    // confirms the child's death, releases the mutex normally, and only then lets the
    // process exit.
    const WATCHDOG_EXIT_TMP = join(import.meta.dirname, '.tmp-watchdog-exit');
    rmSync(WATCHDOG_EXIT_TMP, { recursive: true, force: true });
    mkdirSync(WATCHDOG_EXIT_TMP, { recursive: true });
    const appRoot = join(WATCHDOG_EXIT_TMP, 'app');
    const probe = join(WATCHDOG_EXIT_TMP, 'probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { spawn } from 'node:child_process';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources, WranglerQuarantineError } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        // A real detached child standing in for the unconfirmed wrangler group; it
        // exits BY ITSELF after 700ms.
        `const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 700)'], { detached: true, stdio: 'ignore' });\n` +
        `child.unref();\n` +
        `const startedAt = Date.now();\n` +
        `provisionCloudflareResources(root, cfg, { kvNamespaces: [], queues: [], d1: { binding: 'DB', name: 'myapp-db' } }, {\n` +
        `  runWrangler: () => Promise.reject(new WranglerQuarantineError(child.pid, 'unconfirmed')),\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `  lockOptions: {\n` +
        `    dirDurability: { fsyncSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } },\n` +
        `  },\n` +
        `}).then(\n` +
        `  () => writeFileSync(join(root, 'outcome.txt'), 'RESOLVED'),\n` +
        `  () => writeFileSync(join(root, 'outcome.txt'), 'REJECTED:' + (Date.now() - startedAt)),\n` +
        `);\n` +
        `process.on('exit', () => {\n` +
        `  let childAlive = true;\n` +
        `  try { process.kill(child.pid, 0); } catch { childAlive = false; }\n` +
        `  writeFileSync(join(root, 'exit.txt'), JSON.stringify({ elapsed: Date.now() - startedAt, childAlive }));\n` +
        `});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [probe], {
      cwd: WATCHDOG_EXIT_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    parent.stderr.setEncoding('utf-8');
    parent.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const killTimer = setTimeout(() => parent.kill('SIGKILL'), 15_000);
    try {
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('close', (c, s) => res([c, s]));
      });
      clearTimeout(killTimer);
      // The process exited NORMALLY (the watchdog resolved) — it was not killed.
      expect(signal).toBeNull();
      expect(code).toBe(0);
      // The provision itself rejected fast (persistence failure)…
      expect(readFileSync(join(appRoot, 'outcome.txt'), 'utf-8')).toContain('REJECTED:');
      // …but the WATCHDOG held the process past the child's 700ms lifetime: at exit the
      // child was confirmed dead and ≥ ~700ms had elapsed (pre-fix the loop drained and
      // the process exited within milliseconds, sweeping the tracked mutex while the
      // child lived).
      const exitState = JSON.parse(readFileSync(join(appRoot, 'exit.txt'), 'utf-8')) as {
        elapsed: number;
        childAlive: boolean;
      };
      expect(exitState.childAlive).toBe(false);
      expect(exitState.elapsed).toBeGreaterThanOrEqual(650);
      // The retained state was surfaced loudly, naming the pid + lock path…
      expect(stderr).toMatch(/RETAINED by this process/);
      // …and the watchdog released the mutex cleanly after confirming death: no mutex,
      // no sidecar left behind.
      const cfgReal = realpathSync(join(appRoot, 'wrangler.jsonc'));
      expect(existsSync(`${cfgReal}.void-provision.lock.lock`)).toBe(false);
      expect(existsSync(`${cfgReal}.void-provision.lock.quarantine.json`)).toBe(false);
    } finally {
      clearTimeout(killTimer);
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      rmSync(WATCHDOG_EXIT_TMP, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('acquireProvisionLock — proper-lockfile registry key spelling', () => {
  it('preserves the native separators used by proper-lockfile on each platform', () => {
    const lockTarget = 'D:/a/void/void/wrangler.jsonc.void-provision.lock';

    expect(resolveProperLockfileKey(lockTarget, 'win32')).toBe(
      'D:\\a\\void\\void\\wrangler.jsonc.void-provision.lock',
    );
    expect(resolveProperLockfileKey('/tmp/void/wrangler.jsonc.void-provision.lock', 'linux')).toBe(
      '/tmp/void/wrangler.jsonc.void-provision.lock',
    );
  });
});

describe('acquireProvisionLock — sidecar DIRECTORY durability failures propagate', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('ENOSPC on the directory fsync is a PERSISTENCE FAILURE: no detach, lock stays tracked, hard error', async () => {
    // Pre-fix ALL directory open/fsync/close failures were swallowed: on a real
    // EIO/ENOSPC the code still detached the (now heartbeat-less) lock behind a sidecar
    // whose DIRECTORY ENTRY could vanish on a crash — a stale-reclaimable mutex under a
    // live child. Now only enumerated platform-unsupported codes are ignored.
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, {
      stale: 2_000,
      dirDurability: {
        fsyncSync: () => {
          throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), {
            code: 'ENOSPC',
          });
        },
      },
    });
    try {
      expect(() => lock.quarantine({ pid: 42_424, reason: 'enospc' })).toThrow(
        /could not persist quarantine metadata.*ENOSPC/s,
      );
      // The non-durable sidecar was rolled back (state matches "not persisted")…
      expect(existsSync(sidecar)).toBe(false);
      // …and the lock did NOT detach: past the stale window the still-running heartbeat
      // keeps the mutex fresh, so a contender sees a HELD lock (no steal). 2.3s is just
      // past proper-lockfile's 2000ms stale floor.
      await new Promise((r) => setTimeout(r, 2_300));
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 }),
      ).rejects.toThrow(/already being held/);
    } finally {
      // Still tracked → release works normally and frees the mutex.
      await lock.release();
    }
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('a platform-unsupported code (EINVAL) is ignored — the quarantine still detaches behind the verified sidecar', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const lock = await acquireProvisionLock(wranglerPath, {
      stale: 2_000,
      dirDurability: {
        fsyncSync: () => {
          throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' });
        },
      },
    });
    lock.quarantine({ pid: 42_425, reason: 'einval' }); // must not throw
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(lockMutex)).toBe(true); // retained (detached from the exit sweep)
    await lock.release(); // no-op after a successful quarantine
    expect(existsSync(lockMutex)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });
});

describe('acquireProvisionLock — recovery decisions are serialized + generation-verified', () => {
  const sidecar = `${wranglerPath}.void-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;
  const recoveryTarget = `${wranglerPath}.void-provision.lock.recovery`;

  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  async function spawnHang(): Promise<import('node:child_process').ChildProcess> {
    const { spawn } = await import('node:child_process');
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
  }

  async function deadPid(): Promise<number> {
    const child = await spawnHang();
    const pid = child.pid!;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    expect(await waitForDead(pid, 5_000)).toBe(true);
    return pid;
  }

  function reap(child: import('node:child_process').ChildProcess): void {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  it('a held RECOVERY mutex blocks another acquirer from acting on the sidecar at all (decision serialized)', async () => {
    // Pre-fix, recovery decisions (read → probe → clear) ran UNSERIALIZED: recoverer B
    // could base its clear on a read that recoverer A had already invalidated. Now the
    // WHOLE gate→probe→clear→acquire→revalidate protocol runs under one small recovery
    // mutex, so while another recoverer holds it, no decision — not even the sidecar
    // read — is acted upon.
    setup(JSON.stringify({ name: 'app' }));
    const pid = await deadPid();
    writeFileSync(
      sidecar,
      JSON.stringify({ pid, pgid: pid, reason: 'dead group', generation: 'gen-stale' }),
    );
    const properLockfile = (await import('proper-lockfile')).default;
    const releaseRecovery = await properLockfile.lock(recoveryTarget, {
      stale: 6_000,
      realpath: false,
    });
    try {
      // The dead-group sidecar WOULD be cleared — but the recovery mutex is held, so
      // the acquirer cannot even enter the decision (retries: 0 → fail fast).
      await expect(acquireProvisionLock(wranglerPath, { retries: 0 })).rejects.toThrow(
        /already being held/,
      );
      expect(existsSync(sidecar)).toBe(true); // the decision was NOT made
    } finally {
      await releaseRecovery();
    }
    // With the recovery mutex free the same acquirer clears the dead-group quarantine
    // and proceeds.
    const lock = await acquireProvisionLock(wranglerPath, { retries: 2 });
    expect(existsSync(sidecar)).toBe(false);
    await lock.release();
    expect(existsSync(lockMutex)).toBe(false);
  });

  it("a stale recovery decision cannot delete a NEWER quarantine generation (B's decision detects S1; A's retained mutex stays protected)", async () => {
    // THE scenario, injected deterministically at the one point the
    // recovery mutex cannot serialize (a main-mutex holder's quarantine write): B
    // inspects dead S0 (generation g0) and decides to clear; before its unlink, A's
    // NEWER live-group quarantine S1 (generation g1) replaces the file. Pre-fix B
    // unlinked the PATHNAME — deleting S1 — and A's retained heartbeat-less mutex was
    // then stale-reclaimable under A's live child.
    setup(JSON.stringify({ name: 'app' }));
    const dead = await deadPid();
    const live = await spawnHang();
    try {
      writeFileSync(
        sidecar,
        JSON.stringify({
          pid: dead,
          pgid: dead,
          reason: 'S0 (dead group)',
          generation: 'gen-first',
        }),
      );
      // A's retained mutex: on disk, heartbeat-less, aged far past the stale window —
      // exactly what B would stale-reclaim if its stale decision deleted S1.
      mkdirSync(lockMutex);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      const swapInNewerGeneration = (): void => {
        writeFileSync(
          sidecar,
          JSON.stringify({
            pid: live.pid,
            pgid: live.pid,
            reason: 'S1 (live group, newer quarantine)',
            generation: 'gen-second',
          }),
        );
      };
      await expect(
        acquireProvisionLock(wranglerPath, {
          stale: 2_000,
          retries: 0,
          onBeforeQuarantineClear: swapInNewerGeneration,
        }),
      ).rejects.toThrow(/changed while this recovery decision was being made/);
      // THE crux: S1 SURVIVES the stale decision…
      const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      expect(recorded.generation).toBe('gen-second');
      expect(recorded.pid).toBe(live.pid);
      // …and A's retained mutex was not touched, so the next acquisition gates on S1's
      // LIVE group and fails closed instead of stale-reclaiming it.
      expect(existsSync(lockMutex)).toBe(true);
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2_000, retries: 0 }),
      ).rejects.toThrow(/QUARANTINED/);
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      reap(live);
    }
    expect(await waitForDead(live.pid!, 5_000)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });
});

describe('createDefaultRunWrangler — signal-path kill failure quarantines the lock (child-process)', () => {
  const SIGNAL_KILL_TMP = join(import.meta.dirname, '.tmp-signal-kill');
  beforeEach(() => {
    rmSync(SIGNAL_KILL_TMP, { recursive: true, force: true });
    mkdirSync(SIGNAL_KILL_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(SIGNAL_KILL_TMP, { recursive: true, force: true });
  });

  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('SIGTERM + an injected kill FAILURE: the parent dies with mutex + sidecar RETAINED; the gate blocks until the child dies', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // Pre-fix, the signal-forwarding path re-raised IMMEDIATELY on a non-ESRCH kill
    // failure — the parent died, proper-lockfile's exit hook removed the still-tracked
    // mutex, and the live wrangler child kept creating resources with NO lock on disk.
    const appRoot = join(SIGNAL_KILL_TMP, 'app');
    const pidFile = join(SIGNAL_KILL_TMP, 'child.pid');
    const hungCli = join(SIGNAL_KILL_TMP, 'hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(SIGNAL_KILL_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources, createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        `const runner = createDefaultRunWrangler(root, {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(hungCli)}, ${JSON.stringify(pidFile)}],\n` +
        `  killProcessGroup: () => {\n` +
        `    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });\n` +
        `  },\n` +
        `});\n` +
        `provisionCloudflareResources(root, cfg, { kvNamespaces: [], queues: [], d1: { binding: 'DB', name: 'myapp-db' } }, {\n` +
        `  runWrangler: runner,\n` +
        `  log: { info: () => {}, warn: () => {} },\n` +
        `}).then(\n` +
        `  () => console.log('RESOLVED'),\n` +
        `  (e) => console.log('REJECTED:' + e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: SIGNAL_KILL_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childPid: number | undefined;
    try {
      // Wait until the hung "wrangler" wrote its pid (mid-provision, lock held).
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          const raw = readFileSync(pidFile, 'utf-8');
          if (raw.length > 0) {
            childPid = Number(raw);
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(childPid).toBeDefined();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      // The parent still dies of the re-raised SIGTERM (default action) — not exit 0.
      expect(signal).toBe('SIGTERM');
      // THE crux: at parent exit the mutex + sidecar are STILL ON DISK — quarantine ran
      // BEFORE the re-raise, so proper-lockfile's exit sweep skipped the detached lock
      // while the wrangler child is still alive.
      const cfgReal = realpathSync(join(appRoot, 'wrangler.jsonc'));
      const lockMutex = `${cfgReal}.void-provision.lock.lock`;
      const sidecar = `${cfgReal}.void-provision.lock.quarantine.json`;
      expect(existsSync(lockMutex)).toBe(true);
      expect(existsSync(sidecar)).toBe(true);
      const recorded = JSON.parse(readFileSync(sidecar, 'utf-8')) as Record<string, unknown>;
      expect(recorded.pid).toBe(childPid);
      expect(String(recorded.reason)).toMatch(/SIGTERM/);
      // The child is genuinely still alive — and the gate FAILS CLOSED on it even
      // with the mutex aged far past the stale window.
      expect(() => process.kill(childPid!, 0)).not.toThrow();
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(acquireProvisionLock(cfgReal, { stale: 2_000, retries: 0 })).rejects.toThrow(
        /QUARANTINED/,
      );
      // Kill the recorded group; the next acquisition clears the quarantine + proceeds.
      try {
        process.kill(-childPid!, 'SIGKILL');
      } catch {
        process.kill(childPid!, 'SIGKILL');
      }
      expect(await waitForDead(childPid!, 5_000)).toBe(true);
      const lock = await acquireProvisionLock(cfgReal, { stale: 2_000, retries: 5 });
      expect(existsSync(sidecar)).toBe(false);
      await lock.release();
      expect(existsSync(lockMutex)).toBe(false);
    } finally {
      // Belt + braces: never leak processes even on assertion failure.
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});

describe('createDefaultRunWrangler — ONE signal coordinator: repeated signals coalesced, teardown bounded, spawns rejected', () => {
  const COORDINATOR_TMP = join(import.meta.dirname, '.tmp-signal-coordinator');
  beforeEach(() => {
    rmSync(COORDINATOR_TMP, { recursive: true, force: true });
    mkdirSync(COORDINATOR_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(COORDINATOR_TMP, { recursive: true, force: true });
  });

  async function waitForPid(pidFile: string, timeoutMs: number): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const raw = readFileSync(pidFile, 'utf-8');
        if (raw.length > 0) {
          return Number(raw);
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return undefined;
  }

  it('a SECOND concurrently-active wrangler child is rejected PRE-SPAWN (at most one registrant)', async () => {
    // Within one provision every wrangler call is awaited sequentially, and at most one
    // provision runs per process — so a second concurrently-active child is always a
    // caller bug and is rejected fast, before any child is spawned.
    const slowChild = join(COORDINATOR_TMP, 'slow-child.cjs');
    writeFileSync(
      slowChild,
      `setTimeout(() => { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }, 400);\n`,
    );
    const runA = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      timeoutMs: 30_000,
    });
    const first = runA({ type: 'd1.list' }, { accountId: 'acct' });
    await new Promise((r) => setTimeout(r, 80)); // A's child is alive and registered
    const runB = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      timeoutMs: 30_000,
    });
    await expect(runB({ type: 'd1.list' }, { accountId: 'acct' })).rejects.toThrow(
      /another wrangler child is already active in this process/,
    );
    // The first runner is unaffected and settles cleanly.
    const result = await first;
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  }, 15_000);

  it('permits two immutable Worker uploads while rejecting a third upload or traffic mutation', async () => {
    const slowChild = join(COORDINATOR_TMP, 'parallel-upload.cjs');
    writeFileSync(
      slowChild,
      `setTimeout(() => { console.log(JSON.stringify({ operationResult: 1 })); process.exit(0); }, 400);\n`,
    );
    const spawned: Array<number | undefined> = [];
    const run = createDefaultRunWrangler(COORDINATOR_TMP, {
      launcher: [process.execPath, slowChild],
      onSpawnedChild: (child) => spawned.push(child.pid),
      parallelWorkerUpload: true,
      timeoutMs: 30_000,
    });
    const first = run(operationFixtureRequest(['versions', 'upload']), { accountId: 'acct' });
    const second = run(operationFixtureRequest(['versions', 'upload']), { accountId: 'acct' });
    expect(spawned).toHaveLength(2);
    await expect(
      run(operationFixtureRequest(['versions', 'upload']), { accountId: 'acct' }),
    ).rejects.toThrow(/another wrangler child is already active in this process/);
    await expect(
      run(operationFixtureRequest(['versions', 'deploy']), { accountId: 'acct' }),
    ).rejects.toThrow(/another wrangler child is already active in this process/);
    expect(spawned).toHaveLength(2);
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([0, 0]);
    expect(
      (await run(operationFixtureRequest(['versions', 'deploy']), { accountId: 'acct' })).status,
    ).toBe(0);
  }, 15_000);

  it('confirms both parallel upload process groups have exited before forwarding SIGTERM', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    const pidFiles = [join(COORDINATOR_TMP, 'upload-a.pid'), join(COORDINATOR_TMP, 'upload-b.pid')];
    const childScript = join(COORDINATOR_TMP, 'upload-slow-exit.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parallel-upload-parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        pidFiles
          .map(
            (pidFile) =>
              `createDefaultRunWrangler(process.cwd(), { launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}], parallelWorkerUpload: true })({ type: 'versions.upload' }, { accountId: 'acct' }).catch(() => {});\n`,
          )
          .join(''),
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids: Array<number> = [];
    try {
      for (const file of pidFiles) {
        const pid = await waitForPid(file, 10_000);
        expect(pid).toBeDefined();
        pids.push(pid!);
      }
      parent.kill('SIGTERM');
      const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
        parent.on('exit', (_code, received) => resolve(received));
      });
      expect(signal).toBe('SIGTERM');
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      parent.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('one SIGTERM (+ a repeat mid-teardown) is coalesced: the parent re-raises only after the group is dead', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // Previously, runners installed per-runner listeners that detached themselves at
    // signal entry — a REPEATED signal during the bounded teardown took Node's default
    // action, killing the parent with the child alive, every tracked mutex swept, and
    // no sidecar. The ONE coordinator keeps its handler installed through the teardown,
    // so the repeat is swallowed and the single re-raise fires only after confirmation.
    const pidFile = join(COORDINATOR_TMP, 'a.pid');
    const childScript = join(COORDINATOR_TMP, 'slow-exit-child.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const runA = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `runA({ type: 'd1.list' }, { accountId: 'acct' }).then(\n` +
        `  (r) => console.log('A-settled', r.status, r.signal),\n` +
        `  (e) => console.log('A-rejected', e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      parent.kill('SIGTERM');
      // The REPEATED signal lands mid-teardown (the child is still alive at 120ms).
      // The coordinator's still-installed handler must coalesce it — no bypass.
      setTimeout(() => {
        try {
          parent.kill('SIGTERM');
        } catch {
          // parent already gone (that itself would fail the assertions below)
        }
      }, 120);
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      // The parent died of the single re-raised SIGTERM (default action) — not exit 0.
      expect(signal).toBe('SIGTERM');
      // THE crux: at parent exit the (slow, 600ms) child is already dead — the repeat
      // did not bypass the confirmation barrier.
      let alive = true;
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      // Belt + braces: never leak processes even on assertion failure.
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('a spawn attempted AFTER teardown began is rejected fast (no child spawned, teardown unaffected)', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    const pidFile = join(COORDINATOR_TMP, 'c.pid');
    const childScript = join(COORDINATOR_TMP, 'slow-exit-child2.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const outcomeFile = join(COORDINATOR_TMP, 'late-spawn-outcome.txt');
    const parentScript = join(COORDINATOR_TMP, 'parent-spawn-mid-teardown.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { writeFileSync } from 'node:fs';\n` +
        `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `run({ type: 'd1.list' }, { accountId: 'acct' }).catch(() => {});\n` +
        // A ONCE listener (consumed by the first SIGTERM, so it can never swallow the
        // coordinator's later re-raise) schedules a mid-teardown spawn attempt. The
        // outcome is written SYNCHRONOUSLY to a file so the re-raise death cannot lose it.
        `process.once('SIGTERM', () => {\n` +
        `  setTimeout(() => {\n` +
        `    run({ type: 'd1.list' }, { accountId: 'acct' }).then(\n` +
        `      () => writeFileSync(${JSON.stringify(outcomeFile)}, 'LATE-SPAWN-ALLOWED'),\n` +
        `      (e) => writeFileSync(${JSON.stringify(outcomeFile)}, 'LATE-SPAWN-REJECTED:' + e.message),\n` +
        `    );\n` +
        `  }, 50);\n` +
        `});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      // The teardown still completed with the single re-raise (child confirmed first)…
      expect(signal).toBe('SIGTERM');
      // …and the mid-teardown spawn was rejected outright — fail fast, no child, no
      // fresh per-runner deadline joining the teardown.
      const outcome = readFileSync(outcomeFile, 'utf-8');
      expect(outcome).toContain('LATE-SPAWN-REJECTED:');
      expect(outcome).toMatch(/refusing to spawn wrangler.*fatal SIGTERM.*terminating/s);
    } finally {
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it('the coordinator-WIDE deadline bounds an unconfirmable teardown (quarantine + re-raise, never a wedge)', async (ctx) => {
    ctx.skip(process.platform === 'win32', WINDOWS_NO_SIGNALS);
    // The runner's own confirmation window is 60s here and the child never dies (the
    // injected group-killer claims success but kills nothing) — pre-fix `pending`
    // stayed nonzero for the full 60s and the fatal signal was not re-raised. The
    // coordinator-wide deadline (800ms) quarantines the pair and re-raises at the bound.
    const pidFile = join(COORDINATOR_TMP, 'd.pid');
    const hangScript = join(COORDINATOR_TMP, 'hang-child.cjs');
    writeFileSync(
      hangScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(COORDINATOR_TMP, 'parent-deadline.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(hangScript)}, ${JSON.stringify(pidFile)}],\n` +
        `  confirmKillGraceMs: 60_000,\n` +
        `  signalTeardownDeadlineMs: 800,\n` +
        `  killProcessGroup: () => {},\n` + // claims success, kills nothing
        `});\n` +
        `run({ type: 'd1.list' }, { accountId: 'acct' }).catch(() => {});\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: COORDINATOR_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pid: number | undefined;
    try {
      pid = await waitForPid(pidFile, 10_000);
      expect(pid).toBeDefined();
      const killedAt = Date.now();
      parent.kill('SIGTERM');
      const [, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        parent.on('exit', (code, sig) => res([code, sig]));
      });
      const elapsed = Date.now() - killedAt;
      // The parent died of the re-raised SIGTERM AT the coordinator-wide bound — the
      // deadline was honored (≥ ~800ms) and nowhere near the 60s runner window
      // (pre-fix `pending` stayed nonzero for the full 60s confirmation window and the
      // fatal signal was not re-raised until then).
      expect(signal).toBe('SIGTERM');
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(elapsed).toBeLessThan(15_000);
      // The (genuinely unkillable-by-the-fake-killer) child is STILL ALIVE at parent
      // exit — the only path to a completed teardown with a live group is the
      // deadline's quarantine of the pair (confirmation was impossible). Reap it.
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      try {
        parent.kill('SIGKILL');
      } catch {
        // already gone
      }
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
  }, 20_000);
});

describe('createDefaultRunWrangler — post-spawn child `error` events confirm/quarantine', () => {
  const POST_SPAWN_TMP = join(import.meta.dirname, '.tmp-post-spawn-error');
  const spawnedChildren = new Set<import('node:child_process').ChildProcess>();
  beforeEach(() => {
    rmSync(POST_SPAWN_TMP, { recursive: true, force: true });
    mkdirSync(POST_SPAWN_TMP, { recursive: true });
  });
  afterEach(async () => {
    // A test deadline can interrupt the assertion before the runner's deadline.
    // Wait for actual close before removing a directory a Windows child uses as cwd.
    for (const child of spawnedChildren) {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    }
    rmSync(POST_SPAWN_TMP, { recursive: true, force: true });
  });

  function createRunner(options: NonNullable<Parameters<typeof createDefaultRunWrangler>[1]>) {
    return createDefaultRunWrangler(POST_SPAWN_TMP, {
      ...options,
      onSpawnedChild: (child) => {
        spawnedChildren.add(child);
        child.once('close', () => spawnedChildren.delete(child));
        options.onSpawnedChild?.(child);
      },
    });
  }

  function writeHangScript(path: string): void {
    // Ignores SIGTERM; only the machine's SIGKILL can end it.
    writeFileSync(
      path,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
  }

  function reapPidFile(pidFile: string): number | undefined {
    if (!existsSync(pidFile)) {
      return undefined;
    }
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return pid;
  }

  function injectErrorAfterChildStarts(
    child: import('node:child_process').ChildProcess,
    pidFile: string,
    message: string,
  ): void {
    // A fixed delay can fire before Node loads the child script on a busy runner.
    // Wait until the child has written its PID so this is truly a post-spawn error.
    void (async () => {
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.emit('error', new Error(message));
    })();
  }

  it('pre-spawn ENOENT still settles directly as a hard failure (the one carve-out: no pid, nothing to confirm)', async () => {
    const run = createRunner({
      launcher: [join(POST_SPAWN_TMP, 'no-such-wrangler-binary')],
    });
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'missing-launcher-db',
        binding: 'HYPERDRIVE',
        configPath: 'literal config.jsonc',
      },
      { accountId: 'acct', input: 'postgres://user:secret@localhost/db' },
    );
    expect(result.status).toBe(1);
    expect(result.error).toContain('ENOENT');
    expect(result.signal).toBeNull();
  });

  it('an early closed stdin rejects a buffered success envelope and confirms child termination', async (ctx) => {
    // Even after closing fd 0 and destroying its stream, a live Node process on
    // Windows retains inherited pipe handles. Real peer-exit and Writable-error
    // regressions below cover Windows without relying on POSIX descriptor closure.
    ctx.skip(
      process.platform === 'win32',
      'closing a live child stdin descriptor does not close inherited Windows pipe handles',
    );
    const script = join(POST_SPAWN_TMP, 'closed-stdin.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'closed-stdin.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        `fs.closeSync(0);\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });
    try {
      const result = await run(
        {
          type: 'hyperdrive.create',
          name: 'closed-stdin-db',
          binding: 'HYPERDRIVE',
          configPath: 'literal config.jsonc',
        },
        { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
      );
      expect(result.status).toBe(1);
      expect(result.signal).toBe('SIGKILL');
      expect(result.stderr).toMatch(/EPIPE|broken pipe/i);
      expect(result.stdout).toContain('"operationResult":1');
      expect(result.data).toBeUndefined();
      const pid = Number(readFileSync(pidFile, 'utf-8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      reapPidFile(pidFile);
    }
  }, 15_000);

  it('a provider exiting after reporting success rejects unread stdin through its real pipe error', async () => {
    const script = join(POST_SPAWN_TMP, 'exited-stdin.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'exited-stdin.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        // Exit closes every inherited handle on Windows as well as POSIX. The
        // oversized unread input is still pending, so the parent gets a real
        // closed-pipe error (write EOF on Windows, EPIPE on POSIX).
        `process.exit(0);\n`,
    );
    let observedOutput = '';
    let childClosed = Promise.resolve();
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        child.stdout!.on('data', (chunk: string) => {
          observedOutput += chunk;
        });
        childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      },
    });
    let result: Awaited<ReturnType<typeof run>> | undefined;
    let failure: unknown;
    try {
      result = await run(
        {
          type: 'hyperdrive.create',
          name: 'exited-stdin-db',
          binding: 'HYPERDRIVE',
          configPath: 'literal config.jsonc',
        },
        { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
      );
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      // macOS can return EPERM when signalling an already-exiting process group.
      // The runner must quarantine that unconfirmed group, never trust its output.
      expect(failure).toBeInstanceOf(WranglerQuarantineError);
      expect((failure as Error).message).toMatch(
        /post-spawn child error \(.*EPIPE.*\).*failed process-group kill/s,
      );
    } else {
      expect(result!.status).toBe(1);
      // The stdin error owns termination even if exit 0 is concurrently observed.
      expect(result!.signal).toBe('SIGKILL');
      expect(result!.stderr).toMatch(
        process.platform === 'win32' ? /write EOF|EPIPE|broken pipe/i : /EPIPE|broken pipe/i,
      );
      expect(result!.stdout).toContain('"operationResult":1');
      expect(result!.data).toBeUndefined();
    }
    expect(observedOutput).toContain('"operationResult":1');
    await childClosed;
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('a stdin Writable error rejects buffered success only after the child is confirmed dead', async () => {
    const script = join(POST_SPAWN_TMP, 'stdin-error.cjs');
    const pidFile = join(POST_SPAWN_TMP, 'stdin-error.pid');
    writeFileSync(
      script,
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `fs.writeSync(1, JSON.stringify({ operationResult: 1, data: { id: 'provider-id' } }));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createRunner({
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        child.stdout!.once('data', () => {
          // Drive Node's real Writable error event after the runner buffered success.
          // This separately covers the error path regardless of platform pipe behavior.
          child.stdin!.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        });
      },
    });
    const result = await run(
      {
        type: 'hyperdrive.create',
        name: 'stdin-error-db',
        binding: 'HYPERDRIVE',
        configPath: 'literal config.jsonc',
      },
      { accountId: 'acct', input: 'x'.repeat(2 * 1024 * 1024) },
    );
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('write EPIPE');
    expect(result.stdout).toContain('"operationResult":1');
    expect(result.data).toBeUndefined();
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('an injected POST-spawn `error` routes through the termination machine: the group is DEAD before the promise settles', async () => {
    // Pre-fix the `error` handler ALWAYS called finish() — a post-spawn error (e.g. a
    // kill-delivery failure) settled as an ordinary hard failure and RELEASED the
    // whole-provision lock while the hung child lived on.
    const pidFile = join(POST_SPAWN_TMP, 'child.pid');
    const hang = join(POST_SPAWN_TMP, 'hang.cjs');
    writeHangScript(hang);
    const run = createRunner({
      launcher: [process.execPath, hang, pidFile],
      timeoutMs: 30_000,
      onSpawnedChild: (child) => {
        injectErrorAfterChildStarts(child, pidFile, 'injected kill-delivery failure');
      },
    });
    const result = await run(operationFixtureRequest(['d1', 'list']), { accountId: 'acct' });
    // Settled as a HARD failure carrying the injected error + kill provenance…
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('injected kill-delivery failure');
    // …and ONLY once the whole group was confirmed dead: the hung child was reaped
    // BEFORE the promise settled (pre-fix it was still alive here).
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    reapPidFile(pidFile); // belt + braces: never leak on assertion failure
    expect(alive).toBe(false);
  }, 15_000);

  it('a POST-spawn `error` + a FAILED group kill QUARANTINES (rejects; the caller retains the lock)', async () => {
    const pidFile = join(POST_SPAWN_TMP, 'child2.pid');
    const hang = join(POST_SPAWN_TMP, 'hang2.cjs');
    writeHangScript(hang);
    const run = createRunner({
      launcher: [process.execPath, hang, pidFile],
      timeoutMs: 30_000,
      killProcessGroup: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
      onSpawnedChild: (child) => {
        injectErrorAfterChildStarts(child, pidFile, 'injected post-spawn failure');
      },
    });
    let thrown: unknown;
    try {
      await run(operationFixtureRequest(['d1', 'list']), { accountId: 'acct' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WranglerQuarantineError);
    expect((thrown as Error).message).toMatch(
      /post-spawn child error \(injected post-spawn failure\).*could not be signalled|post-spawn child error \(injected post-spawn failure\).*failed process-group kill/s,
    );
    // The (really alive) child is reaped by the test, then confirmed gone.
    const pid = reapPidFile(pidFile);
    expect(pid).toBeDefined();
    const deadline = Date.now() + 5_000;
    let dead = false;
    while (!dead && Date.now() < deadline) {
      try {
        process.kill(pid!, 0);
      } catch {
        dead = true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(dead).toBe(true);
  }, 15_000);
});

describe('withListerDeadline — the deadline holds in a REAL process (child-process regression)', () => {
  const LISTER_DEADLINE_TMP = join(import.meta.dirname, '.tmp-lister-deadline');
  beforeEach(() => {
    rmSync(LISTER_DEADLINE_TMP, { recursive: true, force: true });
    mkdirSync(LISTER_DEADLINE_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(LISTER_DEADLINE_TMP, { recursive: true, force: true });
  });

  it('a never-settling lister REJECTS after the deadline — the process does NOT exit 0 early, lock released', async () => {
    // Pre-fix, the deadline timer was unref'd: with a never-settling lister nothing else
    // referenced the loop (proper-lockfile's heartbeat is unref'd too), so a REAL node
    // process drained its loop and exited STATUS 0 before the deadline fired — silently
    // "succeeding" mid-provision. Vitest's own handles mask this in-worker, so the
    // regression must run in a spawned child process.
    const appRoot = join(LISTER_DEADLINE_TMP, 'app');
    const probe = join(LISTER_DEADLINE_TMP, 'probe.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      probe,
      `import { mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `import { provisionCloudflareResources } from ${JSON.stringify(provisionUrl)};\n` +
        `const root = ${JSON.stringify(appRoot)};\n` +
        `mkdirSync(root, { recursive: true });\n` +
        `const cfg = join(root, 'wrangler.jsonc');\n` +
        `writeFileSync(cfg, JSON.stringify({ name: 'app', account_id: 'acct' }));\n` +
        `provisionCloudflareResources(root, cfg, {\n` +
        `  kvNamespaces: [],\n` +
        `  queues: [],\n` +
        `  hyperdrive: { binding: 'HYPERDRIVE', name: 'probe-hd', connectionString: 'postgres://u:pw@h/db' },\n` +
        `}, {\n` +
        `  runWrangler: () => ({ stdout: '', stderr: '', status: 0 }),\n` +
        `  listHyperdriveConfigs: () => new Promise(() => {}),\n` +
        `  listTimeoutMs: 500,\n` +
        `  log: { info: () => {}, warn: (m) => console.log('WARN:' + m) },\n` +
        `}).then(\n` +
        `  () => console.log('RESOLVED'),\n` +
        `  (err) => { console.log('REJECTED:' + err.message); process.exitCode = 7; },\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [probe], {
      cwd: LISTER_DEADLINE_TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
        child.on('close', (c, s) => res([c, s]));
      });
      expect(signal).toBeNull();
      // THE crux: pre-fix the loop drained and the process exited 0 with NO output.
      expect(code).not.toBe(0);
      expect(code).toBe(7);
      expect(stdout).toContain('exceeded the 500ms deadline');
      expect(stdout).toContain('REJECTED:');
      expect(stdout).not.toContain('RESOLVED');
      // The whole-provision lock was RELEASED on the normal fail-closed path.
      expect(existsSync(join(appRoot, 'wrangler.jsonc.void-provision.lock.lock'))).toBe(false);
    } finally {
      clearTimeout(killTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 20_000);
});

describe('provisionCloudflareResources — R2 absence needs the STRUCTURED code', () => {
  it('a failure whose text merely contains 10006 inside a bucket name is NOT absence (fails closed, no create)', async () => {
    setup(JSON.stringify({ name: 'app', account_id: 'acct' }));
    const { run, calls } = makeRunner([
      {
        // An AUTH failure (code 10000) whose text contains the digits 10006 inside a bucket name.
        match: /^r2 bucket info /,
        reply: () =>
          fail('', 'X [ERROR] Authentication error for bucket archive-10006-prod [code: 10000]'),
      },
    ]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'archive-10006-prod' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/r2 bucket info archive-10006-prod.*(failed|refusing)/s);
    // No blind create on a non-structured-10006 failure.
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(false);
  });

  it('the GENUINE structured [code: 10006] IS absence → create', async () => {
    setup(JSON.stringify({ name: 'app', account_id: 'acct' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist. [code: 10006]'),
      },
      {
        match: /^r2 bucket create /,
        reply: () => {
          simulateUpdateConfig('r2_buckets', {
            binding: 'STORAGE',
            bucket_name: 'archive-10006-prod',
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'archive-10006-prod' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls.some((c) => isCall(c, 'r2', 'bucket', 'create'))).toBe(true);
    expect(result.resources[0].action).toBe('created');
  });
});

describe('provisionCloudflareResources — Hyperdrive lister deadline', () => {
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('a never-settling lister makes the boundary REJECT within the deadline (no infinite hold, lock released)', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const { run } = makeRunner([]);
    const start = Date.now();
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          // Ignores the signal and NEVER settles — pre-fix this held the lock forever.
          listHyperdriveConfigs: () => new Promise<never>(() => {}),
          listTimeoutMs: 200,
        },
      ),
    ).rejects.toThrow(/cannot verify whether Hyperdrive config .* already/s);
    const elapsed = Date.now() - start;
    // The rejection itself proves the boundary did NOT hold forever (else the vitest
    // timeout below fires). This is a load-tolerant "bounded" sanity bound — the 200ms
    // deadline timer can be delayed under heavy load, so keep generous headroom.
    expect(elapsed).toBeLessThan(12_000);
    // The lock was released (no infinite hold).
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('the deadline signal is aborted when the deadline fires (so a real fetch would cancel)', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    let capturedSignal: AbortSignal | undefined;
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: (ctx) => {
            capturedSignal = ctx.signal;
            return new Promise<never>(() => {});
          },
          listTimeoutMs: 150,
        },
      ),
    ).rejects.toThrow(/cannot verify/);
    expect(capturedSignal?.aborted).toBe(true);
  }, 10_000);
});

describe('createDefaultRunWrangler — confirmed child termination + kill classification', () => {
  /**
   * A UNIQUE directory per test. Every child spawned in this block runs with its `cwd` set to
   * this directory, and a fixed shared path lets a crashed or concurrent run leave a stale
   * `*.pid` file behind whose pid the OS may since have reassigned — so nothing may be inferred
   * from, and certainly nothing killed by, a pid found on disk. Per-test isolation also stops
   * one case's stranded child from blocking every later case's cleanup.
   */
  let killClassifyTmp = '';
  /**
   * Windows refuses to remove a directory that is a live process's CWD, and `waitForDead` only
   * proves the exit CODE is set — the rundown that releases the CWD handle finishes slightly
   * later. `maxRetries` is Node's documented remedy for exactly that: it retries
   * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM on a linear backoff, and is honored only when
   * `recursive` is set. Inert on POSIX, which unlinks a directory regardless of open handles.
   *
   * This deliberately KILLS NOTHING. A pid read from a file is not proof that the process now
   * holding that pid is the one that wrote it, so signalling it could terminate an unrelated
   * process.
   *
   * A removal that still fails is then classified, not blanket-tolerated: a recorded pid that is
   * STILL LIVE means a child was genuinely stranded — a real leak, failed loud. Otherwise the
   * only things left are the dead child's own script and pid file, which Windows keeps mapped
   * until process rundown completes; that can outlast any practical retry budget and is an OS
   * artifact rather than a defect in the code under test, whose assertions have already passed.
   */
  const rmTmp = (): void => {
    if (killClassifyTmp === '') {
      return;
    }
    try {
      rmSync(killClassifyTmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      return;
    } catch (error) {
      const left = existsSync(killClassifyTmp) ? readdirSync(killClassifyTmp) : [];
      const live = left
        .filter((entry) => entry.endsWith('.pid'))
        .map((entry) => Number(readFileSync(join(killClassifyTmp, entry), 'utf-8').trim()))
        .filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      const detail =
        `${(error as Error).message}\n` +
        `  entries remaining: ${left.length > 0 ? left.join(', ') : '(none)'}\n` +
        `  recorded pids still resolving to a live process: ${live.length > 0 ? live.join(', ') : 'none'}`;
      if (live.length > 0) {
        throw new Error(`could not remove ${killClassifyTmp}: ${detail}`);
      }
      // Nothing of ours is running. Warn so it stays visible, rather than reddening a green
      // behavioural test over temp-file hygiene; the directory is unique per test and ignored by
      // git, so a leftover cannot affect any other case.
      console.warn(`warn: leaving ${killClassifyTmp} behind — ${detail}`);
    }
  };
  beforeEach(() => {
    killClassifyTmp = mkdtempSync(join(import.meta.dirname, '.tmp-kill-classify-'));
  });
  afterEach(() => {
    rmTmp();
  });

  async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('isAlreadyGoneKillError: ESRCH → true (already gone), any other code → false (real failure)', () => {
    expect(isAlreadyGoneKillError(Object.assign(new Error('x'), { code: 'ESRCH' }))).toBe(true);
    expect(isAlreadyGoneKillError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(false);
    expect(isAlreadyGoneKillError(new Error('x'))).toBe(false);
    expect(isAlreadyGoneKillError(null)).toBe(false);
  });

  it('a REAL kill failure (EPERM) on timeout QUARANTINES: the runner REJECTS, never settle-and-release', async () => {
    const pidFile = join(killClassifyTmp, 'cli.pid');
    const hungCli = join(killClassifyTmp, 'hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 300,
      // Simulate a kill that FAILS for a non-ESRCH reason (the child is still alive).
      killProcessGroup: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    });
    // The child may still be running, so the runner must NOT resolve (a resolution would
    // let the provision error path release the whole-provision lock under a live child).
    // It REJECTS with a quarantine error naming the pid + manual-recovery guidance.
    let rejected: unknown;
    try {
      await run(operationFixtureRequest(['d1', 'list', '--json']), { accountId: 'acct' });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WranglerQuarantineError);
    const err = rejected as WranglerQuarantineError;
    expect(err.quarantine).toBe(true);
    expect(err.message).toMatch(/could not be killed: EPERM/);
    expect(err.message).toMatch(/intentionally RETAINED/);
    expect(err.message).toMatch(/pid \d+/);
    // The child is genuinely STILL ALIVE (the bug scenario) — prove it, then clean up.
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    expect(() => process.kill(pid, 0)).not.toThrow();
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('an unconfirmable termination (grace expiry, child still alive) QUARANTINES too', async () => {
    const pidFile = join(killClassifyTmp, 'cli3.pid');
    const hungCli = join(killClassifyTmp, 'hung3.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 250,
      confirmKillGraceMs: 500,
      // A killer that CLAIMS success but kills nothing: the group stays alive, so
      // close/group-gone can never both be confirmed → quarantine at the grace expiry.
      killProcessGroup: () => {},
    });
    let rejected: unknown;
    try {
      await run(operationFixtureRequest(['d1', 'list', '--json']), { accountId: 'acct' });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WranglerQuarantineError);
    expect((rejected as Error).message).toMatch(/could not be confirmed terminated within 500ms/);
    expect((rejected as Error).message).toMatch(/intentionally RETAINED/);
    // Clean up the real child the fake killer left alive.
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('an ESRCH kill (already gone) is treated as SUCCESS — settles as the timeout hard-failure, no kill-error text', async () => {
    const pidFile = join(killClassifyTmp, 'cli2.pid');
    const hungCli = join(killClassifyTmp, 'hung2.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const run = createDefaultRunWrangler(killClassifyTmp, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 300,
      // Kill FOR REAL, then report ESRCH (the child exited in the race window) → treated as gone.
      killProcessGroup: (target, signal) => {
        process.kill(target, signal);
        throw Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' });
      },
    });
    const result = await run(operationFixtureRequest(['d1', 'list', '--json']), {
      accountId: 'acct',
    });
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // ESRCH is NOT a kill failure — no "could not be killed" surfaced.
    expect(result.stderr).not.toMatch(/could not be killed/);
    expect(result.error).toBeNull();
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    expect(await waitForDead(pid, 10_000)).toBe(true);
  }, 15_000);

  it('lock is released only AFTER confirmed child termination: a hung wrangler → provision rejects, child dead, mutex gone', async () => {
    // Drive a FULL provision whose wrangler runner is the REAL default runner spawning a hung
    // CLI. The `d1 list` times out → confirmed-termination hard failure → provision rejects →
    // the whole-provision lock is released. The child must be dead and the mutex gone.
    const cfgDir = join(killClassifyTmp, 'app');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'wrangler.jsonc');
    writeFileSync(cfgPath, JSON.stringify({ name: 'app', account_id: 'acct' }));
    const pidFile = join(killClassifyTmp, 'prov-cli.pid');
    const hungCli = join(killClassifyTmp, 'prov-hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    let spawnedPid: number | undefined;
    const runner = createDefaultRunWrangler(cfgDir, {
      launcher: [process.execPath, hungCli],
      onSpawnedChild: (child) => {
        spawnedPid = child.pid;
      },
      timeoutMs: 400,
    });
    const lockMutex = `${realpathSync(cfgPath)}.void-provision.lock.lock`;
    await expect(
      provisionCloudflareResources(
        cfgDir,
        cfgPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: runner, log: silentLog },
      ),
    ).rejects.toThrow(/d1 list.*(failed|timeout)/s);
    const pid = spawnedPid!;
    expect(pid).toBeTypeOf('number');
    // The child (and its group) was confirmed terminated...
    expect(await waitForDead(pid, 5_000)).toBe(true);
    // ...and the lock was released (never leaked past the child).
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);
});

describe('provisionCloudflareResources — dangling-symlink lock identity', () => {
  it('provisions via dangling-symlink aliases to the SAME not-yet-created target share ONE lock identity (one create)', async () => {
    // A `shared/` dir exists but `shared/wrangler.jsonc` does NOT yet. Two aliases both point
    // (as DANGLING symlinks) at that same not-yet-created target. Without resolving the dangling
    // final link each alias would canonicalize to ITS OWN lexical path → two marker locks → an
    // alias provision would not contend on the canonical lock and both could create a duplicate.
    // (Two provisions can no longer race in ONE process — the identity proof is that
    // an alias provision blocks on the CANONICAL mutex, plus create-then-reuse across aliases.)
    const sharedDir = join(tmpDir, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const target = join(sharedDir, 'wrangler.jsonc'); // NOT created yet — dangling
    const aliasA = join(tmpDir, 'aliasA.jsonc');
    const aliasB = join(tmpDir, 'aliasB.jsonc');
    symlinkSync(target, aliasA);
    symlinkSync(target, aliasB);
    expect(existsSync(target)).toBe(false); // both aliases are dangling at start

    let createCalls = 0;
    const run: RunWrangler = provisionOperationFixture((args) => {
      if (isCall(args, 'hyperdrive', 'create')) {
        createCalls++;
        // --update-config writes to the CANONICAL target (both aliases resolve to it).
        simulateUpdateConfig(
          'hyperdrive',
          { binding: 'HYPERDRIVE', id: hex32('hd-' + createCalls) },
          target,
        );
        return ok();
      }
      return ok();
    });
    const makeProv = (
      aliasPath: string,
      retries?: number,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> =>
      provisionCloudflareResources(
        tmpDir,
        aliasPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => [],
          ...(retries !== undefined ? { lockOptions: { retries } } : {}),
        },
      ) as Promise<{ resources: Array<{ kind: string; action: string }> }>;
    // IDENTITY: while the CANONICAL (real-target) lock is held, a dangling-alias
    // provision cannot acquire — it resolves to the same mutex.
    const canonicalTarget = join(realpathSync(sharedDir), 'wrangler.jsonc');
    const held = await acquireProvisionLock(canonicalTarget);
    await expect(makeProv(aliasA, 0)).rejects.toThrow(/already being held/);
    await held.release();
    // One underlying (initially not-yet-created) file: a create via alias A is
    // read-first-REUSED via alias B.
    const a = await makeProv(aliasA);
    const b = await makeProv(aliasB);
    expect(a.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('created');
    expect(b.resources.find((r) => r.kind === 'hyperdrive')?.action).toBe('reused');
    expect(createCalls).toBe(1);
    // The ONE canonical mutex (keyed on the real target) is released.
    expect(existsSync(`${realpathSync(target)}.void-provision.lock.lock`)).toBe(false);
  }, 15_000);

  it('a non-ENOENT realpath error (a self-referential symlink cycle → ELOOP) SURFACES, not swallowed', async () => {
    // `loop.jsonc` → `loop.jsonc` is a symlink cycle: realpath throws ELOOP (NOT ENOENT). The
    // old broad catch swallowed it and fell back to a bogus lexical path; the fix rethrows it.
    mkdirSync(tmpDir, { recursive: true });
    const loop = join(tmpDir, 'loop.jsonc');
    symlinkSync(loop, loop);
    const { run } = makeRunner([]);
    await expect(
      provisionCloudflareResources(
        tmpDir,
        loop,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/ELOOP/);
  });
});

describe('provisionCloudflareResources — dotenv fence: export prefix + empty-env files', () => {
  const redirect = 'CLOUDFLARE_API_BASE_URL=https://api.staging.cloudflare.com/client/v4\n';
  const runFail = () => {
    const { run, calls } = makeRunner([]);
    return { run, calls };
  };

  it('detects an `export `-prefixed transport-redirect var in `.env` and fails closed (no remote work)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), `export ${redirect}`);
    const { run, calls } = runFail();
    let listerCalled = false;
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          d1: { binding: 'DB', name: 'myapp-db' },
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: '' },
        },
        {
          runWrangler: run,
          log: silentLog,
          listHyperdriveConfigs: async () => {
            listerCalled = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow(/refusing to provision.*\.env.*CLOUDFLARE_API_BASE_URL.*redirect/s);
    expect(calls.length).toBe(0);
    expect(listerCalled).toBe(false);
  });

  it('detects a transport-redirect var in the empty-env file `.env.` (loaded because every command passes --env=)', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env.'), redirect);
    const { run, calls } = runFail();
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/refusing to provision.*"\.env\.".*CLOUDFLARE_API_BASE_URL.*redirect/s);
    expect(calls.length).toBe(0);
  });

  it('detects a transport-redirect var in the empty-env file `.env..local`', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env..local'), redirect);
    const { run, calls } = runFail();
    await expect(
      provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
        { runWrangler: run, log: silentLog },
      ),
    ).rejects.toThrow(/refusing to provision.*"\.env\.\.local".*redirect/s);
    expect(calls.length).toBe(0);
  });

  it('does NOT false-trigger on a benign `.env` with an unrelated `export` var', async () => {
    setup(JSON.stringify({ account_id: 'config-acct', name: 'app' }));
    writeFileSync(join(tmpDir, '.env'), 'export DATABASE_URL=postgres://localhost/app\nFOO=bar\n');
    const { run } = makeRunner([
      { match: /^d1 list/, reply: () => ok('[]') },
      {
        match: /^d1 create/,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: uuid('db'),
          });
          return ok();
        },
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(result.resources.find((r) => r.kind === 'd1')?.action).toBe('created');
  });
});

describe('checkCloudflareProvisionDrift — id-drift vs the committed wrangler config', () => {
  it('reports every desired id-bearing resource as missing when the config file is absent', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [
        { binding: 'KV', title: 'myapp-kv' },
        { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
      ],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: ['jobs'],
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
    });
    // Queues are name-bearing, not id-bearing → excluded from the id-drift check.
    expect(missing.map((m) => m.binding).sort()).toEqual([
      'DB',
      'HYPERDRIVE',
      'ISR_CACHE',
      'KV',
      'STORAGE',
    ]);
  });

  it('treats placeholder ids (local / default) as NOT provisioned', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
        kv_namespaces: [{ binding: 'ISR_CACHE', id: 'local' }],
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }],
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr-cache' }],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: [],
    });
    expect(missing.map((m) => m.kind).sort()).toEqual(['d1', 'kv', 'r2']);
  });

  it('accepts a stored R2 bucket named default when that is the desired bucket', () => {
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'default' }] }));
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      ...emptyDesired,
      r2: { binding: 'STORAGE', bucketName: 'default' },
    });
    expect(missing).toEqual([]);
  });

  it('reports NO drift when every desired resource has a real id', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db') }],
        kv_namespaces: [
          { binding: 'KV', id: hex32('kv') },
          { binding: 'ISR_CACHE', id: hex32('isr') },
        ],
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'myapp-storage' }],
        hyperdrive: [{ binding: 'HYPERDRIVE', id: hex32('hd') }],
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [
        { binding: 'KV', title: 'myapp-kv' },
        { binding: 'ISR_CACHE', title: 'myapp-isr-cache' },
      ],
      r2: { binding: 'STORAGE', bucketName: 'myapp-storage' },
      queues: [],
      hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hyperdrive', connectionString: '' },
    });
    expect(missing).toEqual([]);
  });

  it('flags only the newly-desired resource when the rest are already provisioned', () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: uuid('db') }],
        // ISR_CACHE not yet declared — routes just started using `revalidate`.
      }),
    );
    const { missing } = checkCloudflareProvisionDrift(wranglerPath, {
      d1: { binding: 'DB', name: 'myapp-db' },
      kvNamespaces: [{ binding: 'ISR_CACHE', title: 'myapp-isr-cache' }],
      queues: [],
    });
    expect(missing).toEqual([{ binding: 'ISR_CACHE', kind: 'kv', name: 'myapp-isr-cache' }]);
  });
});
