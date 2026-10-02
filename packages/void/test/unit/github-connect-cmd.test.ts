import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createCodeChallenge } from '../../src/cli/auth.ts';
import {
  PlatformApiError,
  type GithubConnection,
  type GithubInstallation,
  type PlatformClient,
  type ProjectResponse,
} from '../../src/cli/client.ts';
import * as gitMetadata from '../../src/cli/git-metadata.ts';
import type { GithubArgs } from '../../src/cli/github-args.ts';
import { runConnect } from '../../src/cli/github-cmd.ts';

// Mock node:child_process so openBrowser (called by awaitBrowserCallback) never
// launches a real browser; the localhost callback is driven directly by fetch.
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

// Partial mock of @voidzero-dev/vite-plus-prompts: only `text` is replaced (for the repo
// prompt); everything else — including `log`, which the spies below target —
// passes through from the actual module.
const mockText = vi.fn();
vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return { ...actual, text: (...args: Array<unknown>) => mockText(...args) };
});

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
    role: 'owner',
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
  listGithubInstallations?: ReturnType<typeof vi.fn>;
  getGithubJoinUrl?: ReturnType<typeof vi.fn>;
  completeGithubJoin?: ReturnType<typeof vi.fn>;
  joinCallbackQuery?: (callbackUrl: URL) => URL;
  args?: Partial<Extract<GithubArgs, { subcommand: 'connect' }>>;
}): {
  promise: Promise<void>;
  connectGithub: ReturnType<typeof vi.fn>;
  getGithubConnectAuthorizeUrl: ReturnType<typeof vi.fn>;
  listGithubInstallations: ReturnType<typeof vi.fn>;
  getGithubJoinUrl: ReturnType<typeof vi.fn>;
  completeGithubJoin: ReturnType<typeof vi.fn>;
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

  let resolveJoinCallback: ((url: URL) => void) | undefined;
  const joinCallbackReady = new Promise<URL>((resolve) => {
    resolveJoinCallback = resolve;
  });

  const getGithubJoinUrl =
    opts.getGithubJoinUrl ??
    vi.fn(async (redirect: string) => {
      resolveJoinCallback?.(new URL(redirect));
      return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
    });
  const completeGithubJoin =
    opts.completeGithubJoin ?? vi.fn(async () => ({ status: 'joined', count: 0 }));

  const listGithubInstallations =
    opts.listGithubInstallations ?? vi.fn(async () => [makeInstallation()]);

  const client = {
    listProjects: vi.fn(async () => [makeProject()]),
    listGithubInstallations,
    connectGithub: opts.connectGithub,
    getGithubConnectAuthorizeUrl,
    getGithubJoinUrl,
    completeGithubJoin,
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

  const joinFired = opts.joinCallbackQuery
    ? joinCallbackReady.then(async (callbackUrl) => {
        const hit = opts.joinCallbackQuery!(callbackUrl);
        await originalFetch(hit).catch(() => {});
      })
    : Promise.resolve();

  return {
    promise: run.finally(() => fired.catch(() => {})).finally(() => joinFired.catch(() => {})),
    connectGithub: opts.connectGithub,
    getGithubConnectAuthorizeUrl,
    listGithubInstallations,
    getGithubJoinUrl,
    completeGithubJoin,
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let successSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let messageSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  mockExecFile.mockReset();
  mockText.mockReset();
  // A CI checkout must not supply a default repository for these prompt fixtures.
  vi.stubEnv('GITHUB_REPOSITORY', undefined);
  // Force the non-interactive (non-TTY) path so tests never hit clack prompts.
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  messageSpy = vi.spyOn(log, 'message').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
  exitSpy.mockRestore();
  successSpy.mockRestore();
  errorSpy.mockRestore();
  messageSpy.mockRestore();
  infoSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it('preserves a project permission rejection after GitHub authorization', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const rejection = new PlatformApiError(
      'Failed to connect GitHub repository',
      403,
      JSON.stringify({
        error: 'forbidden',
        message:
          'Changing project settings requires admin or owner access. Ask a project admin to update your access.',
      }),
      'settings',
    );
    const connectGithub = vi
      .fn()
      .mockRejectedValueOnce(authRequired())
      .mockRejectedValueOnce(rejection);
    const { promise, getGithubConnectAuthorizeUrl } = driveConnect({
      connectGithub,
      args: { executor: 'container' },
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('connect_grant', 'fresh-grant');
        return hit;
      },
    });
    await expect(promise).rejects.toBe(rejection);
    expect(rejection.message).toContain('Ask a project admin');
    expect(getGithubConnectAuthorizeUrl).toHaveBeenCalledTimes(1);
    expect(connectGithub).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('GitHub authorization failed or expired'),
    );
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

const joinCallback = (cb: URL) => {
  const hit = new URL(cb); // already carries the command's state
  hit.searchParams.set('join_code', 'jc-1');
  return hit;
};

describe('runConnect — auto-join fallback', () => {
  it('auto-joins and continues when the caller has no installations yet', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi
      .fn()
      .mockResolvedValueOnce([]) // before join
      .mockResolvedValueOnce([makeInstallation()]); // after join
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 1 }));
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise, getGithubJoinUrl } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' },
    });
    await promise;

    expect(getGithubJoinUrl).toHaveBeenCalledTimes(1);
    expect(completeGithubJoin).toHaveBeenCalledWith('jc-1', expect.any(String));
    expect(listGithubInstallations).toHaveBeenCalledTimes(2);
    expect(connectGithub).toHaveBeenCalledTimes(1);
  });

  it('errors with install-first guidance when auto-join finds nothing', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi.fn(async () => []);
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 0 }));
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'No GitHub App installation found for your account or your organizations. Run `void github install` first.',
    );
    expect(listGithubInstallations).toHaveBeenCalledTimes(1); // zero joined → no re-list
    expect(connectGithub).not.toHaveBeenCalled();
  });

  it('falls through to the install-first error when join OAuth is not configured (503)', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi.fn(async () => []);
    const getGithubJoinUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformApiError(
          'Failed to get GitHub join URL',
          503,
          JSON.stringify({ error: 'github_oauth_not_configured' }),
        ),
      );
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      getGithubJoinUrl,
      args: { executor: 'container' },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'No GitHub App installation found for your account or your organizations. Run `void github install` first.',
    );
    // The join-command-only copy must not leak into connect:
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Organization installation sharing is not enabled on this Void instance.',
    );
  });

  it('never starts the join round-trip without a TTY', async () => {
    // beforeEach already forces isTTY = false
    const listGithubInstallations = vi.fn(async () => []);
    const getGithubJoinUrl = vi.fn();
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      getGithubJoinUrl,
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(getGithubJoinUrl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'No active GitHub App installation. Run `void github install` first, or `void github join` if your organization already installed the Void GitHub App.',
    );
  });

  it('recovers a missing --installation id via auto-join', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const other: GithubInstallation = {
      ...makeInstallation(),
      id: 'install_2',
      installation_id: '999999',
      account_login: 'someone-else',
    };
    const listGithubInstallations = vi
      .fn()
      .mockResolvedValueOnce([other]) // target missing
      .mockResolvedValueOnce([other, makeInstallation()]); // joined
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 1 }));
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise, getGithubJoinUrl } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' }, // baseArgs pins installationId = '123456'
    });
    await promise;

    expect(getGithubJoinUrl).toHaveBeenCalledTimes(1);
    expect(listGithubInstallations).toHaveBeenCalledTimes(2);
    expect(connectGithub).toHaveBeenCalledTimes(1);
  });
});

