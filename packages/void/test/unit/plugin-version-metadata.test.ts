import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../../src/shared/env.ts';
import {
  CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  DEFAULT_VERSION_METADATA_BINDING,
} from '../../src/shared/version-metadata.ts';

type Config = { config: (resolved: Record<string, unknown>) => Record<string, unknown> };
vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare(config: Config): Array<Plugin> {
    return [{ name: 'mock:cloudflare', api: { config } }];
  },
}));
vi.mock('../../src/cli/auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => null,
}));

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function generate(resolved: Record<string, unknown>, command: 'build' | 'serve' = 'build') {
  const root = mkdtempSync(join(tmpdir(), 'void-version-binding-'));
  roots.push(root);
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-09-11' } }),
  );
  writeFileSync(join(root, 'routes/index.ts'), 'export const GET = () => ({ ok: true });');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();
  const hook = plugins.find((plugin) => plugin.name === 'void:env')?.config;
  const configure = typeof hook === 'function' ? hook : hook?.handler;
  if (!configure) {
    throw new Error('Void environment hook missing');
  }
  (configure as (config: UserConfig, environment: ConfigEnv) => void)(
    {},
    { command, mode: command === 'build' ? 'production' : 'development' },
  );
  const cloudflare = plugins.find((plugin) => plugin.name === 'mock:cloudflare');
  if (!cloudflare) {
    throw new Error('Cloudflare configuration callback missing');
  }
  const patch = (cloudflare.api as { config: Config }).config.config(resolved);
  const routingHook = plugins.find((plugin) => plugin.name === 'void:routing')?.buildStart;
  const buildStart = typeof routingHook === 'function' ? routingHook : routingHook?.handler;
  if (!buildStart) {
    throw new Error('Void routing hook missing');
  }
  await (buildStart as () => Promise<void>)();
  return { patch, entry: readFileSync(join(root, '.void/entry.ts'), 'utf8') };
}

describe('native metadata configuration and generated runtime', () => {
  it('adds Free-compatible self-metadata and threads its name to readiness without paid bindings', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    const providerFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected provider probe'));
    const { patch, entry } = await generate({});
    expect(patch.version_metadata).toEqual({ binding: DEFAULT_VERSION_METADATA_BINDING });
    expect(entry).toContain(`versionId: env["${DEFAULT_VERSION_METADATA_BINDING}"]?.id`);
    expect(patch.containers).toBeUndefined();
    expect(patch.ai).toBeUndefined();
    expect(patch.hyperdrive).toBeUndefined();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('preserves an authored name in the binding and generated handler', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    const resolved = { version_metadata: { binding: 'AUTHORED_VERSION' } };
    const { patch, entry } = await generate(resolved);
    expect(patch.version_metadata).toBeUndefined();
    expect(resolved.version_metadata).toEqual({ binding: 'AUTHORED_VERSION' });
    expect(entry).toContain('versionId: env["AUTHORED_VERSION"]?.id');
  });

  it('leaves handoff bindings and its legacy runtime unchanged when no metadata exists', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    vi.stubEnv(CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV, '1');
    const { patch, entry } = await generate({});
    expect(patch.version_metadata).toBeUndefined();
    expect(entry).not.toContain('versionId: env[');
  });

  it.each(['build', 'serve'] as const)(
    'does not inject metadata into a %s outside native deployment',
    async (command) => {
      vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '');
      const { patch, entry } = await generate({}, command);
      expect(patch.version_metadata).toBeUndefined();
      expect(entry).not.toContain('versionId: env[');
    },
  );

  it('fails before upload when an application variable occupies the internal name', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    await expect(
      generate({ vars: { [DEFAULT_VERSION_METADATA_BINDING]: 'application-value' } }),
    ).rejects.toThrow('conflicts with');
  });
});
