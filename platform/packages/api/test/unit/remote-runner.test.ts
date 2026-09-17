import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { queryD1 } from '../../src/migrations/remote-runner.ts';
const ACCOUNT_ID = 'test-account';
const API_TOKEN = 'test-token';
const DATABASE_ID = 'd1-uuid-123';
afterEach(() => vi.unstubAllGlobals());

it('sends the query and parameters to the expected D1 endpoint', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      success: true,
      result: [{ results: [{ name: 'one' }], meta: { changes: 1 } }],
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const result = await queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, {
    sql: 'SELECT ?',
    params: ['one'],
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/d1-uuid-123/query',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT ?', params: ['one'] }),
    }),
  );
  expect(result).toEqual({ results: [{ name: 'one' }], meta: { changes: 1 } });
});

it('rejects a failed statement even when the response envelope succeeds', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        result: [
          { success: true, results: [] },
          { success: false, error: 'tracking failed', results: [] },
        ],
      }),
    ),
  );
  await expect(
    queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1; SELECT 2' }),
  ).rejects.toThrow('tracking failed');
});

describe('queryD1 timeout', () => {
  it('aborts the fetch and throws a timed-out error when the request hangs', async () => {
    // Without a timeout, a hung D1 REST call would hold the
    // migration row lock indefinitely — every subsequent apply/
    // rename/rollback on the same project would pile up on the
    // project's FOR UPDATE row lock. queryD1 must abort the fetch
    // on its own timeout so the transaction unwinds and releases
    // the lock.
    let abortSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          abortSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    vi.stubGlobal('fetch', hangingFetch);

    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(abortSignal?.aborted).toBe(true);
  });

  it('propagates non-abort fetch errors unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow('network unreachable');
  });

  it('clears the timeout on a successful response so no dangling timer fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, errors: [], result: [{ results: [] }] })),
      ),
    );
    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).resolves.toEqual({ results: [], meta: undefined });
  });

  it('aborts and rejects when headers arrive but the body stalls', async () => {
    // `fetch()` resolves on response HEADERS, not the full body. A D1
    // that sends headers and then stalls the chunked body (or sends a
    // truncated stream that never closes) would hang the `response.json()`
    // await forever, holding the row lock and pg pool connection. The
    // abort controller must stay active until AFTER json() completes so
    // abort propagates into the body stream and rejects the parse.
    //
    // The test constructs a Response whose body is a ReadableStream that
    // never emits a byte. When the timer fires, the abort listener
    // errors the stream, which propagates through json() as an
    // AbortError, and queryD1 rethrows it as a timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(
      queryD1(ACCOUNT_ID, API_TOKEN, DATABASE_ID, { sql: 'SELECT 1' }, 50),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});
