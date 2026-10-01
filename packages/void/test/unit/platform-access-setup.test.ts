import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  activatePlatformAccessCredentials,
  checkpointPlatformAccessResources,
  parsePlatformAccessSetupSpec,
  platformAccessResourceInventory,
  preparePlatformAccessSetup,
} from '../../src/cli/platform-access-setup.ts';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { platformAccessFixture } from '../fixtures/platform-access.ts';

const plan = {
  account: { id: 'account', name: 'Account' },
  installationId: 'team-installation',
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Access installer setup', () => {
  it('creates and resumes login with the unnamed built-in Cloudflare provider', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = platformAccessFixture();
    env.identityProviders[0] = { id: 'company-idp', type: 'cloudflare', name: '' };
    const checkpoint: Record<string, string> = {};
    const input = {
      plan,
      ownershipNonce: 'owned-installation',
      login: { id: 'access', label: 'Cloudflare Access' },
      protection: false,
      yes: true,
      spec: {
        mode: 'create' as const,
        identityProviderIds: ['company-idp'],
        policyIds: ['employees'],
      },
      client: env.transport as PlatformCloudflareClient,
      checkpoint,
      save: (values: Record<string, string>) => Object.assign(checkpoint, values),
    };
    const result = await preparePlatformAccessSetup(input);
    expect(result?.login?.configuration.kind).toBe('cloudflare-access');
    expect([...env.apps.values()][0]).toMatchObject({
      allowed_idps: ['company-idp'],
      policies: [{ id: 'employees', precedence: 1 }],
    });
    expect(await preparePlatformAccessSetup({ ...input, spec: undefined })).toEqual(result);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(env.tokens.size).toBe(0);
  });
  it('publishes recovered ambiguous resource IDs without replacing deployment configuration', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      authentication: { providers: ['google'], configurable: true },
      capabilities: { githubOAuth: false, googleOAuth: true },
      displayName: 'Team',
      installationSlug: 'team',
    });
    const manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: new Date(0).toISOString(),
      deployment,
      id: plan.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const checkpointed = checkpointPlatformAccessResources(
      manifest,
      JSON.stringify({
        version: 1,
        accountId: 'identity-account',
        installationId: plan.installationId,
        resources: {
          protection: {
            id: 'reconciled-app',
            name: 'Protection',
            fingerprint: 'fingerprint',
            pending: true,
          },
        },
      }),
      '2026-09-18T00:00:00.000Z',
    );
    expect(checkpointed.deployment).toEqual(deployment);
    expect(checkpointed.authenticationResources).toEqual([
      {
        accountId: 'identity-account',
        id: 'reconciled-app',
        key: 'protection',
        kind: 'application',
        name: 'Protection',
        ownership: 'created',
      },
    ]);
  });

  it.each([
    { login: true, protection: false, applications: 1, tokens: 0 },
    { login: false, protection: true, applications: 1, tokens: 1 },
    { login: true, protection: true, applications: 2, tokens: 1 },
    { login: false, protection: false, applications: 0, tokens: 0 },
  ])(
    'provisions only selected capabilities: $login / $protection and resumes without duplicate resources',
    async ({ login, protection, applications, tokens }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubEnv('VOID_ACCESS_CREDENTIALS', '');
      const env = platformAccessFixture();
      const checkpoint: Record<string, string> = {};
      const input = {
        plan,
        ownershipNonce: 'owned-installation',
        ...(login ? { login: { id: 'access', label: 'Company' } } : {}),
        protection,
        yes: true,
        spec: {
          mode: 'create' as const,
          identityProviderIds: ['company-idp'],
          policyIds: ['employees'],
        },
        client: env.transport as PlatformCloudflareClient,
        checkpoint,
        save: (values: Record<string, string>) => Object.assign(checkpoint, values),
      };
      const result = await preparePlatformAccessSetup(input);
      expect(env.apps.size).toBe(applications);
      expect(env.tokens.size).toBe(tokens);
      const resumed = await preparePlatformAccessSetup({ ...input, spec: undefined });
      expect(resumed).toEqual(result);
      expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(
        applications + tokens,
      );
      const resources = platformAccessResourceInventory(
        checkpoint.accessProvisioningJson,
        plan.installationId,
      );
      expect(resources).toHaveLength(applications + tokens);
      expect(JSON.stringify(resources)).not.toContain('secret');
      if (!login && !protection) {
        expect(env.calls).toHaveLength(0);
      }
      if (protection) {
        expect(Object.keys(JSON.parse(process.env.VOID_ACCESS_CREDENTIALS!))).toEqual([
          plan.apiUrl,
          plan.proxyUrl,
        ]);
      }
    },
  );

  it('validates nonsecret Access setup without reading environment credentials', () => {
    expect(
      parsePlatformAccessSetupSpec({ mode: 'existing', loginClientSecretEnv: 'UNSET_SECRET' }),
    ).toEqual({ mode: 'existing', loginClientSecretEnv: 'UNSET_SECRET' });
    for (const value of [
      { mode: 'create', clientSecret: 'plaintext' },
      { mode: 'existing', serviceToken: { id: 'token', clientSecret: 'plaintext' } },
      { mode: 'existing', loginClientSecretEnv: '$(secret)' },
      { mode: 'create', policyIds: ['duplicate', 'duplicate'] },
    ]) {
      expect(() => parsePlatformAccessSetupSpec(value)).toThrow();
    }
  });

  it('rejects recovery credentials for unrelated origins without activating any of them', () => {
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', '{}');
    expect(() =>
      activatePlatformAccessCredentials(
        JSON.stringify({
          [plan.apiUrl]: { CF_ACCESS_CLIENT_ID: 'client', CF_ACCESS_CLIENT_SECRET: 'secret' },
          'https://unrelated.example.com': {
            CF_ACCESS_CLIENT_ID: 'client',
            CF_ACCESS_CLIENT_SECRET: 'secret',
          },
        }),
        [plan.apiUrl, plan.proxyUrl],
      ),
    ).toThrow('scoped');
    expect(process.env.VOID_ACCESS_CREDENTIALS).toBe('{}');
  });
});
