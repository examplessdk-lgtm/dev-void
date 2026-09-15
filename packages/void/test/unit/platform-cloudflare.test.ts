import { describe, expect, it } from 'vite-plus/test';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  parsePostgresConnectionString,
  PlatformCloudflareClient,
  PlatformWorkerCustomDomainsChangedError,
} from '../../src/cli/platform-cloudflare.ts';

describe('platform Cloudflare client', () => {
  it('pins every Wrangler Cloudflare transport selector exactly once', () => {
    const keys = [
      'CLOUDFLARE_API_BASE_URL',
      'CF_API_BASE_URL',
      'WRANGLER_API_ENVIRONMENT',
      'CLOUDFLARE_COMPLIANCE_REGION',
    ] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const cases: Array<[Record<string, string>, string]> = [
      [{ CF_API_BASE_URL: 'https://legacy.example/client/v4' }, 'https://legacy.example/client/v4'],
      [{ WRANGLER_API_ENVIRONMENT: 'staging' }, 'https://api.staging.cloudflare.com/client/v4'],
      [
        { CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' },
        'https://api.fed.cloudflare.com/client/v4',
      ],
      [
        {
          CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high',
          WRANGLER_API_ENVIRONMENT: 'staging',
        },
        'https://api.fed.staging.cloudflare.com/client/v4',
      ],
      [{ CLOUDFLARE_API_BASE_URL: '' }, ''],
    ];
    try {
      for (const [environment, expected] of cases) {
        for (const key of keys) {
          delete process.env[key];
        }
        Object.assign(process.env, environment);
        const client = new PlatformCloudflareClient('token');
        expect(client.apiBaseUrl).toBe(expected);
        process.env.CLOUDFLARE_API_BASE_URL = 'https://changed.example/client/v4';
        expect(client.apiBaseUrl).toBe(expected);
      }
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('parses PostgreSQL credentials without exposing them', () => {
    expect(
      parsePostgresConnectionString('postgres://user:p%40ss@db.example.com:5433/void'),
    ).toEqual({
      database: 'void',
      host: 'db.example.com',
      password: 'p@ss',
      port: 5433,
      user: 'user',
    });
    expect(() => parsePostgresConnectionString('mysql://user:secret@db.example.com/db')).toThrow(
      'postgres://',
    );
  });

  it('resolves an R2 creation fingerprint before returning a new bucket', async () => {
    const methods: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return init?.method === 'POST'
          ? Response.json({ success: true, result: { name: 'assets' } })
          : Response.json({
              success: true,
              result: {
                buckets: [{ creation_date: '2026-09-14T00:00:00.000Z', name: 'assets' }],
              },
            });
      },
    });

    await expect(client.createR2Bucket('account', 'assets')).resolves.toEqual({
      fingerprint: '2026-09-14T00:00:00.000Z',
      id: 'assets',
      name: 'assets',
    });
    expect(methods).toEqual(['POST', 'GET']);
  });

  it('preserves supported PostgreSQL TLS modes in Hyperdrive requests', async () => {
    let payload: unknown;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ success: true, result: { id: 'hyperdrive-id', name: 'void-db' } });
      },
    });

    await client.createHyperdrive(
      'account',
      'void-db',
      'postgresql://user:secret@db.example.com/void?sslmode=verify-full',
    );

    expect(payload).toMatchObject({ mtls: { sslmode: 'verify-full' } });
    expect(() =>
      parsePostgresConnectionString('postgresql://user:secret@db.example.com/void?sslmode=prefer'),
    ).toThrow('Unsupported sslmode');
  });

  it('reads and fingerprints a Hyperdrive origin without its password', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: {
            id: 'hyperdrive-id',
            name: 'void-db',
            origin: {
              database: 'void',
              host: 'DB.EXAMPLE.COM',
              port: 5432,
              scheme: 'postgres',
              user: 'void-user',
            },
          },
        }),
    });
    const config = await client.getHyperdriveConfig('account', 'hyperdrive-id');
    expect(config.origin).toEqual({
      database: 'void',
      host: 'db.example.com',
      port: 5432,
      scheme: 'postgresql',
      user: 'void-user',
    });
    expect(hyperdriveOriginConfigHash(config.origin)).toBe(
      hyperdriveOriginConfigHash(
        hyperdriveOriginFromConnectionString(
          'postgres://void-user:secret@db.example.com:5432/void',
        ),
      ),
    );
  });

  it('never includes the API token in errors', async () => {
    const token = 'super-secret-token';
    const client = new PlatformCloudflareClient(token, {
      fetcher: async () => new Response('not json', { status: 500 }),
    });
    let message = '';
    try {
      await client.verifyToken();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(token);
    expect(message).toContain('non-JSON');
  });

  it('refuses unattended custom-domain deletion without a generation precondition', async () => {
    const requests: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        requests.push(String(input));
        return Response.json({ result: [], success: true });
      },
    });

    await expect(
      client.removeRoutes('account', null, {
        customDomains: [{ hostname: 'api.example.com', id: 'domain-id', service: 'void-api' }],
        routes: [],
      }),
    ).rejects.toThrow('does not support conditional Worker traffic deletion');
    expect(requests).toEqual([]);
  });

  it('refuses unattended route deletion before reading mutable zone state', async () => {
    const requests: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('/zones/')) {
          return Response.json(
            { errors: [{ message: 'missing' }], result: null, success: false },
            { status: 404 },
          );
        }
        return Response.json({ result: [], success: true });
      },
    });

    await expect(
      client.removeRoutes('account', 'removed-zone', {
        customDomains: [{ hostname: 'api.example.com', id: 'domain-id', service: 'void-api' }],
        routes: [{ id: 'route-id', pattern: 'apps.example.com/*', script: 'void-api' }],
      }),
    ).rejects.toThrow('does not support conditional Worker traffic deletion');
    expect(requests).toEqual([]);
  });

  it('treats a missing Worker as already disabled but not as enabled', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json(
          { errors: [{ message: 'missing' }], result: null, success: false },
          { status: 404 },
        ),
    });

    await expect(client.setWorkerSubdomain('account', 'missing', false)).resolves.toBeUndefined();
    await expect(client.setWorkerSubdomain('account', 'missing', true)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('paginates namespace discovery without a title filter', async () => {
    const pages: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        pages.push(url.searchParams.get('page') ?? '');
        const page = url.searchParams.get('page');
        const result =
          page === '1'
            ? Array.from({ length: 100 }, (_, index) => ({
                id: `id-${index}`,
                title: `namespace-${index}`,
              }))
            : [{ id: 'id-100', title: 'namespace-100' }];
        return Response.json({ success: true, result });
      },
    });
    await expect(client.listKvNamespaces('account')).resolves.toHaveLength(101);
    expect(pages).toEqual(['1', '2']);
  });

  it('exhausts paginated collision checks for platform resource names', async () => {
    const calls: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname}?${url.searchParams}`);
        const page = Number(url.searchParams.get('page') ?? '1');
        if (url.pathname.endsWith('/ai-gateway/gateways')) {
          return Response.json({
            success: true,
            result:
              page === 1
                ? Array.from({ length: 50 }, (_, index) => ({ id: `gateway-${index}` }))
                : [{ id: 'gateway-50' }],
          });
        }
        return Response.json({
          success: true,
          result:
            page === 1
              ? Array.from({ length: 50 }, (_, index) => ({
                  id: `hyperdrive-${index}`,
                  name: `hyperdrive-${index}`,
                }))
              : [{ id: 'hyperdrive-50', name: 'hyperdrive-50' }],
        });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toHaveLength(51);
    await expect(client.listHyperdriveConfigs('account')).resolves.toHaveLength(51);
    expect(calls.filter((call) => call.includes('ai-gateway'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('hyperdrive'))).toHaveLength(2);
  });

  it('paginates R2 buckets with a stable start-after cursor', async () => {
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get('start_after') ?? '';
        cursors.push(cursor);
        const buckets = cursor
          ? [{ creation_date: '2026-09-14T00:00:01.000Z', name: 'bucket-1000' }]
          : Array.from({ length: 1000 }, (_, index) => ({
              creation_date: '2026-09-14T00:00:00.000Z',
              name: `bucket-${String(index).padStart(4, '0')}`,
            }));
        return Response.json({ success: true, result: { buckets } });
      },
    });

    await expect(client.listR2Buckets('account')).resolves.toHaveLength(1001);
    expect(cursors).toEqual(['', 'bucket-0999']);
  });

  it('preserves R2 key path separators while encoding reserved characters', async () => {
    const requests: Array<{ body: string; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: String(init?.body ?? ''),
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return init?.method === 'PUT'
          ? new Response(null, { status: 200 })
          : new Response('marker');
      },
    });

    await client.putR2Object('account', 'bucket/name', '__void/platform/ownership/v1', 'marker');
    await expect(
      client.getR2Object('account', 'bucket/name', '__void/platform/ownership/v1'),
    ).resolves.toBe('marker');
    await client.putR2Object('account', 'bucket/name', 'reserved/what? #%.json', 'reserved');
    await expect(
      client.getR2Object('account', 'bucket/name', 'reserved/what? #%.json'),
    ).resolves.toBe('marker');
    expect(requests).toEqual([
      {
        body: 'marker',
        method: 'PUT',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/__void/platform/ownership/v1',
      },
      {
        body: '',
        method: 'GET',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/__void/platform/ownership/v1',
      },
      {
        body: 'reserved',
        method: 'PUT',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved/what%3F%20%23%25.json',
      },
      {
        body: '',
        method: 'GET',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved/what%3F%20%23%25.json',
      },
    ]);
  });

  it('reads only plain-text Worker ownership bindings', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: {
            bindings: [
              { name: 'PLATFORM_OWNERSHIP_MARKER', text: 'owned', type: 'plain_text' },
              { name: 'SECRET', type: 'secret_text' },
            ],
          },
        }),
    });
    await expect(client.getWorkerPlainTextBindings('account', 'worker')).resolves.toEqual({
      PLATFORM_OWNERSHIP_MARKER: 'owned',
    });
  });

  it('empties every paginated R2 object before bucket deletion', async () => {
    const deleted: Array<ReadonlyArray<string>> = [];
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'DELETE') {
          const keys = JSON.parse(String(init.body)) as Array<string>;
          deleted.push(keys);
          return Response.json({
            success: true,
            result: keys.map((key) => ({ key })),
          });
        }
        const cursor = url.searchParams.get('cursor') ?? '';
        cursors.push(cursor);
        return Response.json(
          cursor
            ? { success: true, result: [{ key: 'nested/c.txt' }] }
            : {
                success: true,
                result: [
                  { key: 'a.txt' },
                  { key: '__void/platform/ownership/v1' },
                  { key: 'b.txt' },
                ],
                result_info: { cursor: 'next-page' },
              },
        );
      },
    });

    await client.emptyR2Bucket('account', 'void-assets', new Set(['__void/platform/ownership/v1']));
    expect(cursors).toEqual(['', 'next-page']);
    expect(deleted).toEqual([['a.txt', 'b.txt'], ['nested/c.txt']]);
  });

  it('uses the documented AI Gateway lifecycle endpoints and creation shape', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        const result =
          init?.method === 'POST'
            ? { id: 'void-team' }
            : init?.method === 'DELETE'
              ? null
              : [{ id: 'void-team' }];
        return Response.json({ success: true, result });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toEqual([
      { id: 'void-team', name: 'void-team' },
    ]);
    await expect(client.createAiGateway('account', 'void-team')).resolves.toEqual({
      id: 'void-team',
      name: 'void-team',
    });
    await client.deleteResource('account', 'ai-gateway', 'void-team');

    expect(requests).toEqual([
      {
        body: null,
        method: 'GET',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: {
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id: 'void-team',
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        },
        method: 'POST',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways/void-team',
      },
    ]);
  });

  it('creates and deletes the proxied wildcard application DNS record in its zone', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const dns = {
      content: '100::',
      id: 'dns-id',
      name: '*.apps.example.com',
      proxied: true,
      type: 'AAAA',
    };
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return Response.json({
          success: true,
          result:
            init?.method === 'GET' || !init?.method ? [dns] : init.method === 'POST' ? dns : null,
        });
      },
    });

    await expect(client.listDnsRecords('zone-id', '*.apps.example.com')).resolves.toEqual([dns]);
    await expect(client.createDnsRecord('zone-id', '*.apps.example.com')).resolves.toEqual(dns);
    await client.deleteResource('account', 'dns-record', 'dns-id', 'zone-id');

    expect(requests).toEqual([
      { body: null, method: 'GET', pathname: '/client/v4/zones/zone-id/dns_records' },
      {
        body: {
          content: '100::',
          name: '*.apps.example.com',
          proxied: true,
          ttl: 1,
          type: 'AAAA',
        },
        method: 'POST',
        pathname: '/client/v4/zones/zone-id/dns_records',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/zones/zone-id/dns_records/dns-id',
      },
    ]);
  });

  it('enables and disables the workers.dev endpoint for one Worker', async () => {
    const bodies: Array<unknown> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ success: true, result: null });
      },
    });
    await client.setWorkerSubdomain('account', 'void-company-api', false);
    await client.setWorkerSubdomain('account', 'void-company-api', true);
    expect(bodies).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: true, previews_enabled: true },
    ]);
  });

  it('never calls Cloudflare for non-empty unattended traffic cleanup', async () => {
    let requests = 0;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () => {
        requests++;
        return Response.json({ success: true, result: null });
      },
    });

    await expect(
      client.removeRoutes('account', 'zone', {
        customDomains: [],
        routes: [{ id: 'route', pattern: 'apps.example.com/*', script: 'worker' }],
      }),
    ).rejects.toThrow('does not support conditional Worker traffic deletion');
    expect(requests).toBe(0);
  });

  it('inventories Worker custom domains before installer deployment', async () => {
    const pages: Array<string | null> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const page = new URL(String(input)).searchParams.get('page');
        pages.push(page);
        return Response.json({
          success: true,
          result:
            page === '1'
              ? [
                  {
                    hostname: 'api.platform.example.com',
                    id: 'domain-id',
                    service: 'existing-worker',
                    zone_name: 'example.com',
                  },
                ]
              : [
                  {
                    hostname: 'admin.platform.example.net',
                    id: 'domain-id-2',
                    service: 'existing-worker',
                  },
                ],
          result_info: { page: Number(page), per_page: 1, total_pages: 2 },
        });
      },
    });
    await expect(client.listWorkerDomains('account')).resolves.toEqual([
      {
        hostname: 'api.platform.example.com',
        id: 'domain-id',
        service: 'existing-worker',
        zoneName: 'example.com',
      },
      {
        hostname: 'admin.platform.example.net',
        id: 'domain-id-2',
        service: 'existing-worker',
      },
    ]);
    expect(pages).toEqual(['1', '2']);
  });

  it('adds only missing managed routes while preserving concurrent routes', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let inventories = 0;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          url,
        });
        if (init?.method === 'POST') {
          return Response.json({
            success: true,
            result: { id: 'managed-id', pattern: 'apps.example.com/*', script: 'void-dispatch' },
          });
        }
        return Response.json({
          success: true,
          result:
            inventories++ === 0
              ? [{ id: 'manual-id', pattern: 'manual.example.net/*', script: 'void-dispatch' }]
              : [
                  { id: 'manual-id', pattern: 'manual.example.net/*', script: 'void-dispatch' },
                  { id: 'managed-id', pattern: 'apps.example.com/*', script: 'void-dispatch' },
                  {
                    id: 'concurrent-id',
                    pattern: 'concurrent.example.net/*',
                    script: 'void-dispatch',
                  },
                ],
        });
      },
    });

    await client.publishWorkerRoutesSafely('zone', 'void-dispatch', ['apps.example.com/*']);

    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(requests[1]).toMatchObject({
      body: { pattern: 'apps.example.com/*', script: 'void-dispatch' },
    });
  });

  it('treats an ambiguous managed route publication as unsafe', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        if (init?.method === 'POST') {
          throw new Error('connection reset');
        }
        return Response.json({ success: true, result: [] });
      },
    });

    await expect(
      client.publishWorkerRoutesSafely('zone', 'void-dispatch', ['apps.example.com/*']),
    ).rejects.toMatchObject({ name: 'PlatformWorkerRoutesChangedError' });
  });

  it('publishes Worker custom domains without takeover flags and verifies ownership', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let inventories = 0;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          url,
        });
        return url.endsWith('/domains/records')
          ? Response.json({ success: true, result: null })
          : Response.json({
              success: true,
              result:
                inventories++ === 0
                  ? []
                  : [
                      {
                        hostname: 'api.example.com',
                        id: 'domain-id',
                        service: 'void-api',
                        zone_name: 'example.com',
                      },
                      {
                        hostname: 'concurrent.example.net',
                        id: 'concurrent-domain-id',
                        service: 'void-api',
                      },
                    ],
              result_info: { page: 1, per_page: 100, total_pages: 1 },
            });
      },
    });

    await client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com', zoneName: 'example.com' },
    ]);

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[1]).toMatchObject({
      body: {
        origins: [{ hostname: 'api.example.com', zone_name: 'example.com' }],
        override_existing_dns_record: false,
        override_existing_origin: false,
        override_scope: false,
      },
      method: 'PUT',
    });
    expect(requests[1]!.url).toContain(
      '/accounts/account/workers/scripts/void-api/domains/records',
    );
    expect(requests[2]).toMatchObject({ method: 'GET' });
  });

  it('does not mutate a Worker when every custom domain is already attached', async () => {
    const methods: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return Response.json({
          success: true,
          result: [{ hostname: 'api.example.com', id: 'domain-id', service: 'void-api' }],
          result_info: { page: 1, per_page: 100, total_pages: 1 },
        });
      },
    });

    await client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com' },
    ]);
    expect(methods).toEqual(['GET']);
  });

  it('treats an ambiguous custom-domain publication as unsafe', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        if (String(input).endsWith('/domains/records')) {
          throw new Error('connection reset');
        }
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, per_page: 100, total_pages: 1 },
        });
      },
    });

    await expect(
      client.publishWorkerCustomDomainsSafely('account', 'void-api', [
        { hostname: 'api.example.com' },
      ]),
    ).rejects.toBeInstanceOf(PlatformWorkerCustomDomainsChangedError);
  });

  it('fails closed when a published Worker custom domain changes ownership', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) =>
        String(input).endsWith('/domains/records')
          ? Response.json({ success: true, result: null })
          : Response.json({
              success: true,
              result: [{ hostname: 'api.example.com', id: 'domain-id', service: 'other-worker' }],
              result_info: { page: 1, per_page: 100, total_pages: 1 },
            }),
    });

    const publication = client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com' },
    ]);
    await expect(publication).rejects.toBeInstanceOf(PlatformWorkerCustomDomainsChangedError);
    await expect(publication).rejects.toThrow('changed concurrently');
  });

  it('inventories every route for a Worker without requiring zone visibility', async () => {
    let requestUrl = '';
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        requestUrl = String(input);
        return Response.json({
          success: true,
          result: [{ pattern: 'manual.example.com/*', zone_name: 'example.com' }],
        });
      },
    });

    await expect(client.listWorkerServiceRoutes('account', 'worker')).resolves.toEqual([
      { pattern: 'manual.example.com/*', zoneName: 'example.com' },
    ]);
    expect(requestUrl).toContain(
      '/accounts/account/workers/services/worker/environments/production/routes?show_zonename=true',
    );
  });
});
