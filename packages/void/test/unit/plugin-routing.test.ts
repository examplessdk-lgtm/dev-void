import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { routingPlugin } from '../../src/plugin-routing.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-routing-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'routes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

describe('routingPlugin', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables the worker SPA fallback for websocket-only routes', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'routes', 'notifications.ws.ts'),
      'export default defineWebSocket({});\n',
    );

    const plugin = routingPlugin(root, { isAuthEnabled: () => false });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'build',
      mode: 'production',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);

    await buildStart.call({} as never);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain('"/index.html"');
    expect(entry).toContain('accept.includes("text/html")');
  });

  it('enables the worker SPA fallback for auth-only apps', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ auth: { providers: ['email'] } }));

    const plugin = routingPlugin(root, { isAuthEnabled: () => true });
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;

    configResolved({
      build: { assetsDir: 'assets' },
      command: 'build',
      mode: 'production',
      plugins: [],
    } as unknown as import('vite').ResolvedConfig);

    await buildStart.call({} as never);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain('"/index.html"');
    expect(entry).toContain('accept.includes("text/html")');
  });
});
