import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError, type PlatformClient } from '../../src/cli/client.ts';
import { runGithubJoin } from '../../src/cli/github-cmd.ts';

// Mock node:child_process so openBrowser never launches a real browser; the
// localhost callback server is driven directly by fetch in each test.
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

const originalFetch = globalThis.fetch.bind(globalThis);

type FakeClient = Pick<PlatformClient, 'getGithubJoinUrl' | 'completeGithubJoin'>;

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockExecFile.mockReset();
  // process.exit -> throw so we can assert the error-path exit without killing
  // the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.unstubAllGlobals();
});

/**
 * Run runGithubJoin against a fake client, intercepting the authorize URL the
 * command requests (via the fake getGithubJoinUrl) so the test can POST back to
 * the localhost callback with whatever query it wants.
 *
 * `completeGithubJoin` and the callback query are configurable per test.
 */
function drive(opts: {
  completeGithubJoin: FakeClient['completeGithubJoin'];
  callbackQuery: (callbackUrl: URL) => URL;
}): Promise<void> {
  let resolveCallback!: (url: URL) => void;
  const callbackReady = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const client: FakeClient = {
    getGithubJoinUrl: vi.fn(async (redirect: string) => {
      // `redirect` is the localhost callback URL (with the command's state).
      resolveCallback(new URL(redirect));
      return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
    }),
    completeGithubJoin: opts.completeGithubJoin,
  };

  const run = runGithubJoin(client as unknown as PlatformClient);

  // Once the command has built the callback URL, fire the simulated browser
  // redirect back at the localhost server. Swallow fetch errors: on the
  // error paths the server is torn down mid-response (process.exit / throw),
  // which can surface as ECONNRESET on the in-flight request — irrelevant to
  // what we're asserting (the command's outcome).
  const fired = callbackReady.then(async (callbackUrl) => {
    const hit = opts.callbackQuery(callbackUrl);
    await originalFetch(hit).catch(() => {});
  });

  // Settle on the command's outcome, but make sure the fetch is also drained so
  // no dangling promise leaks across tests.
  return run.finally(() => fired.catch(() => {}));
}

describe('runGithubJoin', () => {
  it('completes the join on a successful callback (count > 0, plural)', async () => {
    const successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
    const messageSpy = vi.spyOn(log, 'message').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 2 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb); // already carries the command's state
        hit.searchParams.set('join_code', 'jc-123');
        return hit;
      },
    });

    expect(completeGithubJoin).toHaveBeenCalledTimes(1);
    expect(completeGithubJoin).toHaveBeenCalledWith('jc-123', expect.any(String));
    expect(successSpy).toHaveBeenCalledWith('Joined 2 installations.');
    expect(messageSpy).toHaveBeenCalledWith(
      'Run `void github installations` to see them, then `void github connect`.',
    );
    expect(exitSpy).not.toHaveBeenCalled();

    successSpy.mockRestore();
    messageSpy.mockRestore();
  });

  it('uses the singular form when exactly one installation is joined', async () => {
    const successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 1 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('join_code', 'jc-one');
        return hit;
      },
    });

    expect(successSpy).toHaveBeenCalledWith('Joined 1 installation.');
    expect(exitSpy).not.toHaveBeenCalled();

    successSpy.mockRestore();
  });

  it('reports the no-op path when count === 0', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    const successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 0 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('join_code', 'jc-zero');
        return hit;
      },
    });

    expect(completeGithubJoin).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('No new installations to join.');
    expect(successSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
    successSpy.mockRestore();
  });

  it('throws when the callback returns no join code', async () => {
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 1 }));

    await expect(
      drive({
        completeGithubJoin,
        // valid state, but no join_code in the query
        callbackQuery: (cb) => new URL(cb),
      }),
    ).rejects.toThrow('did not return a join code');

    expect(completeGithubJoin).not.toHaveBeenCalled();
  });

  it('exits(1) with a friendly message when org sharing is not configured (503)', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    // getGithubJoinUrl (buildAuthUrl) rejects fail-closed; awaitBrowserCallback
    // tears down the localhost server and rejects WITHOUT firing a callback, so
    // no simulated browser redirect is needed here.
    const getGithubJoinUrl = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to start GitHub join',
        503,
        JSON.stringify({ error: 'github_oauth_not_configured' }),
      );
    });
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 0 }));
    const client: FakeClient = { getGithubJoinUrl, completeGithubJoin };

    await expect(runGithubJoin(client as unknown as PlatformClient)).rejects.toThrow(
      'process.exit(1)',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Organization installation sharing is not enabled on this Void instance.',
    );
    expect(completeGithubJoin).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('re-throws non-503 PlatformApiErrors', async () => {
    const completeGithubJoin = vi.fn(async () => {
      throw new PlatformApiError('Failed to complete GitHub join', 500, 'boom');
    });

    await expect(
      drive({
        completeGithubJoin,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('join_code', 'jc-500');
          return hit;
        },
      }),
    ).rejects.toMatchObject({ name: 'PlatformApiError', status: 500 });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
