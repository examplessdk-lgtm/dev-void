import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError, type PlatformClient } from '../../src/cli/client.ts';
import { runGithubLink } from '../../src/cli/github-cmd.ts';

// Mock node:child_process so openBrowser never launches a real browser; the
// localhost callback server is driven directly by fetch in each test.
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

const originalFetch = globalThis.fetch.bind(globalThis);

type FakeClient = Pick<PlatformClient, 'getGithubLinkUrl' | 'completeGithubLink'>;

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
 * Run runGithubLink against a fake client, intercepting the authorize URL the
 * command requests (via the fake getGithubLinkUrl) so the test can POST back to
 * the localhost callback with whatever query it wants.
 *
 * `completeGithubLink` and the callback query are configurable per test.
 */
function drive(opts: {
  completeGithubLink: FakeClient['completeGithubLink'];
  callbackQuery: (callbackUrl: URL) => URL;
}): Promise<void> {
  let resolveCallback!: (url: URL) => void;
  const callbackReady = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const client: FakeClient = {
    getGithubLinkUrl: vi.fn(async (redirect: string) => {
      // `redirect` is the localhost callback URL (with the command's state).
      resolveCallback(new URL(redirect));
      return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
    }),
    completeGithubLink: opts.completeGithubLink,
  };

  const run = runGithubLink(client as unknown as PlatformClient);

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

describe('runGithubLink', () => {
  it('completes the link on a successful callback (status: linked)', async () => {
    const completeGithubLink = vi.fn(async () => ({ status: 'linked' as const }));

    await drive({
      completeGithubLink,
      callbackQuery: (cb) => {
        const hit = new URL(cb); // already carries the command's state
        hit.searchParams.set('link_code', 'lc-123');
        return hit;
      },
    });

    expect(completeGithubLink).toHaveBeenCalledTimes(1);
    expect(completeGithubLink).toHaveBeenCalledWith('lc-123', expect.any(String));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) on a 409 github_identity_conflict', async () => {
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to complete GitHub link',
        409,
        JSON.stringify({ error: 'github_identity_conflict' }),
      );
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-409');
          return hit;
        },
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits(1) with a distinct message on a 409 github_already_linked', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to complete GitHub link',
        409,
        JSON.stringify({ error: 'github_already_linked' }),
      );
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-already');
          return hit;
        },
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The new code maps to the "your account, different GitHub" message —
    // distinct from the other-user github_identity_conflict wording.
    expect(errorSpy).toHaveBeenCalledWith(
      'Your Void account is already linked to a different GitHub account.',
    );
    errorSpy.mockRestore();
  });

  it('throws when the callback returns no link code', async () => {
    const completeGithubLink = vi.fn(async () => ({ status: 'linked' as const }));

    await expect(
      drive({
        completeGithubLink,
        // valid state, but no link_code in the query
        callbackQuery: (cb) => new URL(cb),
      }),
    ).rejects.toThrow('did not return a link code');

    expect(completeGithubLink).not.toHaveBeenCalled();
  });

  it('re-throws non-conflict PlatformApiErrors', async () => {
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError('Failed to complete GitHub link', 500, 'boom');
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-500');
          return hit;
        },
      }),
    ).rejects.toMatchObject({ name: 'PlatformApiError', status: 500 });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
