import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDeploy } from '../../src/cli/deploy.ts';

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

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});
