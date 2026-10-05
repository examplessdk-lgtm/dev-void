import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  getPort,
  waitForServer,
  killChild,
  collectServerOutput,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { collectWorkerFiles } from '../../src/cli/package.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-app';
let DEV_PORT: number;
let DEV_BASE: string;

describe('playground/vinext-app dev', () => {
  let child: ReturnType<typeof spawn>;
  let serverOutput = () => '';
  let playground: IsolatedPlayground;

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(DEV_PORT)], {
      cwd: playground.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VOID_INSPECTOR_PORT: 'false',
      },
    });

    serverOutput = collectServerOutput(child);

    await waitForServer(DEV_BASE, 30_000, {
      isAlive: () => child.exitCode === null && child.signalCode === null,
      diagnostics: serverOutput,
    });
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
    if (serverOutput().includes('error when starting dev server')) {
      throw new Error(serverOutput());
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext App Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});

describe('playground/vinext-app build', () => {
  const playgrounds: Array<IsolatedPlayground> = [];
  let runtime: Miniflare | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  afterAll(() => {
    for (const playground of playgrounds.splice(0)) {
      playground.cleanup();
    }
  });

  it.each([['voidPlugin(), vinext()'], ['vinext(), voidPlugin()']])(
    'builds the Void worker entry with plugins [%s]',
    async (order) => {
      const playground = createIsolatedPlayground(ROOT, PLAYGROUND);
      playgrounds.push(playground);
      writeFileSync(
        join(playground.root, 'vite.config.ts'),
        `import vinext from 'vinext';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [${order}],
});
`,
      );
      const result = await new Promise<{ status: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn('vp', ['build'], {
            cwd: playground.root,
            env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let output = '';
          child.stdout!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.stderr!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.on('error', reject);
          child.on('close', (status) => resolve({ status, output }));
        },
      );
      expect(result.status, result.output).toBe(0);

      // A worker whose entry is vinext's bare RSC handler (a function default
      // export) never reaches Void's wrapper and cannot serve requests.
      const serverDir = join(playground.root, 'dist', 'server');
      const config = JSON.parse(readFileSync(join(serverDir, 'wrangler.json'), 'utf8'));
      const files = collectWorkerFiles(serverDir);
      const modulePaths = [
        config.main,
        ...Array.from(files.keys()).filter((path) => path !== config.main),
      ];
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          modules: modulePaths
            .filter((path) => /\.(?:js|mjs)$/.test(path))
            .map((path) => ({
              type: 'ESModule',
              path: join(serverDir, path),
              contents: files.get(path)!,
            })),
          modulesRoot: serverDir,
          d1Databases: ['DB'],
          kvNamespaces: ['KV'],
        }),
      );
      const response = await runtime.dispatchFetch('http://localhost/');
      const html = await response.text();
      expect(response.status, html.slice(0, 500)).toBe(200);
      expect(html).toContain('vinext App Router + Void');
    },
    180_000,
  );
});