describe('runConnect — member repo prompt (redacted repository list)', () => {
  const memberInstallation = (): GithubInstallation => ({
    ...makeInstallation(),
    repositories: [], // server redacts the list for non-owner (member) rows
    repository_selection: 'selected',
  });

  it('prompts for owner/repo on a TTY instead of dead-ending', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    mockText.mockResolvedValueOnce(repoFullName); // user types octocat/hello-world
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations: vi.fn(async () => [memberInstallation()]),
      args: { executor: 'container', repo: undefined }, // no --repo
    });
    await promise;

    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Repository (owner/repo):' }),
    );
    // The prompt's validate callback rejects anything that isn't owner/repo.
    const textOptions = mockText.mock.calls[0]![0] as {
      validate: (value?: string) => string | undefined;
    };
    expect(textOptions.validate('not-a-repo')).toBe('Enter the repository as owner/repo.');
    expect(textOptions.validate('')).toBe('Enter the repository as owner/repo.');
    expect(textOptions.validate('octocat/hello-world')).toBeUndefined();
    expect(textOptions.validate(' octocat/hello-world ')).toBeUndefined();
    expect(connectGithub).toHaveBeenCalledTimes(1);
    // client.connectGithub(projectId, body) — body.repoFullName carries the typed repo
    const body = connectGithub.mock.calls[0]![1] as { repoFullName: string };
    expect(body.repoFullName).toBe(repoFullName);
  });

  it('accepts inferred repository, branch, and workflow suggestions with Enter', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const metadata = vi.spyOn(gitMetadata, 'collectGitDeployMetadata').mockReturnValue({
      commit: null,
      commitUrl: null,
      gitRef: 'release',
      repositoryUrl: `https://github.com/${repoFullName}`,
    });
    mockText.mockImplementation(async ({ defaultValue }) => defaultValue);
    const connectGithub = vi
      .fn()
      .mockResolvedValueOnce(
        makeConnection({ branch: 'release', build_executor: 'github_actions' }),
      );
    try {
      const { promise } = driveConnect({
        connectGithub,
        listGithubInstallations: vi.fn(async () => [memberInstallation()]),
        args: { executor: 'github_actions', repo: undefined, branch: undefined },
      });
      await promise;

      const repoPrompt = mockText.mock.calls[0]![0];
      expect(repoPrompt.validate('')).toBeUndefined();
      expect(repoPrompt.validate(' ')).toBe('Enter the repository as owner/repo.');
      expect(repoPrompt.validate('another/project')).toBeUndefined();
      for (const [index, suggestion] of [
        [0, repoFullName],
        [1, 'release'],
        [2, '.github/workflows/void-deploy.yml'],
      ] as const) {
        expect(mockText.mock.calls[index]![0]).toMatchObject({
          placeholder: suggestion,
          defaultValue: suggestion,
        });
        expect(mockText.mock.calls[index]![0]).not.toHaveProperty('initialValue');
      }
      expect(connectGithub).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          repoFullName,
          branch: 'release',
          buildExecutor: 'github_actions',
        }),
      );
    } finally {
      metadata.mockRestore();
    }
  });

  it('fails closed without a TTY, naming --repo', async () => {
    const connectGithub = vi.fn();
    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations: vi.fn(async () => [memberInstallation()]),
      args: { repo: undefined },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(
      'connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.',
    );
    expect(mockText).not.toHaveBeenCalled();
  });
});
