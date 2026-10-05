import { stripVTControlCharacters } from 'node:util';
import { createPlatformDeploymentManifest } from '@void/platform';
import { describe, it, expect, vi } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import {
  formatPlatformInstallCommand,
  formatPlatformSetupPlan,
  openPlatformSetupPage,
  platformSetupPages,
  platformManagementSetupPage,
  platformSetupFieldHelp,
} from '../../src/cli/platform-setup.ts';

function plan(domain = ''): PlatformInstallPlan {
  return {
    account: { id: 'account', name: 'Account' },
    apiUrl: 'https://api.account.workers.dev',
    proxyUrl: 'https://proxy.account.workers.dev',
    installationId: 'test-123456abcdef',
    workersSubdomain: 'account',
    zone: null,
    actions: [
      {
        action: 'inspect',
        id: null,
        key: 'ai-gateway',
        kind: 'ai-gateway',
        name: 'gateway',
        reason: 'test',
      },
    ],
    deployment: createPlatformDeploymentManifest({
      installationSlug: 'test',
      displayName: 'Test & Team',
      application: {
        baseDomain: domain || 'account.workers.dev',
        zoneName: domain,
        ...(domain
          ? {}
          : { workersDev: { subdomain: 'account', installationId: 'test-123456abcdef' } }),
      },
    }),
  };
}
describe('platform credential setup links', () => {
  it.each([false, true])(
    'includes Access in the management token only, with protection: %s',
    (protection) => {
      const input = plan();
      const selected = {
        ...input,
        deployment: {
          ...input.deployment,
          authentication: {
            providers: ['cloudflare-access'] as const,
            configurable: true as const,
            ...(protection ? { accessProtection: true as const } : {}),
          },
        },
      };
      const page = platformManagementSetupPage(selected);
      const permissions = JSON.parse(new URL(page.url).searchParams.get('permissionGroupKeys')!);
      expect(permissions).toContainEqual({ key: 'access', type: 'edit' });
      expect(permissions).toContainEqual({ key: 'access_acct', type: 'read' });
      expect(permissions.some(({ key }: { key: string }) => key === 'access_service_token')).toBe(
        protection,
      );
      if (protection) {
        expect(permissions).toContainEqual({ key: 'access_service_token', type: 'edit' });
      }
      expect(
        permissions.some(({ key }: { key: string }) =>
          ['zone', 'dns', 'workers_routes'].includes(key),
        ),
      ).toBe(false);
      expect(page.instructions).toContain('Scope it to Account.');
      const runtime = JSON.parse(
        new URL(platformSetupPages(selected).runtime.url).searchParams.get('permissionGroupKeys')!,
      );
      expect(runtime.some(({ key }: { key: string }) => key.startsWith('access'))).toBe(false);
      const disabled = JSON.parse(
        new URL(platformManagementSetupPage(selected, { access: false }).url).searchParams.get(
          'permissionGroupKeys',
        )!,
      );
      expect(disabled.some(({ key }: { key: string }) => key.startsWith('access'))).toBe(false);
    },
  );

  it('uses read permissions for existing Access applications', () => {
    const permissions = JSON.parse(
      new URL(
        platformManagementSetupPage(plan(), { access: { readOnly: true, protection: true } }).url,
      ).searchParams.get('permissionGroupKeys')!,
    );
    expect(permissions.filter(({ key }: { key: string }) => key.startsWith('access'))).toEqual([
      { key: 'access', type: 'read' },
      { key: 'access_acct', type: 'read' },
      { key: 'access_service_token', type: 'read' },
    ]);
  });
  it('prefills a separate management token with account provisioning and zone permissions', () => {
    const original = plan('example.com');
    const page = platformManagementSetupPage(original);
    const url = new URL(page.url);
    expect(url.searchParams.get('to')).toBe('/account/api-tokens');
    expect(url.searchParams.get('name')).toBe('Test & Team Management');
    const permissions = JSON.parse(url.searchParams.get('permissionGroupKeys')!);
    for (const key of [
      'workers_scripts',
      'workers_kv_storage',
      'workers_r2',
      'd1',
      'queues',
      'query_cache',
      'aig',
      'dns',
      'workers_routes',
    ]) {
      expect(permissions).toContainEqual({ key, type: 'edit' });
    }
    expect(permissions).toContainEqual({ key: 'zone', type: 'read' });
    expect(
      permissions.some(({ key }: { key: string }) => ['cache', 'account_api_tokens'].includes(key)),
    ).toBe(false);
    expect(page.instructions).toBe(
      [
        'This token lets the Void CLI install your platform. Void will now open a pre-configured token creation site. Please review the permissions and then paste the token here.',
        'Scope it to Account.',
        'Change the zone policy from All Domains to Specified Domains → example.com.',
      ].join('\n'),
    );
    const createZone = platformManagementSetupPage({
      ...original,
      actions: [
        {
          kind: 'zone',
          key: 'zone',
          action: 'create',
          id: null,
          name: 'example.com',
          reason: 'test',
        },
      ],
    });
    expect(
      JSON.parse(new URL(createZone.url).searchParams.get('permissionGroupKeys')!),
    ).toContainEqual({ key: 'zone', type: 'edit' });
    expect(createZone.instructions).toContain(
      'Keep the zone policy on All Domains so Void can create example.com.',
    );
    expect(createZone.instructions).not.toContain('Specified Domains');
    const separateApi = platformManagementSetupPage({
      ...original,
      deployment: {
        ...original.deployment,
        controlPlane: { ...original.deployment.controlPlane, apiHostname: 'api.company.net' },
      },
    });
    expect(separateApi.instructions).toContain(
      'Change the zone policy from All Domains to Specified Domains → example.com and the zone for api.company.net.',
    );
    const workersDevApi = platformManagementSetupPage({
      ...plan(),
      deployment: {
        ...plan().deployment,
        controlPlane: { ...plan().deployment.controlPlane, apiHostname: 'api.company.net' },
      },
    });
    expect(workersDevApi.instructions).toContain(
      'Change the zone policy from All Domains to Specified Domains → the zone for api.company.net.',
    );
  });
  it('cannot preselect a zone in the account token link, so it names the dashboard change', () => {
    // Account token template links accept only permissionGroupKeys and name.
    const url = new URL(platformManagementSetupPage(plan('example.com')).url);
    expect([...url.searchParams.keys()]).toEqual(['to', 'name', 'permissionGroupKeys']);
    const runtime = new URL(platformSetupPages(plan('example.com')).runtime.url);
    expect([...runtime.searchParams.keys()]).toEqual(['to', 'name', 'permissionGroupKeys']);
  });

  it('round-trips planned defaults, Hyperdrive, dashboard, and login choices into install arguments', () => {
    const command = formatPlatformInstallCommand({
      commandName: 'void',
      accountId: 'account',
      installationSlug: 'team',
      displayName: 'Team',
      applicationDomain: 'example.com',
      zoneName: 'example.com',
      controlPlaneDomain: '',
      dashboardUrl: 'https://dash.example.com:8443',
      dedicatedZone: false,
      workersDev: false,
      authentication: { providers: ['google', 'oidc'], configurable: true, accessProtection: true },
      hyperdrive: 'drive-id',
      runtime: '',
      yes: false,
    });
    expect(parsePlatformArgs(command.split(' ').slice(2))).toMatchObject({
      noControlPlaneDomain: true,
      dedicatedZoneSpecified: true,
      hyperdrive: 'drive-id',
      loginMethods: ['google', 'oidc'],
      accessProtection: true,
      dashboardUrl: 'https://dash.example.com:8443',
    });
  });
  it('keeps planned domain, authentication, and runtime choices in a copyable command', () => {
    const command = formatPlatformInstallCommand({
      commandName: 'void-dev',
      accountId: 'account',
      installationSlug: 'team',
      displayName: "Team's Platform",
      applicationDomain: 'apps.example.com',
      zoneName: 'example.com',
      controlPlaneDomain: 'api.example.com',
      dedicatedZone: true,
      workersDev: false,
      authConfig: './auth config.json',
      dashboardUrl: 'https://dash.example.com:8443',
      runtime: './build output',
      yes: true,
    });
    const quotedName =
      process.platform === 'win32' ? "'Team''s Platform'" : "'Team'\\''s Platform'";
    expect(command).toBe(
      `void-dev platform install --name team --account account --display-name ${quotedName} --application-domain apps.example.com --zone example.com --dedicated-zone --control-plane-domain api.example.com --auth-config './auth config.json' --dashboard-url https://dash.example.com:8443 --runtime './build output' --yes`,
    );
  });

  it('provides concise database and key guidance with live website links', () => {
    const database = platformSetupFieldHelp('databaseUrl')!;
    expect(database.placeholder).toBe('postgresql://user:pw@…/database');
    expect(database.description).toContain('users, projects, and deployments');
    expect(database.description).toContain('https://neon.com/');
    expect(database.description).toContain(
      'https://void.cloud/guide/platform/installation/prerequisites#platform-database',
    );
    for (const key of ['jwtSecret', 'projectSecretKey']) {
      const help = platformSetupFieldHelp(key)!;
      const description = stripVTControlCharacters(help.description);
      expect(description).toContain('Run openssl rand -base64 32');
      expect(description).toContain(
        'https://void.cloud/guide/platform/installation/credentials#signing-and-encryption-keys',
      );
      expect(description).not.toContain('\n');
    }
    expect(platformSetupFieldHelp('jwtSecret')!.description).toContain(
      'Create a JWT signing key for platform login tokens',
    );
    expect(platformSetupFieldHelp('projectSecretKey')!.description).toContain(
      'Generate a project encryption key for app secrets',
    );
    expect(platformSetupFieldHelp('cloudflareApiToken')).toBeUndefined();
  });
  it('scopes the runtime form to the account and preselects every required permission', () => {
    const pages = platformSetupPages(plan());
    const url = new URL(pages.runtime.url);
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.searchParams.get('to')).toBe('/account/api-tokens');
    expect(url.searchParams.get('name')).toBe('Test & Team Runtime');
    const permissions = JSON.parse(url.searchParams.get('permissionGroupKeys')!);
    expect(permissions).toEqual([
      { key: 'account_settings', type: 'read' },
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_kv_storage', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'd1', type: 'edit' },
      { key: 'queues', type: 'edit' },
      { key: 'account_analytics', type: 'read' },
      { key: 'workers_tail', type: 'read' },
      { key: 'query_cache', type: 'edit' },
      { key: 'aig', type: 'edit' },
    ]);
    expect(
      permissions.some((permission: { key: string }) =>
        ['cache', 'ssl_and_certificates', 'account_api_tokens'].includes(permission.key),
      ),
    ).toBe(false);
    expect(pages.runtime.instructions).toBe(
      'Create a Cloudflare runtime token that Void can use to manage the platform. Please review the permissions and then paste the token here.',
    );
    expect(new URL(pages.r2.url).searchParams.get('to')).toBe('/account/r2/api-tokens/create');
    expect(new URL(pages.r2.url).searchParams.get('type')).toBe('account');
    expect(pages.r2.instructions).toContain('Object Read & Write');
  });
  it('opens R2 creation without claiming unsupported permission prefills', () => {
    const page = platformSetupPages(plan()).r2;
    const url = new URL(page.url);
    expect([...url.searchParams.keys()]).toEqual(['to', 'type']);
    expect(page.instructions).toContain('Select Object Read & Write.');
    expect(page.instructions).toContain('Keep Apply to all buckets in this account selected.');
    expect(page.instructions).not.toMatch(/[();]/);
    expect(page.instructions).toContain('Access Key ID and Secret Access Key');
    expect(page.instructions).not.toContain('Admin Read');
  });
  it('does not request AI Gateway permission when operator auth can manage it', () => {
    const pages = platformSetupPages({ ...plan(), actions: [] });
    const permissions = JSON.parse(
      new URL(pages.runtime.url).searchParams.get('permissionGroupKeys')!,
    );
    expect(permissions).not.toContainEqual({ key: 'aig', type: 'edit' });
    expect(pages.runtime.instructions).not.toContain('AI Gateway');
    expect(permissions).toContainEqual({ key: 'query_cache', type: 'edit' });
    expect(permissions).toContainEqual({ key: 'workers_tail', type: 'read' });
  });
  it('includes the catalog SSL key only when custom hostnames are enabled', () => {
    const original = plan('example.com');
    const custom = {
      ...original,
      deployment: {
        ...original.deployment,
        capabilities: { ...original.deployment.capabilities, customDomains: true },
      },
    };
    const permissions = (input: PlatformInstallPlan) =>
      JSON.parse(
        new URL(platformSetupPages(input).runtime.url).searchParams.get('permissionGroupKeys')!,
      );
    expect(permissions(custom)).toContainEqual({ key: 'ssl_and_certificates', type: 'edit' });
    expect(permissions(original)).not.toContainEqual({ key: 'ssl_and_certificates', type: 'edit' });
  });
  it('requests the email zone and sending permissions only when email is enabled', () => {
    const original = plan('example.com');
    const withEmail = {
      ...original,
      deployment: {
        ...original.deployment,
        capabilities: { ...original.deployment.capabilities, email: true },
      },
    };
    const permissions = (input: PlatformInstallPlan) =>
      JSON.parse(
        new URL(platformSetupPages(input).runtime.url).searchParams.get('permissionGroupKeys')!,
      ) as Array<{ key: string; type: string }>;
    const emailKeys = [
      'zone',
      'zone_settings',
      'email_routing_address',
      'email_routing_rule',
      'email_sending',
    ];
    expect(permissions(withEmail).map((permission) => permission.key)).toEqual(
      expect.arrayContaining(emailKeys),
    );
    expect(permissions(original).some((permission) => emailKeys.includes(permission.key))).toBe(
      false,
    );
    expect(platformSetupPages(original).runtime.instructions).not.toContain(
      'Email Routing Addresses',
    );
    expect(platformSetupPages(original).runtime.instructions).not.toContain('Email Sending');
  });
  it('lists credentials in previews and shows credential links and callbacks during setup', () => {
    const preview = formatPlatformSetupPlan(plan());
    expect(preview).toContain(
      'The installation will guide you through setting up the following credentials:',
    );
    expect(preview).not.toContain('https://');
    expect(preview).not.toContain('/auth/callback');
    expect(platformSetupPages(plan()).github.instructions).toContain(
      plan().apiUrl + '/auth/callback',
    );
    expect(preview).toContain('PostgreSQL database URL');
    expect(preview).toContain('JWT signing key and project encryption key');
    expect(preview).not.toMatch(/paste|copy|Workers Scripts|Object Read|Register a GitHub/);
    expect(preview).not.toMatch(/[();]/);
    expect(preview.split('\n').length).toBeLessThanOrEqual(10);
  });
  it('lists the selected Access credentials and required DNS token concisely', () => {
    const original = plan('example.com');
    const preview = formatPlatformSetupPlan(
      {
        ...original,
        deployment: {
          ...original.deployment,
          authentication: {
            providers: ['cloudflare-access'],
            configurable: true,
            accessProtection: true,
          },
        },
      },
      { managementToken: true },
    );
    expect(preview).toBe(
      [
        'The installation will guide you through setting up the following credentials:',
        '',
        '• Cloudflare management API token for DNS changes',
        '• PostgreSQL database URL',
        '• Cloudflare runtime token',
        '• R2 upload token',
        '• Cloudflare Access OIDC client ID and secret',
        '• Cloudflare Access application and installer credentials',
        '• JWT signing key and project encryption key',
      ].join('\n'),
    );
    expect(formatPlatformSetupPlan(plan())).not.toContain('management API token');
    expect(formatPlatformSetupPlan(plan())).not.toContain('Access application');
  });
  it('includes zone permissions only for an application domain', () => {
    const page = platformSetupPages(plan('example.com')).runtime;
    expect(JSON.parse(new URL(page.url).searchParams.get('permissionGroupKeys')!)).toContainEqual({
      key: 'cache',
      type: 'purge',
    });
    expect(page.instructions).toBe(
      [
        'Create a Cloudflare runtime token that Void can use to manage the platform. Please review the permissions and then paste the token here.',
        'Change the zone policy from All Domains to Specified Domains → example.com.',
      ].join('\n'),
    );
    const original = plan('example.com');
    const withEmail = platformSetupPages({
      ...original,
      deployment: {
        ...original.deployment,
        capabilities: { ...original.deployment.capabilities, email: true },
      },
    }).runtime;
    expect(withEmail.instructions).toContain(
      'Change the zone policy from All Domains to Specified Domains → example.com and every zone that will carry mail.',
    );
  });
  it('keeps the runtime token on All Domains when Void creates the zone', () => {
    // The zone does not exist yet, so Specified Domains cannot select it.
    const page = platformSetupPages({
      ...plan('example.com'),
      actions: [
        {
          kind: 'zone',
          key: 'zone',
          action: 'create',
          id: null,
          name: 'example.com',
          reason: 'test',
        },
      ],
    }).runtime;
    expect(page.instructions).toBe(
      [
        'Create a Cloudflare runtime token that Void can use to manage the platform. Please review the permissions and then paste the token here.',
        'Keep the zone policy on All Domains so the token can purge cache on example.com after Void creates it.',
      ].join('\n'),
    );
  });
  it('opens only in interactive mode and retains a manual link if opening fails', () => {
    const open = vi.fn(() => {
      throw new Error('no browser');
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const page = platformSetupPages(plan()).r2;
      openPlatformSetupPage(page, { interactive: false, open });
      expect(open).not.toHaveBeenCalled();
      expect(() => openPlatformSetupPage(page, { interactive: true, open })).not.toThrow();
      expect(open).toHaveBeenCalledWith(page.url);
      expect(output).toHaveBeenCalledWith(expect.stringContaining(page.url));
    } finally {
      output.mockRestore();
    }
  });
});
