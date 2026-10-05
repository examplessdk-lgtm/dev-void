import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cleanupWrapper,
  needsWrapper,
  generateWrapper,
  selectBundledEntryFilename,
} from '../../src/cli/wrapper.ts';
import type { WrapperFeatures } from '../../src/cli/wrapper.ts';

const base: WrapperFeatures = {
  crons: [],
  queues: [],
};

describe('repeated wrapper generation', () => {
  const roots: Array<string> = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the served framework version through its authored metadata binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-version-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { throw new Error("app reached"); } };',
    );
    await generateWrapper(root, 'index.mjs', root, {
      ...base,
      readiness: true,
      versionMetadataBinding: 'AUTHORED_VERSION',
    });
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    const response = await worker.fetch(
      new Request('https://app.example/__void/ready', {
        headers: { 'Cloudflare-Workers-Version-Overrides': 'app="new-version"' },
      }),
      { AUTHORED_VERSION: { id: 'old-version', tag: 'private-tag' } },
      {},
    );
    expect(await response.json()).toEqual({ ready: true, versionId: 'old-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(
      await (await worker.fetch(new Request('https://app.example/__void/ready'), {}, {})).json(),
    ).toEqual({ ready: true });
  });

  it('preserves the real application across repeated skip-build preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-repeat-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("application"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    expect(await (await worker.fetch(new Request('https://app/'), {}, {})).text()).toBe(
      'application',
    );
    expect((await worker.fetch(new Request('https://app/__void/ready'), {}, {})).status).toBe(200);
  });

  it('fails readiness when the wrapped entry has no fetch handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-no-fetch-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export default function handler() { return new Response("bare"); }',
    );
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    const response = await worker.fetch(new Request('https://app/__void/ready'), {}, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      error: 'worker entry has no fetch handler',
    });
  });

  it('serves cached framework HTML while leaving client data requests live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-framework-isr-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      `export default {
      fetch(request, env) {
        env.renders++;
        return request.headers.get('accept') === 'application/json'
          ? Response.json({ live: env.renders })
          : new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } });
      }
    };`,
    );
    const kvStore = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
    const edgeStore = new Map<string, Response>();
    const env = {
      renders: 0,
      ISR_CACHE: {
        getWithMetadata: async (key: string) => kvStore.get(key) ?? { value: null, metadata: null },
        put: async (key: string, value: ArrayBuffer, options?: { metadata?: unknown }) => {
          kvStore.set(key, { value, metadata: options?.metadata ?? null });
        },
        delete: async (key: string) => {
          kvStore.delete(key);
        },
        list: async () => ({ keys: [], list_complete: true, cursor: '' }),
      },
    };
    vi.stubGlobal('caches', {
      default: {
        match: async (key: string) => edgeStore.get(key)?.clone(),
        put: async (key: string, response: Response) => {
          edgeStore.set(key, response);
        },
        delete: async (key: string) => edgeStore.delete(key),
      },
    });
    try {
      await generateWrapper(root, 'index.mjs', root, { ...base, isr: { revalidate: 60 } });
      const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
      const tasks: Array<Promise<unknown>> = [];
      const ctx = {
        waitUntil: (task: Promise<unknown>) => {
          tasks.push(task);
        },
      };
      const document = new Request('https://app.test/news', { headers: { accept: 'text/html' } });

      const first = await worker.fetch(document, env, ctx);
      expect(first.headers.get('x-isr-cache')).toBe('MISS');
      await Promise.all(tasks);
      const second = await worker.fetch(document, env, ctx);
      expect(second.headers.get('x-isr-cache')).toBe('HIT');
      expect(env.renders).toBe(1);

      const data = await worker.fetch(
        new Request('https://app.test/news', { headers: { accept: 'application/json' } }),
        env,
        ctx,
      );
      expect(await data.json()).toEqual({ live: 2 });
      expect(env.renders).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the entry intact when compiling handlers fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-failed-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("application"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await expect(
      generateWrapper(root, 'index.mjs', root, {
        ...base,
        crons: [{ name: 'missing', filePath: 'missing.ts', crons: ['* * * * *'] }],
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(root, 'index.mjs'), 'utf8')).toBe(original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
  });

  it('recognizes legacy wrappers and refreshes the original after a new build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-legacy-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("first"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const legacy = readFileSync(join(root, 'index.mjs'), 'utf8').replace(
      /^\/\/ Generated[^\n]*\n/,
      '',
    );
    writeFileSync(join(root, 'index.mjs'), legacy);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
    const rebuilt = original.replace('first', 'second');
    writeFileSync(join(root, 'index.mjs'), rebuilt);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(rebuilt);
  });

  it('requires a rebuild if an older repeated deploy already destroyed the original', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-corrupt-wrapper-'));
    roots.push(root);
    const wrapper =
      'import original from "./__original.mjs";\nexport default { fetch: original.fetch };';
    writeFileSync(join(root, 'index.mjs'), wrapper);
    writeFileSync(join(root, '__original.mjs'), wrapper);
    await expect(
      generateWrapper(root, 'index.mjs', root, { ...base, readiness: true }),
    ).rejects.toThrow('Rebuild');
  });
});

describe('needsWrapper', () => {
  it('returns false when no features are set', () => {
    expect(needsWrapper(base)).toBe(false);
  });

  it('returns true when crons are present', () => {
    expect(
      needsWrapper({
        ...base,
        crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
      }),
    ).toBe(true);
  });

  it('returns true when queues are present', () => {
    expect(
      needsWrapper({
        ...base,
        queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'EMAILS' }],
      }),
    ).toBe(true);
  });

  it('returns true when hasMigrations is set', () => {
    expect(needsWrapper({ ...base, hasMigrations: true })).toBe(true);
  });

  it('returns true when deployment readiness is required', () => {
    expect(needsWrapper({ ...base, readiness: true })).toBe(true);
  });

  it('returns false when hasMigrations is false', () => {
    expect(needsWrapper({ ...base, hasMigrations: false })).toBe(false);
  });
});

describe('selectBundledEntryFilename', () => {
  it('selects the exact bundled entry when index-prefixed chunks sort first', () => {
    expect(selectBundledEntryFilename(['index-server-Bo4VDtw5.js', 'index.js'])).toBe('index.js');
  });

  it('throws a helpful error when no exact bundled entry exists', () => {
    expect(() => selectBundledEntryFilename(['index-server-Bo4VDtw5.js'])).toThrow(
      'deploy: Bundled worker entry not found',
    );
  });
});

describe('cleanupWrapper', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the linked project config needed by remote commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-cleanup-'));
    roots.push(root);

    const voidDir = join(root, '.void');
    const projectFile = join(voidDir, 'project.json');
    const temporaryDirectories = ['handlers', 'migration-handler', 'isr', 'bundle'];
    for (const directory of temporaryDirectories) {
      mkdirSync(join(voidDir, directory), { recursive: true });
      writeFileSync(join(voidDir, directory, 'generated.js'), 'export default {};');
    }
    writeFileSync(projectFile, JSON.stringify({ projectId: 'proj_123', slug: 'speakers' }));
    writeFileSync(join(voidDir, 'dev-trigger-token'), 'stable-token');

    cleanupWrapper(root);

    expect(existsSync(projectFile)).toBe(true);
    expect(readFileSync(join(voidDir, 'dev-trigger-token'), 'utf-8')).toBe('stable-token');
    for (const directory of temporaryDirectories) {
      expect(existsSync(join(voidDir, directory))).toBe(false);
    }
  });
});

describe('generated wrapper queue dispatch', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function createRelayWorker() {
    const root = mkdtempSync(join(tmpdir(), 'void-queue-relay-'));
    roots.push(root);
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { return Response.json({ app: true }); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      `export default function(batch, env) {
      env.calls.push(batch.messages[0].timestamp.getTime());
      batch.messages[0].ack();
      if (env.fail) throw new Error('after first message');
      batch.messages[0].retry();
      batch.messages[1].retry({ delaySeconds: 9 });
      batch.ackAll();
    }`,
    );
    await generateWrapper(root, 'index.mjs', root, {
      ...base,
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });
    return (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
  }

  const relayRequest = (token?: string) =>
    new Request('https://worker/__void/queue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-void-internal': token } : {}),
      },
      body: JSON.stringify({
        queue: 'emails',
        messages: ['one', 'two'].map((id) => ({
          id,
          timestamp: '2026-01-01T00:00:00Z',
          body: {},
          attempts: 1,
        })),
      }),
    });

  it('delivers managed HTTP batches and returns first-wins acknowledgment decisions', async () => {
    const worker = await createRelayWorker();
    const env = { __VOID_PROXY_TOKEN: 'token', calls: [] as Array<number> };
    const response = await worker.fetch(relayRequest('token'), env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      decisions: {
        one: { action: 'ack' },
        two: { action: 'retry', delaySeconds: 9 },
      },
    });
    expect(env.calls).toEqual([Date.parse('2026-01-01T00:00:00Z')]);
    const failed = await worker.fetch(relayRequest('token'), { ...env, fail: true }, {});
    expect(await failed.json()).toEqual({ ok: false, decisions: { one: { action: 'ack' } } });
    expect((await worker.fetch(new Request('https://worker/__void/ready'), env, {})).status).toBe(
      200,
    );
  });

  it('requires a configured token before invoking a managed queue consumer', async () => {
    const worker = await createRelayWorker();
    const calls: Array<number> = [];
    for (const [request, env] of [
      [relayRequest(), { __VOID_PROXY_TOKEN: 'token', calls }],
      [relayRequest('wrong'), { __VOID_PROXY_TOKEN: 'token', calls }],
      [relayRequest('token'), { calls }],
    ] as const) {
      expect((await worker.fetch(request, env, {})).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('uses exact or unique longest suffix matches and rejects unknown queues', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-queues-'));
    const workerDir = join(root, 'server');
    roots.push(root);
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      'export default async function(_batch, env) { env.calls.push("emails"); }',
    );
    writeFileSync(
      join(root, 'queues/order-emails.ts'),
      'export default async function(_batch, env) { env.calls.push("order-emails"); }',
    );

    await generateWrapper(workerDir, 'index.mjs', root, {
      ...base,
      queues: [
        { name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' },
        {
          name: 'order-emails',
          filePath: 'order-emails.ts',
          bindingName: 'CUSTOM_ORDER_EMAILS',
        },
      ],
    });

    const wrapper = (await import(
      `${pathToFileURL(join(workerDir, 'index.mjs')).href}?test=${crypto.randomUUID()}`
    )) as {
      default: {
        queue(
          batch: MessageBatch,
          env: { calls: Array<string> },
          ctx: ExecutionContext,
        ): Promise<void>;
      };
    };
    const makeBatch = (queue: string, retryAll = vi.fn()) =>
      ({
        queue,
        messages: [],
        ackAll: vi.fn(),
        retryAll,
      }) as unknown as MessageBatch;

    for (const [queue, expected] of [
      ['emails', 'emails'],
      ['project-emails', 'emails'],
      ['order-emails', 'order-emails'],
      ['project-order-emails', 'order-emails'],
    ]) {
      const env = { calls: [] as Array<string> };
      await wrapper.default.queue(makeBatch(queue), env, {} as ExecutionContext);
      expect(env.calls).toEqual([expected]);
    }

    const retryAll = vi.fn();
    const env = { calls: [] as Array<string> };
    await expect(
      wrapper.default.queue(makeBatch('project-unknown', retryAll), env, {} as ExecutionContext),
    ).rejects.toThrow('No unambiguous queue handler matches "project-unknown"');
    expect(retryAll).toHaveBeenCalledOnce();
    expect(env.calls).toEqual([]);
  });

  it('passes native queue messages, dates, and acknowledgment methods through unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-native-queue-'));
    roots.push(root);
    const workerDir = join(root, 'server');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("app"); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      `export default async function(batch, env) {
      env.received = batch;
      env.timestamp = batch.messages[0].timestamp.getTime();
      batch.messages[0].ack();
      batch.messages[1].retry({ delaySeconds: 12 });
      batch.ackAll();
      batch.retryAll({ delaySeconds: 30 });
    }`,
    );
    await generateWrapper(workerDir, 'index.mjs', root, {
      ...base,
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });
    const wrapper = (await import(pathToFileURL(join(workerDir, 'index.mjs')).href)).default;
    const timestamp = new Date('2026-01-01T00:00:00Z');
    const batch = {
      queue: 'emails',
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      messages: [
        { id: '1', body: {}, attempts: 1, timestamp, ack: vi.fn(), retry: vi.fn() },
        { id: '2', body: {}, attempts: 1, timestamp, ack: vi.fn(), retry: vi.fn() },
      ],
    };
    const env: { received?: unknown; timestamp?: number } = {};
    await wrapper.queue(batch, env, {});
    expect(env.received).toBe(batch);
    expect(env.timestamp).toBe(timestamp.getTime());
    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 12 });
    expect(batch.ackAll).toHaveBeenCalledOnce();
    expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 });
  });
});

describe('generateWrapper with migrations', () => {
  const tmpRoot = join(import.meta.dirname, '..', '..', '.test-wrapper-tmp');
  const workerDir = join(tmpRoot, 'server');
  const projectRoot = join(tmpRoot, 'project');

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('generates wrapper with /__void/migrate handler', async () => {
    // Set up fake worker dir with a minimal entry
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    // Set up fake project with a migration
    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INTEGER PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    // Original entry should be renamed
    expect(existsSync(join(workerDir, '__original.mjs'))).toBe(true);

    // Wrapper should be written as index.mjs
    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('createMigrationHandler');
    expect(wrapper).toContain('__migrations');
    expect(wrapper).toContain('import original from "./__original.mjs"');

    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('bundles the SQLite migration handler into a self-contained worker module', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INTEGER PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toMatch(/from\s+["']\.\.\//);
    expect(handler).not.toContain('../migrations/canonical-json');
    expect(handler).not.toContain('../canonical-json-');
    expect(handler).toContain('function canonicalJson');
  });

  it('includes migrations JSON in wrapper source', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('001_create_users.sql');
    expect(wrapper).toContain('CREATE TABLE users');
  });

  it('uses PG migration handler when dialect is postgresql', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id SERIAL PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'postgresql',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('createMigrationHandler');
    expect(wrapper).toContain('"postgresql"');

    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toContain('import("pg")');
    expect(
      readdirSync(workerDir).some((file) => file.startsWith('__void_migration_handler-')),
    ).toBe(true);
    const bundled = readdirSync(workerDir)
      .map((file) => readFileSync(join(workerDir, file), 'utf-8'))
      .join('\n');
    expect(bundled).not.toContain('PGPASSFILE');
    expect(bundled).not.toContain('createReadStream');
    expect(bundled).not.toContain('__require("pgpass")');
    expect(bundled).not.toContain('createRequire(import.meta.url)');
    expect(bundled).not.toContain('createRequire("file:///__void_migration_handler.mjs")');
    expect(bundled).not.toContain('node:module');
    expect(bundled).not.toContain('empty module that is served up when outside of a workerd');
    expect(bundled).toContain('CloudflareSocket');
    expect(bundled).toContain('cloudflare:sockets');
    expect(bundled).toContain('node:events');
    expect(bundled).toContain('node:util/types');
    expect(bundled).toContain('"util/types": __voidNodeUtilTypes');
    expect(bundled).toContain('__voidNodeRequireModules');
    expect(bundled).toContain('__voidPgpassNoop');
  });

  it('uses the MySQL migration handler when dialect is mysql', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INT);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'mysql',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/migrate');
    expect(wrapper).toContain('"mysql"');
    expect(existsSync(join(workerDir, '__void_migration_handler.mjs'))).toBe(true);
  });

  it('intercepts GET /__void/ready with {ready:true} when wrapper is generated', async () => {
    // Platform's deploy-time readiness probe (packages/api/src/routes/deploy.ts)
    // expects a JSON 200 from GET /__void/ready before dispatching migrations.
    // Without this, the request falls through to the user's framework handler
    // (e.g. SvelteKit -> env.ASSETS), which returns CF's "Assets have not yet
    // been deployed to this script." stub during WfP propagation, causing the
    // probe to retry until exhaustion.
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'db', 'migrations', '001_test.sql'),
      'CREATE TABLE test (id INTEGER PRIMARY KEY);',
    );

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('/__void/ready');
    expect(wrapper).toMatch(/Response\.json\(\s*\{\s*ready:\s*true\s*\}\s*\)/);
    // Must be checked before delegating to original.fetch, otherwise the
    // user's framework handler will see the request.
    const readyIdx = wrapper.indexOf('/__void/ready');
    const originalIdx = wrapper.indexOf('original.fetch');
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeGreaterThan(readyIdx);
  });

  it('does not generate migration handler when hasMigrations is false', async () => {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );

    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });

    // Create fake cron handler
    mkdirSync(join(projectRoot, 'crons'), { recursive: true });
    writeFileSync(join(projectRoot, 'crons', 'daily.ts'), 'export default async () => {};');

    // Only crons, no migrations
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).not.toContain('/__void/migrate');
    expect(wrapper).toContain('/__void/scheduled');
  });
});
