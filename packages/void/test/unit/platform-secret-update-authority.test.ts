import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationStep,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { assertPlatformWorkerSecretUpdateAuthority } from '../../src/cli/platform-secret-update-authority.ts';

const completeReplacement = {
  CF_API_TOKEN: 'new-cloudflare-token',
  GITHUB_CLIENT_ID: 'new-github-client-id',
  GITHUB_CLIENT_SECRET: 'new-github-client-secret',
  R2_ACCESS_KEY_ID: 'new-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'new-r2-secret-access-key',
};

function manifestWithSteps(steps: ReadonlyArray<Readonly<{ key: string; resultHash: string }>>) {
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-16T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    }),
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  for (const [index, step] of steps.entries()) {
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: `2026-09-16T00:00:0${index + 1}.000Z`,
        ...step,
      },
      `2026-09-16T00:00:0${index + 1}.000Z`,
    );
  }
  return manifest;
}

describe('platform Worker secret update authority', () => {
  it('rejects a partial replacement before a host can supersede an unresolved intent', () => {
    const manifest = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-cutover:1:restored', resultHash: 'restored' },
    ]);

    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: { CF_API_TOKEN: 'partial-replacement' },
        manifest,
      }),
    ).toThrow('owned by another encrypted recovery checkpoint');
  });

  it('allows the matching encrypted intent to resume with a partial explicit override', () => {
    const manifest = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-cutover:1:restored', resultHash: 'restored' },
    ]);

    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: { CF_API_TOKEN: 'retry-override' },
        localIntent: { generation: 1, id: 'intent-a' },
        manifest,
      }),
    ).not.toThrow();
    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: {},
        localIntent: { generation: null, id: 'intent-a' },
        manifest,
      }),
    ).not.toThrow();
  });

  it('allows a complete replacement from another host', () => {
    const manifest = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-cutover:1:restored', resultHash: 'restored' },
    ]);

    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: completeReplacement,
        manifest,
      }),
    ).not.toThrow();
  });

  it('requires a complete replacement for an orphaned intent behind a newer cutover', () => {
    const manifest = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-cutover:1:restored', resultHash: 'restored' },
      { key: 'worker-cutover:2:committed', resultHash: 'committed' },
    ]);

    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: {},
        localIntent: { generation: 1, id: 'intent-a' },
        manifest,
      }),
    ).toThrow('owned by another encrypted recovery checkpoint');
    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({
        explicitUpdates: completeReplacement,
        localIntent: { generation: 1, id: 'intent-a' },
        manifest,
      }),
    ).not.toThrow();
  });

  it('ignores an intent that was committed or superseded by a later committed intent', () => {
    const committed = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-secret-updates:1:committed', resultHash: 'intent-a' },
    ]);
    const superseded = manifestWithSteps([
      { key: 'worker-secret-updates:1:pending', resultHash: 'intent-a' },
      { key: 'worker-secret-updates:2:pending', resultHash: 'intent-b' },
      { key: 'worker-secret-updates:2:committed', resultHash: 'intent-b' },
    ]);

    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({ explicitUpdates: {}, manifest: committed }),
    ).not.toThrow();
    expect(() =>
      assertPlatformWorkerSecretUpdateAuthority({ explicitUpdates: {}, manifest: superseded }),
    ).not.toThrow();
  });
});
