import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

// Capture how many times each asset path is read via `readFileSync`. Mocked
// before any importer of `node:fs` so the spy is in place when `package.ts`
// resolves its `import { readFileSync } from 'node:fs'` binding. Only assets
// inside the test fixture directory are counted; other reads (e.g.
// .assetsignore lookup misses) pass through to the real fs.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
      actual.readFileSync(...args),
    ),
  };
});

// `@voidzero-dev/vite-plus-prompts` opens TTY-bound spinners we don't want to render in tests.
const noopSpinner = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
  clear: vi.fn(),
};
vi.mock('@voidzero-dev/vite-plus-prompts', async () => {
  const actual = await vi.importActual<typeof import('@voidzero-dev/vite-plus-prompts')>(
    '@voidzero-dev/vite-plus-prompts',
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
    },
    spinner: () => noopSpinner,
  };
});

// `output.ts` wraps clack's spinner — re-export the same noop. Used by
// runStaticDeploy through `createSpinner()`.
vi.mock('../../src/cli/output.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/cli/output.ts')>('../../src/cli/output.ts');
  return {
    ...actual,
    createSpinner: () => noopSpinner,
  };
});

const fsModule = await import('node:fs');
const readFileSyncMock = fsModule.readFileSync as unknown as ReturnType<typeof vi.fn>;

const { runStaticDeploy } = await import('../../src/cli/deploy.ts');
const { openDeployLog } = await import('../../src/cli/log-file.ts');
const { PlatformClient } = await import('../../src/cli/client.ts');

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

let workdir: string;
let assetsDir: string;
const fixtureFiles: Record<string, string | Buffer> = {
  '/index.html': '<!doctype html><html><body>hi</body></html>\n',
  '/style.css': 'body { color: red; }\n',
  '/script.js': 'console.log("hello");\n',
  // Larger asset (>100KB) to stress buffer threading.
  '/large.bin': Buffer.alloc(120_000, 0xa5),
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'void-direct-r2-'));
  assetsDir = join(workdir, 'dist');
  mkdirSync(assetsDir, { recursive: true });
  for (const [relPath, content] of Object.entries(fixtureFiles)) {
    writeFileSync(join(assetsDir, relPath.slice(1)), content);
  }

  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
  readFileSyncMock.mockClear();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

type MockState = {
  preflightCalls: Array<unknown>;
  uploadUrlsCalls: Array<unknown>;
  r2PutCalls: Array<{ url: string; init: RequestInit }>;
  finalizeCalls: Array<{ url: string; init: RequestInit }>;
};

