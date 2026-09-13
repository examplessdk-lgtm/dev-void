import { describe, expect, it } from 'vite-plus/test';
import {
  DEPLOY_ARTIFACT_VERSION,
  createDeployArtifact,
  createDeployUploadPayload,
  type DeployManifest,
} from '../../src/index.ts';

describe('deployment artifacts', () => {
  const manifest: DeployManifest = {
    version: 3,
    type: 'framework',
    framework: 'astro',
    bindings: { kv: ['CACHE'] },
    assetConfig: { not_found_handling: 'none' },
  };

  it('creates one versioned target-neutral artifact', () => {
    const artifact = createDeployArtifact({
      manifest,
      assetManifest: {
        '/index.html': { blake3: 'b3', md5: 'md5', size: 12, hash: 'b3' },
      },
      workerFiles: { 'index.js': 'ZXhwb3J0IGRlZmF1bHQge30=' },
    });

    expect(artifact).toEqual({
      artifactVersion: DEPLOY_ARTIFACT_VERSION,
      manifest,
      assetManifest: {
        '/index.html': { blake3: 'b3', md5: 'md5', size: 12, hash: 'b3' },
      },
      workerFiles: { 'index.js': 'ZXhwb3J0IGRlZmF1bHQge30=' },
    });
  });

  it('keeps target metadata outside the artifact and preserves the hosted wire shape', () => {
    const artifact = createDeployArtifact({ manifest, assetManifest: {} });
    const payload = createDeployUploadPayload(artifact, {
      source: 'cli',
      commit: 'abc123',
      repositoryUrl: null,
      commitUrl: null,
      gitRef: 'main',
      preflight: null,
    });

    expect(payload).toEqual({
      manifest,
      assetManifest: {},
      source: 'cli',
      commit: 'abc123',
      repositoryUrl: null,
      commitUrl: null,
      gitRef: 'main',
      preflight: null,
    });
    expect(payload).not.toHaveProperty('artifactVersion');
  });
});
