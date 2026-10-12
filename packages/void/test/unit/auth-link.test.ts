import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseAccountArgs } from '../../src/cli/account-args.ts';
const state = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  link: vi.fn(async () => ({ url: 'https://api.example.com/auth/link?id=proof' })),
  who: vi.fn(),
  login: vi.fn(async () => 'fresh-token'),
}));
vi.mock('../../src/cli/auth.ts', () => ({
  getApiUrl: () => 'https://api.example.com',
  getToken: () => 'existing-token',
  openBrowser: state.open,
  runPlatformLogin: state.login,
  savePlatformToken: state.save,
}));
vi.mock('../../src/cli/platform-cmd.ts', () => ({
  discoverPlatform: async () => ({
    apiUrl: 'https://api.example.com',
    authentication: { methods: [] },
  }),
}));
vi.mock('../../src/cli/login.ts', () => ({
  selectPlatformLoginMethod: async (_: unknown, id?: string) => ({
    id: id ?? 'github',
    label: id ?? 'GitHub',
  }),
}));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    whoami = state.who;
    startIdentityLink = state.link;
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({ log: { info: vi.fn() } }));
import { runAuthLink } from '../../src/cli/auth-link.ts';
beforeEach(() => vi.clearAllMocks());
describe('ordinary account linking CLI', () => {
  it('parses explicit or interactive connection selection and rejects extra arguments', () => {
    expect(parseAccountArgs(['link', 'company'])).toEqual({
      subcommand: 'link',
      connectionId: 'company',
    });
    expect(parseAccountArgs(['link'])).toEqual({ subcommand: 'link' });
    expect(() => parseAccountArgs(['link', 'company', 'extra'])).toThrow('Usage');
    expect(() => parseAccountArgs(['link', 'https://evil.example'])).toThrow('Usage');
  });
  it('reauthenticates the original account before opening explicit linking confirmation', async () => {
    state.who.mockResolvedValue({ id: 'user', login: 'existing' });
    await runAuthLink('/app', 'company');
    expect(state.login).toHaveBeenCalledWith(
      'https://api.example.com',
      'github',
      expect.any(Function),
    );
    expect(state.link).toHaveBeenCalledWith('company');
    expect(state.open).toHaveBeenCalledWith('https://api.example.com/auth/link?id=proof');
  });
  it('refuses linking or saving a login into a different account', async () => {
    state.who
      .mockResolvedValueOnce({ id: 'original', login: 'original' })
      .mockResolvedValueOnce({ id: 'different', login: 'different' });
    await expect(runAuthLink('/app', 'company')).rejects.toThrow('different Void account');
    expect(state.save).not.toHaveBeenCalled();
    expect(state.link).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
  });
});
