import { log } from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cloudflareAuthCommandEnvironment,
  cloudflareAuthEnvironment,
  ensureCloudflareAuthentication,
  parseCloudflareAccounts,
} from '../../src/cli/cloudflare-auth.ts';

const SESSION = JSON.stringify({
  loggedIn: true,
  accounts: [{ id: 'account-1', name: 'Example' }],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare authentication', () => {
  it('uses an existing secure session without opening browser login', async () => {
    const runWrangler = vi.fn(() => ({ status: 0, stderr: '', stdout: SESSION }));

    await expect(ensureCloudflareAuthentication({ runWrangler })).resolves.toEqual({
      accounts: [{ id: 'account-1', name: 'Example' }],
    });
    expect(runWrangler).toHaveBeenCalledTimes(1);
  });

  it('signs in with the bundled secure flow and resumes', async () => {
    const loginNotice = vi.spyOn(log, 'info').mockImplementation(() => {});
    const calls: Array<string> = [];
    let whoamiCalls = 0;
    const session = await ensureCloudflareAuthentication({
      interactive: true,
      requireAccounts: true,
      runWrangler: (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'whoami') {
          whoamiCalls++;
          return whoamiCalls === 1
            ? { status: 1, stderr: 'not authenticated', stdout: '' }
            : { status: 0, stderr: '', stdout: SESSION };
        }
        return { status: 0, stderr: '', stdout: '' };
      },
    });

    expect(session.accounts).toEqual([{ id: 'account-1', name: 'Example' }]);
    expect(calls).toEqual([
      'whoami --json',
      'auth keyring enable',
      'login --use-keyring',
      'whoami --json',
    ]);
    expect(loginNotice).toHaveBeenCalledWith(
      'Opening Cloudflare login in your browser. Press Ctrl+C to cancel.',
    );
  });

  it('requires a token or a prior browser session outside a terminal', async () => {
    await expect(
      ensureCloudflareAuthentication({
        interactive: false,
        runWrangler: () => ({ status: 1, stderr: '', stdout: '' }),
      }),
    ).rejects.toThrow('CLOUDFLARE_API_TOKEN');
  });

  it('accepts an explicit API token for a pinned operation without account discovery', async () => {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = 'scoped-token';
    const runWrangler = vi.fn(() => ({ status: 1, stderr: '', stdout: '' }));
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
      parseCloudflareAccounts(
        JSON.stringify({
          loggedIn: true,
          accounts: [{ id: 'one', name: 'One' }, { id: '', name: 'Invalid' }, null],
        }),
      ),
    ).toEqual([{ id: 'one', name: 'One' }]);
    expect(parseCloudflareAccounts('not json')).toBeNull();
  });

  it('forces keyring storage and removes unrelated sensitive values', () => {
    expect(
      cloudflareAuthEnvironment({
        CF_ACCESS_CLIENT_SECRET: 'access',
        DATABASE_URL: 'postgres://secret',
        PATH: '/bin',
        VOID_PLATFORM_RECOVERY_KEY: 'recovery',
      }),
    ).toEqual({
      CLOUDFLARE_AUTH_USE_KEYRING: 'true',
      PATH: '/bin',
      WRANGLER_LOG_SANITIZE: 'true',
    });
  });

  it('suppresses branded login output without suppressing JSON commands', () => {
    expect(cloudflareAuthCommandEnvironment(['login'], {}).WRANGLER_LOG).toBe('none');
    expect(cloudflareAuthCommandEnvironment(['logout'], {}).WRANGLER_LOG).toBe('none');
    expect(cloudflareAuthCommandEnvironment(['whoami', '--json'], {}).WRANGLER_LOG).toBeUndefined();
    expect(
      cloudflareAuthCommandEnvironment(['auth', 'token', '--json'], {}).WRANGLER_LOG,
    ).toBeUndefined();
  });
});
