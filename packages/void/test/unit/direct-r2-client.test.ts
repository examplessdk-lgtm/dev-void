import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformClient,
  type DeploymentResponse,
  type ManifestOnlyDeployPayload,
} from '../../src/cli/client.ts';
import type { DeployManifest } from '../../src/cli/types.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const projectId = 'proj_test';
const token = 'auth-token-x';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonStreamResponse(events: Array<unknown>, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('PlatformClient.requestUploadUrls', () => {
  it('POSTs JSON to /:id/deploy/upload-urls and returns the urls map', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        urls: {
          aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
        },
      }),
    );

    const client = makeClient();
    const urls = await client.requestUploadUrls(projectId, [
      { blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/deploy/upload-urls`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    // Version header so the platform's cliVersionGate middleware can refuse
    // stale CLIs cleanly (HTTP 426 + cli_outdated). Format must look like a
    // semver triplet — exact value is package.json-driven.
    expect(headers['X-Void-CLI-Version']).toMatch(/^\d+\.\d+\.\d+/);

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      assets: [{ blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' }],
    });

    expect(urls).toEqual({
      aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
    });
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const client = makeClient();
    await expect(
      client.requestUploadUrls(projectId, [
        { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
      ]),
    ).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 403,
    });
  });
});

describe('PlatformClient.getMigrationStatus', () => {
  it('passes the dialect query parameter when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ applied: [] }));

    const client = makeClient();
    await client.getMigrationStatus(projectId, 'postgresql');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${apiUrl}/projects/${projectId}/migrations?dialect=postgresql`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
  });
});

