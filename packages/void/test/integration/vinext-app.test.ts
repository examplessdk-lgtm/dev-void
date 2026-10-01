import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  getPort,
  waitForServer,
  killChild,
  collectServerOutput,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

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
