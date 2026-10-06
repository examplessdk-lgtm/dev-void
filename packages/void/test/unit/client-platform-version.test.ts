import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { MIN_PLATFORM_VERSION, PlatformClient } from '../../src/cli/client.ts';
import {
  isPlatformDiscoveryRequest,
  platformDiscoveryResponse,
} from '../helpers/platform-discovery.ts';

// Never read the keychain or run cloudflared. Without Access credentials, an
// Access challenge fails the way it does for a CLI that has none.
vi.mock('../../src/cli/cf-access.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cf-access.ts')>()),
  ensureCloudflaredToken: vi.fn(),
  ensurePlatformAccessToken: vi.fn(() => {
    throw new Error('platform: Cloudflare Access authentication is required.');
  }),
}));

// Version checks are cached per process and base URL, so each test uses its own origin.
let origin = '';
let sequence = 0;
const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  origin = `https://platform-${++sequence}.example.test`;
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serve(platformVersion: string | (() => Response | Promise<Response>)): void {
  fetchMock.mockImplementation(async (input: string) => {
    if (isPlatformDiscoveryRequest(input)) {
      return typeof platformVersion === 'string'
        ? platformDiscoveryResponse(input, platformVersion)
        : platformVersion();
    }
    return Response.json([]);
  });
}

function requestedPaths(): Array<string> {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

function client(options: { checkPlatformVersion?: boolean } = {}): PlatformClient {
  return new PlatformClient('token', { apiUrl: origin, ...options });
}

describe('minimum platform version', () => {
  it('declares 0.26.0 as the minimum', () => {
    expect(MIN_PLATFORM_VERSION).toBe('0.26.0');
  });

  it.each(['0.26.0', '0.27.0', '1.0.0', 'hosted'])(
    'accepts a platform reporting %s',
    async (version) => {
      serve(version);
      await expect(client().listProjectChoices()).resolves.toEqual([]);
      expect(requestedPaths()).toEqual(['/.well-known/void-platform', '/projects/choices']);
    },
  );

  it('sends discovery without the account token', async () => {
    serve('0.26.0');
    await client().listProjectChoices();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it.each(['0.22.0', '0.25.0', '0.26.0-1'])('refuses a platform reporting %s', async (version) => {
    serve(version);
    await expect(client().listProjectChoices()).rejects.toThrow(
      `The Void platform at ${origin} runs version ${version}, but this CLI requires 0.26.0 or later. Ask its administrator to upgrade the platform runtime with \`void platform upgrade\`.`,
    );
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it('checks once per process and base URL, sharing a concurrent first check', async () => {
    serve('0.26.0');
    await Promise.all([client().listProjectChoices(), client().listProjects()]);
    await client().listProjectChoices();
    expect(requestedPaths().filter((path) => path === '/.well-known/void-platform')).toHaveLength(
      1,
    );
    expect(requestedPaths()).toHaveLength(4);

    const other = `https://other-${sequence}.example.test`;
    await new PlatformClient('token', { apiUrl: other }).listProjects();
    expect(fetchMock.mock.calls.at(-2)?.[0]).toBe(`${other}/.well-known/void-platform`);
  });

  it('does not check when login opts out', async () => {
    serve('0.22.0');
    await expect(client({ checkPlatformVersion: false }).listProjectChoices()).resolves.toEqual([]);
    expect(requestedPaths()).toEqual(['/projects/choices']);
  });

  it('refuses a too-old platform once and keeps the answer for later requests', async () => {
    serve('0.22.0');
    await expect(client().listProjectChoices()).rejects.toThrow('runs version 0.22.0');
    await expect(client().listProjects()).rejects.toThrow('runs version 0.22.0');
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it.each([
    ['an HTML 404', () => new Response('<html>not found</html>', { status: 404 })],
    ['a JSON 404', () => Response.json({ error: 'not found' }, { status: 404 })],
  ])('refuses a platform that answers discovery with %s', async (_label, answer) => {
    serve(answer);
    const message = `The Void platform at ${origin} does not report its version, but this CLI requires 0.26.0 or later. Ask its administrator to upgrade the platform runtime with \`void platform upgrade\`.`;
    await expect(client().listProjectChoices()).rejects.toThrow(message);
    await expect(client().listProjects()).rejects.toThrow(message);
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it.each([
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
    [
      'a disabled platform (503)',
      () => Response.json({ error: 'platform disabled' }, { status: 503 }),
    ],
    [
      'an Access login redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
        }),
    ],
    ['invalid JSON', () => new Response('not json', { status: 200 })],
  ])(
    'lets the request run once discovery gives %s, and does not probe again',
    async (_label, answer) => {
      serve(answer);
      await expect(client().listProjectChoices()).resolves.toEqual([]);
      await expect(client().listProjects()).resolves.toEqual([]);
      expect(requestedPaths()).toEqual([
        '/.well-known/void-platform',
        '/projects/choices',
        '/projects',
      ]);
    },
  );

  it('accepts a version it cannot order', async () => {
    serve('development');
    await expect(client().listProjectChoices()).resolves.toEqual([]);
  });
});
