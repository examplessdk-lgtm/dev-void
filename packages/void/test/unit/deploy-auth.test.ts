import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildEnv, runDeploy } from '../../src/cli/deploy.ts';

const mockError = vi.fn();
const mockInfo = vi.fn();
const mockStep = vi.fn();
const mockWarn = vi.fn();
const mockSuccess = vi.fn();
const mockGetToken = vi.fn();
const mockGetTokenSource = vi.fn();
const mockGetApiUrl = vi.fn();
const mockListProjects = vi.fn();
const mockIsExpiredTokenError = vi.fn();
const mockPromptForLoginToken = vi.fn();
const mockIsOidcAvailable = vi.fn();
const mockExchangeOidc = vi.fn();
const mockMaskSecret = vi.fn();
const mockClientCtor = vi.fn();

const originalIsTTY = process.stdin.isTTY;
let savedVoidToken: string | undefined;

vi.mock('@clack/prompts', () => ({
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
    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }
  },
  isExpiredTokenError: (...args: Array<unknown>) => mockIsExpiredTokenError(...args),
}));

vi.mock('../../src/cli/login', () => ({
  promptForLoginToken: (...args: Array<unknown>) => mockPromptForLoginToken(...args),
}));

beforeEach(() => {
  mockError.mockReset();
  mockInfo.mockReset();
  mockStep.mockReset();
  mockWarn.mockReset();
  mockSuccess.mockReset();
  mockGetToken.mockReset();
  mockGetTokenSource.mockReset();
  mockGetApiUrl.mockReset();
  mockListProjects.mockReset();
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
  mockListProjects.mockRejectedValue(new Error('expired-token'));
  mockIsExpiredTokenError.mockImplementation((error: unknown) => {
    return error instanceof Error && error.message === 'expired-token';
  });
  mockPromptForLoginToken.mockResolvedValue('fresh-token');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

  // Isolate process.env.VOID_TOKEN across tests: the OIDC branch now exports
  // the minted token there, so start each test clean and restore afterwards.
  savedVoidToken = process.env.VOID_TOKEN;
  delete process.env.VOID_TOKEN;
});

describe('runDeploy auth failures', () => {
  it('shows a re-login instruction for expired local auth tokens in non-interactive mode', async () => {
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      'Auth token expired. Run `void auth login` and try again.',
    );
  });

  it('reauthenticates and retries once for expired local auth tokens in interactive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockListProjects
      .mockRejectedValueOnce(new Error('expired-token'))
      .mockRejectedValueOnce(new Error('second failure'));

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      'second failure',
    );

    expect(mockPromptForLoginToken).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith('Auth token expired. Re-authenticating...');
    expect(mockSuccess).toHaveBeenCalledWith('Re-authenticated. Retrying deploy...');
  });

  it('shows a VOID_TOKEN instruction for expired CI tokens', async () => {
    mockGetTokenSource.mockReturnValue('ci');

    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow(
      '`VOID_TOKEN` is invalid or expired. Generate a new token and try again.',
    );
  });
});

