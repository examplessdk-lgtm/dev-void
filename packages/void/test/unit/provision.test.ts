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

/** Build an injectable runWrangler stub that records every subcommand. */
function makeRunner(handlers: Array<Handler>): { run: RunWrangler; calls: Array<string> } {
  const calls: Array<string> = [];
  const run: RunWrangler = (sub) => {
    calls.push(sub);
    for (const handler of handlers) {
      if (handler.match.test(sub)) {
        return handler.reply(sub);
      }
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  return { run, calls };
}

const ok = (stdout = ''): RunWranglerResult => ({ stdout, stderr: '', status: 0 });
const fail = (stdout: string, stderr = ''): RunWranglerResult => ({ stdout, stderr, status: 1 });

/** Mimic `wrangler <res> create --update-config`: upsert a binding entry by binding. */
function simulateUpdateConfig(field: string, entry: Record<string, unknown>): void {
  const cfg = readConfig();
  const list = Array.isArray(cfg[field]) ? (cfg[field] as Array<Record<string, unknown>>) : [];
  const index = list.findIndex((e) => e.binding === entry.binding);
  if (index >= 0) {
    list[index] = { ...list[index], ...entry };
  } else {
    list.push(entry);
  }
  cfg[field] = list;
  writeFileSync(wranglerPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

const emptyDesired: DesiredResourceSet = { kvNamespaces: [], queues: [] };

describe('provisionCloudflareResources — read-first', () => {
  it('skips D1 entirely when the binding already has a real database_id (records reused, no wrangler call)', async () => {
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
    expect(calls[0]).toBe('d1 list --json');
    expect(result.resources[0].action).toBe('created');
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
      'd1 list --json',
      `d1 create myapp-db --binding DB --update-config -c ${wranglerPath}`,
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
    expect(calls).toEqual(['d1 list --json']);
    expect(calls.some((c) => c.startsWith('d1 create'))).toBe(false);
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
      'd1 list --json',
      `d1 create myapp-db --binding DB --update-config -c ${wranglerPath}`,
      'd1 info myapp-db --json',
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
    expect(calls).toEqual(['kv namespace list']);
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
      'kv namespace list',
      `kv namespace create myapp-isr --binding ISR_CACHE --update-config -c ${wranglerPath}`,
    ]);
    expect(result.resources).toEqual([
      { kind: 'kv', binding: 'ISR_CACHE', name: 'myapp-isr', action: 'created' },
    ]);
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
    expect(calls.filter((c) => c.startsWith('kv namespace create'))).toHaveLength(2);
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
    expect(calls).toEqual(['r2 bucket info myapp-uploads --json']);
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
      'r2 bucket info myapp-uploads --json',
      `r2 bucket create myapp-uploads --binding STORAGE --update-config -c ${wranglerPath}`,
    ]);
    expect(result.resources).toEqual([
      { kind: 'r2', binding: 'STORAGE', name: 'myapp-uploads', action: 'created' },
    ]);
  });

  it('surfaces a create failure (e.g. auth error) when the bucket cannot be probed or created', async () => {
    // Non-zero info → attempt create; `r2 bucket create` on an existing name
    // errors rather than duplicating, so a failed create always surfaces the real
    // problem instead of minting a second bucket.
    setup(JSON.stringify({ name: 'app' }));
    const { run, calls } = makeRunner([
      {
        match: /^r2 bucket info /,
        reply: () => fail('', 'X [ERROR] Authentication error [code: 10000]'),
      },
      {
        match: /^r2 bucket create /,
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
    ).rejects.toThrow(/r2 bucket create myapp-uploads.*failed/s);
    expect(calls).toEqual([
      'r2 bucket info myapp-uploads --json',
      `r2 bucket create myapp-uploads --binding STORAGE --update-config -c ${wranglerPath}`,
    ]);
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

  it('skips with a structured reason when no connection string is provided (never prompts)', async () => {
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

  it('creates the config with the connection string via --update-config', async () => {
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
      { runWrangler: run, log: silentLog },
    );
    expect(calls).toEqual([
      `hyperdrive create myapp-hd --connection-string=postgres://u:p@h/db --binding HYPERDRIVE --update-config -c ${wranglerPath}`,
    ]);
    expect(result.resources).toEqual([
      { kind: 'hyperdrive', binding: 'HYPERDRIVE', name: 'myapp-hd', action: 'created' },
    ]);
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
    expect(calls).toEqual(['queues info jobs']);
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
    expect(calls).toEqual(['queues info emails', 'queues create emails']);
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
    expect(calls).toEqual(['queues info jobs', 'queues info emails', 'queues create emails']);
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
    expect(calls.some((c) => c.startsWith('queues create'))).toBe(false);
  });
});
