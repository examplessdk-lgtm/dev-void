import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cloudflareAuthEnvironment,
  ensureCloudflareAuthentication,
  parseCloudflareAuthSession,
} from '../../src/cli/cloudflare-auth.ts';

const SESSION = {
  loggedIn: true,
  accounts: [{ id: 'account-1', name: 'Example' }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare authentication', () => {
  it('refuses malformed session data even after a successful process exit', async () => {
    const runWrangler = vi.fn(() => ({
      status: 0,
      stdout: '',
      stderr: '',
      data: { loggedIn: true },
    }));
    await expect(
      ensureCloudflareAuthentication({ runWrangler, interactive: false }),
    ).rejects.toThrow('Cloudflare authentication is required');
    expect(runWrangler).toHaveBeenCalledExactlyOnceWith({ type: 'auth.whoami' }, true);
  });
  it('uses an existing cf session without opening browser login', async () => {
    const runWrangler = vi.fn(() => ({ status: 0, stderr: '', stdout: '', data: SESSION }));

    await expect(ensureCloudflareAuthentication({ runWrangler })).resolves.toEqual({
      accounts: [{ id: 'account-1', name: 'Example' }],
    });
    expect(runWrangler).toHaveBeenCalledTimes(1);
  });

  it('signs in with cf and resumes', async () => {
    const calls: Array<string> = [];
    let whoamiCalls = 0;
    const session = await ensureCloudflareAuthentication({
      interactive: true,
      requireAccounts: true,
      runWrangler: (args) => {
        calls.push(args.type);
        if (args.type === 'auth.whoami') {
          whoamiCalls++;
          return whoamiCalls === 1
            ? { status: 1, stderr: 'not authenticated', stdout: '', data: '' }
            : { status: 0, stderr: '', stdout: '', data: SESSION };
        }
        return { status: 0, stderr: '', stdout: '', data: '' };
      },
    });

    expect(session.accounts).toEqual([{ id: 'account-1', name: 'Example' }]);
    expect(calls).toEqual(['auth.whoami', 'auth.login', 'auth.whoami']);
  });

  it('requires a token or a prior browser session outside a terminal', async () => {
    await expect(
      ensureCloudflareAuthentication({
        interactive: false,
        runWrangler: () => ({ status: 1, stderr: '', stdout: '', data: '' }),
      }),
    ).rejects.toThrow('CLOUDFLARE_API_TOKEN');
  });

  it('accepts an explicit API token for a pinned operation without account discovery', async () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = 'scoped-token';
    const runWrangler = vi.fn(() => ({ status: 1, stderr: '', stdout: '', data: '' }));
    try {
      await expect(
        ensureCloudflareAuthentication({ acceptApiToken: true, runWrangler }),
      ).resolves.toEqual({ accounts: [] });
      expect(runWrangler).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = previous;
      }
    }
  });

  it('parses only valid account records', () => {
    expect(
      parseCloudflareAuthSession({
        loggedIn: true,
        accounts: [{ id: 'one', name: 'One' }, { id: '', name: 'Invalid' }, null],
      })?.accounts,
    ).toEqual([{ id: 'one', name: 'One' }]);
    expect(parseCloudflareAuthSession('not json')).toBeNull();
  });

  it('removes unrelated sensitive values from auth commands', () => {
    expect(
      cloudflareAuthEnvironment({
        CF_ACCESS_CLIENT_SECRET: 'access',
        DATABASE_URL: 'postgres://secret',
        PATH: '/bin',
        VOID_PLATFORM_RECOVERY_KEY: 'recovery',
      }),
    ).toEqual({ PATH: '/bin', CLOUDFLARE_AUTH_USE_KEYRING: 'true' });
  });

  it('pins the encrypted cf store over any keyring override spelling', () => {
    expect(
      cloudflareAuthEnvironment({
        PATH: '/bin',
        cloudflare_auth_use_keyring: 'false',
      }),
    ).toEqual({ PATH: '/bin', CLOUDFLARE_AUTH_USE_KEYRING: 'true' });
  });
});
