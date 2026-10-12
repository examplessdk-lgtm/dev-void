import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import {
  collectInstallationAuthentication,
  selectInstallationAuthentication,
  platformManagementAccessForAuthentication,
} from '../../src/cli/platform-install-auth.ts';
import { createPlatformInstallationSecrets } from '../../src/cli/platform-installer.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';

let directory: string;
const plan = {
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
} as PlatformInstallPlan;
const input = {
  connections: [
    {
      configuration: {
        id: 'google',
        kind: 'google',
        label: 'Company Google',
        clientId: 'google-client',
        allowedDomains: ['example.com'],
      },
      clientSecretEnv: 'TEST_PLATFORM_GOOGLE_SECRET',
    },
  ],
  admission: { mode: 'company', connections: ['google'], access: false },
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'void-install-auth-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('installer login selection', () => {
  it('requests Access management only for setup in the installation account', () => {
    const selection = {
      authentication: {
        providers: ['cloudflare-access'] as const,
        configurable: true as const,
        accessProtection: true as const,
      },
    };
    expect(platformManagementAccessForAuthentication(selection, 'account', null)).toEqual({
      protection: true,
      readOnly: false,
    });
    expect(
      platformManagementAccessForAuthentication(
        {
          ...selection,
          authentication: { providers: ['github'], configurable: true, accessProtection: true },
        },
        'account',
        null,
      ),
    ).toEqual({ protection: true, readOnly: false });
    expect(
      platformManagementAccessForAuthentication(selection, 'account', {
        accessSetupSpecJson: JSON.stringify({ mode: 'existing', accountId: 'other' }),
      }),
    ).toBeUndefined();
    expect(
      platformManagementAccessForAuthentication(selection, 'account', {
        accessSetupSpecJson: JSON.stringify({ mode: 'existing', accountId: 'account' }),
      }),
    ).toEqual({ protection: true, readOnly: true });
    expect(
      platformManagementAccessForAuthentication(
        {
          authentication: { providers: ['cloudflare-access'], configurable: true },
          file: { connections: [{ configuration: { kind: 'cloudflare-access' } }] },
        },
        'account',
        null,
      ),
    ).toBeUndefined();
    expect(
      platformManagementAccessForAuthentication(
        { authentication: { providers: ['github'] } },
        'account',
        null,
      ),
    ).toBeUndefined();
  });
  it('uses planned login and protection choices without interactive selection', async () => {
    expect(
      await selectInstallationAuthentication(undefined, undefined, {
        loginMethods: ['google', 'oidc'],
        accessProtection: true,
      }),
    ).toEqual({
      authentication: { providers: ['google', 'oidc'], configurable: true, accessProtection: true },
    });
    expect(
      await selectInstallationAuthentication(undefined, undefined, {
        loginMethods: ['github'],
        accessProtection: false,
      }),
    ).toEqual({ authentication: { providers: ['github'] } });
    await expect(
      selectInstallationAuthentication(
        undefined,
        { providers: ['github'] },
        { loginMethods: ['google'], accessProtection: false },
      ),
    ).rejects.toThrow('recorded');
    await expect(
      selectInstallationAuthentication(
        undefined,
        { providers: ['github'] },
        { accessProtection: true },
      ),
    ).rejects.toThrow('recorded');
  });
  it('connects Access login in a separate identity account without Cloudflare management calls', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(
      file,
      JSON.stringify({
        connections: [
          {
            configuration: {
              id: 'company-access',
              kind: 'cloudflare-access',
              label: 'Company Access',
              issuer:
                'https://identity.cloudflareaccess.com/cdn-cgi/access/sso/oidc/external-client',
              clientId: 'external-client',
            },
            clientSecretEnv: 'TEST_EXTERNAL_SECRET',
          },
        ],
      }),
    );
    vi.stubEnv('TEST_EXTERNAL_SECRET', 'external-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const request = vi.fn(() => {
      throw new Error('No Cloudflare management calls expected');
    });
    const selection = await selectInstallationAuthentication(file);
    const result = await collectInstallationAuthentication(selection, plan, {}, () => {}, {
      client: { request } as unknown as PlatformCloudflareClient,
      ownershipNonce: 'owned',
      yes: true,
    });
    expect(JSON.parse(result!.authenticationSetupJson).connections[0].configuration.id).toBe(
      'company-access',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('reads a nonsecret plan without requiring provider credentials', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(file, JSON.stringify(input));
    const selection = await selectInstallationAuthentication(file);
    expect(selection.authentication).toEqual({ providers: ['google'], configurable: true });
  });
  it('keeps recorded GitHub-only installation selection unchanged', async () => {
    expect(await selectInstallationAuthentication(undefined, { providers: ['github'] })).toEqual({
      authentication: { providers: ['github'] },
    });
    expect(
      await collectInstallationAuthentication(
        { authentication: { providers: ['github'] } },
        plan,
        {},
        () => {},
      ),
    ).toBeUndefined();
  });
  it('resolves secrets only during credential collection and checkpoints each connection', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(file, JSON.stringify(input));
    vi.stubEnv('TEST_PLATFORM_GOOGLE_SECRET', 'secret-from-environment');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const values: Record<string, string> = {};
    const selection = await selectInstallationAuthentication(file);
    const result = (await collectInstallationAuthentication(selection, plan, values, (update) =>
      Object.assign(values, update),
    ))!;
    const setup = JSON.parse(result.authenticationSetupJson);
    expect(setup.connections[0].clientSecret).toBe('secret-from-environment');
    expect(setup.bootstrapCredentialHash).toBe(
      createHash('sha256').update(result.authBootstrapCode).digest('hex'),
    );
    expect(values['authenticationConnection:google']).toBeTruthy();
    expect(JSON.stringify(output.mock.calls)).not.toContain('secret-from-environment');
    const resumed = await collectInstallationAuthentication(
      { authentication: selection.authentication },
      plan,
      values,
      () => {
        throw new Error('no new checkpoint expected');
      },
    );
    expect(resumed).toEqual(result);
    const secrets = createPlatformInstallationSecrets({
      ...result,
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      githubClientId: '',
      githubClientSecret: '',
      cloudflareApiToken: 'runtime',
      databaseUrl: 'postgresql://user:password@db.example.com/platform',
      jwtSecret: 'j'.repeat(32),
      projectSecretKey: Buffer.alloc(32, 3).toString('base64'),
      r2AccessKeyId: 'r2',
      r2SecretAccessKey: 'r2-secret',
    });
    expect(secrets.githubClientId).toBe('');
    expect(secrets.bootstrapGitHubLogin).toBe('');
    expect(secrets.authSetupToken).toBe(result.authSetupToken);
  });
  it('rejects plaintext credential files and incompatible resume choices', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(
      file,
      JSON.stringify({ connections: [{ ...input.connections[0], clientSecret: 'plaintext' }] }),
    );
    await expect(selectInstallationAuthentication(file)).rejects.toThrow('plaintext');
    await writeFile(file, JSON.stringify(input));
    await expect(selectInstallationAuthentication(file, { providers: ['github'] })).rejects.toThrow(
      'recorded',
    );
  });
});
