import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intro } from '@voidzero-dev/vite-plus-prompts';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runDeploy } from '../../src/cli/deploy.ts';
import { buildEnv } from '../../src/shared/untrusted-env.ts';

const mockError = vi.fn();
const mockInfo = vi.fn();
const mockStep = vi.fn();
const mockWarn = vi.fn();
const mockSuccess = vi.fn();
const mockGetToken = vi.fn();
const mockGetTokenSource = vi.fn();
const mockGetApiUrl = vi.fn();
const mockProjectLookup = vi.fn();
const mockIsExpiredTokenError = vi.fn();
const mockPromptForLoginToken = vi.fn();
const mockIsOidcAvailable = vi.fn();
const mockExchangeOidc = vi.fn();
const mockMaskSecret = vi.fn();
const mockClientCtor = vi.fn();

const originalIsTTY = process.stdin.isTTY;
let savedVoidToken: string | undefined;
let savedVoidApiUrl: string | undefined;

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  confirm: vi.fn(),
  isCancel: () => false,
  log: {
    error: (...args: Array<unknown>) => mockError(...args),
    info: (...args: Array<unknown>) => mockInfo(...args),
    step: (...args: Array<unknown>) => mockStep(...args),
    warn: (...args: Array<unknown>) => mockWarn(...args),
    success: (...args: Array<unknown>) => mockSuccess(...args),
  },
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
  getTokenSource: (...args: Array<unknown>) => mockGetTokenSource(...args),
  getApiUrl: (...args: Array<unknown>) => mockGetApiUrl(...args),
}));

vi.mock('../../src/cli/github-oidc', () => ({
  isGithubActionsOidcAvailable: (...args: Array<unknown>) => mockIsOidcAvailable(...args),
  exchangeGithubOidcForDeployToken: (...args: Array<unknown>) => mockExchangeOidc(...args),
  maskGithubActionsSecret: (...args: Array<unknown>) => mockMaskSecret(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    constructor(...args: Array<unknown>) {
      mockClientCtor(...args);
    }
    listProjects() {
      throw new Error('deploy unexpectedly loaded the full project list');
    }
    async findProjectBySlug(slug: string) {
      const projects = await mockProjectLookup();
      return projects.find((project: { slug: string }) => project.slug === slug) ?? null;
    }
    async getProject(projectId: string) {
      const projects = await mockProjectLookup();
      return projects.find((project: { id: string }) => project.id === projectId) ?? null;
    }
  },
  isExpiredTokenError: (...args: Array<unknown>) => mockIsExpiredTokenError(...args),
}));

vi.mock('../../src/cli/login', () => ({
  promptForLoginToken: (...args: Array<unknown>) => mockPromptForLoginToken(...args),
}));

beforeEach(() => {
  vi.mocked(intro).mockClear();
  mockError.mockReset();
  mockInfo.mockReset();
  mockStep.mockReset();
  mockWarn.mockReset();
  mockSuccess.mockReset();
  mockGetToken.mockReset();
  mockGetTokenSource.mockReset();
  mockGetApiUrl.mockReset();
  mockProjectLookup.mockReset();
  mockIsExpiredTokenError.mockReset();
  mockPromptForLoginToken.mockReset();
  mockIsOidcAvailable.mockReset();
  mockExchangeOidc.mockReset();
  mockMaskSecret.mockReset();
  mockClientCtor.mockReset();

  mockGetToken.mockReturnValue('token');
  mockGetTokenSource.mockReturnValue('manual');
  mockGetApiUrl.mockReturnValue('https://api.test');
  // Default: not running in GitHub Actions, so the OIDC branch is inert and the
  // existing auth tests are unaffected.
  mockIsOidcAvailable.mockReturnValue(false);
  mockExchangeOidc.mockResolvedValue('minted-token');
  mockProjectLookup.mockRejectedValue(new Error('expired-token'));
  mockIsExpiredTokenError.mockImplementation((error: unknown) => {
    return error instanceof Error && error.message === 'expired-token';
  });
  mockPromptForLoginToken.mockResolvedValue('fresh-token');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  // Isolate process.env.VOID_TOKEN across tests: the OIDC branch now exports
  // the minted token there, so start each test clean and restore afterwards.
  savedVoidToken = process.env.VOID_TOKEN;
  savedVoidApiUrl = process.env.VOID_API_URL;
  delete process.env.VOID_TOKEN;
  delete process.env.VOID_API_URL;
});

