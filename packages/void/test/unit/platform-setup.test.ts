import { createPlatformDeploymentManifest } from '@void/platform';
import { describe, it, expect, vi } from 'vite-plus/test';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import {
  formatPlatformSetupPlan,
  openPlatformSetupPage,
  platformSetupPages,
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
  it('scopes the runtime form to the account and supplies documented permissions with an accurate fallback', () => {
    const pages = platformSetupPages(plan(), false);
    const url = new URL(pages.runtime.url);
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.searchParams.get('to')).toBe('/account/api-tokens');
    expect(url.searchParams.get('name')).toBe('Test & Team Runtime');
    const permissions = JSON.parse(url.searchParams.get('permissionGroupKeys')!);
    expect(permissions).toContainEqual({ key: 'workers_scripts', type: 'edit' });
    expect(
      permissions.some((permission: { key: string }) =>
        ['cache', 'ssl_and_certificates', 'account_api_tokens'].includes(permission.key),
      ),
    ).toBe(false);
    expect(pages.runtime.instructions).toContain(
      'Workers Tail: Read; Hyperdrive: Write; AI Gateway: Edit',
    );
    expect(pages.runtime.instructions).not.toContain('Zone');
    expect(new URL(pages.r2.url).searchParams.get('to')).toBe('/account/r2/api-tokens');
    expect(pages.r2.instructions).toContain('Object Read & Write');
  });
  it('does not advertise a provisional callback as usable', () => {
    const preview = formatPlatformSetupPlan(plan(), false);
    expect(preview).toContain('https://github.com/settings/applications/new');
    expect(preview).not.toContain(plan().apiUrl + '/auth/callback');
    expect(platformSetupPages(plan(), true).github.instructions).toContain(
      plan().apiUrl + '/auth/callback',
    );
  });
  it('includes zone permissions only for an application domain', () => {
    const page = platformSetupPages(plan('example.com'), true).runtime;
    expect(JSON.parse(new URL(page.url).searchParams.get('permissionGroupKeys')!)).toContainEqual({
      key: 'cache',
      type: 'purge',
    });
    expect(page.instructions).toContain('Zone example.com: Cache Purge: Purge');
  });
  it('opens only in interactive mode and retains a manual link if opening fails', () => {
    const open = vi.fn(() => {
      throw new Error('no browser');
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const page = platformSetupPages(plan(), true).r2;
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
