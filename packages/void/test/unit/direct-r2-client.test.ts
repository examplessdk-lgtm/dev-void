import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient, type ManifestOnlyDeployPayload } from '../../src/cli/client.ts';
import type { DeployManifest } from '../../src/cli/types.ts';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const accessKeyring = vi.hoisted(() => ({
  read: vi.fn((): string | null => null),
  write: vi.fn(() => true),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: (...args: Array<unknown>) => spawnSyncMock(...args),
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: accessKeyring.read,
  writeKeyringPassword: accessKeyring.write,
}));

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

  const deployPostCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/deploy'));
  const deploymentListCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/deployments'));

  it('retries a transport-level fetch rejection with backoff, then streams events', async () => {
    vi.useFakeTimers();
    let posts = 0;
    fetchMock.mockImplementation(() => {
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
      // No client-side dedupe GET — the server's precheck is authoritative.
      expect(deploymentListCalls()).toHaveLength(0);
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
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));

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

      // 1 initial attempt + 3 retries — no dedupe GETs.
      expect(deployPostCalls()).toHaveLength(4);
      expect(deploymentListCalls()).toHaveLength(0);
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

  it('surfaces the server 409 as an error event when a deploy is already in progress', async () => {
    vi.useFakeTimers();
    // The replay hits the authoritative concurrency guard — possibly the
    // earlier attempt of this same deploy, or a concurrent one.
    let posts = 0;
    fetchMock.mockImplementation(() => {
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        jsonResponse({ error: 'deploy in progress', deployment: 'dpl_conflict' }, 409),
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
      expect(events).toEqual([
        {
          event: 'error',
          step: 'finalize',
          message: expect.stringContaining('dpl_conflict'),
        },
      ]);
      expect(cliLog.warn).toHaveBeenCalledWith(
        'deploy_conflict',
        expect.objectContaining({ deploymentId: 'dpl_conflict' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a first-attempt 409 without retrying', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'deploy in progress', deployment: 'dpl_busy' }, 409),
    );

    const client = makeClient();
    const events: Array<unknown> = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    expect(deployPostCalls()).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'error',
      message: expect.stringContaining('dpl_busy'),
    });
  });

  it('throws the platform error for a 409 without a deployment id', async () => {
    fetchMock.mockResolvedValue(new Response('conflict', { status: 409 }));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('uses a browser-renewed Access token acquired after construction', async () => {
    const savedToken = process.env.CF_ACCESS_TOKEN;
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    const savedCredentials = process.env.VOID_ACCESS_CREDENTIALS;
    const savedOrigin = process.env.VOID_ACCESS_ORIGIN;
    try {
      delete process.env.CF_ACCESS_CLIENT_ID;
      delete process.env.CF_ACCESS_CLIENT_SECRET;
      delete process.env.VOID_ACCESS_CREDENTIALS;
      delete process.env.VOID_ACCESS_ORIGIN;
      process.env.CF_ACCESS_TOKEN = 'initial-user-token';
      const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

      process.env.CF_ACCESS_TOKEN = 'renewed-user-token';
      fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));
      await client.requestUploadUrls(projectId, [
        { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
      ]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['cf-access-token']).toBe('renewed-user-token');
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
    } finally {
      for (const [name, value] of [
        ['CF_ACCESS_TOKEN', savedToken],
        ['CF_ACCESS_CLIENT_ID', savedId],
        ['CF_ACCESS_CLIENT_SECRET', savedSecret],
        ['VOID_ACCESS_CREDENTIALS', savedCredentials],
        ['VOID_ACCESS_ORIGIN', savedOrigin],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

describe('PlatformClient Cloudflare Access challenge renewal', () => {
  const origin = 'https://api.example.com';
  const accessJwt = (seconds: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
  let savedCredentials: string | undefined;
  let savedOrigin: string | undefined;
  let stdinTty: boolean | undefined;
  let stdoutTty: boolean | undefined;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    accessKeyring.read.mockReset().mockReturnValue(null);
    accessKeyring.write.mockReset().mockReturnValue(true);
    savedCredentials = process.env.VOID_ACCESS_CREDENTIALS;
    savedOrigin = process.env.VOID_ACCESS_ORIGIN;
    stdinTty = process.stdin.isTTY;
    stdoutTty = process.stdout.isTTY;
    delete process.env.VOID_ACCESS_ORIGIN;
  });

  afterEach(() => {
    if (savedCredentials === undefined) {
      delete process.env.VOID_ACCESS_CREDENTIALS;
    } else {
      process.env.VOID_ACCESS_CREDENTIALS = savedCredentials;
    }
    if (savedOrigin === undefined) {
      delete process.env.VOID_ACCESS_ORIGIN;
    } else {
      process.env.VOID_ACCESS_ORIGIN = savedOrigin;
    }
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
  });

  it('renews a rejected human token and retries once at the original API endpoint', async () => {
    const stale = accessJwt(600);
    const fresh = accessJwt(900);
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
      [origin]: { CF_ACCESS_TOKEN: stale },
    });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    spawnSyncMock.mockImplementation((_command, args: Array<string>) =>
      args[1] === 'login' ? { status: 0, stdout: '' } : { status: 0, stdout: fresh },
    );
    const challengeLocation =
      'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com';
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: challengeLocation } }),
      )
      .mockResolvedValueOnce(jsonResponse([]));

    await expect(new PlatformClient(token, { apiUrl: origin }).listProjects()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/projects`,
      `${origin}/projects`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual([
      'manual',
      'manual',
    ]);
    const firstHeaders = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(firstHeaders['cf-access-token']).toBe(stale);
    expect(secondHeaders['cf-access-token']).toBe(fresh);
    expect(secondHeaders['CF-Access-Client-Id']).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url === challengeLocation)).toBe(false);
  });

  it('does not retry ambiguous API errors', async () => {
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
      [origin]: { CF_ACCESS_TOKEN: accessJwt(600) },
    });
    fetchMock.mockResolvedValueOnce(new Response('application failure', { status: 500 }));

    await expect(
      new PlatformClient(token, { apiUrl: origin }).listProjects(),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not replace a rejected scoped service credential with a human login', async () => {
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
      [origin]: {
        CF_ACCESS_CLIENT_ID: 'ci-client',
        CF_ACCESS_CLIENT_SECRET: 'ci-secret',
      },
    });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const client = new PlatformClient(token, { apiUrl: origin });
    delete process.env.VOID_ACCESS_CREDENTIALS;
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com',
        },
      }),
    );

    await expect(client.listProjects()).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