describe('runDeploy auth failures', () => {
  it('rejects an unconnected platform before reading credentials or exchanging OIDC tokens', async () => {
    mockGetApiUrl.mockImplementation(() => {
      throw new Error('platform: Run `void connect <url>` first.');
    });
    mockIsOidcAvailable.mockReturnValue(true);
    await expect(
      runDeploy(process.cwd(), { platform: 'void', projectSlug: 'my-app' }),
    ).rejects.toThrow('void connect');
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockExchangeOidc).not.toHaveBeenCalled();
    expect(mockClientCtor).not.toHaveBeenCalled();
  });
  it('shows a re-login instruction for expired local auth tokens in non-interactive mode', async () => {
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      'Auth token expired. Run `void account login` and try again.',
    );
  });

  it('does not print a deployment heading until the managed project is resolved', async () => {
    await expect(
      runDeploy(process.cwd(), { platform: 'void', projectSlug: 'my-app' }),
    ).rejects.toThrow();

    expect(intro).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalledWith('Deployment target: Void');
  });

  it('does not print a deployment heading for an invalid Cloudflare target', async () => {
    await expect(
      runDeploy(process.cwd(), { platform: 'cloudflare', projectSlug: 'my-app' }),
    ).rejects.toThrow('--project is not supported with platform cloudflare');

    expect(intro).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalledWith('Deployment target: Cloudflare');
  });

  it('reauthenticates and retries once for expired local auth tokens in interactive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockProjectLookup
      .mockRejectedValueOnce(new Error('expired-token'))
      .mockRejectedValueOnce(new Error('second failure'));

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      'second failure',
    );

    expect(mockPromptForLoginToken).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith('Auth token expired. Re-authenticating...');
    expect(mockStep).toHaveBeenCalledWith('Re-authenticated. Retrying deploy...');
  });

  it('shows a VOID_TOKEN instruction for expired CI tokens', async () => {
    mockGetTokenSource.mockReturnValue('ci');

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      '`VOID_TOKEN` is invalid or expired. Generate a new token and try again.',
    );
  });
});

describe('runDeploy project access', () => {
  let root: string;
  let savedProject: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'void-deploy-project-access-'));
    savedProject = process.env.VOID_PROJECT;
    delete process.env.VOID_PROJECT;
    // Stop allowed projects at app configuration, before building or uploading.
    // Reader errors must precede this deliberately invalid configuration.
    writeFileSync(join(root, 'void.json'), '{');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedProject === undefined) {
      delete process.env.VOID_PROJECT;
    } else {
      process.env.VOID_PROJECT = savedProject;
    }
  });

  function linkProject(slug = 'my-app'): void {
    mkdirSync(join(root, '.void'));
    writeFileSync(
      join(root, '.void', 'project.json'),
      JSON.stringify({
        projectId: 'proj_1',
        slug,
        platform: 'void',
        platformUrl: 'https://api.test',
      }),
    );
  }

  it.each(['flag', 'environment', 'saved'])(
    'rejects a reader selected by %s before loading app configuration or building',
    async (source) => {
      mockProjectLookup.mockResolvedValue([{ id: 'proj_1', slug: 'my-app', role: 'reader' }]);
      if (source === 'environment') {
        process.env.VOID_PROJECT = 'my-app';
      } else if (source === 'saved') {
        // Linked identity is the project ID, even if the saved slug is outdated.
        linkProject('old-slug');
      }

      await expect(
        runDeploy(root, {
          platform: 'void',
          ...(source === 'flag' ? { projectSlug: 'my-app' } : {}),
        }),
      ).rejects.toThrow(
        'You have reader access to "my-app" and cannot deploy. Ask a project admin or owner to grant collaborator access',
      );

      expect(mockProjectLookup).toHaveBeenCalledOnce();
    },
  );

  it.each(['collaborator', 'admin', 'owner', undefined])(
    'continues to app configuration for an explicit project with role %s',
    async (role) => {
      mockProjectLookup.mockResolvedValue([{ id: 'proj_1', slug: 'my-app', role }]);

      await expect(runDeploy(root, { platform: 'void', projectSlug: 'my-app' })).rejects.toThrow(
        'migrate: Invalid JSON in void.json. Fix it before migrating.',
      );

      expect(mockProjectLookup).toHaveBeenCalledOnce();
    },
  );

  it.each(['collaborator', 'admin', 'owner', undefined])(
    'continues to app configuration for a saved project with role %s',
    async (role) => {
      linkProject();
      mockProjectLookup.mockResolvedValue([{ id: 'proj_1', slug: 'my-app', role }]);

      await expect(runDeploy(root, { platform: 'void' })).rejects.toThrow(
        'migrate: Invalid JSON in void.json. Fix it before migrating.',
      );

      expect(mockProjectLookup).toHaveBeenCalledOnce();
    },
  );

  it('rejects a stale saved project before building, even when another project shares its slug', async () => {
    linkProject();
    mockProjectLookup.mockResolvedValue([{ id: 'proj_2', slug: 'my-app', role: 'owner' }]);

    await expect(runDeploy(root, { platform: 'void' })).rejects.toThrow(
      'The linked project "my-app" is unavailable or you no longer have access.',
    );

    expect(mockProjectLookup).toHaveBeenCalledOnce();
  });

  it('does not fetch Void project roles for a direct Cloudflare deployment', async () => {
    linkProject();

    await expect(
      runDeploy(root, { platform: 'cloudflare', projectSlug: 'my-app' }),
    ).rejects.toThrow('--project is not supported with platform cloudflare');

    expect(mockProjectLookup).not.toHaveBeenCalled();
    expect(mockClientCtor).not.toHaveBeenCalled();
  });
});

