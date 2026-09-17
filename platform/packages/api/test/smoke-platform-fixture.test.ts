import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { prepareKitchenSinkPlatformFixture } from '../../../scripts/kitchen-sink-platform-fixture.ts';

describe('hosted kitchen-sink smoke fixture', () => {
  let fixture: ReturnType<typeof prepareKitchenSinkPlatformFixture>;

  beforeAll(() => {
    fixture = prepareKitchenSinkPlatformFixture();
  });

  afterAll(() => fixture?.cleanup());

  it('preserves the native Sandbox example while removing its hosted routes and links', () => {
    for (const path of ['routes/api/sandbox.ts', 'pages/sandbox.vue', 'pages/sandbox.server.ts']) {
      expect(existsSync(resolve(fixture.root, path))).toBe(false);
      expect(
        existsSync(resolve(import.meta.dirname, '../../../../playground/kitchen-sink', path)),
      ).toBe(true);
    }
    for (const path of ['pages/layout.vue', 'pages/index.vue']) {
      expect(readFileSync(resolve(fixture.root, path), 'utf8')).not.toContain('href="/sandbox"');
    }
  });

  it('builds the hosted app with its supported bindings and no Sandbox container', () => {
    const build = spawn.sync('vp', ['build'], {
      cwd: fixture.root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const config = JSON.parse(
      readFileSync(resolve(fixture.root, 'dist/ssr/wrangler.json'), 'utf8'),
    );
    expect(config.containers ?? []).toEqual([]);
    expect(config.durable_objects?.bindings ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'SANDBOX' }),
    );
    expect(config.d1_databases).toContainEqual(expect.objectContaining({ binding: 'DB' }));
    expect(config.kv_namespaces).toContainEqual(expect.objectContaining({ binding: 'KV' }));
    expect(config.r2_buckets).toContainEqual(expect.objectContaining({ binding: 'STORAGE' }));
    expect(config.ai).toEqual({ binding: 'AI' });
    expect(config.queues.producers.length).toBeGreaterThan(0);
  }, 120_000);
});
