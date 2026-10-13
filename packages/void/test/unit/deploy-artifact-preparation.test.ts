import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployArtifactDigest } from '@void/deploy-core';
import { beforeEach, afterEach, it, expect, vi } from 'vite-plus/test';
import { prepareDeployArtifact } from '../../src/deploy.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-prepared-artifact-'));
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  writeFileSync(
    join(root, 'dist/server/index.js'),
    "export default { fetch() { return new Response('hello') } }",
  );
  writeFileSync(
    join(root, 'dist/server/wrangler.json'),
    JSON.stringify({
      main: 'index.js',
      compatibility_date: '2026-10-08',
      compatibility_flags: ['nodejs_compat'],
    }),
  );
  writeFileSync(join(root, 'dist/client/index.html'), '<h1>Hello</h1>');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Packaging must not contact a provider');
    }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
it('packages real Worker and asset bytes without credentials or provider calls', async () => {
  const result = await prepareDeployArtifact(root);
  expect(Buffer.from(result.artifact.workerFiles!['index.js']!, 'base64').toString()).toContain(
    "new Response('hello')",
  );
  expect(Buffer.from(result.assets['/index.html']!, 'base64').toString()).toBe('<h1>Hello</h1>');
  expect(result.artifact.manifest.assetManifestVersion).toBe(2);
  expect(result.artifact.manifest.bindings).toEqual({});
  expect(result.artifact.assetManifest['/index.html']).toMatchObject({
    blake3: expect.stringMatching(/^[a-f0-9]{32}$/),
    md5: expect.stringMatching(/^[a-f0-9]{32}$/),
    size: 14,
  });
  expect(fetch).not.toHaveBeenCalled();
  const digest = await deployArtifactDigest(result.artifact);
  expect(
    await deployArtifactDigest({
      ...result.artifact,
      workerFiles: { 'index.js': btoa('other executable') },
    }),
  ).not.toBe(digest);
  expect(
    await deployArtifactDigest({
      ...result.artifact,
      manifest: { ...result.artifact.manifest, bindings: { kv: ['KV'] } },
    }),
  ).not.toBe(digest);
});
it('fails when Worker build output is missing', async () => {
  rmSync(join(root, 'dist/server'), { recursive: true });
  await expect(prepareDeployArtifact(root)).rejects.toThrow('Worker output not found');
});