describe('runDeploy GitHub Actions OIDC exchange', () => {
  it('exchanges an OIDC token for a deploy token when no VOID_TOKEN and in Actions', async () => {
    mockGetToken.mockReturnValue(null);
    mockIsOidcAvailable.mockReturnValue(true);
    mockExchangeOidc.mockResolvedValue('minted-token');

    // The deploy still fails later (project lookup is mocked to reject), but the
    // OIDC exchange must run first and mint the token the client is built with.
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(mockExchangeOidc).toHaveBeenCalledTimes(1);
    expect(mockExchangeOidc).toHaveBeenCalledWith('https://api.test', 'my-app');
    expect(mockMaskSecret).toHaveBeenCalledWith('minted-token');
  });

  it('prefers OIDC over an AMBIENT saved keychain/file token in Actions (no VOID_TOKEN env)', async () => {
    // Regression guard: on a self-hosted / reused runner a leftover
    // `void account login` credential lives in the keychain/config file, so
    // getToken() returns it — but there is NO explicit VOID_TOKEN env. The
    // deploy MUST still mint a fresh project-scoped OIDC deploy token and use
    // THAT, not the broad long-lived saved token. (Before the fix, getToken was
    // consulted first and the ambient token preempted OIDC entirely.)
    mockGetToken.mockReturnValue('ambient-saved-token');
    mockIsOidcAvailable.mockReturnValue(true);
    mockExchangeOidc.mockResolvedValue('minted-token');

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    // The OIDC exchange ran...
    expect(mockExchangeOidc).toHaveBeenCalledTimes(1);
    expect(mockExchangeOidc).toHaveBeenCalledWith('https://api.test', 'my-app');
    expect(mockMaskSecret).toHaveBeenCalledWith('minted-token');
    // ...the minted token was exported for the build/prerender...
    expect(process.env.VOID_TOKEN).toBe('minted-token');
    // ...and the PlatformClient was built with the MINTED token, NOT the saved one.
    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    expect(mockClientCtor.mock.calls[0][0]).toBe('minted-token');
  });

  it('uses the saved keychain/file token when NOT in Actions (local dev, no exchange)', async () => {
    // Local dev: not in GitHub Actions, no VOID_TOKEN env, but a saved token is
    // present. It must be used directly with no OIDC exchange.
    mockGetToken.mockReturnValue('ambient-saved-token');
    mockIsOidcAvailable.mockReturnValue(false);

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(mockExchangeOidc).not.toHaveBeenCalled();
    expect(mockMaskSecret).not.toHaveBeenCalled();
    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    expect(mockClientCtor.mock.calls[0][0]).toBe('ambient-saved-token');
    // The saved token is never promoted into process.env (still clean here).
    expect(process.env.VOID_TOKEN).toBeUndefined();
  });

  it('binds the minted token to its issuing platform for later credential reads', async () => {
    mockGetToken.mockReturnValue(null);
    mockIsOidcAvailable.mockReturnValue(true);
    mockExchangeOidc.mockResolvedValue('minted-token');

    // The deploy throws later, but any in-process credential read must retain
    // the issuing origin; a saved project must not redirect the minted token.
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(process.env.VOID_TOKEN).toBe('minted-token');
    expect(process.env.VOID_API_URL).toBe('https://api.test');
    expect(mockExchangeOidc).toHaveBeenCalledWith('https://api.test', 'my-app');
  });

  it('does NOT overwrite an explicit VOID_TOKEN in process.env (no mint)', async () => {
    // getToken returns a token (explicit VOID_TOKEN / keychain / file), so the
    // OIDC branch is skipped and the existing process.env.VOID_TOKEN is left
    // untouched — no re-mint, no clobber.
    mockGetToken.mockReturnValue('explicit-token');
    mockIsOidcAvailable.mockReturnValue(true);
    process.env.VOID_TOKEN = 'explicit-env-token';

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(mockExchangeOidc).not.toHaveBeenCalled();
    expect(process.env.VOID_TOKEN).toBe('explicit-env-token');
  });

  it('rejects an explicit token before constructing a client when a custom origin is selected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-deploy-origin-guard-'));
    const registry = join(root, 'registry');
    const savedRegistry = process.env.VOID_PLATFORM_REGISTRY_DIR;
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
      process.env.VOID_TOKEN = 'unbound-production-token';
      const { getToken: realGetToken } =
        await vi.importActual<typeof import('../../src/cli/auth.ts')>('../../src/cli/auth.ts');
      const { savePlatformConnection } = await vi.importActual<
        typeof import('../../src/cli/platform-registry.ts')
      >('../../src/cli/platform-registry.ts');
      savePlatformConnection({
        accountId: null,
        apiUrl: 'https://platform.example.test',
        applicationDomain: 'apps.example.test',
        displayName: 'Company Void',
        installationId: null,
        kind: 'connected',
        proxyUrl: 'https://proxy.example.test',
      });
      mockGetToken.mockImplementation((tokenRoot: string) => realGetToken(tokenRoot));

      await expect(runDeploy(root, { platform: 'void', projectSlug: 'my-app' })).rejects.toThrow(
        'Set VOID_API_URL alongside VOID_TOKEN',
      );

      expect(mockGetToken).toHaveBeenCalledWith(root);
      expect(mockClientCtor).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      if (savedRegistry === undefined) {
        delete process.env.VOID_PLATFORM_REGISTRY_DIR;
      } else {
        process.env.VOID_PLATFORM_REGISTRY_DIR = savedRegistry;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('errors when in Actions but the project is unknown', async () => {
    mockGetToken.mockReturnValue(null);
    mockIsOidcAvailable.mockReturnValue(true);

    const root = mkdtempSync(join(tmpdir(), 'void-oidc-'));
    const savedProject = process.env.VOID_PROJECT;
    delete process.env.VOID_PROJECT;
    try {
      // No --project, no VOID_PROJECT, no .void/project.json → slug is unknown.
      await expect(runDeploy(root)).rejects.toThrow(
        'running in GitHub Actions but the project is unknown',
      );
      expect(mockExchangeOidc).not.toHaveBeenCalled();
    } finally {
      if (savedProject === undefined) {
        delete process.env.VOID_PROJECT;
      } else {
        process.env.VOID_PROJECT = savedProject;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The deploy flow spawns untrusted `vite build` (and other build children) with
// the spawn env. A shared CF Access service token (used only by the CLI's own API
// client, which captures the headers at construction) must NOT survive into those
// children. runDeploy keeps the pair OUT of the child env via `buildEnv()` while
// LEAVING process.env untouched — mutating process.env would break interactive
// expired-token re-auth, which reads the pair after the build step.
describe('runDeploy keeps the CF Access service token in process.env', () => {
  it('does NOT delete CF_ACCESS_CLIENT_ID/SECRET from process.env (re-auth needs them)', async () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    const savedToken = process.env.CF_ACCESS_TOKEN;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';
      process.env.CF_ACCESS_TOKEN = 'jwt-keep-me';

      // Default mocks make project lookup reject with an expired token in non-TTY
      // mode, so runDeploy throws after constructing the client.
      await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

      // The pair is preserved so a later re-auth can still read it.
      expect(process.env.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
      expect(process.env.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
      expect(process.env.CF_ACCESS_TOKEN).toBe('jwt-keep-me');
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore('CF_ACCESS_CLIENT_ID', savedId);
      restore('CF_ACCESS_CLIENT_SECRET', savedSecret);
      restore('CF_ACCESS_TOKEN', savedToken);
    }
  });

  it('exposes the interactive re-auth path to the still-present Access pair', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';

      // Capture the env the re-auth path sees when it runs (after the client was
      // already constructed). cf-access.ts / auth.ts read process.env here, so the
      // pair must still be present.
      let pairAtReauth: { id?: string; secret?: string } | undefined;
      mockPromptForLoginToken.mockImplementationOnce(() => {
        pairAtReauth = {
          id: process.env.CF_ACCESS_CLIENT_ID,
          secret: process.env.CF_ACCESS_CLIENT_SECRET,
        };
        return Promise.resolve('fresh-token');
      });
      // First call expires (triggers re-auth), second fails to end the loop.
      mockProjectLookup
        .mockRejectedValueOnce(new Error('expired-token'))
        .mockRejectedValueOnce(new Error('second failure'));

      await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
        'second failure',
      );

      expect(mockPromptForLoginToken).toHaveBeenCalledTimes(1);
      expect(pairAtReauth).toEqual({ id: 'svc-id.access', secret: 'svc-secret' });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore('CF_ACCESS_CLIENT_ID', savedId);
      restore('CF_ACCESS_CLIENT_SECRET', savedSecret);
    }
  });
});

// The build child env must omit every deploy credential even though process.env
// keeps them. Managed prerender obtains a separate proxy-only token afterward.
describe('buildEnv', () => {
  it('omits Cloudflare and Access credentials while process.env keeps them', () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    const savedToken = process.env.CF_ACCESS_TOKEN;
    const savedCloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
    const savedVoidToken = process.env.VOID_TOKEN;
    const savedDatabaseUrl = process.env.DATABASE_URL;
    const savedActionsOidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const savedActionsOidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';
      process.env.CF_ACCESS_TOKEN = 'access-jwt';
      process.env.CLOUDFLARE_API_TOKEN = 'cloudflare-token';
      process.env.VOID_TOKEN = 'project-token';
      process.env.DATABASE_URL = 'postgresql://production:secret@db.example.com/app';
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://actions.example.com/oidc';
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'actions-oidc-bearer';

      const childEnv = buildEnv({ VOID_DEPLOY_PROJECT_ID: 'proj_1' });

      // Pair scrubbed from the CHILD env...
      expect(childEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(childEnv.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
      expect(childEnv.CF_ACCESS_TOKEN).toBeUndefined();
      expect(childEnv.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(childEnv.VOID_TOKEN).toBeUndefined();
      expect(childEnv.DATABASE_URL).toBeUndefined();
      expect(childEnv.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      expect(childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(childEnv.VOID_DEPLOY_PROJECT_ID).toBe('proj_1');
      // ...and process.env is untouched.
      expect(process.env.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
      expect(process.env.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('actions-oidc-bearer');
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore('CF_ACCESS_CLIENT_ID', savedId);
      restore('CF_ACCESS_CLIENT_SECRET', savedSecret);
      restore('CF_ACCESS_TOKEN', savedToken);
      restore('CLOUDFLARE_API_TOKEN', savedCloudflareToken);
      restore('VOID_TOKEN', savedVoidToken);
      restore('DATABASE_URL', savedDatabaseUrl);
      restore('ACTIONS_ID_TOKEN_REQUEST_URL', savedActionsOidcUrl);
      restore('ACTIONS_ID_TOKEN_REQUEST_TOKEN', savedActionsOidcToken);
    }
  });

  it('scrubs database credentials case-insensitively', () => {
    const childEnv = buildEnv({ DaTaBaSe_Url: 'postgresql://production:secret@db/app' });
    expect(Object.keys(childEnv).some((key) => key.toLowerCase() === 'database_url')).toBe(false);
  });
});

// Build commands are handed to a SHELL (`execSync`), and a user-configured
// `inference.build` names bare binaries (`vitepress build && vite build`) that
// only exist under the project's own node_modules/.bin. Under the build
// container's `npx --yes void deploy` this happens to work — npx prepends every
// ancestor `.bin` itself — so the gap is invisible there and only bites a
// directly invoked `node_modules/.bin/void deploy` or a globally installed
// `void`, where nothing puts the project's bin dir on PATH.
//
// It is an explicit OPT-IN (`{ localBinRoot }`), never the default: prepending
// the project's bin dir makes a dependency-shipped `node_modules/.bin/<name>`
// shadow the system binary of that name for the child. That is exactly what a
// build command wants, and exactly what `getGitCommit`'s `git` children — which
// run BEFORE any build, with `VOID_TOKEN` in env, even in the no-build deploy
// modes (`--dir`, static/spa presets with no build command) — must not get.
describe('buildEnv — local node_modules/.bin on PATH', () => {
  const DELIMITER = process.platform === 'win32' ? ';' : ':';

  /** Read PATH the way a child process would: case-insensitively (Windows: `Path`). */
  function readPath(env: NodeJS.ProcessEnv): string | undefined {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    return key ? env[key] : undefined;
  }

  function withInheritedPath(path: string | undefined, assert: () => void): void {
    const saved = Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'path');
    for (const [key] of saved) {
      delete process.env[key];
    }
    if (path !== undefined) {
      process.env[saved[0]?.[0] ?? 'PATH'] = path;
    }

    try {
      assert();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toLowerCase() === 'path') {
          delete process.env[key];
        }
      }
      for (const [key, value] of saved) {
        process.env[key] = value;
      }
    }
  }

  it('prepends <root>/node_modules/.bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    try {
      const childPath = readPath(buildEnv(undefined, { localBinRoot: root }));
      expect(childPath?.startsWith(toSlash(join(root, 'node_modules', '.bin')) + DELIMITER)).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the inherited PATH after the prepended entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    try {
      withInheritedPath(`/usr/bin${DELIMITER}/bin`, () => {
        const childPath = readPath(buildEnv(undefined, { localBinRoot: root }));
        expect(childPath).toBe(
          `${toSlash(join(root, 'node_modules', '.bin'))}${DELIMITER}/usr/bin${DELIMITER}/bin`,
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the platform PATH delimiter', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    try {
      withInheritedPath('/usr/bin', () => {
        const childPath = readPath(buildEnv(undefined, { localBinRoot: root }));
        const binDir = toSlash(join(root, 'node_modules', '.bin'));
        expect(childPath).toBe(`${binDir}${DELIMITER}/usr/bin`);
        // Guard against the classic `:`-everywhere bug: on Windows a `:` would
        // make the whole variable one unusable entry (`C:\...` already has a `:`).
        expect(DELIMITER).toBe(process.platform === 'win32' ? ';' : ':');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sets PATH to just the bin dir when nothing was inherited', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    try {
      withInheritedPath(undefined, () => {
        expect(readPath(buildEnv(undefined, { localBinRoot: root }))).toBe(
          toSlash(join(root, 'node_modules', '.bin')),
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still scrubs the CF Access pair and still passes extras through', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      const childEnv = buildEnv({ VOID_DEPLOY_PROJECT_ID: 'proj_1' }, { localBinRoot: root });
      expect(childEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(childEnv.VOID_DEPLOY_PROJECT_ID).toBe('proj_1');
      expect(readPath(childEnv)?.startsWith(toSlash(join(root, 'node_modules', '.bin')))).toBe(
        true,
      );
    } finally {
      if (savedId === undefined) {
        delete process.env.CF_ACCESS_CLIENT_ID;
      } else {
        process.env.CF_ACCESS_CLIENT_ID = savedId;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The privileged case must be opt-in. `getGitCommit` and the drizzle-kit
  // spawn call `buildEnv()` with no options, and a dependency that ships
  // `node_modules/.bin/git` must not be able to hijack them — `getGitCommit`
  // runs before the build and, on `void deploy --dir dist` or a static/spa
  // preset with no build command, is the ONLY child the deploy spawns.
  it('leaves PATH untouched when no localBinRoot is given', () => {
    withInheritedPath(`/usr/bin${DELIMITER}/bin`, () => {
      expect(readPath(buildEnv())).toBe(`/usr/bin${DELIMITER}/bin`);
      expect(readPath(buildEnv({ VOID_DEPLOY_PROJECT_ID: 'proj_1' }))).toBe(
        `/usr/bin${DELIMITER}/bin`,
      );
    });
  });

  it('hands the child the parent PATH byte-for-byte when no localBinRoot is given', () => {
    // Deliberately NOT asserting on `process.cwd()/node_modules/.bin`: the test
    // runner itself puts that on PATH, so an absence check there would be
    // vacuous. Identity with the parent is the property that matters.
    expect(readPath(buildEnv())).toBe(readPath(process.env));
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  if (savedVoidToken === undefined) {
    delete process.env.VOID_TOKEN;
  } else {
    process.env.VOID_TOKEN = savedVoidToken;
  }
  if (savedVoidApiUrl === undefined) {
    delete process.env.VOID_API_URL;
  } else {
    process.env.VOID_API_URL = savedVoidApiUrl;
  }
});
