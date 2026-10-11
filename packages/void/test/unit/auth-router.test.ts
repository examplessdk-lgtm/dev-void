import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseAuthArgs } from '../../src/cli/auth-args.ts';
import { runAuthRouter } from '../../src/cli/auth-router.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { writeDeploymentPlatform } from '../../src/cli/project.ts';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  cloudflare: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../src/cli/account-cmd.ts', () => ({ runAccountCommand: mocks.account }));
vi.mock('../../src/cli/cloudflare-cmd.ts', () => ({ runCloudflareCommand: mocks.cloudflare }));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  select: mocks.select,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockReset();
  root = mkdtempSync(join(tmpdir(), 'void-auth-router-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
  vi.stubEnv('VOID_API_URL', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { force: true, recursive: true });
});

describe('void auth destination routing', () => {
  it('uses the saved Cloudflare destination without prompting', async () => {
    writeDeploymentPlatform(root, 'cloudflare');
    await runAuthRouter(root, parseAuthArgs(['login']), false);
    expect(mocks.cloudflare).toHaveBeenCalledWith(root, { subcommand: 'login' });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('uses the saved Void destination and maps status to whoami', async () => {
    writeDeploymentPlatform(root, 'void');
    await runAuthRouter(root, parseAuthArgs(['status']), false);
    expect(mocks.account).toHaveBeenCalledWith(root, { subcommand: 'whoami' });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('lets an explicit target override a saved destination', async () => {
    writeDeploymentPlatform(root, 'cloudflare');
    await runAuthRouter(root, parseAuthArgs(['logout', '--platform', 'void']), false);
    expect(mocks.account).toHaveBeenCalledWith(root, { subcommand: 'logout' });
    expect(mocks.cloudflare).not.toHaveBeenCalled();
  });

  it('asks for the target when the project has no preference', async () => {
    mocks.select.mockResolvedValue('cloudflare');
    await runAuthRouter(root, parseAuthArgs(['status']), true);
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.cloudflare).toHaveBeenCalledWith(root, { subcommand: 'status' });
  });

  it('uses the selected connected platform only for this invocation', async () => {
    const apiUrl = 'https://platform.example.com';
    savePlatformConnection({
      accountId: null,
      apiUrl,
      applicationDomain: 'apps.example.com',
      displayName: 'Example platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.com',
    });
    mocks.select.mockResolvedValue(apiUrl);
    mocks.account.mockImplementation(() => {
      expect(process.env.VOID_API_URL).toBe(apiUrl);
    });
    await runAuthRouter(root, parseAuthArgs(['login']), true);
    expect(mocks.select.mock.calls[0]?.[0].options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: apiUrl })]),
    );
    expect(process.env.VOID_API_URL).toBeUndefined();
    expect(mocks.account).toHaveBeenCalledWith(root, { subcommand: 'login' });
  });

  it('fails clearly in a non-interactive project without a destination', async () => {
    await expect(runAuthRouter(root, parseAuthArgs(['login']), false)).rejects.toThrow(
      'No deployment destination is saved',
    );
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.cloudflare).not.toHaveBeenCalled();
  });

  it.each(['whoami', 'link', 'token'])('rejects the retired auth %s shortcut', (command) => {
    expect(() => parseAuthArgs([command])).toThrow('void auth <login|status|logout>');
  });

  it('validates explicit targets', () => {
    expect(parseAuthArgs(['login', '--platform', 'cloudflare'])).toEqual({
      subcommand: 'login',
      platform: 'cloudflare',
    });
    expect(() => parseAuthArgs(['login', '--platform', 'other'])).toThrow('--platform');
  });
});
