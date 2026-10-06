import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// flushLogs runs on a fire-and-forget setInterval. A naive `await postToDo()`
// against a slow/hung DO would let every 500ms tick start ANOTHER POST, each
// retaining its (bounded) batch + JSON body in an unresolved promise — so the
// in-flight bodies accumulate without bound and move the OOM into the network
// layer (logBuffer/pendingLines/stderr are already capped). flushLogs is
// single-flight: concurrent callers JOIN the in-flight promise instead of starting
// a parallel POST, so at most ONE POST is ever in flight.
//
// DO_LOG_URL is captured into a const at module load (and deleted from
// process.env), and postToDo no-ops on an empty URL, so the URL must be set BEFORE
// the agent module is imported. This file imports it dynamically after setting the
// env; per-file module isolation keeps that separate from other suites' instances.
describe('build-agent flushLogs single-flight (in-flight POST bounding)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DO_LOG_URL;
  });

  it('joins the in-flight POST instead of starting a parallel one while it hangs', async () => {
    process.env.DO_LOG_URL = 'http://test-do/logs';

    // First POST hangs (slow/hung DO); record each fetch so we can prove a second
    // flush does NOT open a second concurrent POST.
    const resolvers: Array<(value: unknown) => void> = [];
    vi.stubGlobal('fetch', () => {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });

    const { record, flushLogs } = await import('../../container/build-agent.mjs');

    record('line-1', 'stdout');
    const p1 = flushLogs(); // starts the drain loop → POST #1 (hangs)
    record('line-2', 'stdout');
    const p2 = flushLogs(); // single-flight: must JOIN p1, not open POST #2

    // If broken: a fire-and-forget flush opens a second POST here, so
    // resolvers.length === 2 and p2 !== p1.
    expect(resolvers.length).toBe(1);
    expect(p2).toBe(p1);

    // Drain cleanly: switch to immediate-resolve, release the hung POST; the loop
    // then flushes line-2 via the immediate mock and resolves p1.
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true }));
    resolvers[0]({ ok: true });
    await p1;
  });
});
