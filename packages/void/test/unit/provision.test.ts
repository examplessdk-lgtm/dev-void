import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseJsoncRaw } from 'jsonc-parser';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  provisionCloudflareResources,
  type DesiredResourceSet,
  type RunWrangler,
  type RunWranglerResult,
} from '../../src/cli/provision.ts';

const tmpDir = join(import.meta.dirname, '.tmp-provision-test');
const wranglerPath = join(tmpDir, 'wrangler.jsonc');

function setup(content: string): void {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(wranglerPath, content);
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: 'real-uuid-1' }],
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
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: 'real-uuid-1' },
    ]);
  });

  it('does NOT treat a placeholder database_id ("local") as real — proceeds to provision', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json$/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: 'created-uuid',
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
    expect(calls[0]).toEqual(['d1', 'list', '--json']);
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
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: 'new-hd-id' });
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
        { match: /^d1 list --json$/, reply: () => ok('[]') },
        {
          match: /^d1 create /,
          reply: () => {
            simulateUpdateConfig(
              'd1_databases',
              { binding: 'DB', database_name: 'myapp-db', database_id: 'created-uuid' },
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
          d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: 'real-uuid-1' }],
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
    expect(result.resources[0]).toMatchObject({ kind: 'd1', action: 'reused', id: 'real-uuid-1' });
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
        match: /^kv namespace list$/,
        reply: () => ok(JSON.stringify([{ id: 'real-kv-id', title: 'myapp-kv' }])),
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
    expect((jsonAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe('real-kv-id');
    // wrangler.jsonc is untouched (still the placeholder).
    const jsoncAfter = parseJsoncRaw(readFileSync(jsoncPath, 'utf-8')) as Record<string, unknown>;
    expect((jsoncAfter.kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe('local');
  });
});

describe('provisionCloudflareResources — D1', () => {
  it('creates a missing D1 with --update-config then writes migrations_dir', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^d1 list --json$/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => {
          simulateUpdateConfig('d1_databases', {
            binding: 'DB',
            database_name: 'myapp-db',
            database_id: 'created-uuid',
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
      ['d1', 'list', '--json'],
      ['d1', 'create', 'myapp-db', '--binding', 'DB', '--update-config', '-c', wranglerPath],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: 'created-uuid',
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
        d1_databases: [{ binding: 'DB', database_name: 'myapp-db', database_id: 'real-uuid-1' }],
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
      database_id: 'real-uuid-1',
      migrations_dir: './db/migrations',
    });
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'reused', id: 'real-uuid-1' },
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
        match: /^d1 list --json$/,
        reply: () => ok(JSON.stringify([{ uuid: 'existing-uuid', name: 'myapp-db' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['d1', 'list', '--json']]);
    expect(calls.some((c) => isCall(c, 'd1', 'create'))).toBe(false);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1).toEqual([
      {
        binding: 'DB',
        database_name: 'myapp-db',
        database_id: 'existing-uuid',
        migrations_dir: './db/migrations',
      },
    ]);
    expect(result.resources).toEqual([
      { kind: 'd1', binding: 'DB', name: 'myapp-db', action: 'adopted', id: 'existing-uuid' },
    ]);
  });

  it('treats a create-time 7502 (already exists) as adopt — captures the id via d1 info', async () => {
    setup(
      JSON.stringify({
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    const { run, calls } = makeRunner([
      { match: /^d1 list --json$/, reply: () => ok('[]') },
      {
        match: /^d1 create /,
        reply: () => fail('', 'X [ERROR] A database with that name already exists [code: 7502]'),
      },
      {
        match: /^d1 info myapp-db --json$/,
        reply: () => ok(JSON.stringify({ uuid: 'raced-uuid', name: 'myapp-db' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, d1: { binding: 'DB', name: 'myapp-db' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['d1', 'list', '--json'],
      ['d1', 'create', 'myapp-db', '--binding', 'DB', '--update-config', '-c', wranglerPath],
      ['d1', 'info', 'myapp-db', '--json'],
    ]);
    const d1 = readConfig().d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', database_id: 'raced-uuid' });
    expect(result.resources[0]).toEqual({
      kind: 'd1',
      binding: 'DB',
      name: 'myapp-db',
      action: 'adopted',
      id: 'raced-uuid',
    });
  });

  it('throws on a non-7502 create failure', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([
      { match: /^d1 list --json$/, reply: () => ok('[]') },
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

describe('provisionCloudflareResources — KV', () => {
  it('adopts when the namespace list shows a title match (writes id, no create)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const { run, calls } = makeRunner([
      {
        match: /^kv namespace list$/,
        reply: () => ok(JSON.stringify([{ id: 'real-kv-id', title: 'myapp-kv' }])),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, kvNamespaces: [{ binding: 'KV', title: 'myapp-kv' }] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['kv', 'namespace', 'list']]);
    const kv = readConfig().kv_namespaces as Array<Record<string, unknown>>;
    expect(kv).toEqual([{ binding: 'KV', id: 'real-kv-id' }]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'adopted', id: 'real-kv-id' },
    ]);
  });

  it('creates when the namespace list is empty', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list$/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: () => {
          simulateUpdateConfig('kv_namespaces', { binding: 'ISR_CACHE', id: 'new-kv-id' });
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
      ['kv', 'namespace', 'list'],
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
        match: /^kv namespace list$/,
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
      { match: /^kv namespace list$/, reply: () => ok('not a json list at all') },
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
      { match: /^kv namespace list$/, reply: () => ok('[{ "id": "a", "title": "myapp-kv"') },
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
        match: /^kv namespace list$/,
        reply: () =>
          ok(
            JSON.stringify([
              { id: 'zzz', title: 'myapp-kv' },
              { id: 'aaa', title: 'myapp-kv' },
              { id: 'mmm', title: 'other' },
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
    expect(result.resources[0]).toMatchObject({ action: 'adopted', id: 'aaa' });
    expect((readConfig().kv_namespaces as Array<Record<string, unknown>>)[0].id).toBe('aaa');
    expect(warnings.some((w) => w.includes('multiple KV namespaces') && w.includes('aaa'))).toBe(
      true,
    );
  });

  it('provisions each KV binding independently (ISR_CACHE + app KV)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^kv namespace list$/, reply: () => ok('[]') },
      {
        match: /^kv namespace create /,
        reply: (sub) => {
          const binding = sub.includes('ISR_CACHE') ? 'ISR_CACHE' : 'KV';
          simulateUpdateConfig('kv_namespaces', { binding, id: `${binding}-id` });
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

  it('does not write account_id when not provided', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run } = makeRunner([]);
    const result = await provisionCloudflareResources(tmpDir, wranglerPath, emptyDesired, {
      runWrangler: run,
      log: silentLog,
    });
    expect(readConfig().account_id).toBeUndefined();
    expect(result.accountIdWritten).toBe(false);
  });
});

describe('provisionCloudflareResources — idempotent re-run', () => {
  it('a second run after adoption is a read-first no-op (byte-identical config, no wrangler calls)', async () => {
    setup(JSON.stringify({ kv_namespaces: [{ binding: 'KV', id: 'local' }] }));
    const first = makeRunner([
      {
        match: /^kv namespace list$/,
        reply: () => ok(JSON.stringify([{ id: 'real-kv-id', title: 'myapp-kv' }])),
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
      { kind: 'kv', binding: 'KV', name: 'myapp-kv', action: 'reused', id: 'real-kv-id' },
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
        match: /^r2 bucket info myapp-uploads --json$/,
        reply: () => ok(JSON.stringify({ name: 'myapp-uploads', created: 'x' })),
      },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['r2', 'bucket', 'info', 'myapp-uploads', '--json']]);
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
      ['r2', 'bucket', 'info', 'myapp-uploads', '--json'],
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
    expect(calls).toEqual([['r2', 'bucket', 'info', 'myapp-uploads', '--json']]);
  });
});

describe('provisionCloudflareResources — Hyperdrive', () => {
  it('reuses when the hyperdrive binding already has a real id (no wrangler call)', async () => {
    setup(JSON.stringify({ hyperdrive: [{ binding: 'HYPERDRIVE', id: 'real-hd-id' }] }));
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
        id: 'real-hd-id',
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
          { id: 'existing-hd-id', name: 'myapp-hd' },
        ],
      },
    );
    // No wrangler create — existence via the injected REST seam, id via the writer.
    expect(calls.some((c) => isCall(c, 'hyperdrive', 'create'))).toBe(false);
    const hd = readConfig().hyperdrive as Array<Record<string, unknown>>;
    expect(hd).toEqual([{ binding: 'HYPERDRIVE', id: 'existing-hd-id' }]);
    expect(result.resources).toEqual([
      {
        kind: 'hyperdrive',
        binding: 'HYPERDRIVE',
        name: 'myapp-hd',
        action: 'adopted',
        id: 'existing-hd-id',
      },
    ]);
  });

  it('creates the config when confirmed absent and a connection string is present', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^hyperdrive create /,
        reply: () => {
          simulateUpdateConfig('hyperdrive', { binding: 'HYPERDRIVE', id: 'new-hd-id' });
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
      { match: /^queues info jobs$/, reply: () => ok('Queue Name: jobs') },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([['queues', 'info', 'jobs']]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'jobs', action: 'reused' }]);
    // Task 4 must NOT write queue producer/consumer entries into the config.
    expect(readConfig().queues).toBeUndefined();
  });

  it('creates a queue that `queues info` reports missing; never writes queue config entries', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^queues info emails$/,
        reply: () => fail('', 'X [ERROR] Queue "emails" does not exist.'),
      },
      { match: /^queues create emails$/, reply: () => ok('Created queue emails') },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'emails'],
      ['queues', 'create', 'emails'],
    ]);
    expect(result.resources).toEqual([{ kind: 'queue', name: 'emails', action: 'created' }]);
    expect(readConfig().queues).toBeUndefined();
  });

  it('handles a mix of existing and missing queues', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      { match: /^queues info jobs$/, reply: () => ok('Queue Name: jobs') },
      { match: /^queues info emails$/, reply: () => fail('', 'Queue "emails" does not exist.') },
      { match: /^queues create emails$/, reply: () => ok() },
    ]);
    const result = await provisionCloudflareResources(
      tmpDir,
      wranglerPath,
      { ...emptyDesired, queues: ['jobs', 'emails'] },
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      ['queues', 'info', 'jobs'],
      ['queues', 'info', 'emails'],
      ['queues', 'create', 'emails'],
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
        match: /^queues info jobs$/,
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
});
