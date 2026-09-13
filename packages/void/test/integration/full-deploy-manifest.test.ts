import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import type { DetectedFramework } from '../../src/plugin-inference.ts';

// @clack/prompts + the output-spinner wrapper are TTY-bound; noop them (same as
// direct-r2-deploy.test.ts) so runDeploy's interactive UI doesn't render here.
const noopSpinner = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
};
vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
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
vi.mock('../../src/cli/output.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/cli/output.ts')>('../../src/cli/output.ts');
  return { ...actual, createSpinner: () => noopSpinner };
});

// Prerender path discovery spins Miniflare/workerd in-process. It feeds
// `manifest.prerender`, NOT `manifest.pages`, so it is orthogonal to the seam
// under test. Stub it to [] to keep this test offline, fast and deterministic —
// everything else in runFullDeploy (including assembleVoidManifest) runs for
// real. (For a non-`output:static` Void app this is the only in-process CF
// runtime the deploy path would otherwise start; all network I/O is mocked
// below.)
const { mockCollectPrerenderPaths } = vi.hoisted(() => ({
  mockCollectPrerenderPaths: vi.fn(async () => [] as Array<string>),
}));
vi.mock('../../src/prerender.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/prerender.ts')>('../../src/prerender.ts');
  return {
    ...actual,
    collectPrerenderPaths: mockCollectPrerenderPaths,
  };
});

// detectFramework is mocked so the SAME pre-built fixture can be driven down
// both deploy routes: the default (undefined → Void pages path, exercised by
// the first test) and, per-test, a forced Class-A framework (→ runFullDeploy
// with isFrameworkMode = true, which must suppress manifest.pages). The return
// value is set in beforeEach (undefined) and overridden inside the framework
// test — so the Void test always sees the real-world `undefined`.
const { mockDetectFramework } = vi.hoisted(() => ({
  mockDetectFramework: vi.fn<(root: string) => DetectedFramework | undefined>(),
}));
vi.mock('../../src/plugin-inference.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/plugin-inference.ts')>(
    '../../src/plugin-inference.ts',
  );
  return { ...actual, detectFramework: mockDetectFramework };
});

const { runDeploy } = await import('../../src/cli/deploy.ts');

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/named-layouts';
let playground: IsolatedPlayground;
let fixture = '';
let projectJson = '';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;
let savedToken: string | undefined;
let savedProject: string | undefined;
let projectJsonSnapshot: string | undefined;
let projectJsonSnapshotTaken = false;

type Captured = { finalizeBody: { manifest?: { pages?: unknown } } | null };

