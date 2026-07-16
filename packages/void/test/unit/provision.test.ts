import {
  existsSync,
  mkdir,
  mkdirSync,
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
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  acquireProvisionLock,
  assertNoTransportRedirectInProjectDotenv,
  createDefaultRunWrangler,
  isAlreadyGoneKillError,
  normalizeRunWranglerResult,
  provisionCloudflareResources,
  provisionEnv,
  resolvePinnedApiBaseUrl,
  WranglerQuarantineError,
  type DesiredResourceSet,
  type RunWrangler,
  type RunWranglerResult,
} from '../../src/cli/provision.ts';

/**
 * A passthrough of proper-lockfile's callback-style fs seam (mkdir/stat/utimes/rmdir/
 * realpath + a sync rmdir). The F2 unlock-failure test overrides `rmdir` on top of this.
 */
const passthruFs = { mkdir, stat, utimes, rmdir, realpath, rmdirSync };

const tmpDir = join(import.meta.dirname, '.tmp-provision-test');
const wranglerPath = join(tmpDir, 'wrangler.jsonc');

function setup(content: string): void {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(wranglerPath, content);
}

/**
 * F2 — the provisioner requires a resolvable Cloudflare account whenever `desired`
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
  const run: RunWrangler = (args) => {
    calls.push(args);
    const sub = args.join(' ');
    for (const handler of handlers) {
      if (handler.match.test(sub)) {
        return handler.reply(sub);
      }
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  return { run, calls };
}

/** True when an argv array is a `wrangler <a> <b> …` invocation of a given kind. */
function isCall(argv: Array<string>, ...prefix: Array<string>): boolean {
  return prefix.every((token, i) => argv[i] === token);
}

const ok = (stdout = ''): RunWranglerResult => ({ stdout, stderr: '', status: 0 });
const fail = (stdout: string, stderr = ''): RunWranglerResult => ({ stdout, stderr, status: 1 });

// Valid-FORMAT synthetic ids for fixtures. F4's validators require REAL shapes:
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

