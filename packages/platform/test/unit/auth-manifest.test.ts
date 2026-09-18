import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';

describe('configurable authentication deployment manifests', () => {
  it.each(['google', 'oidc', 'cloudflare-access'] as const)(
    'round-trips %s without enabling GitHub',
    (kind) => {
      const manifest = createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Team',
        installationSlug: 'team',
        authentication: { providers: [kind], configurable: true },
        capabilities: { githubOAuth: false, googleOAuth: kind === 'google' },
      });
      expect(manifest.schemaVersion).toBe(3);
      expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
    },
  );
  it('supports workers.dev with independently selected Access protection', () => {
    const manifest = createPlatformDeploymentManifest({
      application: {
        baseDomain: 'team.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'team', installationId: 'team-12345678' },
      },
      displayName: 'Team',
      installationSlug: 'team',
      authentication: { providers: ['github'], accessProtection: true },
    });
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.authentication.configurable).toBe(true);
    expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
  });
  it('keeps legacy manifests unchanged and rejects stripping the new contract into an old version', () => {
    const legacy = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
    });
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.authentication).toEqual({ providers: ['github'] });
    expect(() =>
      parsePlatformDeploymentManifest({
        ...legacy,
        authentication: { ...legacy.authentication, configurable: true },
      }),
    ).toThrow('schema version 3');
  });
});
