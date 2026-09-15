import { describe, expect, it, vi } from 'vite-plus/test';
import {
  readExistingCloudflareWorker,
  assertExistingCloudflareConfig,
  assertCloudflareBindingsPreserved,
  type ExistingCloudflareWorker,
} from '../../src/existing.ts';

const worker: ExistingCloudflareWorker = {
  versionId: 'original',
  bindings: [
    { type: 'secret_text', name: 'TOKEN' },
    { type: 'plain_text', name: 'URL', text: 'https://example.com' },
    { type: 'kv_namespace', name: 'KV', namespace_id: 'existing-id' },
  ],
  script: { handlers: ['fetch', 'scheduled'] },
  runtime: { compatibility_date: '2026-02-24', compatibility_flags: [] },
};
const config = {
  name: 'site',
  compatibility_date: '2026-02-24',
  kv_namespaces: [{ binding: 'KV', id: 'existing-id' }],
};
describe('existing Worker preservation', () => {
  it('keeps remote-only vars/secrets while requiring exact resource identities', () => {
    expect(() => assertExistingCloudflareConfig(worker, config, true)).not.toThrow();
    expect(() =>
      assertExistingCloudflareConfig(worker, {
        ...config,
        kv_namespaces: [{ binding: 'KV', id: 'new-empty-id' }],
      }),
    ).toThrow('existing Cloudflare resource');
    expect(() => assertExistingCloudflareConfig(worker, { ...config, kv_namespaces: [] })).toThrow(
      'existing Cloudflare resource',
    );
  });
  it('blocks variable changes and secret demotion without exposing values', () => {
    for (const vars of [{ TOKEN: 'private-value' }, { URL: 'private-value' }]) {
      try {
        assertExistingCloudflareConfig(worker, { ...config, vars });
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).toContain('Preserve production');
        expect(String(error)).not.toContain('private-value');
      }
    }
  });
  it('rejects an upload that drops an existing event handler', () => {
    expect(() =>
      assertCloudflareBindingsPreserved(worker, {
        ...worker,
        versionId: 'candidate',
        script: { handlers: ['fetch'] },
      }),
    ).toThrow('event handlers');
    expect(() =>
      assertCloudflareBindingsPreserved(worker, {
        ...worker,
        versionId: 'candidate',
        script: { handlers: ['scheduled', 'fetch'] },
      }),
    ).not.toThrow();
  });
  it('blocks new resources, runtime changes, and unsupported bindings', () => {
    expect(() =>
      assertExistingCloudflareConfig(worker, {
        ...config,
        r2_buckets: [{ binding: 'STORAGE', bucket_name: 'new' }],
      }),
    ).toThrow('cannot add');
    expect(() =>
      assertExistingCloudflareConfig(worker, { ...config, compatibility_date: '2026-09-15' }),
    ).toThrow('compatibility_date');
    expect(() =>
      assertExistingCloudflareConfig(
        { ...worker, bindings: [{ name: 'STATE', type: 'durable_object_namespace' }] },
        config,
      ),
    ).toThrow('not yet supported');
  });
  it('accepts empty normalized runtime collections', () => {
    expect(() =>
      assertExistingCloudflareConfig(
        worker,
        { ...config, triggers: { crons: [] }, queues: { consumers: [], producers: [] } },
        true,
      ),
    ).not.toThrow();
  });
  it('compares compatibility flags as a semantic set', () => {
    expect(() =>
      assertExistingCloudflareConfig(
        {
          ...worker,
          runtime: {
            compatibility_date: '2026-02-24',
            compatibility_flags: ['nodejs_compat'],
          },
        },
        { ...config, compatibility_flags: ['nodejs_compat', 'nodejs_compat'] },
        true,
      ),
    ).not.toThrow();
  });
  it('reads the active version and detects changes during inspection', async () => {
    let statuses = 0;
    const runWrangler = vi.fn((args: Array<string>) => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'deployments'
          ? {
              versions: [
                { version_id: ++statuses === 1 ? 'original' : 'new-owner', percentage: 100 },
              ],
            }
          : {
              id: 'original',
              resources: {
                bindings: worker.bindings,
                script: worker.script,
                script_runtime: worker.runtime,
              },
            },
      ),
    }));
    await expect(
      readExistingCloudflareWorker({
        runWrangler,
        workerName: 'site',
        configPath: '/app/wrangler.jsonc',
      }),
    ).rejects.toThrow('production changed');
    expect(runWrangler.mock.calls[1]![0]).toContain('original');
    expect(runWrangler.mock.calls.every(([args]) => args.includes('--json'))).toBe(true);
  });
  it.each([403, 404, 1])('never turns a failed read (%s) into Worker creation', async (status) => {
    await expect(
      readExistingCloudflareWorker({
        runWrangler: () => ({ status, stdout: '', stderr: 'private data' }),
        workerName: 'site',
        configPath: '/app/wrangler.jsonc',
      }),
    ).rejects.toThrow('Could not verify existing');
  });
});
