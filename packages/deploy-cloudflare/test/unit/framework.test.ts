import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import { parseRootWranglerConfig, writeCloudflareFrameworkDeployConfig } from '../../src/index.ts';

describe('Cloudflare framework deployment', () => {
  it('preserves root state and points Wrangler at the standalone Worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-framework-config-'));
    const configPath = join(root, 'wrangler.jsonc');
    const pointerPath = join(root, '.wrangler/deploy/config.json');
    const assetsDirectory = '.svelte-kit/cloudflare';
    mkdirSync(join(root, assetsDirectory), { recursive: true });
    writeFileSync(join(root, assetsDirectory, '.assetsignore'), '# framework rule\n.keep-out\n');
    writeFileSync(
      configPath,
      `{
  // retain operator context
  "compatibility_flags": ["custom-flag"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "kv_namespaces": [{ "binding": "KV", "id": "abc" }]
}\n`,
    );

    const input = {
      configPath,
      deployPointerPath: pointerPath,
      name: 'my-sveltekit-app',
      accountId: 'account-id',
      main: '.svelte-kit/cloudflare/_worker.js',
      assetsDirectory,
      compatibilityDate: '2026-09-11',
      compatibilityFlags: ['nodejs_als'],
      assetsIgnore: ['_worker.js', '_routes.json'],
      crons: ['0 * * * *'],
    };
    expect(writeCloudflareFrameworkDeployConfig(input)).toBe(true);
    expect(writeCloudflareFrameworkDeployConfig(input)).toBe(false);

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// retain operator context');
    expect(parseRootWranglerConfig(configPath)).toMatchObject({
      name: 'my-sveltekit-app',
      account_id: 'account-id',
      main: '.svelte-kit/cloudflare/_worker.js',
      compatibility_date: '2026-09-11',
      compatibility_flags: ['custom-flag', 'nodejs_als'],
      no_bundle: false,
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
      assets: {
        directory: assetsDirectory,
        binding: 'ASSETS',
        run_worker_first: true,
        not_found_handling: 'none',
      },
      triggers: { crons: ['0 * * * *'] },
    });
    expect(JSON.parse(readFileSync(pointerPath, 'utf-8'))).toEqual({
      configPath: '../../wrangler.jsonc',
      auxiliaryWorkers: [],
    });
    expect(readFileSync(join(root, assetsDirectory, '.assetsignore'), 'utf-8')).toBe(
      '# framework rule\n.keep-out\n_worker.js\n_routes.json\n',
    );
  });

  it('removes stale cron schedules when the current source has none', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-framework-config-'));
    const configPath = join(root, 'wrangler.jsonc');
    const pointerPath = join(root, '.wrangler/deploy/config.json');
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ triggers: { crons: ['0 * * * *'] } }, null, 2) + '\n',
    );

    writeCloudflareFrameworkDeployConfig({
      configPath,
      deployPointerPath: pointerPath,
      name: 'framework-app',
      accountId: 'account-id',
      main: 'dist/worker.js',
      assetsDirectory: 'dist/assets',
      compatibilityDate: '2026-09-11',
      crons: [],
    });

    expect(parseRootWranglerConfig(configPath)).toMatchObject({ triggers: { crons: [] } });
  });
});
