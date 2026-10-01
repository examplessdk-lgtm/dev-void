import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  getPort,
  waitForServer,
  killChild,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_PORT: number;
let DEV_BASE: string;
let PROD_PORT: number;
let PROD_BASE: string;

describe('playground/node-app dev', () => {
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-app');
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(DEV_PORT)], {
      cwd: playground.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.stdout!.resume();

    await waitForServer(DEV_BASE, 20_000);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('serves API routes via Hono in Node.js', async () => {
    const response = await fetch(`${DEV_BASE}/api/hello`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: 'Hello from Node.js!' });
  });

  it('returns JSON content-type for API routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/hello`);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
  });

  it('serves pages with SSR HTML at root', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // React inserts <!-- --> comment nodes between text siblings
    expect(html).toContain('data-testid="title"');
    expect(html).toContain('Welcome');
    expect(html).toContain('<title>Home | Node App</title>');
  });

  it('serves the about page with SSR HTML', async () => {
    const response = await fetch(`${DEV_BASE}/about`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('Void running on Node.js with React Pages');
    expect(html).toContain('<title>About | Node App</title>');
  });

  it('returns 404 for unregistered routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/nonexistent`);
    expect(response.status).toBe(404);
  });
});

describe('playground/node-app build + production', () => {
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-app');
    const build = spawn.sync('vp', ['build'], {
      cwd: playground.root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);

    PROD_PORT = await getPort();
    PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;

    child = spawn('node', ['dist/ssr/index.js'], {
      cwd: playground.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PROD_PORT) },
    });

    await waitForServer(PROD_BASE, 20_000, {
      isAlive: () => child.exitCode === null,
    });
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
  });

  it('emits app.js, index.js, and client assets', () => {
    expect(existsSync(join(playground.root, 'dist/ssr/app.js'))).toBe(true);
    expect(existsSync(join(playground.root, 'dist/ssr/index.js'))).toBe(true);
    expect(existsSync(join(playground.root, 'dist/client'))).toBe(true);

    const index = readFileSync(join(playground.root, 'dist/ssr/index.js'), 'utf-8');
    expect(index).toContain('@hono/node-server');
  });

  it('production server serves API routes', async () => {
    const response = await fetch(`${PROD_BASE}/api/hello`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: 'Hello from Node.js!' });
  });

  it('production server serves pages with SSR HTML', async () => {
    const response = await fetch(`${PROD_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Welcome');
    expect(html).toContain('<title>Home | Node App</title>');
  });
});
