import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

type LocalRuntime = {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
};

let runtime: LocalRuntime;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const miniflarePath = createRequire(require.resolve('wrangler')).resolve('miniflare');
  const { Miniflare, convertV4MiniflareOptions } = (await import(
    pathToFileURL(miniflarePath).href
  )) as {
    Miniflare: new (options: Record<string, unknown>) => LocalRuntime;
    convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>;
  };
  const dispatchPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
  // Use the real Workers Cache API: Map-backed Response mocks have writable
  // headers and cannot catch mutations of an immutable cache-hit response.
  const fixture = `
    import dispatch from ${JSON.stringify(dispatchPath)};
    let originCalls = 0;
    export default {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const headerRules = pathname.includes('unmatched')
          ? [{ pattern: '/other/*', headers: [['X-Test', 'unmatched']] }]
          : pathname.includes('matched')
            ? [{ pattern: '/assets/*', headers: [['X-Test', 'matched']] }]
            : undefined;
        const pending = [];
        const routing = {
          workerName: 'test-worker', projectId: 'proj-test', ssr: true,
          hashedAssetsPrefix: 'assets', headerRules,
        };
        const response = await dispatch.fetch(request, {
          ROUTING: { get: async () => JSON.stringify(routing) },
          DISPATCH: { get: () => ({ fetch: async () => {
            originCalls++;
            return new Response('export const value = 42;', {
              headers: { 'Content-Type': 'text/javascript', 'X-Origin-Call': String(originCalls) },
            });
          } }) },
          ANALYTICS: { writeDataPoint() {} },
        }, { waitUntil: promise => pending.push(promise) });
        await Promise.all(pending);
        return response;
      },
    };
  `;
  const build = await rolldown({
    input: 'virtual:asset-cache-runtime',
    plugins: [
      {
        name: 'asset-cache-runtime',
        resolveId: (id) => (id === 'virtual:asset-cache-runtime' ? id : undefined),
        load: (id) => (id === 'virtual:asset-cache-runtime' ? fixture : undefined),
      },
    ],
  });
  try {
    const { output } = await build.generate({ format: 'esm' });
    const entry = output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
    if (!entry || entry.type !== 'chunk') {
      throw new Error('Dispatch test bundle is missing');
    }
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        compatibilityDate: '2026-02-12',
        script: entry.code,
      }),
    );
  } finally {
    await build.close();
  }
});

afterAll(async () => {
  await runtime?.dispose();
});

describe('hashed assets in the Workers runtime', () => {
  it.each(['no-rules', 'unmatched-rules', 'matched-rules'])(
    'serves repeated cache hits with %s',
    async (scenario) => {
      const url = `https://test.void.app/assets/${scenario}.js`;
      const miss = await runtime.dispatchFetch(url);
      expect(miss.status).toBe(200);
      const originCall = miss.headers.get('X-Origin-Call');
      expect(originCall).not.toBeNull();
      expect(await miss.text()).toBe('export const value = 42;');

      for (let i = 0; i < 2; i++) {
        const hit = await runtime.dispatchFetch(url);
        expect(hit.status).toBe(200);
        expect(await hit.text()).toBe('export const value = 42;');
        expect(hit.headers.get('X-Origin-Call')).toBe(originCall);
        expect(hit.headers.get('Content-Type')).toBe('text/javascript');
        expect(hit.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        expect(hit.headers.get('x-void-shared-cache-policy')).toBeNull();
        expect(hit.headers.get('X-Test')).toBe(scenario === 'matched-rules' ? 'matched' : null);
      }
    },
  );
});
