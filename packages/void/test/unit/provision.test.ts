import {
  existsSync,
  mkdir,
  mkdirSync,
  readFileSync,
  realpath,
  rmdir,
  rmdirSync,
  rmSync,
  stat,
  utimes,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  acquireProvisionLock,
  normalizeRunWranglerResult,
  provisionCloudflareResources,
  provisionEnv,
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
        reply: () => fail('', 'X [ERROR] The specified bucket does not exist'),
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
          { id: 'other-hd', name: 'someone-else' },
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
      { match: /^r2 bucket info /, reply: () => fail('', 'The specified bucket does not exist') },
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
          result: [{ id: 'p1a', name: 'other-1' }],
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
            { id: 'hd-1', name: 'myapp-hd' },
            { id: 'hd-2', name: 'myapp-hd' },
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

describe('provisionCloudflareResources — F1 account gate + env scrub (round 4)', () => {
  it('provisionEnv scrubs CLOUDFLARE_ENV + the CF Access token pair and pins the account', () => {
    const prevEnv = process.env.CLOUDFLARE_ENV;
    const prevId = process.env.CF_ACCESS_CLIENT_ID;
    const prevSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    process.env.CLOUDFLARE_ENV = 'staging';
    process.env.CF_ACCESS_CLIENT_ID = 'id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'secret';
    try {
      const env = provisionEnv('acct-X');
      // CLOUDFLARE_ENV would let wrangler select an env-specific account block.
      expect(env.CLOUDFLARE_ENV).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-X');
    } finally {
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      };
      restore('CLOUDFLARE_ENV', prevEnv);
      restore('CF_ACCESS_CLIENT_ID', prevId);
      restore('CF_ACCESS_CLIENT_SECRET', prevSecret);
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
      { match: /^r2 bucket info /, reply: () => fail('', 'The specified bucket does not exist') },
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
        reply: () => ok(JSON.stringify([{ uuid: 'id-a', database_id: 'id-b', name: 'myapp-db' }])),
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
              { name: 'myapp-db', database_name: 'other-db', database_id: 'the-id' },
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
              { name: 'myapp-db', database_id: 'id-1' },
              { name: 'myapp-db', database_id: 'id-2' },
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
        { id: 'dup', name: 'other' },
        { id: 'dup', name: 'myapp-hd' },
      ]),
    ).rejects.toThrow(/duplicate config id/);
    expect(readConfig().hyperdrive).toBeUndefined();
  });

  it('fails closed on 2 configs sharing the requested name (ambiguous)', async () => {
    await expect(
      provisionWithInjectedList([
        { id: 'x', name: 'myapp-hd' },
        { id: 'y', name: 'myapp-hd' },
      ]),
    ).rejects.toThrow(/share that name/);
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

describe('provisionCloudflareResources — resource-specific create postcondition (round 6 F4)', () => {
  it('R2: fails closed when create writes a DIFFERENT bucket_name than requested', async () => {
    setup(JSON.stringify({ account_id: 'acct' }));
    const { run } = makeRunner([
      { match: /^r2 bucket info /, reply: () => fail('', 'The specified bucket does not exist') },
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
});