function installPlatformMocks(opts?: {
  preflightSkipped?: number;
  preflightNeeded?: Array<string>;
  r2PutBehavior?: (url: string) => Response | Promise<Response>;
  finalizeEvents?: Array<unknown>;
}): MockState {
  const state: MockState = {
    preflightCalls: [],
    uploadUrlsCalls: [],
    r2PutCalls: [],
    finalizeCalls: [],
  };

  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const reqInit = init ?? {};
    const method = reqInit.method ?? 'GET';

    if (url.endsWith('/deploy/preflight') && method === 'POST') {
      state.preflightCalls.push(JSON.parse(reqInit.body as string));
      return new Response(
        JSON.stringify({
          needed: opts?.preflightNeeded ?? Object.keys(fixtureFiles),
          total: Object.keys(fixtureFiles).length,
          skipped: opts?.preflightSkipped ?? 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.endsWith('/deploy/upload-urls') && method === 'POST') {
      const body = JSON.parse(reqInit.body as string) as {
        assets: Array<{ blake3: string; md5: string; contentType: string }>;
      };
      state.uploadUrlsCalls.push(body);
      const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
      for (const asset of body.assets) {
        urls[asset.blake3] = {
          url: `https://r2-test/${asset.blake3}`,
          headers: {
            'Content-Md5': hexToBase64(asset.md5),
            'Content-Type': asset.contentType,
          },
        };
      }
      return new Response(JSON.stringify({ urls }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.startsWith('https://r2-test/') && method === 'PUT') {
      state.r2PutCalls.push({ url, init: reqInit });
      if (opts?.r2PutBehavior) {
        return opts.r2PutBehavior(url);
      }
      return new Response(null, { status: 200 });
    }

    if (url.endsWith('/deploy') && method === 'POST') {
      state.finalizeCalls.push({ url, init: reqInit });
      return ndjsonResponse(opts?.finalizeEvents ?? defaultDoneEvents());
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return state;
}

function defaultDoneEvents(): Array<unknown> {
  return [
    { event: 'start', deploymentId: 'dep_test' },
    { event: 'asset_upload', total: 4, new: 4, cached: 0 },
    {
      event: 'done',
      deployment: 'dep_test',
      url: 'https://test.void.app',
      urls: ['https://test.void.app'],
      assets: 4,
      workers: 0,
    },
  ];
}

function ndjsonResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson', 'x-void-deployment-id': 'dep_test' },
  });
}

function hexToBase64(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  return buf.toString('base64');
}

function makeClient(): InstanceType<typeof PlatformClient> {
  return new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog: openTestLog() });
}

let capturedLogPath: string | null = null;
function openTestLog(): ReturnType<typeof openDeployLog> {
  const log = openDeployLog();
  capturedLogPath = log.path;
  return log;
}

describe('direct-to-R2 deploy flow', () => {
  it.each([true, undefined, false])(
    'prints a single success after the box only when routing is published (%s)',
    async (published) => {
      const { note, outro } = await import('@voidzero-dev/vite-plus-prompts');
      const summary = vi.mocked(note).mockClear();
      const ending = vi.mocked(outro).mockClear();
      const events = defaultDoneEvents() as Array<Record<string, unknown>>;
      events.at(-1)!.published = published;
      installPlatformMocks({ finalizeEvents: events });

      await runStaticDeploy(
        workdir,
        { projectId: 'proj_t', slug: 'test' },
        makeClient(),
        { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
        true,
      );

      expect(summary).toHaveBeenCalledOnce();
      if (published === false) {
        expect(ending).not.toHaveBeenCalled();
      } else {
        expect(ending).toHaveBeenCalledOnce();
        expect(ending.mock.calls[0][0]).toContain('✓ Successfully deployed!');
        expect(ending.mock.invocationCallOrder[0]).toBeGreaterThan(
          summary.mock.invocationCallOrder[0],
        );
      }
    },
  );

  it('uploads assets directly to R2 then calls finalize JSON endpoint', async () => {
    const state = installPlatformMocks();
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true, // skipBuild
      undefined, // gitMetadata
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // cliLog (tested separately)
    );

    // Preflight + upload-urls + R2 PUTs + finalize were called once each.
    expect(state.preflightCalls).toHaveLength(1);
    expect(state.uploadUrlsCalls).toHaveLength(1);
    expect(state.r2PutCalls).toHaveLength(4);
    expect(state.finalizeCalls).toHaveLength(1);

    // Each R2 PUT carries Content-Md5 and the asset bytes.
    for (const { init } of state.r2PutCalls) {
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Md5']).toBeDefined();
      expect(headers['Content-Type']).toBeDefined();
      expect(init.method).toBe('PUT');
      expect(init.body).toBeInstanceOf(Uint8Array);
    }

    // Body payload of finalize is JSON, not multipart.
    const finalize = state.finalizeCalls[0];
    expect((finalize.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const finalizeBody = JSON.parse(finalize.init.body as string);
    expect(finalizeBody.manifest.assetManifestVersion).toBe(2);
    expect(finalizeBody.assetManifest['/index.html']).toMatchObject({
      blake3: expect.any(String),
      md5: expect.any(String),
      size: fixtureFiles['/index.html'].length,
    });
    expect(finalizeBody.preflight).toBe(null); // skipped=0 means no preflight reuse
    expect(finalizeBody.workerFiles).toBeUndefined(); // static → no worker bytes
  });

  it('reads each asset file from disk EXACTLY ONCE end-to-end', async () => {
    installPlatformMocks();
    const client = makeClient();

    // Reset the mock so we count ONLY reads from this run.
    readFileSyncMock.mockClear();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    // Filter to just the fixture files — `.assetsignore` lookup may fire
    // an additional read against a file that doesn't exist (caught and
    // swallowed by package.ts via existsSync), but that's not an asset
    // re-read so we filter it out.
    const reads = readFileSyncMock.mock.calls.filter(([p]: Array<unknown>) => {
      const path = String(p);
      return (
        path.endsWith('index.html') ||
        path.endsWith('style.css') ||
        path.endsWith('script.js') ||
        path.endsWith('large.bin')
      );
    });

    // 4 fixture assets × 1 read each = 4 reads total. The new direct-to-R2
    // flow uses the in-memory `assetFiles` cache from collectAndHashAssets
    // for the upload phase — no second pass over the disk.
    expect(reads).toHaveLength(4);
    const uniquePaths = new Set(reads.map(([p]: Array<unknown>) => String(p)));
    expect(uniquePaths.size).toBe(4);
  });

  it('prunes the in-memory assetFiles cache to needed-only after preflight', async () => {
    // 4 fixture assets, only 1 needed: pruning should drop 3 buffers
    // immediately after preflight, and the per-PUT cleanup should drop
    // the last one once R2 acks the upload. We assert via the JSONL log,
    // which captures both the pre/post-prune sizes (`asset_cache_pruned`)
    // and the upload events (`r2_put_end`).
    installPlatformMocks({
      preflightNeeded: ['/index.html'],
      preflightSkipped: 3,
    });
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();
    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cliLog,
    );

    await cliLog.close();
    const lines = readFileSync(logPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string; before?: number; after?: number });
    const prune = lines.find((l) => l.msg === 'asset_cache_pruned');
    expect(prune).toBeDefined();
    // Before prune: 4 fixture buffers in the cache. After: 1 (the only
    // needed asset). Per-PUT cleanup runs after this event so the log
    // value here is the post-prune-but-pre-PUT size.
    expect(prune?.before).toBe(4);
    expect(prune?.after).toBe(1);
  });

  it('does not log asset_cache_pruned when nothing was skipped', async () => {
    // All 4 needed → prune is a no-op and we suppress the noisy log.
    installPlatformMocks();
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();
    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cliLog,
    );

    await cliLog.close();
    const lines = readFileSync(logPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string });
    expect(lines.find((l) => l.msg === 'asset_cache_pruned')).toBeUndefined();
  });

  it('skips upload-urls + R2 PUT phase when no assets are needed', async () => {
    const state = installPlatformMocks({ preflightNeeded: [], preflightSkipped: 4 });
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(state.uploadUrlsCalls).toHaveLength(0);
    expect(state.r2PutCalls).toHaveLength(0);
    expect(state.finalizeCalls).toHaveLength(1);
    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.preflight).toBe('true');
  });

  // `routing.notFound` must reach the STATIC manifest, not only the
  // worker-with-assets path. `detectPreset` classifies any Vite project with
  // no backend files as `spa`, so a plain Vite MPA lands here and would
  // otherwise ship `not_found_handling: 'single-page-application'` — every
  // unknown URL answered with index.html and HTTP 200.
  it('threads routing.notFound into the finalize manifest (static path)', async () => {
    const state = installPlatformMocks();
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { notFound: '404-page' },
      undefined,
    );

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.manifest.type).toBe('spa');
    expect(body.manifest.assetConfig).toEqual({ not_found_handling: '404-page' });
    // Overriding away from SPA must NOT leave the synthetic `/* -> /index.html`
    // fallback behind, or the shell would still be served via a rule.
    expect(body.manifest.fallbackRules).toBeUndefined();
  });

  // Calling convention of the "all pages prerendered -> static" redirect in
  // `runFullDeploy`: it merged the routing RULES upstream and deliberately
  // passes `routing: undefined`, so the notFound override has to ride the
  // dedicated trailing param or it is silently dropped there too.
  it('honors an explicit notFound when routing is undefined (full->static redirect shape)', async () => {
    const state = installPlatformMocks();
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'static' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'single-page-application',
    );

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.manifest.assetConfig).toEqual({
      not_found_handling: 'single-page-application',
    });
  });

  it('retries 5xx R2 PUT failures up to 3 times', async () => {
    let attemptsForFirstAsset = 0;
    const state = installPlatformMocks({
      r2PutBehavior(url) {
        // Pick a deterministic asset and fail it 2 times.
        if (url.includes('/') && attemptsForFirstAsset < 2) {
          // Match only the very first PUT URL (preserve mock state)
          attemptsForFirstAsset++;
          if (attemptsForFirstAsset <= 2) {
            return new Response('temporary', { status: 503 });
          }
        }
        return new Response(null, { status: 200 });
      },
    });
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    // 4 assets but the first one was retried 2 times, so total PUTs = 4 + 2 = 6.
    expect(state.r2PutCalls.length).toBeGreaterThanOrEqual(5);
    expect(state.finalizeCalls).toHaveLength(1);
  });

  it('surfaces 4xx R2 PUT errors with asset path and hash', async () => {
    installPlatformMocks({
      r2PutBehavior() {
        return new Response('SignatureMismatch', { status: 403 });
      },
    });
    const client = makeClient();

    await expect(
      runStaticDeploy(
        workdir,
        { projectId: 'proj_t', slug: 'test' },
        client,
        { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/R2 PUT failed.+SignatureMismatch/);
  });

  it('writes presign + r2_put + finalize events to the JSONL log', async () => {
    installPlatformMocks();
    const cliLog = openDeployLog();
    capturedLogPath = cliLog.path;
    expect(capturedLogPath).toBeTruthy();

    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cliLog,
    );

    await cliLog.close();
    const lines = readFileSync(capturedLogPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string });
    const events = lines.map((l) => l.msg);
    expect(events).toContain('presign_request_start');
    expect(events).toContain('presign_request_end');
    expect(events).toContain('r2_put_start');
    expect(events).toContain('r2_put_end');
    expect(events).toContain('finalize_start');
    expect(events).toContain('finalize_end');
  });

  it('dedupes presign + R2 PUT by content hash when paths share blake3', async () => {
    // Two files with identical content → identical blake3. The upload
    // phase must collapse to ONE presign + ONE PUT, but the final
    // assetManifest must still list BOTH paths (the platform builds the
    // per-path serving manifest from it).
    //
    // We build a fresh fixture: keep `index.html` and `style.css` from
    // the default set, plus two extra files with the same identical
    // content so the duplicates are an explicit pair.
    const sharedHtml = '<!doctype html><html><body>shared</body></html>\n';
    const dupeRel = '/about.html';
    const dupeRel2 = '/contact.html';
    writeFileSync(join(assetsDir, dupeRel.slice(1)), sharedHtml);
    writeFileSync(join(assetsDir, dupeRel2.slice(1)), sharedHtml);

    const allPaths = [...Object.keys(fixtureFiles), dupeRel, dupeRel2];
    const state = installPlatformMocks({ preflightNeeded: allPaths });
    const client = makeClient();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      client,
      { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    // 6 paths total but only 5 unique blake3 values (about.html ==
    // contact.html). Presign request body MUST contain 5 entries,
    // R2 PUTs MUST be 5, NOT 6.
    expect(state.uploadUrlsCalls).toHaveLength(1);
    const presign = state.uploadUrlsCalls[0] as {
      assets: Array<{ blake3: string }>;
    };
    expect(presign.assets).toHaveLength(5);
    const presignHashes = new Set(presign.assets.map((a) => a.blake3));
    expect(presignHashes.size).toBe(5);

    expect(state.r2PutCalls).toHaveLength(5);
    const r2Hashes = new Set(state.r2PutCalls.map(({ url }) => url.split('/').pop()));
    expect(r2Hashes.size).toBe(5);

    // The finalize payload's assetManifest still includes BOTH duplicate
    // paths so the platform-side per-path serving manifest is complete.
    expect(state.finalizeCalls).toHaveLength(1);
    const finalizeBody = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(finalizeBody.assetManifest[dupeRel]).toBeDefined();
    expect(finalizeBody.assetManifest[dupeRel2]).toBeDefined();
    expect(finalizeBody.assetManifest[dupeRel].blake3).toBe(
      finalizeBody.assetManifest[dupeRel2].blake3,
    );
  });

  it('failure-mode error message ends with the JSONL log path', async () => {
    installPlatformMocks({
      finalizeEvents: [{ event: 'error', message: 'something broke', step: 'finalize' }],
    });
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();

    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await expect(
      runStaticDeploy(
        workdir,
        { projectId: 'proj_t', slug: 'test' },
        client,
        { buildCommand: null, outputDir: assetsDir, appType: 'spa' },
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        cliLog,
      ),
    ).rejects.toThrow(new RegExp(escapeRegex(logPath as string)));

    await cliLog.close();
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
