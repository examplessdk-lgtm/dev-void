import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_PORT: number;
let DEV_BASE: string;
let PREVIEW_PORT: number;
let PREVIEW_BASE: string;

describe('playground/ssr dev', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        'playground/ssr',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEV_PORT),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      },
    );

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(DEV_BASE, 20_000);
  }, 30_000);

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('serves SSR output for / and non-root paths', async () => {
    const rootResponse = await fetch(`${DEV_BASE}/`);
    expect(rootResponse.status).toBe(200);
    const rootHtml = await rootResponse.text();
    expect(rootHtml).toContain('Void SSR Playground');
    expect(rootHtml).toContain('Rendered URL: <!-- -->/');
    expect(rootHtml).toContain('<script type="module" src="/@vite/client"></script>');
    expect(rootHtml).toContain('<script type="module" src="/src/main.client.tsx"></script>');
    expect(rootHtml).toContain('__vite_plugin_react_preamble_installed__ = true');

    const nestedResponse = await fetch(`${DEV_BASE}/dashboard`);
    expect(nestedResponse.status).toBe(200);
    const nestedHtml = await nestedResponse.text();
    expect(nestedHtml).toContain('Rendered URL: <!-- -->/dashboard');

    const clientEntryResponse = await fetch(`${DEV_BASE}/src/main.client.tsx`);
    expect(clientEntryResponse.status).toBe(200);
    const contentType = clientEntryResponse.headers.get('content-type') ?? '';
    expect(contentType).toContain('javascript');
  });
}, 60_000);

describe('playground/ssr build + preview', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    rmSync(join(ROOT, 'playground/ssr/dist'), { recursive: true, force: true });
    execSync('pnpm --dir playground/ssr build', { cwd: ROOT, stdio: 'pipe' });

    PREVIEW_PORT = await getPort();
    PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        'playground/ssr',
        'exec',
        'vite',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(PREVIEW_PORT),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      },
    );

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(PREVIEW_BASE, 20_000, {
      isAlive: () => child.exitCode === null,
    });
  }, 60_000);

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting preview server')) {
      throw new Error(stderr);
    }
  });

  it('emits worker entry and client manifest', () => {
    const workerEntry = join(ROOT, 'playground/ssr/dist/ssr/index.js');
    const clientManifest = join(ROOT, 'playground/ssr/dist/client/.vite/manifest.json');

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);

    const code = readFileSync(workerEntry, 'utf-8');
    // String literals survive minification; function names may be mangled
    expect(code).toContain('/.vite/manifest.json');
    expect(code).toContain('src/main.client.tsx');

    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, 'playground/ssr/dist/ssr/wrangler.json'), 'utf-8'),
    ) as {
      assets?: { run_worker_first?: boolean | string[] };
      kv_namespaces?: Array<{ binding: string }>;
    };
    expect(wranglerConfig.assets?.run_worker_first).toEqual(['/**']);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
  });

  it('preview serves SSR pages', async () => {
    const rootFirst = await (await fetch(`${PREVIEW_BASE}/`)).text();
    const rootSecond = await (await fetch(`${PREVIEW_BASE}/`)).text();
    expect(rootFirst).toContain('Rendered URL: <!-- -->/');
    expect(rootSecond).toContain('Rendered URL: <!-- -->/');

    const previewAboutHtml = await (await fetch(`${PREVIEW_BASE}/about`)).text();
    expect(previewAboutHtml).toContain('Rendered URL: <!-- -->/about');
  });
}, 60_000);
