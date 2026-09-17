import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  getPort,
  killChild,
  waitForServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const targets = [
  { target: 'node', command: process.execPath, args: [] },
  { target: 'bun', command: process.env.VOID_TEST_BUN_BIN ?? 'bun', args: [] },
  { target: 'deno', command: process.env.VOID_TEST_DENO_BIN ?? 'deno', args: ['run', '-A'] },
];

for (const { target, command, args } of targets) {
  const available = spawn.sync(command, ['--version']).status === 0;
  describe.skipIf(!available)(`${target} production Pages assets`, () => {
    let root: string;
    let playground: IsolatedPlayground;
    let base: string;
    let child: ReturnType<typeof spawn>;
    let errors = '';

    beforeAll(async () => {
      // Keep relative workspace dependency links at the same depth and on the
      // same drive. A junction into the Windows system temp directory breaks them.
      playground = createIsolatedPlayground(repository, 'playground/node-app');
      root = playground.root;
      const config = JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'));
      writeFileSync(join(root, 'void.json'), JSON.stringify({ ...config, target }));
      writeFileSync(
        join(root, 'pages/index.tsx'),
        `
import { useState } from 'react';
import './index.css';
export default function Home() {
  const [count, setCount] = useState(0);
  return <button className="counter" onClick={() => setCount(count + 1)}>Count {count}</button>;
}
`,
      );
      writeFileSync(join(root, 'pages/index.css'), '.counter { color: rgb(12, 34, 56); }');
      mkdirSync(join(root, 'public'));
      writeFileSync(join(root, 'public/health.txt'), 'public asset');
      execFileSync('vp', ['build'], { cwd: root, stdio: 'pipe' });
      const port = await getPort();
      base = `http://127.0.0.1:${port}`;
      child = spawn(command, [...args, 'dist/ssr/index.js'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port) },
      });
      child.stderr!.on('data', (chunk) => {
        errors += String(chunk);
      });
      try {
        await waitForServer(base, 20_000, { isAlive: () => child.exitCode === null });
      } catch (error) {
        throw new Error(`${String(error)}\n${errors}`);
      }
    });

    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
      playground?.cleanup();
    });

    it('loads the real manifest and serves every referenced script and stylesheet from app-root startup', async () => {
      const response = await fetch(base);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain('/@vite/');
      const scripts = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g), (match) => match[1]);
      const styles = Array.from(
        html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
        (match) => match[1],
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(styles.length).toBeGreaterThan(0);
      for (const [urls, mime] of [
        [scripts, /javascript/],
        [styles, /text\/css/],
      ] as const) {
        for (const url of urls) {
          const asset = await fetch(new URL(url, base));
          expect(asset.status, url).toBe(200);
          expect(asset.headers.get('content-type'), url).toMatch(mime);
          expect((await asset.text()).length).toBeGreaterThan(0);
        }
      }
      const head = await fetch(new URL(scripts[0], base), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(await (await fetch(`${base}/health.txt`)).text()).toBe('public asset');
      expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/assets/..%2f..%2fssr/app.js`)).status).toBe(404);
      expect((await fetch(`${base}/assets/missing.js`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${base}/api/hello`)).status).toBe(200);
    });

    it('resolves assets from the emitted module when the working directory changes', async () => {
      const elsewhere = join(root, 'another-working-directory');
      mkdirSync(elsewhere);
      const port = await getPort();
      const relocatedBase = `http://127.0.0.1:${port}`;
      const relocated = spawn(command, [...args, join(root, 'dist/ssr/index.js')], {
        cwd: elsewhere,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port) },
      });
      try {
        await waitForServer(relocatedBase, 20_000, { isAlive: () => relocated.exitCode === null });
        const html = await (await fetch(relocatedBase)).text();
        const script = html.match(/<script[^>]*src="([^"]+)"/);
        expect(script).not.toBeNull();
        expect((await fetch(new URL(script![1], relocatedBase))).status).toBe(200);
        expect(await (await fetch(`${relocatedBase}/health.txt`)).text()).toBe('public asset');
      } finally {
        await killChild(relocated);
      }
    });

    it('hydrates an interactive page and applies its emitted CSS in a real browser', async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      try {
        await page.goto(base);
        await page.waitForSelector('#app[data-hydrated="true"]');
        await page.getByRole('button', { name: 'Count 0' }).click();
        await page.getByRole('button', { name: 'Count 1' }).waitFor();
        expect(
          await page.locator('.counter').evaluate((element) => getComputedStyle(element).color),
        ).toBe('rgb(12, 34, 56)');
      } finally {
        await browser.close();
      }
    });
  });
}