describe('PlatformClient.finalizeDeploy', () => {
  const baseManifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
    bindings: {},
    type: 'spa',
    assetConfig: { not_found_handling: 'single-page-application' },
  };

  function makePayload(): ManifestOnlyDeployPayload {
    return {
      manifest: baseManifest,
      assetManifest: {
        '/index.html': {
          blake3: 'a'.repeat(32),
          md5: 'b'.repeat(32),
          size: 12,
          hash: 'a'.repeat(32),
        },
      },
      source: 'manual',
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: 'true',
    };
  }

  it('POSTs JSON (NOT multipart) to /:id/deploy and parses the NDJSON event stream', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonStreamResponse([
        { event: 'start', deploymentId: 'dep_x' },
        { event: 'asset_upload', total: 1, new: 0, cached: 1 },
        {
          event: 'done',
          deployment: 'dep_x',
          url: 'https://x.void.app',
          urls: [],
          assets: 1,
          workers: 0,
        },
      ]),
    );

    const client = makeClient();
    const events = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    // Verify wire shape: JSON, not multipart.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/deploy`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(typeof init.body).toBe('string');
    const parsed = JSON.parse(init.body as string);
    expect(parsed.manifest).toEqual(baseManifest);
    expect(parsed.assetManifest['/index.html']).toMatchObject({
      blake3: 'a'.repeat(32),
      md5: 'b'.repeat(32),
      size: 12,
    });
    expect(parsed.preflight).toBe('true');

    // Verify all events were yielded in order, parsed from NDJSON.
    expect(events).toEqual([
      { event: 'start', deploymentId: 'dep_x' },
      { event: 'asset_upload', total: 1, new: 0, cached: 1 },
      {
        event: 'done',
        deployment: 'dep_x',
        url: 'https://x.void.app',
        urls: [],
        assets: 1,
        workers: 0,
      },
    ]);
  });

  it('handles NDJSON split across chunk boundaries', async () => {
    // Hand-craft a stream that splits the second event mid-way.
    const lines = [
      `${JSON.stringify({ event: 'start', deploymentId: 'd1' })}\n`,
      `${JSON.stringify({ event: 'heartbeat', step: 'preflight' })}`,
      `\n${JSON.stringify({ event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 })}\n`,
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines[0] + lines[1]));
        controller.enqueue(encoder.encode(lines[2]));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    );

    const client = makeClient();
    const events = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    expect(events.map((e) => (e as { event?: string }).event)).toEqual([
      'start',
      'heartbeat',
      'done',
    ]);
  });

  it('throws PlatformApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busted', { status: 500 }));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 500,
    });
  });

  function makeCliLog() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      path: '/tmp/test.jsonl',
      close: vi.fn(),
    };
  }

  function makeDeployment(overrides: Partial<DeploymentResponse> = {}): DeploymentResponse {
    return {
      id: 'dpl_existing',
      status: 'pending',
      source: 'manual',
      commit: null,
      manifest: null,
      error_message: null,
      retained: false,
      applied_migrations: null,
      created_at: new Date().toISOString(),
      deployed_at: null,
      ...overrides,
    };
  }

  function deploymentListResponse(deployments: Array<DeploymentResponse>): Response {
    return jsonResponse({ deployments, activeDeploymentId: null });
  }

  const deployPostCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/deploy'));
  const deploymentListCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/deployments'));

  it('retries a transport-level fetch rejection with backoff, then streams events', async () => {
    vi.useFakeTimers();
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([]));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(
          new TypeError('fetch failed', { cause: new Error('read ECONNRESET') }),
        );
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, makePayload())) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(deploymentListCalls()).toHaveLength(1);
      expect(events).toEqual([
        { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
      ]);
      expect(cliLog.warn).toHaveBeenCalledWith(
        'deploy_fetch_retry',
        expect.objectContaining({ attempt: 1, delayMs: 1000 }),
      );
      expect(cliLog.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws the original error after exhausting transport retries', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([]));
      }
      return Promise.reject(new TypeError('fetch failed'));
    });

    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    try {
      const consume = (async () => {
        for await (const _event of client.finalizeDeploy(projectId, makePayload())) {
          // unreachable — every attempt rejects
        }
      })();
      const assertion = expect(consume).rejects.toBeInstanceOf(TypeError);
      await vi.runAllTimersAsync();
      await assertion;

      // 1 initial attempt + 3 retries, one dedupe GET per retry.
      expect(deployPostCalls()).toHaveLength(4);
      expect(deploymentListCalls()).toHaveLength(3);
      const retries = cliLog.warn.mock.calls.filter(([msg]) => msg === 'deploy_fetch_retry');
      expect(retries.map(([, fields]) => fields?.delayMs)).toEqual([1000, 5000, 10000]);
      expect(cliLog.error).toHaveBeenCalledWith(
        'deploy_fetch_rejected',
        expect.any(TypeError),
        expect.objectContaining({
          url: `${apiUrl}/projects/${projectId}/deploy`,
          attempts: 4,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses the retry when an earlier attempt already created a deployment', async () => {
    // makeDeployment().commit === null matches makePayload().commit === null.
    const existing = makeDeployment({ id: 'dpl_existing', status: 'uploading' });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([existing]));
      }
      return Promise.reject(new TypeError('fetch failed'));
    });

    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    const events: Array<unknown> = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    // The POST is never replayed — the platform keeps its only deployment.
    expect(deployPostCalls()).toHaveLength(1);
    expect(deploymentListCalls()).toHaveLength(1);
    expect(events).toEqual([
      {
        event: 'error',
        step: 'finalize',
        message: expect.stringContaining('dpl_existing'),
      },
    ]);
    expect(cliLog.warn).toHaveBeenCalledWith(
      'deploy_retry_suppressed',
      expect.objectContaining({ deploymentId: 'dpl_existing', status: 'uploading' }),
    );
  });

  it('suppresses when the recent deployment carries the same commit as the payload', async () => {
    const existing = makeDeployment({ id: 'dpl_same', commit: 'sha_ours' });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([existing]));
      }
      return Promise.reject(new TypeError('fetch failed'));
    });

    const client = makeClient();
    const payload = { ...makePayload(), commit: 'sha_ours' };
    const events: Array<unknown> = [];
    for await (const event of client.finalizeDeploy(projectId, payload)) {
      events.push(event);
    }

    expect(deployPostCalls()).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'error',
      message: expect.stringContaining('dpl_same'),
    });
  });

  it('retries when the recent deployment carries a different commit than the payload', async () => {
    vi.useFakeTimers();
    // A racing deploy's row — not ours, so the POST must still be replayed.
    const unrelated = makeDeployment({ id: 'dpl_theirs', commit: 'sha_theirs' });
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([unrelated]));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const client = makeClient();
    const payload = { ...makePayload(), commit: 'sha_ours' };
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, payload)) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events[0]).toMatchObject({ event: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses when an in-flight placeholder row has no commit yet', async () => {
    // The server inserts the deployment as a concurrency claim with
    // commit=NULL and only fills it after R2 inventory — our own attempt
    // reads commit:null for its first seconds.
    const placeholder = makeDeployment({ id: 'dpl_placeholder', commit: null, status: 'pending' });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([placeholder]));
      }
      return Promise.reject(new TypeError('fetch failed'));
    });

    const client = makeClient();
    const payload = { ...makePayload(), commit: 'sha_ours' };
    const events: Array<unknown> = [];
    for await (const event of client.finalizeDeploy(projectId, payload)) {
      events.push(event);
    }

    expect(deployPostCalls()).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'error',
      message: expect.stringContaining('dpl_placeholder'),
    });
  });

  it('retries when the only recent commit-less deployment is already live', async () => {
    vi.useFakeTimers();
    // A live null-commit row is an unrelated manual deploy — it cannot be
    // our placeholder (our commit is written before reaching live).
    const unrelated = makeDeployment({ id: 'dpl_live', commit: null, status: 'live' });
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([unrelated]));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const client = makeClient();
    const payload = { ...makePayload(), commit: 'sha_ours' };
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, payload)) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events[0]).toMatchObject({ event: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when the same-commit deployment already failed', async () => {
    vi.useFakeTimers();
    // A dead attempt cannot conflict — the retried POST must run.
    const dead = makeDeployment({ id: 'dpl_dead', commit: 'sha_ours', status: 'failed' });
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([dead]));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const client = makeClient();
    const payload = { ...makePayload(), commit: 'sha_ours' };
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, payload)) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events[0]).toMatchObject({ event: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still retries when the newest deployment is older than the dedupe window', async () => {
    vi.useFakeTimers();
    const stale = makeDeployment({
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.resolve(deploymentListResponse([stale]));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const client = makeClient();
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, makePayload())) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events[0]).toMatchObject({ event: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still retries when the recent-deployment check itself fails', async () => {
    vi.useFakeTimers();
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/deployments')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const client = makeClient();
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, makePayload())) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events[0]).toMatchObject({ event: 'done' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry non-transport rejections (e.g. AbortError)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toBeInstanceOf(DOMException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry HTTP error responses — the server answered', async () => {
    fetchMock.mockResolvedValue(new Response('busted', { status: 503 }));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes workerFiles as base64 in the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonStreamResponse([
        {
          event: 'done',
          deployment: 'd1',
          url: 'https://x',
          urls: [],
          assets: 0,
          workers: 1,
        },
      ]),
    );

    const client = makeClient();
    const payload = makePayload();
    payload.workerFiles = {
      'index.mjs': Buffer.from('export default {};').toString('base64'),
    };

    for await (const _event of client.finalizeDeploy(projectId, payload)) {
      // no-op — we only need the request body
    }

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(init.body as string);
    expect(parsed.workerFiles).toEqual({
      'index.mjs': Buffer.from('export default {};').toString('base64'),
    });
  });
});

