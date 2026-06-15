import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildEnv, runDeploy } from '../../src/cli/deploy.ts';

const mockError = vi.fn();
const mockInfo = vi.fn();
const mockStep = vi.fn();
const mockWarn = vi.fn();
const mockSuccess = vi.fn();
const mockGetToken = vi.fn();
const mockGetTokenSource = vi.fn();
const mockListProjects = vi.fn();
const mockIsExpiredTokenError = vi.fn();
const mockPromptForLoginToken = vi.fn();

const originalIsTTY = process.stdin.isTTY;

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
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
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
  mockListProjects.mockReset();
  mockIsExpiredTokenError.mockReset();
  mockPromptForLoginToken.mockReset();

  mockGetToken.mockReturnValue('token');
  mockGetTokenSource.mockReturnValue('manual');
  mockListProjects.mockRejectedValue(new Error('expired-token'));
  mockIsExpiredTokenError.mockImplementation((error: unknown) => {
    return error instanceof Error && error.message === 'expired-token';
  });
  mockPromptForLoginToken.mockResolvedValue('fresh-token');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
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

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});