describe('runDeploy GitHub Actions OIDC exchange', () => {
  it('exchanges an OIDC token for a deploy token when no VOID_TOKEN and in Actions', async () => {
    mockGetToken.mockReturnValue(null);
    mockIsOidcAvailable.mockReturnValue(true);
    mockExchangeOidc.mockResolvedValue('minted-token');

    // The deploy still fails later (listProjects is mocked to reject), but the
    // OIDC exchange must run first and mint the token the client is built with.
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(mockExchangeOidc).toHaveBeenCalledTimes(1);
    expect(mockExchangeOidc).toHaveBeenCalledWith('https://api.test', 'my-app');
    expect(mockMaskSecret).toHaveBeenCalledWith('minted-token');
  });

  it('prefers OIDC over an AMBIENT saved keychain/file token in Actions (no VOID_TOKEN env)', async () => {
    // Regression guard: on a self-hosted / reused runner a leftover
    // `void auth login` credential lives in the keychain/config file, so
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

  it('exports the minted token to process.env.VOID_TOKEN so the build/prerender getToken sees it', async () => {
    mockGetToken.mockReturnValue(null);
    mockIsOidcAvailable.mockReturnValue(true);
    mockExchangeOidc.mockResolvedValue('minted-token');

    // The deploy throws later (listProjects rejects), but the OIDC branch runs
    // first. The minted token must land in process.env.VOID_TOKEN — the
    // downstream `vite build` child (which inherits process.env) and the
    // in-process prerender both re-read it via getToken(), which reads
    // process.env.VOID_TOKEN first. A local variable can't reach either.
    await expect(runDeploy(process.cwd(), { projectSlug: 'my-app' })).rejects.toThrow();

    expect(process.env.VOID_TOKEN).toBe('minted-token');
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

      // Default mocks make listProjects reject with an expired token in non-TTY
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
      mockListProjects
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

// The build child env must omit the CF Access service-token pair even though
// process.env still carries it, so untrusted build code can't read the shared
// staging credential.
describe('buildEnv', () => {
  it('omits CF_ACCESS_CLIENT_ID/SECRET while process.env keeps them', () => {
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    const savedToken = process.env.CF_ACCESS_TOKEN;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      process.env.CF_ACCESS_CLIENT_SECRET = 'svc-secret';
      process.env.CF_ACCESS_TOKEN = 'jwt-keep-me';

      const childEnv = buildEnv({ VOID_DEPLOY_PROJECT_ID: 'proj_1' });

      // Pair scrubbed from the CHILD env...
      expect(childEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(childEnv.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
      // ...the cloudflared JWT (dev path) and extras pass through...
      expect(childEnv.CF_ACCESS_TOKEN).toBe('jwt-keep-me');
      expect(childEnv.VOID_DEPLOY_PROJECT_ID).toBe('proj_1');
      // ...and process.env is untouched.
      expect(process.env.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
      expect(process.env.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
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
});

// Build commands are handed to a SHELL (`execSync`), and a user-configured
// `inference.build` names bare binaries (`vitepress build && vite build`) that
// only exist under the project's own node_modules/.bin. Under the build
// container's `npx --yes void deploy` this happens to work — npx prepends every
// ancestor `.bin` itself — so the gap is invisible there and only bites a
// directly invoked `node_modules/.bin/void deploy` or a globally installed
// `void`, where nothing puts the project's bin dir on PATH.
describe('buildEnv — local node_modules/.bin on PATH', () => {
  const DELIMITER = process.platform === 'win32' ? ';' : ':';

  /** Read PATH the way a child process would: case-insensitively (Windows: `Path`). */
  function readPath(env: NodeJS.ProcessEnv): string | undefined {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    return key ? env[key] : undefined;
  }

  it('prepends <root>/node_modules/.bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    try {
      const childPath = readPath(buildEnv(undefined, root));
      expect(childPath?.startsWith(join(root, 'node_modules', '.bin') + DELIMITER)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the inherited PATH after the prepended entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `/usr/bin${DELIMITER}/bin`;
      const childPath = readPath(buildEnv(undefined, root));
      expect(childPath).toBe(
        `${join(root, 'node_modules', '.bin')}${DELIMITER}/usr/bin${DELIMITER}/bin`,
      );
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the platform PATH delimiter', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin';
      const childPath = readPath(buildEnv(undefined, root));
      const binDir = join(root, 'node_modules', '.bin');
      expect(childPath).toBe(`${binDir}${DELIMITER}/usr/bin`);
      // Guard against the classic `:`-everywhere bug: on Windows a `:` would
      // make the whole variable one unusable entry (`C:\...` already has a `:`).
      expect(DELIMITER).toBe(process.platform === 'win32' ? ';' : ':');
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sets PATH to just the bin dir when nothing was inherited', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    const savedPath = process.env.PATH;
    try {
      delete process.env.PATH;
      expect(readPath(buildEnv(undefined, root))).toBe(join(root, 'node_modules', '.bin'));
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still scrubs the CF Access pair and still passes extras through', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-build-env-'));
    const savedId = process.env.CF_ACCESS_CLIENT_ID;
    try {
      process.env.CF_ACCESS_CLIENT_ID = 'svc-id.access';
      const childEnv = buildEnv({ VOID_DEPLOY_PROJECT_ID: 'proj_1' }, root);
      expect(childEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
      expect(childEnv.VOID_DEPLOY_PROJECT_ID).toBe('proj_1');
      expect(readPath(childEnv)?.startsWith(join(root, 'node_modules', '.bin'))).toBe(true);
    } finally {
      if (savedId === undefined) {
        delete process.env.CF_ACCESS_CLIENT_ID;
      } else {
        process.env.CF_ACCESS_CLIENT_ID = savedId;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the CWD when no root is given', () => {
    expect(readPath(buildEnv())?.startsWith(join(process.cwd(), 'node_modules', '.bin'))).toBe(
      true,
    );
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  if (savedVoidToken === undefined) {
    delete process.env.VOID_TOKEN;
  } else {
    process.env.VOID_TOKEN = savedVoidToken;
  }
});
