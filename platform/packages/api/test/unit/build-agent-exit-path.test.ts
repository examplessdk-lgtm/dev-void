import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// `finishBuildLogging` is the seam that makes the container's exit-path ORDERING
// testable.
//
// The exit path must not await `flushLogs()` BEFORE the drain barrier. That push
// has no route to the DO's log sink (BuildManager
// registers no `outboundByHost`/`outbound` handler and the api worker exports no
// `ContainerProxy`, so `@cloudflare/containers` never installs outbound
// interception; the POST leaves for the public internet where the single-label
// `DO_LOG_URL` host is unresolvable). It would deliver nothing while spending
// the DO's LOG_DRAIN_GRACE_SECONDS window — up to 2 x DO_POST_TIMEOUT_MS, since the
// exit call JOINS an in-flight interval flush and then drains one more batch. A
// grace miss inside the barrier makes `enforceTimeout` overwrite an already-live,
// successful deploy with 'build timed out'.
//
// DO_LOG_URL is captured into a const at module load (and deleted from
// process.env), and postToDo no-ops on an empty URL, so it must be set BEFORE the
// agent module is imported. Per-file module isolation keeps this instance separate
// from other suites'.
describe('build-agent exit path (finishBuildLogging)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DO_LOG_URL;
  });

  it('does not spend the drain grace on a push that has no route to the DO', async () => {
    process.env.DO_LOG_URL = 'http://test-do/logs';

    // Any POST hangs forever — the shape of a black-holed DO. If the exit path
    // flushes, it cannot return.
    const seen: Array<string> = [];
    vi.stubGlobal('fetch', (url: unknown) => {
      seen.push(String(url));
      return new Promise(() => {});
    });

    const { record, finishBuildLogging } = await import('../../container/build-agent.mjs');

    // A pending line, so a flush would have something to send.
    record('[build-agent] void deploy exited with code 0', 'stdout');

    const startedAt = Date.now();
    // If broken: never resolves — the hung POST holds the exit path open,
    // so this hits the test timeout instead of the assertions below.
    await finishBuildLogging(null, { timeoutMs: 50, pollMs: 5 });

    expect(seen).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('runs the drain barrier BEFORE closing the control server', async () => {
    // Ordering, not just presence: closing the server first would tear down the
    // only transport the DO's pull-loop can reach, which is the tail loss the
    // barrier exists to prevent.
    const order: Array<string> = [];
    const { finishBuildLogging } = await import('../../container/build-agent.mjs');

    const server = {
      close(cb: () => void) {
        order.push('close');
        cb();
      },
    };

    await finishBuildLogging(server, {
      timeoutMs: 50,
      pollMs: 5,
      served: () => {
        order.push('drain');
        return 0;
      },
      recorded: () => 0,
    });

    expect(order).toEqual(['drain', 'close']);
  });
});
