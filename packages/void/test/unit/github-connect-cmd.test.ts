import { log } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createCodeChallenge } from '../../src/cli/auth.ts';
import {
  PlatformApiError,
  type GithubConnection,
  type GithubInstallation,
  type PlatformClient,
  type ProjectResponse,
} from '../../src/cli/client.ts';
import type { GithubArgs } from '../../src/cli/github-args.ts';
import { runConnect } from '../../src/cli/github-cmd.ts';

// Mock node:child_process so openBrowser (called by awaitBrowserCallback) never
// launches a real browser; the localhost callback is driven directly by fetch.
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

const originalFetch = globalThis.fetch.bind(globalThis);

const projectId = 'proj_test';
const slug = 'my-app';
const installationId = '123456';
const repoFullName = 'octocat/hello-world';

function makeProject(): ProjectResponse {
  return {
    id: projectId,
    user_id: 'user_1',
    slug,
    type: 'void',
    created_at: '2024-01-01T00:00:00Z',
    custom_domain: null,
  };
}

function makeInstallation(): GithubInstallation {
  return {
    id: 'install_1',
    installation_id: installationId,
    account_login: 'octocat',
    account_id: '1',
    account_type: 'Organization',
    repositories: [{ full_name: repoFullName, id: 1 }],
    repository_selection: 'selected',
    status: 'active',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

function makeConnection(overrides: Partial<GithubConnection> = {}): GithubConnection {
  return {
    id: 'conn_1',
    project_id: projectId,
    installation_id: installationId,
    repo_full_name: repoFullName,
    repository_id: '9876',
    branch: 'main',
    build_executor: 'container',
    workflow_path: '.github/workflows/void-deploy.yml',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function authRequired(): PlatformApiError {
  return new PlatformApiError(
    'Failed to connect GitHub repository',
    403,
    JSON.stringify({ error: 'connect_authorization_required' }),
  );
}

const baseArgs: Extract<GithubArgs, { subcommand: 'connect' }> = {
  subcommand: 'connect',
  projectName: slug,
  installationId,
  repo: repoFullName,
  branch: 'main',
};

/**
 * Drive runConnect against a fake client. `getGithubConnectAuthorizeUrl` (the
 * round-trip URL builder) resolves the localhost callback URL the moment the
 * command requests it, so the test can POST back to the callback with whatever
 * query it wants (mirroring the link/join command tests). When `callbackQuery`
 * is omitted the round-trip is never expected to start, so no callback fires.
 */
function driveConnect(opts: {
  connectGithub: ReturnType<typeof vi.fn>;
  getGithubConnectAuthorizeUrl?: ReturnType<typeof vi.fn>;
  callbackQuery?: (callbackUrl: URL) => URL;
  args?: Partial<Extract<GithubArgs, { subcommand: 'connect' }>>;
}): {
  promise: Promise<void>;
  connectGithub: ReturnType<typeof vi.fn>;
  getGithubConnectAuthorizeUrl: ReturnType<typeof vi.fn>;
} {
  let resolveCallback: ((url: URL) => void) | undefined;
  const callbackReady = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const getGithubConnectAuthorizeUrl =
    opts.getGithubConnectAuthorizeUrl ??
    vi.fn(async (redirect: string) => {
      // `redirect` is the localhost callback URL (with the command's state).
      resolveCallback?.(new URL(redirect));
      return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
    });

  const client = {
    listProjects: vi.fn(async () => [makeProject()]),
    listGithubInstallations: vi.fn(async () => [makeInstallation()]),
    connectGithub: opts.connectGithub,
    getGithubConnectAuthorizeUrl,
  } as unknown as PlatformClient;

  const run = runConnect('/project', client, { ...baseArgs, ...opts.args });

  // Fire the simulated browser redirect once the round-trip's callback URL is
  // known. Swallow fetch errors: on the error paths the server is torn down
  // mid-response (process.exit / throw), which can surface as ECONNRESET.
  const fired = opts.callbackQuery
    ? callbackReady.then(async (callbackUrl) => {
        const hit = opts.callbackQuery!(callbackUrl);
        await originalFetch(hit).catch(() => {});
      })
    : Promise.resolve();

  return {
    promise: run.finally(() => fired.catch(() => {})),
    connectGithub: opts.connectGithub,
    getGithubConnectAuthorizeUrl,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let successSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let messageSpy: ReturnType<typeof vi.spyOn>;
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  mockExecFile.mockReset();
  // Force the non-interactive (non-TTY) path so tests never hit clack prompts.
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  messageSpy = vi.spyOn(log, 'message').mockImplementation(() => {});
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
  exitSpy.mockRestore();
  successSpy.mockRestore();
  errorSpy.mockRestore();
  messageSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('runConnect — non-owner member connect-authorization round-trip', () => {
  it('runs the round-trip and retries connect with the grant + verifier on 403 connect_authorization_required', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const connectGithub = vi
      .fn()
      .mockRejectedValueOnce(authRequired())
      .mockResolvedValueOnce(makeConnection());

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({
      connectGithub,
      args: { executor: 'container' },
      callbackQuery: (cb) => {
        const hit = new URL(cb); // already carries the command's state
        hit.searchParams.set('connect_grant', 'grant-xyz');
        return hit;
      },
    });

    await promise;

    // Round-trip was started for the specific installation + repo.
    expect(getGithubConnectAuthorizeUrl).toHaveBeenCalledTimes(1);
    const authorizeArgs = getGithubConnectAuthorizeUrl.mock.calls[0] as [
      string,
      string,
      string,
      string,
    ];
    expect(authorizeArgs[2]).toBe(installationId);
    expect(authorizeArgs[3]).toBe(repoFullName);

    // Two connect attempts: bare first, grant-carrying retry.
    expect(connectGithub).toHaveBeenCalledTimes(2);

    const firstBody = connectGithub.mock.calls[0]![1] as Record<string, unknown>;
    expect(firstBody.connectGrant).toBeUndefined();
    expect(firstBody.codeVerifier).toBeUndefined();

    const retryBody = connectGithub.mock.calls[1]![1] as Record<string, unknown>;
    expect(retryBody).toMatchObject({
      installationId,
      repoFullName,
      branch: 'main',
      buildExecutor: 'container',
      connectGrant: 'grant-xyz',
    });
    expect(typeof retryBody.codeVerifier).toBe('string');
    expect((retryBody.codeVerifier as string).length).toBeGreaterThan(0);

    // The verifier echoed to the retry is the one whose S256 challenge was sent
    // to the authorize URL builder (PKCE binding is intact).
    expect(authorizeArgs[1]).toBe(createCodeChallenge(retryBody.codeVerifier as string));

    expect(successSpy).toHaveBeenCalledWith(
      'Connected octocat/hello-world (main) → project. Push to main to deploy.',
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does NOT run the round-trip for an owner whose first connect succeeds', async () => {
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({ connectGithub });

    await promise;

    expect(connectGithub).toHaveBeenCalledTimes(1);
    const body = connectGithub.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.connectGrant).toBeUndefined();
    expect(getGithubConnectAuthorizeUrl).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith(
      'Connected octocat/hello-world (main) → project. Push to main to deploy.',
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) with the auth-failed message (NOT "no project access") when the retry is rejected with 403', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const connectGithub = vi
      .fn()
      .mockRejectedValueOnce(authRequired())
      .mockRejectedValueOnce(
        new PlatformApiError(
          'Failed to connect GitHub repository',
          403,
          JSON.stringify({ error: 'invalid connect grant' }),
        ),
      );

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({
      connectGithub,
      args: { executor: 'container' },
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('connect_grant', 'grant-stale');
        return hit;
      },
    });

    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(getGithubConnectAuthorizeUrl).toHaveBeenCalledTimes(1);
    expect(connectGithub).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'connect: GitHub authorization failed or expired. Run `void github connect` again.',
    );
    // Must NOT surface the generic 403 mapping.
    expect(errorSpy).not.toHaveBeenCalledWith("connect: You don't have access to this project.");
    expect(successSpy).not.toHaveBeenCalled();
  });

  it('surfaces the friendly per-repo message and attempts no retry when the callback is repo_not_accessible', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const connectGithub = vi.fn().mockRejectedValueOnce(authRequired());

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({
      connectGithub,
      args: { executor: 'container' },
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('error', 'repo_not_accessible');
        return hit;
      },
    });

    await expect(promise).rejects.toThrow(
      "You don't have access to octocat/hello-world under this installation on GitHub.",
    );

    expect(getGithubConnectAuthorizeUrl).toHaveBeenCalledTimes(1);
    // Only the initial attempt ran — no retry after the round-trip failed.
    expect(connectGithub).toHaveBeenCalledTimes(1);
    expect(successSpy).not.toHaveBeenCalled();
  });

  it('maps a non-connect_authorization_required error via describeConnectError and exits (owner-path handling unchanged)', async () => {
    const connectGithub = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformApiError(
          'Failed to connect GitHub repository',
          409,
          JSON.stringify({ error: 'project already connected' }),
        ),
      );

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({ connectGithub });

    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(getGithubConnectAuthorizeUrl).not.toHaveBeenCalled();
    expect(connectGithub).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'connect: This project is already connected to a GitHub repository.',
    );
    expect(successSpy).not.toHaveBeenCalled();
  });

  it('fails closed in non-interactive mode instead of starting the browser round-trip on 403 connect_authorization_required', async () => {
    const connectGithub = vi.fn().mockRejectedValueOnce(authRequired());

    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({ connectGithub });

    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(getGithubConnectAuthorizeUrl).not.toHaveBeenCalled();
    expect(connectGithub).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'connect: this installation requires per-repo authorization, which needs an interactive browser sign-in. Run `void github connect` locally to authorize, then retry.',
    );
    expect(successSpy).not.toHaveBeenCalled();
  });
});
