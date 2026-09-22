import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { queryProjectAiUsage } from '../../src/routes/usage.ts';

const apiToken = 'private-cloudflare-token';
const since = new Date('2026-09-01T00:00:00.000Z');
const until = new Date('2026-09-02T00:00:00.000Z');

function payload(requests: unknown): unknown {
  return { data: { viewer: { accounts: [{ aiGatewayRequests: requests }] } } };
}

function respond(body: unknown, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, { status }));
}

function query(failOnError = true): Promise<{ neurons: number }> {
  return queryProjectAiUsage('account-1', apiToken, 'void', 'project-1', since, until, failOnError);
}

afterEach(() => vi.restoreAllMocks());

describe('queryProjectAiUsage strict accounting', () => {
  it('queries the requested ownership interval and converts valid costs to neurons', async () => {
    respond(payload([{ sum: { cost: 0.000022 } }]));

    await expect(query()).resolves.toEqual({ neurons: 2 });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    const request = JSON.parse(String(init?.body));
    expect(request.query).toContain('metadata_projectId: "project-1"');
    expect(request.query).toContain(`datetime_geq: "${since.toISOString()}"`);
    expect(request.query).toContain(`datetime_lt: "${until.toISOString()}"`);
  });

  it.each([{ requests: [] }, { requests: [{ sum: { cost: 0 } }] }])(
    'accepts a valid zero-usage result $requests',
    async ({ requests }) => {
      respond(payload(requests));
      await expect(query()).resolves.toEqual({ neurons: 0 });
    },
  );

  it.each([
    null,
    {},
    { data: null },
    { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: {} } } },
  ])('rejects missing account data %j', async (body) => {
    respond(body);
    await expect(query()).rejects.toThrow('AI usage query returned no account data');
  });

  it.each([undefined, null, {}, false, [null, null]])(
    'rejects malformed request aggregates %j',
    async (requests) => {
      respond(payload(requests));
      await expect(query()).rejects.toThrow('AI usage query returned invalid request data');
    },
  );

  it.each([null, {}, { sum: null }, { sum: {} }])('rejects missing costs %j', async (row) => {
    respond(payload([row]));
    await expect(query()).rejects.toThrow('AI usage query returned invalid cost data');
  });

  it.each([-1, '0.000022', null, Number.MAX_VALUE])('rejects invalid cost %j', async (cost) => {
    respond(payload([{ sum: { cost } }]));
    await expect(query()).rejects.toThrow('AI usage query returned invalid cost data');
  });

  it('rejects a nonfinite cost decoded from valid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '{"data":{"viewer":{"accounts":[{"aiGatewayRequests":[{"sum":{"cost":1e400}}]}]}}}',
      ),
    );
    await expect(query()).rejects.toThrow('AI usage query returned invalid cost data');
  });

  it.each([null, { viewer: { accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.000022 } }] }] } }])(
    'rejects HTTP 200 GraphQL errors even alongside data %j',
    async (data) => {
      respond({ data, errors: [{ message: 'not authorized to access aiGatewayRequests' }] });
      await expect(query()).rejects.toThrow(
        'AI usage query failed: not authorized to access aiGatewayRequests',
      );
    },
  );

  it('retains bounded provider messages without echoed queries, credentials, or extensions', async () => {
    respond({
      errors: [
        {
          message: `not authorized ${apiToken}\nBearer unrelated-secret; query { viewer { secretQueryField } }`,
          extensions: { token: 'secret-extension-value', query: 'secret-query-value' },
        },
        { message: `rate limit exceeded ${'detail '.repeat(100)}` },
        { message: 'third error' },
        { message: 'fourth error is omitted' },
      ],
    });

    const error = await query().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('not authorized');
    expect(message).toContain('rate limit exceeded');
    expect(message).toContain('third error');
    expect(message).not.toMatch(/secret|private-cloudflare-token|fourth error|[\r\n]/);
    expect(message.length).toBeLessThan(650);
  });

  it.each([{ message: 'unexpected shape' }, [null], [{ message: 123 }]])(
    'rejects malformed GraphQL errors %j without reporting zero usage',
    async (errors) => {
      respond({ data: { viewer: { accounts: [{ aiGatewayRequests: [] }] } }, errors });
      await expect(query()).rejects.toThrow('AI usage query');
    },
  );

  it.each([null, []])('accepts an error-free response with errors %j', async (errors) => {
    respond({ data: { viewer: { accounts: [{ aiGatewayRequests: [] }] } }, errors });
    await expect(query()).resolves.toEqual({ neurons: 0 });
  });

  it('reports HTTP failures without exposing the response body', async () => {
    respond({ error: apiToken }, 403);
    await expect(query()).rejects.toThrow('AI usage query failed with HTTP 403');
  });

  it('reports invalid JSON without echoing the provider body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`invalid ${apiToken}`));
    await expect(query()).rejects.toThrow('AI usage query returned invalid JSON');
  });
});

describe('queryProjectAiUsage best-effort compatibility', () => {
  it.each([{}, { data: { viewer: { accounts: [] } } }, { errors: [{ message: 'unavailable' }] }])(
    'preserves the default zero fallback for unavailable data %j',
    async (body) => {
      respond(body);
      await expect(query(false)).resolves.toEqual({ neurons: 0 });
    },
  );

  it('preserves usable partial data when GraphQL also reports errors', async () => {
    respond({
      data: { viewer: { accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.000022 } }] }] } },
      errors: [{ message: 'partial result' }],
    });
    await expect(query(false)).resolves.toEqual({ neurons: 2 });
  });

  it('preserves the default zero fallback for HTTP failures', async () => {
    respond({}, 503);
    await expect(query(false)).resolves.toEqual({ neurons: 0 });
  });
});