// The deploy command keeps the CF Access service-token PAIR out of the untrusted
// build children (via `buildEnv()` on the spawn env) so they can't read the
// shared staging credential. That is only safe because the client captures the
// Access headers AT CONSTRUCTION and reuses them — proven here: delete the env
// vars after construction, then verify a later API call STILL sends
// CF-Access-Client-Id / CF-Access-Client-Secret. (deploy.ts no longer mutates
// process.env; this test deletes them itself to assert the capture invariant.)
describe('PlatformClient CF Access header capture (survives a later env scrub)', () => {
  it('keeps sending CF-Access headers after CF_ACCESS_* are deleted from process.env', async () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';

      // Construct a known Access-gated staging client, which captures the
      // credentials before the untrusted build environment is scrubbed.
      const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

      // Simulate deploy.ts's scrub (before any user build spawns).
      delete process.env.CF_ACCESS_CLIENT_ID;
      delete process.env.CF_ACCESS_CLIENT_SECRET;

      fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));
      await client.requestUploadUrls(projectId, [
        { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
      ]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBe('svc-id.access');
      expect(headers['CF-Access-Client-Secret']).toBe('svc-secret');
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

  it('does not send staging Access credentials to a self-hosted platform', async () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));

      await client.requestUploadUrls(projectId, [
        { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
      ]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
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