describe('provisionCloudflareResources — read-first', () => {
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
        spacedPath,
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
    expect(result.configPath).toBe(jsonPath);
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

describe('provisionCloudflareResources — D1 discovery gate + strict validation (F4)', () => {
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
    // wrangler 4.107 `r2 bucket info` also runs a metrics/GraphQL query, so an
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

  it('skips with a structured reason when no connection string is provided (never prompts, never creates)', async () => {
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
      { runWrangler: run, log: { info: () => {}, warn: (m) => warnings.push(m) } },
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

  it('creates a queue that `queues info` reports missing; verifies with a follow-up info probe (F4)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    // F4: after `queues create`, the provisioner RE-RUNS `queues info` and only
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

  it('does NOT create on a generic/unrelated "not found" (e.g. Account not found) — fails closed (F5)', async () => {
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

  it('is name-aware: a "does not exist" for a DIFFERENT queue name is NOT absence for this one (F5)', async () => {
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

  it('creates ONLY on the exact `Queue "<name>" does not exist` signal for THAT name (F5)', async () => {
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

  it('fails closed when a masked-signal `queues create` (wrapper exit 0) did NOT create the queue (F4)', async () => {
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

describe('provisionCloudflareResources — account reconciliation + config pin (F1)', () => {
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

  it('persists account_id BEFORE any remote op so a later different-account retry fails closed (F1)', async () => {
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
    // the top-level `--env=` pin (F1).
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

describe('provisionCloudflareResources — F1 pinned transport (one base for wrangler + REST)', () => {
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
    // F4 — the lister is handed the overall-deadline signal to thread into every fetch.
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

describe('provisionCloudflareResources — Hyperdrive discovery (F2 pagination + fail closed)', () => {
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

describe('provisionCloudflareResources — KV/R2 fail closed on schema-valid ambiguity (F3)', () => {
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

describe('normalizeRunWranglerResult — signal / spawn-error handling (F5)', () => {
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

  it('carries structured signal/error provenance (round-4 F3)', () => {
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

describe('createDefaultRunWrangler — hard timeout kills the REAL process (F2)', () => {
  const F2_TMP = join(import.meta.dirname, '.tmp-f2-timeout');
  beforeEach(() => {
    rmSync(F2_TMP, { recursive: true, force: true });
    mkdirSync(F2_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(F2_TMP, { recursive: true, force: true });
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
    // and hangs forever, writing its pid so the test can confirm it was actually killed.
    const pidFile = join(F2_TMP, 'cli.pid');
    const hungCli = join(F2_TMP, 'hung-cli.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` + // survives a plain SIGTERM (like the wrapper sends)
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createDefaultRunWrangler(F2_TMP, {
      launcher: [process.execPath, hungCli],
      timeoutMs: 400,
    });
    const start = Date.now();
    const result = await run(['d1', 'list', '--json'], { accountId: 'acct' });
    const elapsed = Date.now() - start;
    // Settled within the timeout window (generous ceiling to avoid CI flake).
    expect(elapsed).toBeLessThan(5_000);
    // HARD failure: a non-null signal, folded to a non-zero status.
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exceeded the 400ms command timeout/);
    // No lingering process — the SIGKILL reached the real CLI.
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(await waitForDead(pid, 5_000)).toBe(true);
  });

  it('a WRAPPER that re-spawns a hung grandchild: runner still settles in time AND the grandchild is reaped (F2)', async () => {
    // The exact scenario the finding describes: a `bin/wrangler.js`-style wrapper that
    // spawns an inner CLI with inherited stdio and forwards only SIGTERM (never SIGKILL),
    // mapping a signal-killed child to exit 0. Pre-fix this defeated the timeout (the
    // grandchild survived holding the pipes so `close` never fired). The runner now spawns
    // the launcher in its OWN process group and SIGKILLs the WHOLE group on timeout, then
    // settles immediately — so even a wrapper-plus-hung-grandchild rejects within the
    // timeout with NO lingering process.
    const gcPidFile = join(F2_TMP, 'grandchild.pid');
    const grandchild = join(F2_TMP, 'grandchild.cjs');
    writeFileSync(
      grandchild,
      `require('fs').writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` + // ignore the wrapper's forwarded SIGTERM
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const wrapper = join(F2_TMP, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      `const { spawn } = require('child_process');\n` +
        `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['inherit','inherit','inherit'] });\n` +
        `child.on('exit', (code) => process.exit(code === null ? 0 : code));\n` + // mask signal death as exit 0
        `process.on('SIGTERM', () => child.kill());\n` + // forward only SIGTERM (default)
        `process.on('SIGINT', () => child.kill());\n`,
    );
    const run = createDefaultRunWrangler(F2_TMP, {
      launcher: [process.execPath, wrapper],
      timeoutMs: 500,
    });
    const start = Date.now();
    const result = await run(['d1', 'list', '--json'], { accountId: 'acct' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // The grandchild wrote its pid, then must have been reaped by the process-group kill.
    const gcPid = Number(readFileSync(gcPidFile, 'utf-8'));
    expect(Number.isInteger(gcPid)).toBe(true);
    expect(await waitForDead(gcPid, 5_000)).toBe(true);
  });
});

describe('provisionCloudflareResources — F1 account gate + env scrub (round 4)', () => {
  it('provisionEnv scrubs CLOUDFLARE_ENV + the CF Access token pair and pins the account (F1)', () => {
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string): void => {
      saved[k] = process.env[k];
      process.env[k] = v;
    };
    set('CLOUDFLARE_ENV', 'staging');
    set('CF_ACCESS_CLIENT_ID', 'id');
    set('CF_ACCESS_CLIENT_SECRET', 'secret');
    try {
      const env = provisionEnv({ accountId: 'acct-X' });
      // CLOUDFLARE_ENV would let wrangler select an env-specific account block.
      expect(env.CLOUDFLARE_ENV).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
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

  it('provisionEnv scrubs EVERY transport-redirect var and pins the ONE resolved API base (F1)', () => {
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

describe('provisionCloudflareResources — F2 resource-name validation (round 4)', () => {
  const badNames = ['--help', '--config', '-h'];
  const kinds: Array<{
    label: RegExp;
    desired: (name: string) => DesiredResourceSet;
    createPrefix: Array<string>;
  }> = [
    {
      // badNames all start with "-", so the universal option-injection guard fires FIRST
      // (F5 split) with "refusing to pass an unsafe <label> name", before the grammar check.
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

describe('provisionCloudflareResources — F3 signal-killed probe never authorizes create (round 4)', () => {
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

describe('provisionCloudflareResources — F4 create postcondition (round 4)', () => {
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

describe('provisionCloudflareResources — F5 strict D1 identity (round 4)', () => {
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
    ).rejects.toThrow(/ambiguous or empty id/);
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

describe('provisionCloudflareResources — F1 top-level env pin via --env= (round 5)', () => {
  it('pins the top-level env on EVERY wrangler call even when CLOUDFLARE_ENV names a different env/account', async () => {
    // wrangler 4.107 reloads a project `.env`/`.env.local` into process.env on every
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

describe('provisionCloudflareResources — F2 boundary account fence (round 5)', () => {
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

describe('provisionCloudflareResources — F3 absolute config path (round 5)', () => {
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
    expect(result.configPath).toBe(abs);
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf('-c');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBe(abs); // wrangler `-c` is the SAME absolute file
    }
    // The adopted id landed in root/wrangler.jsonc — the file Node read from too.
    const after = parseJsoncRaw(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
    expect((after.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe(hex32('kv'));
  });
});

describe('provisionCloudflareResources — F5 one D1 normalizer (round 5)', () => {
  it('fails closed on CONFLICTING name aliases (name vs database_name) for the requested database', async () => {
    // The exact F5 scenario: a list member claims the requested name via `name` but its
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

describe('provisionCloudflareResources — transport account context (round 6 F1)', () => {
  it('threads the reconciled account into EVERY wrangler call AND the Hyperdrive lister', async () => {
    // Config pins the account → it is the reconciled effective account (config wins
    // over the ambient CLOUDFLARE_ACCOUNT_ID). Every seam invocation must receive it.
    setup(JSON.stringify({ account_id: 'reconciled-acct' }));
    const seenRunAccounts: Array<string> = [];
    const seenListAccounts: Array<string> = [];
    const run: RunWrangler = (args, opts) => {
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
    };
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

describe('provisionCloudflareResources — boundary duplicate-member guard (round 6 F2)', () => {
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

describe('provisionCloudflareResources — Hyperdrive list validation at the caller (round 6 F3)', () => {
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

  it('F4 — fails closed on a NON-matching member with a malformed id (no create)', async () => {
    // A member for a DIFFERENT config carries a bogus (non-hex) id. Before F4 this passed
    // the whole-list gate (only the name-matched member was format-checked), so an ABSENT
    // target authorized a blind create against a possibly-untrustworthy list. Now every
    // member's id is format-validated up front → fail closed, NO create.
    await expect(
      provisionWithInjectedList([{ id: 'bogus', name: 'someone-else' }]),
    ).rejects.toThrow(/malformed id "bogus".*32-character hex Hyperdrive id/s);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  // F3 — a runtime null/undefined/non-array OUTER result must be treated as UNKNOWN
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

describe('provisionCloudflareResources — F4 whole-list id-format gate (D1 + KV, before name filtering)', () => {
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

describe('provisionCloudflareResources — F5 strict duplicate-safe binding reader', () => {
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

describe('provisionCloudflareResources — resource-specific create postcondition (round 6 F4)', () => {
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

describe('provisionCloudflareResources — F4 resource-specific real-id validators', () => {
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

describe('provisionCloudflareResources — F5 KV title grammar vs option-injection guard', () => {
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

describe('provisionCloudflareResources — F6 queue name grammar (Cloudflare Queues)', () => {
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

describe('provisionCloudflareResources — whole-provision cross-process lock (F1/F2, proper-lockfile)', () => {
  // proper-lockfile locks a dedicated adjacent MARKER file (persists between runs) and
  // implements the mutex as `${marker}.lock` DIRECTORY (removed on release). "No leak"
  // therefore means the MUTEX dir is gone (not the marker file).
  const lockMarker = `${wranglerPath}.void-provision.lock`;
  const lockMutex = `${lockMarker}.lock`;
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('two concurrent Hyperdrive provisions race — exactly ONE create, the other reuses, mutex released', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    let createCalls = 0;
    const makeProv = (): Promise<{ resources: Array<{ kind: string; action: string }> }> => {
      const run: RunWrangler = (args) => {
        if (isCall(args, 'hyperdrive', 'create')) {
          createCalls++;
          simulateUpdateConfig('hyperdrive', {
            binding: 'HYPERDRIVE',
            id: hex32('hd-' + createCalls),
          });
          return ok();
        }
        return ok();
      };
      return provisionCloudflareResources(
        tmpDir,
        wranglerPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          // Barrier: the winner holds the lock while LISTING (40ms), so the loser blocks
          // on the lock — proving the LOCK (not accidental sequencing) serializes them.
          listHyperdriveConfigs: async () => {
            await delay(40);
            return [];
          },
        },
      ) as Promise<{ resources: Array<{ kind: string; action: string }> }>;
    };
    const [a, b] = await Promise.all([makeProv(), makeProv()]);
    const actions = [...a.resources, ...b.resources]
      .filter((r) => r.kind === 'hyperdrive')
      .map((r) => r.action)
      .sort();
    // Exactly one create; the second read-first (inside the lock) reused the first's id.
    expect(createCalls).toBe(1);
    expect(actions).toEqual(['created', 'reused']);
    // Mutex always released — no leak.
    expect(existsSync(lockMutex)).toBe(false);
  });

  it('recovers a STALE/abandoned lock (old mtime, crashed owner) and proceeds', async () => {
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    // Simulate a crashed owner's abandoned mutex: the marker + a mutex dir whose mtime
    // is well past the 120s stale window, so proper-lockfile compromises + steals it.
    writeFileSync(lockMarker, '');
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

  it('F3 — concurrent provisions through a SYMLINK ALIAS to the same config serialize (one lock, one create)', async () => {
    // A real config + a symlink alias to it. Both provisions hit the SAME underlying file
    // but via DIFFERENT lexical paths. Without realpath canonicalization each derives its
    // own marker dir (`<lexical>.void-provision.lock`), so both acquire "the" lock at once
    // and both create a duplicate. With F3 both canonicalize to ONE identity → one lock →
    // the loser blocks, then read-first (under the lock) reuses the winner's id.
    setup(
      JSON.stringify({ account_id: 'acct', hyperdrive: [{ binding: 'HYPERDRIVE', id: 'local' }] }),
    );
    const aliasName = 'wrangler.alias.jsonc';
    symlinkSync(wranglerPath, join(tmpDir, aliasName));
    // Sanity: the alias and the real config canonicalize to the same real file.
    expect(realpathSync(join(tmpDir, aliasName))).toBe(realpathSync(wranglerPath));
    let createCalls = 0;
    const makeProv = (
      configArg: string,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> => {
      const run: RunWrangler = (args) => {
        if (isCall(args, 'hyperdrive', 'create')) {
          createCalls++;
          simulateUpdateConfig('hyperdrive', {
            binding: 'HYPERDRIVE',
            id: hex32('hd-' + createCalls),
          });
          return ok();
        }
        return ok();
      };
      return provisionCloudflareResources(
        tmpDir,
        configArg,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          // Barrier: the winner holds the lock while LISTING (40ms), so the loser blocks
          // on the shared lock — proving canonicalization (not sequencing) serializes them.
          listHyperdriveConfigs: async () => {
            await delay(40);
            return [];
          },
        },
      ) as Promise<{ resources: Array<{ kind: string; action: string }> }>;
    };
    // One via the REAL absolute path, one via the SYMLINK ALIAS (relative).
    const [a, b] = await Promise.all([makeProv(wranglerPath), makeProv(aliasName)]);
    const actions = [...a.resources, ...b.resources]
      .filter((r) => r.kind === 'hyperdrive')
      .map((r) => r.action)
      .sort();
    expect(createCalls).toBe(1);
    expect(actions).toEqual(['created', 'reused']);
    // The single canonical mutex was released.
    expect(existsSync(`${realpathSync(wranglerPath)}.void-provision.lock.lock`)).toBe(false);
  });

  it('F1 — two racing FIRST-RUNS (accounts A and B) serialize; the second fails closed on mismatch, no cross-account write', async () => {
    // Neither run has a config account_id at start. The whole-provision lock forces them
    // to serialize: the winner reads no account, persists its own, and provisions; the
    // loser — under the lock — re-reads the persisted account and fails closed on the
    // A≠B mismatch BEFORE any create, so it never rebinds the winner's resources.
    setup(JSON.stringify({ name: 'app' }));
    const savedAmbient = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID; // force reconciliation via opts.accountId only
    try {
      const makeProv = (account: string): Promise<unknown> => {
        const run: RunWrangler = (args) => {
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
        };
        return provisionCloudflareResources(
          tmpDir,
          wranglerPath,
          {
            ...emptyDesired,
            // A slow lister keeps the winner holding the lock long enough that the loser
            // is forced to wait on it (serialization, not accidental sequencing).
            d1: { binding: 'DB', name: 'myapp-db' },
          },
          {
            runWrangler: run,
            accountId: account,
            log: silentLog,
            listHyperdriveConfigs: async () => [],
          },
        );
      };
      const results = await Promise.allSettled([makeProv('acct-A'), makeProv('acct-B')]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      // Exactly one wins; the other fails closed on the account mismatch.
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(String(rejected[0].reason)).toMatch(/account mismatch/);
      // The config is pinned to the WINNER, with the winner's D1 id — no cross-account
      // overwrite (both never wrote; the loser never ran a wrangler create).
      const cfg = readConfig();
      const winner = cfg.account_id as string;
      expect(['acct-A', 'acct-B']).toContain(winner);
      const d1 = (cfg.d1_databases as Array<Record<string, unknown>>)[0];
      expect(d1.database_id).toBe(uuid('db-' + winner));
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

  it('F1 — a wrangler call blocking past a SHORT stale window does NOT let a second process steal the mutex (async heartbeat keeps it fresh)', async () => {
    setup(JSON.stringify({ account_id: 'acct', kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const run: RunWrangler = async (args) => {
      if (isCall(args, 'kv', 'namespace', 'list')) {
        await delay(3000); // blocks (async) for 3s > the 2s stale window
        return ok(JSON.stringify([{ id: hex32('kv'), title: 'myapp-kv' }]));
      }
      return ok();
    };
    const prov = provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog, lockOptions: { stale: 2000, update: 1000, retries: 0 } },
    );
    // 2.5s into the block — PAST the 2s stale window. If the async heartbeat did not keep the
    // mutex fresh, a retries:0 acquire would STEAL it; it must be REFUSED instead.
    await delay(2500);
    await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow();
    const result = await prov;
    expect(result.resources[0]).toMatchObject({ kind: 'kv', action: 'adopted', id: hex32('kv') });
    expect(existsSync(lockMutex)).toBe(false);
  }, 15000);

  it('F2 — a genuine unlock failure REJECTS the provision (leaked mutex surfaced, not swallowed)', async () => {
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

  it('F7 — a body failure COMBINED with an unlock failure surfaces BOTH (AggregateError)', async () => {
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

describe('provisionCloudflareResources — F1 config compliance_region pins the transport (round 10)', () => {
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
    const run: RunWrangler = (args, opts) => {
      calls.push(args);
      // The wrangler child is pinned to the SAME base via its env transport context.
      expect(opts.apiBaseUrl).toBe('https://api.fed.cloudflare.com/client/v4');
      return { stdout: '', stderr: '', status: 0 };
    };
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

describe('provisionCloudflareResources — F1 wrangler-exact base resolution order (round 11)', () => {
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
      resolvePinnedApiBaseUrl({ CLOUDFLARE_API_BASE_URL: '', CF_API_BASE_URL: 'https://cf.example' }),
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
        { CLOUDFLARE_API_BASE_URL: 'https://direct.example', CLOUDFLARE_COMPLIANCE_REGION: 'public' },
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

describe('provisionCloudflareResources — F4 Hyperdrive password never reaches wrangler diagnostics (round 11)', () => {
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
        { ...emptyDesired, hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: conn } },
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

describe('provisionCloudflareResources — F5 dotenv fence file set + case rule are wrangler-exact (round 11)', () => {
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

describe('provisionCloudflareResources — F7 read-first stored-name identity (round 11)', () => {
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
    setup(JSON.stringify({ r2_buckets: [{ binding: 'STORAGE', bucket_name: 'someone-elses-bucket' }] }));
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
});

describe('provisionCloudflareResources — F2 quarantine retains the whole-provision lock (round 11)', () => {
  const lockMutex = `${wranglerPath}.void-provision.lock.lock`;

  it('a quarantine rejection RETAINS the mutex (not released) and surfaces the quarantine error', async () => {
    setup(JSON.stringify({ account_id: 'acct', name: 'app' }));
    // A runner whose child could not be confirmed dead — the default runner rejects
    // with a quarantine error in that state; injecting the same rejection exercises the
    // provision-level contract: NO release, mutex retained, error surfaced verbatim.
    const quarantineError = new WranglerQuarantineError(43210, 'test: child unconfirmed');
    const run: RunWrangler = () => Promise.reject(quarantineError);
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
    // Cleanup: remove the retained mutex so later tests can lock again. quarantine()
    // detached the lock from proper-lockfile's tracking, so no heartbeat/compromise
    // callback fires after this removal.
    rmSync(lockMutex, { recursive: true, force: true });
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

describe('createDefaultRunWrangler — F2 parent-signal forwarding awaits confirmed teardown (round 11)', () => {
  const SIG_TMP = join(import.meta.dirname, '.tmp-f2-signal-round11');
  beforeEach(() => {
    rmSync(SIG_TMP, { recursive: true, force: true });
    mkdirSync(SIG_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(SIG_TMP, { recursive: true, force: true });
  });

  it('SIGTERM to the parent: the child group is confirmed dead BEFORE the parent re-raises and exits', async () => {
    // A REAL parent process (so the re-raise/exit is observable) runs the runner around a
    // child that exits 250ms AFTER receiving the forwarded SIGTERM. Pre-fix the parent
    // re-raised immediately — it was dead while the child lived on (proper-lockfile's exit
    // hook would strip the mutex under a live child). Post-fix the parent awaits the
    // confirmed teardown, so AT parent exit the child is deterministically gone.
    const pidFile = join(SIG_TMP, 'child.pid');
    const childScript = join(SIG_TMP, 'slow-exit-child.cjs');
    writeFileSync(
      childScript,
      `require('fs').writeFileSync(process.argv[2], String(process.pid));\n` +
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const parentScript = join(SIG_TMP, 'parent.mjs');
    const provisionUrl = `file://${join(import.meta.dirname, '../../src/cli/provision.ts')}`;
    writeFileSync(
      parentScript,
      `import { createDefaultRunWrangler } from ${JSON.stringify(provisionUrl)};\n` +
        `const run = createDefaultRunWrangler(process.cwd(), {\n` +
        `  launcher: [process.execPath, ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}],\n` +
        `});\n` +
        `run(['noop'], { accountId: 'acct' }).then(\n` +
        `  (r) => console.log('runner-settled', r.status, r.signal),\n` +
        `  (e) => console.log('runner-rejected', e.message),\n` +
        `);\n`,
    );
    const { spawn } = await import('node:child_process');
    const parent = spawn(process.execPath, [parentScript], {
      cwd: SIG_TMP,
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

describe('withListerDeadline — F3 the deadline holds in a REAL process (round 11, child-process regression)', () => {
  const F3R11_TMP = join(import.meta.dirname, '.tmp-f3-round11');
  beforeEach(() => {
    rmSync(F3R11_TMP, { recursive: true, force: true });
    mkdirSync(F3R11_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(F3R11_TMP, { recursive: true, force: true });
  });

  it('a never-settling lister REJECTS after the deadline — the process does NOT exit 0 early, lock released', async () => {
    // Pre-fix, the deadline timer was unref'd: with a never-settling lister nothing else
    // referenced the loop (proper-lockfile's heartbeat is unref'd too), so a REAL node
    // process drained its loop and exited STATUS 0 before the deadline fired — silently
    // "succeeding" mid-provision. Vitest's own handles mask this in-worker, so the
    // regression must run in a spawned child process.
    const appRoot = join(F3R11_TMP, 'app');
    const probe = join(F3R11_TMP, 'probe.mjs');
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
      cwd: F3R11_TMP,
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
      expect(
        existsSync(join(appRoot, 'wrangler.jsonc.void-provision.lock.lock')),
      ).toBe(false);
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

describe('provisionCloudflareResources — F5 R2 absence needs the STRUCTURED code (round 10)', () => {
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

describe('provisionCloudflareResources — F4 Hyperdrive lister deadline (round 10)', () => {
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
    expect(elapsed).toBeLessThan(5_000);
    // The lock was released (no infinite hold).
    expect(existsSync(lockMutex)).toBe(false);
  }, 10_000);

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

describe('createDefaultRunWrangler — F3 confirmed child termination + kill classification (round 10)', () => {
  const F3_TMP = join(import.meta.dirname, '.tmp-f3-round10');
  beforeEach(() => {
    rmSync(F3_TMP, { recursive: true, force: true });
    mkdirSync(F3_TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(F3_TMP, { recursive: true, force: true });
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

  it('a REAL kill failure (EPERM) on timeout QUARANTINES: the runner REJECTS, never settle-and-release (round 11)', async () => {
    const pidFile = join(F3_TMP, 'cli.pid');
    const hungCli = join(F3_TMP, 'hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createDefaultRunWrangler(F3_TMP, {
      launcher: [process.execPath, hungCli],
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
      await run(['d1', 'list', '--json'], { accountId: 'acct' });
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
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 5_000)).toBe(true);
  });

  it('an unconfirmable termination (grace expiry, child still alive) QUARANTINES too (round 11)', async () => {
    const pidFile = join(F3_TMP, 'cli3.pid');
    const hungCli = join(F3_TMP, 'hung3.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createDefaultRunWrangler(F3_TMP, {
      launcher: [process.execPath, hungCli],
      timeoutMs: 250,
      confirmKillGraceMs: 500,
      // A killer that CLAIMS success but kills nothing: the group stays alive, so
      // close/group-gone can never both be confirmed → quarantine at the grace expiry.
      killProcessGroup: () => {},
    });
    let rejected: unknown;
    try {
      await run(['d1', 'list', '--json'], { accountId: 'acct' });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WranglerQuarantineError);
    expect((rejected as Error).message).toMatch(/could not be confirmed terminated within 500ms/);
    expect((rejected as Error).message).toMatch(/intentionally RETAINED/);
    // Clean up the real child the fake killer left alive.
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    expect(await waitForDead(pid, 5_000)).toBe(true);
  });

  it('an ESRCH kill (already gone) is treated as SUCCESS — settles as the timeout hard-failure, no kill-error text', async () => {
    const pidFile = join(F3_TMP, 'cli2.pid');
    const hungCli = join(F3_TMP, 'hung2.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const run = createDefaultRunWrangler(F3_TMP, {
      launcher: [process.execPath, hungCli],
      timeoutMs: 300,
      // Kill FOR REAL, then report ESRCH (the child exited in the race window) → treated as gone.
      killProcessGroup: (target, signal) => {
        process.kill(target, signal);
        throw Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' });
      },
    });
    const result = await run(['d1', 'list', '--json'], { accountId: 'acct' });
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    // ESRCH is NOT a kill failure — no "could not be killed" surfaced.
    expect(result.stderr).not.toMatch(/could not be killed/);
    expect(result.error).toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    expect(await waitForDead(pid, 5_000)).toBe(true);
  });

  it('lock is released only AFTER confirmed child termination: a hung wrangler → provision rejects, child dead, mutex gone', async () => {
    // Drive a FULL provision whose wrangler runner is the REAL default runner spawning a hung
    // CLI. The `d1 list` times out → confirmed-termination hard failure → provision rejects →
    // the whole-provision lock is released. The child must be dead and the mutex gone.
    const cfgDir = join(F3_TMP, 'app');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'wrangler.jsonc');
    writeFileSync(cfgPath, JSON.stringify({ name: 'app', account_id: 'acct' }));
    const pidFile = join(F3_TMP, 'prov-cli.pid');
    const hungCli = join(F3_TMP, 'prov-hung.cjs');
    writeFileSync(
      hungCli,
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const runner = createDefaultRunWrangler(cfgDir, {
      launcher: [process.execPath, hungCli],
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
    const pid = Number(readFileSync(pidFile, 'utf-8'));
    // The child (and its group) was confirmed terminated...
    expect(await waitForDead(pid, 5_000)).toBe(true);
    // ...and the lock was released (never leaked past the child).
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);
});

describe('provisionCloudflareResources — F2 dangling-symlink lock identity (round 10)', () => {
  it('two concurrent provisions via a dangling-symlink alias to the SAME not-yet-created target serialize (one lock, one create)', async () => {
    // A `shared/` dir exists but `shared/wrangler.jsonc` does NOT yet. Two aliases both point
    // (as DANGLING symlinks) at that same not-yet-created target. Without resolving the dangling
    // final link each alias would canonicalize to ITS OWN lexical path → two marker locks → both
    // create a duplicate. With F2 both resolve to the ONE real target → one lock → the loser
    // blocks, then read-first (under the lock) reuses the winner's id.
    const sharedDir = join(tmpDir, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const target = join(sharedDir, 'wrangler.jsonc'); // NOT created yet — dangling
    const aliasA = join(tmpDir, 'aliasA.jsonc');
    const aliasB = join(tmpDir, 'aliasB.jsonc');
    symlinkSync(target, aliasA);
    symlinkSync(target, aliasB);
    expect(existsSync(target)).toBe(false); // both aliases are dangling at start

    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let createCalls = 0;
    const makeProv = (
      aliasPath: string,
    ): Promise<{ resources: Array<{ kind: string; action: string }> }> => {
      const run: RunWrangler = (args) => {
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
      };
      return provisionCloudflareResources(
        tmpDir,
        aliasPath,
        {
          ...emptyDesired,
          hyperdrive: { binding: 'HYPERDRIVE', name: 'myapp-hd', connectionString: 'postgres://x' },
        },
        {
          runWrangler: run,
          log: silentLog,
          // Barrier: the winner holds the lock while LISTING (40ms) so the loser must wait on
          // the SHARED lock — proving the dangling-link canonicalization (not sequencing) serializes.
          listHyperdriveConfigs: async () => {
            await delay(40);
            return [];
          },
        },
      ) as Promise<{ resources: Array<{ kind: string; action: string }> }>;
    };
    const [a, b] = await Promise.all([makeProv(aliasA), makeProv(aliasB)]);
    const actions = [...a.resources, ...b.resources]
      .filter((r) => r.kind === 'hyperdrive')
      .map((r) => r.action)
      .sort();
    expect(createCalls).toBe(1);
    expect(actions).toEqual(['created', 'reused']);
    // The ONE canonical mutex (keyed on the real target) is released.
    expect(existsSync(`${realpathSync(target)}.void-provision.lock.lock`)).toBe(false);
  }, 15_000);

  it('a non-ENOENT realpath error (a self-referential symlink cycle → ELOOP) SURFACES, not swallowed', async () => {
    // `loop.jsonc` → `loop.jsonc` is a symlink cycle: realpath throws ELOOP (NOT ENOENT). The
    // old broad catch swallowed it and fell back to a bogus lexical path; F2 rethrows it.
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

describe('provisionCloudflareResources — F6 dotenv fence: export prefix + empty-env files (round 10)', () => {
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
