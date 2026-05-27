import { describe, expect, it } from 'vite-plus/test';
import { bindingRuntimePlugin } from '../../src/plugin-binding-runtime.ts';

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

describe('bindingRuntimePlugin', () => {
  it('uses custom binding names in KV and R2 runtime helpers', () => {
    const plugin = bindingRuntimePlugin({ kv: 'myapp_kv', r2: 'myapp_storage' });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;

    const kvId = resolveId.call({ environment: { name: 'ssr' } }, 'void/kv', undefined, {
      isEntry: false,
    });
    expect(kvId).toBe('\0virtual:void-kv');
    expect(
      resolveId.call({ environment: { name: 'client' } }, 'void/kv', undefined, {
        isEntry: false,
      }),
    ).toBeUndefined();
    const kvCode = load.call({}, kvId!);
    expect(kvCode).toContain('requireRuntimeBinding("myapp_kv")');
    expect(kvCode).not.toContain('requireRuntimeBinding("KV")');

    const storageId = resolveId.call({ environment: { name: 'ssr' } }, 'void/storage', undefined, {
      isEntry: false,
    });
    expect(storageId).toBe('\0virtual:void-storage');
    const storageCode = load.call({}, storageId!);
    expect(storageCode).toContain('requireRuntimeBinding("myapp_storage")');
    expect(storageCode).not.toContain('requireRuntimeBinding("STORAGE")');
  });
});
