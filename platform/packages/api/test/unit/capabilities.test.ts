import { describe, expect, it } from 'vite-plus/test';
import adminPlatform from '../../src/admin/routes/platform.tsx';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

describe('platform capabilities', () => {
  it('keeps all hosted Void Cloud capabilities enabled when configuration is absent', () => {
    expect(getPlatformCapabilities({})).toEqual({
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
    });
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });

  it('blocks hosted Worker rollback operations on self-hosted installations', async () => {
    const response = await adminPlatform.request('/', {}, {
      PLATFORM_INSTALLATION_ID: 'company-a1b2c3d4',
    } as never);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      capability: 'hosted-platform-operations',
    });
  });
});