// Minimal platform mock: report every asset as already-present so the
// upload-urls + R2 PUT phase is skipped and runFullDeploy goes straight to the
// finalize POST, whose JSON body we capture.
function installPlatformMocks(): Captured {
  const captured: Captured = { finalizeBody: null };

  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const reqInit = init ?? {};
    const method = (reqInit.method ?? 'GET').toUpperCase();

    if (url.endsWith('/deploy/preflight') && method === 'POST') {
      const body = JSON.parse(reqInit.body as string) as {
        assetManifest?: Record<string, unknown>;
      };
      const total = Object.keys(body.assetManifest ?? {}).length;
      return json({ needed: [], total, skipped: total });
    }

    if (url.endsWith('/projects/proj_named_layouts_test/prerender-token') && method === 'POST') {
      return json({ token: 'scoped-prerender-token' });
    }

    if (url.endsWith('/deploy') && method === 'POST') {
      captured.finalizeBody = JSON.parse(reqInit.body as string);
      return ndjson([
        { event: 'start', deploymentId: 'dep_test' },
        {
          event: 'done',
          deployment: 'dep_test',
          url: 'https://named-layouts.test.void.app',
          urls: ['https://named-layouts.test.void.app'],
          assets: 0,
          workers: 1,
        },
      ]);
    }

    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });

  return captured;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjson(events: Array<unknown>): Response {
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
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

// End-to-end guard for the `assembleVoidManifest` seam: drives the REAL exported
// runDeploy → runDeployInner → runFullDeploy (Void/SSR path) against a
// pre-built minimal Void pages fixture, with only network + prompts + prerender
// stubbed, and asserts the finalize manifest carries `pages`. Reverting
// runFullDeploy's `assembleVoidManifest(pageScan, …)` back to
// `buildVoidManifest({ … })` drops `pages` and turns this RED.
describe('runFullDeploy emits manifest.pages (Void pages app, end-to-end)', () => {
  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    fixture = playground.root;
    projectJson = join(fixture, '.void', 'project.json');

    // Real build of the minimal React pages fixture so runDeploy(skipBuild:true)
    // finds dist/client/.vite/manifest.json + dist/ssr/{index.js,wrangler.json}.
    const result = spawn.sync('vp', ['run', '--filter', `./${playground.workspacePath}`, 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, VOID_TOKEN: 'test-token-do-not-use' },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

    // Link the fixture to a fake project (snapshot any real link first so we
    // restore developer-local state exactly on teardown).
    projectJsonSnapshot = existsSync(projectJson) ? readFileSync(projectJson, 'utf-8') : undefined;
    projectJsonSnapshotTaken = true;
    mkdirSync(join(fixture, '.void'), { recursive: true });
    writeFileSync(
      projectJson,
      JSON.stringify({ projectId: 'proj_named_layouts_test', slug: 'named-layouts-test' }),
    );
  }, 180_000);

  afterAll(() => {
    if (!projectJsonSnapshotTaken) {
      playground?.cleanup();
      return;
    }
    if (projectJsonSnapshot === undefined) {
      rmSync(projectJson, { force: true });
    } else {
      writeFileSync(projectJson, projectJsonSnapshot);
    }
    playground.cleanup();
  });

  beforeEach(() => {
    // Default: no framework detected → the Void pages path. The framework test
    // overrides this to a Class-A framework before driving runDeploy.
    mockDetectFramework.mockReturnValue(undefined);

    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    fetchMock.mockReset();
    mockCollectPrerenderPaths.mockClear();

    savedToken = process.env.VOID_TOKEN;
    savedProject = process.env.VOID_PROJECT;
    // Explicit token bypasses getToken() + the GitHub-Actions OIDC branch.
    process.env.VOID_TOKEN = 'test-token-do-not-use';
    // Force resolution via .void/project.json (avoid the listProjects() path).
    delete process.env.VOID_PROJECT;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (savedToken === undefined) {
      delete process.env.VOID_TOKEN;
    } else {
      process.env.VOID_TOKEN = savedToken;
    }
    if (savedProject === undefined) {
      delete process.env.VOID_PROJECT;
    } else {
      process.env.VOID_PROJECT = savedProject;
    }
  });

  it('forwards the page scan into the finalize manifest.pages (incl. the ISR page)', async () => {
    const captured = installPlatformMocks();

    await runDeploy(fixture, { skipBuild: true });

    expect(mockCollectPrerenderPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj_named_layouts_test',
        voidToken: 'scoped-prerender-token',
      }),
    );

    expect(captured.finalizeBody).not.toBeNull();
    const pages = captured.finalizeBody!.manifest?.pages as
      | Array<{ pattern: string; revalidate?: number }>
      | undefined;

    // manifest.pages must be a non-empty array — this is exactly what dropping
    // the assembleVoidManifest seam (reverting to buildVoidManifest) removes.
    expect(Array.isArray(pages)).toBe(true);
    expect(pages!.length).toBeGreaterThan(0);
    // Every entry carries a string pattern (raw, route-shaped).
    for (const p of pages!) {
      expect(typeof p.pattern).toBe('string');
    }
    // The /isr page (pages/isr.server.ts → `export const revalidate = 60`) must
    // survive into the real deploy manifest with its exact TTL.
    expect(pages).toContainEqual({ pattern: '/isr', revalidate: 60 });

    // The object `routing.revalidate` in the fixture void.json is NOT baked into
    // per-page TTLs — a REAL build must emit the 3-state table + the RAW object
    // config as `manifest.pathRevalidate` (this is the producer half of the
    // cross-repo contract dispatch consumes; a manually-constructed manifest
    // would not prove the actual CLI emits it). `/docs` and `/docs/ref` have no
    // per-page export, so they ship INHERIT-ELIGIBLE (no `revalidate` key) and
    // dispatch resolves the per-path config against the real request path.
    const manifest = captured.finalizeBody!.manifest as unknown as {
      pathRevalidate?: Record<string, number>;
    };
    expect(manifest.pathRevalidate).toEqual({ '/docs': 120, '/docs/ref': 0 });
    expect(pages).toContainEqual({ pattern: '/docs' });
    expect(pages).toContainEqual({ pattern: '/docs/ref' });
    // Neither inherit-eligible page carries a baked `revalidate` (that would be
    // the unsafe build-time collapse of a per-path config — incl. the `0` opt-out).
    const docsEntry = pages!.find((p) => p.pattern === '/docs');
    const docsRefEntry = pages!.find((p) => p.pattern === '/docs/ref');
    expect(docsEntry).not.toHaveProperty('revalidate');
    expect(docsRefEntry).not.toHaveProperty('revalidate');
  });

  it('suppresses manifest.pages in framework mode (Class-A framework forced via detectFramework)', async () => {
    // Force the SAME pre-built fixture down the Class-A framework route. The
    // vinext-pages preset (workerDir dist/ssr, assetsDir dist/client,
    // workerMain index.js) matches the Void React build layout exactly, so
    // runDeployInner routes to runFullDeploy with isFrameworkMode = true.
    mockDetectFramework.mockReturnValue({ name: 'vinext-pages', class: 'a' });
    const captured = installPlatformMocks();

    await runDeploy(fixture, { skipBuild: true });

    // The deploy still finalizes (manifest present)...
    expect(captured.finalizeBody).not.toBeNull();
    expect(captured.finalizeBody!.manifest).toBeDefined();
    // ...but `pages` (the Void pages-mode ISR table) is suppressed in framework
    // mode even though the fixture has a pages/ dir with an ISR page. Removing
    // the `isFrameworkMode ? undefined :` gate in assembleVoidManifest turns
    // this RED (pages becomes the populated array instead of undefined).
    expect(captured.finalizeBody!.manifest?.pages).toBeUndefined();
  });
});
