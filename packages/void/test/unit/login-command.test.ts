import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { promptForLoginToken, runLoginCommand } from '../../src/cli/login.ts';
import { pc } from '../../src/cli/output.ts';

const mockWarn = vi.fn();
const mockError = vi.fn();
const mockInfo = vi.fn();
const mockSuccess = vi.fn();
const mockStep = vi.fn();
const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockSpinnerStart = vi.fn();
const mockSpinnerStop = vi.fn();
const mockSpinnerMessage = vi.fn();
const mockSelect = vi.fn();
const mockGetToken = vi.fn();
const mockGetApiUrl = vi.fn();
const mockGetTokenSource = vi.fn();
const mockRemoveToken = vi.fn();
const mockRunPlatformLogin = vi.fn();
const mockSavePlatformToken = vi.fn();
const mockWhoami = vi.fn();
const mockIsExpiredTokenError = vi.fn();
const mockDiscoverPlatform = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  settings: { accessible: false },
  intro: (...args: Array<unknown>) => mockIntro(...args),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  log: {
    warn: (...args: Array<unknown>) => mockWarn(...args),
    error: (...args: Array<unknown>) => mockError(...args),
    info: (...args: Array<unknown>) => mockInfo(...args),
    success: (...args: Array<unknown>) => mockSuccess(...args),
    step: (...args: Array<unknown>) => mockStep(...args),
  },
  spinner: () => ({
    start: (...args: Array<unknown>) => mockSpinnerStart(...args),
    stop: (...args: Array<unknown>) => mockSpinnerStop(...args),
    message: (...args: Array<unknown>) => mockSpinnerMessage(...args),
  }),
  isCI: () => false,
  select: (...args: Array<unknown>) => mockSelect(...args),
  isCancel: () => false,
  cancel: vi.fn(),
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
  getApiUrl: (...args: Array<unknown>) => mockGetApiUrl(...args),
  getTokenSource: (...args: Array<unknown>) => mockGetTokenSource(...args),
  removeToken: (...args: Array<unknown>) => mockRemoveToken(...args),
  runPlatformLogin: (...args: Array<unknown>) => mockRunPlatformLogin(...args),
  savePlatformToken: (...args: Array<unknown>) => mockSavePlatformToken(...args),
  isStagingMode: () => false,
}));

vi.mock('../../src/cli/platform-cmd', () => ({
  discoverPlatform: (...args: Array<unknown>) => mockDiscoverPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    whoami(...args: Array<unknown>) {
      return mockWhoami(...args);
    }
  },
  isExpiredTokenError: (...args: Array<unknown>) => mockIsExpiredTokenError(...args),
}));

beforeEach(() => {
  mockWarn.mockReset();
  mockError.mockReset();
  mockInfo.mockReset();
  mockSuccess.mockReset();
  mockStep.mockReset();
  mockIntro.mockReset();
  mockOutro.mockReset();
  mockSpinnerStart.mockReset();
  mockSpinnerStop.mockReset();
  mockSpinnerMessage.mockReset();
  mockSelect.mockReset();
  mockGetToken.mockReset();
  mockGetApiUrl.mockReset().mockReturnValue('https://api.example.test');
  mockGetTokenSource.mockReset();
  mockRemoveToken.mockReset();
  mockRunPlatformLogin.mockReset().mockResolvedValue('platform-token');
  mockSavePlatformToken.mockReset();
  mockWhoami.mockReset();
  mockIsExpiredTokenError.mockReset();
  mockDiscoverPlatform.mockReset().mockResolvedValue({
    apiUrl: 'https://api.example.test',
    authenticationProviders: ['github'],
  });

  mockGetTokenSource.mockReturnValue('manual');
  mockSelect.mockResolvedValue('github');
  mockRemoveToken.mockReturnValue(true);
  mockIsExpiredTokenError.mockReturnValue(false);
});

describe('runLoginCommand', () => {
  const root = '/project';

  it('logs into the explicit platform with its sole provider and scopes token storage', async () => {
    await promptForLoginToken(root, {
      apiUrl: 'https://company.example.com',
      authenticationProviders: ['github'],
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockRunPlatformLogin).toHaveBeenCalledWith(
      'https://company.example.com',
      'github',
      expect.any(Function),
    );
    expect(mockSavePlatformToken).toHaveBeenCalledWith(
      'platform-token',
      'https://company.example.com',
    );
  });

  it('keeps the logout-first flow when the stored token is still valid', async () => {
    mockGetToken.mockReturnValue('existing-token');
    mockWhoami.mockResolvedValue({ login: 'cpojer', plan: 'pro' });

    await runLoginCommand(root);

    expect(mockWhoami).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith('Already logged in.');
    expect(mockOutro).toHaveBeenCalledWith('To re-login, run `void account logout` first.');
    expect(mockRunPlatformLogin).not.toHaveBeenCalled();
    expect(mockRemoveToken).not.toHaveBeenCalled();
  });

  it('restarts login when the stored token is expired', async () => {
    mockGetToken.mockReturnValue('expired-token');
    mockWhoami.mockRejectedValue(new Error('expired'));
    mockIsExpiredTokenError.mockReturnValue(true);

    await runLoginCommand(root);

    expect(mockRemoveToken).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith('Stored auth token expired. Starting a new login.');
    expect(mockDiscoverPlatform).toHaveBeenCalledWith('https://api.example.test');
    expect(mockRunPlatformLogin).toHaveBeenCalledWith(
      'https://api.example.test',
      'github',
      expect.any(Function),
    );
    expect(mockSavePlatformToken).toHaveBeenCalledWith(
      'platform-token',
      'https://api.example.test',
    );
    expect(mockInfo).toHaveBeenCalledWith('Logged in!');
  });

  it('continues into login when VOID_TOKEN is expired', async () => {
    mockGetToken.mockReturnValue('expired-env-token');
    mockGetTokenSource.mockReturnValue('ci');
    mockWhoami.mockRejectedValue(new Error('expired'));
    mockIsExpiredTokenError.mockReturnValue(true);

    await runLoginCommand(root);

    expect(mockRemoveToken).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '`VOID_TOKEN` is invalid or expired. Continuing with a new login.',
    );
    expect(mockDiscoverPlatform).toHaveBeenCalledWith('https://api.example.test');
    expect(mockRunPlatformLogin).toHaveBeenCalledWith(
      'https://api.example.test',
      'github',
      expect.any(Function),
    );
    expect(mockSavePlatformToken).toHaveBeenCalledWith(
      'platform-token',
      'https://api.example.test',
    );
    expect(mockOutro).toHaveBeenCalledWith(
      `\n${pc.green('✓ Token saved. Unset `VOID_TOKEN` to use it.')}`,
      { withGuide: false },
    );
  });
});
