import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectPrerenderPathsNode } from '../../src/prerender';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/node-static';
const DIST = join(ROOT, PLAYGROUND, 'dist');

let staticServer: Server | undefined;
let staticBase: string;

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function resolveStaticFile(clientDir: string, requestUrl: string): string | null {
  const url = new URL(requestUrl, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const candidates =
    pathname === '/'
      ? ['index.html']
      : [pathname.slice(1), `${pathname.slice(1)}.html`, `${pathname.slice(1)}/index.html`];

  const root = resolve(clientDir);
  for (const candidate of candidates) {
    const filePath = resolve(root, candidate);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }
  return null;
}

describe('playground/node-static build (target: node, output: static)', () => {
  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });

    const clientDir = join(DIST, 'client');
    staticServer = createServer((req, res) => {
      const filePath = resolveStaticFile(clientDir, req.url || '/');
      if (!filePath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(filePath) });
      res.end(readFileSync(filePath));
    });
    await new Promise<void>((resolveListen) => {
      staticServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = staticServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start static test server');
    }
    staticBase = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (staticServer) {
      await new Promise<void>((resolveClose) => staticServer!.close(() => resolveClose()));
    }
  });

  it('emits Node SSR entry', () => {
    expect(existsSync(join(DIST, 'ssr/app.js'))).toBe(true);
  });

  it('prerenders index.html with production asset URLs', () => {
    const indexPath = join(DIST, 'client/index.html');
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="home-title"');
    expect(html).toContain('Home');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('proves rendering happened in Node.js via process.versions.node', () => {
    const html = readFileSync(join(DIST, 'client/index.html'), 'utf-8');
    const match = html.match(/data-testid="runtime"[^>]*>([^<]+)</);
    expect(match).not.toBeNull();
    // Node.js version string like "24.13.1"
    expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prerenders about.html with production asset URLs', () => {
    const aboutPath = join(DIST, 'client/about.html');
    expect(existsSync(aboutPath)).toBe(true);

    const html = readFileSync(aboutPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('About');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('emits static page data for prerendered routes', () => {
    const indexData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/index.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };
    const aboutData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/about.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };

    expect(indexData.component).toBe('index');
    expect(indexData.url).toBe('/');
    expect(indexData.props.title).toBe('Home');
    expect(aboutData.component).toBe('about');
    expect(aboutData.url).toBe('/about');
    expect(aboutData.props.description).toBe('A statically prerendered page from Node.js.');
  });

  it('keeps static file traversal outside the client dir blocked', () => {
    const clientDir = join(DIST, 'client');
    const secretDir = join(DIST, 'client-secret');
    const secretPath = join(secretDir, 'foo');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(secretPath, 'secret');

    expect(resolveStaticFile(clientDir, '/..%2fclient-secret/foo')).toBeNull();
  });

  it('serves static output with SPA navigation between prerendered Link routes', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${staticBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
        (document.querySelector('nav') as any).__STAMP = 1;
      });

      await page.click('a[href="/about"]');
      await page.waitForSelector('[data-testid="about-title"]');

      expect(page.url()).toBe(`${staticBase}/about`);
      expect(await page.evaluate(() => (window as any).__SPA_MARKER)).toBe(true);
      expect(await page.evaluate(() => (document.querySelector('nav') as any).__STAMP)).toBe(1);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('collects prerender paths from the built node app endpoint', async () => {
    const paths = await collectPrerenderPathsNode({
      root: join(ROOT, PLAYGROUND),
      ssrDir: join(DIST, 'ssr'),
      clientDir: join(DIST, 'client'),
    });

    expect(paths).toEqual(expect.arrayContaining(['/', '/about']));
  });

  it('does not emit wrangler.json (Node target)', () => {
    expect(existsSync(join(DIST, 'ssr/wrangler.json'))).toBe(false);
    expect(existsSync(join(DIST, 'ssr/wrangler.jsonc'))).toBe(false);
  });
}, 120_000);
