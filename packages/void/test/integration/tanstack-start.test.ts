import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  collectServerOutput,
  getPort,
  killChild,
  waitForServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/tanstack-start';
let DEV_PORT: number;
let DEV_BASE: string;

describe('playground/tanstack-start dev', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'vp',
      [
        'run',
        '--filter',
        `./${PLAYGROUND}`,
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEV_PORT),
        '--strictPort',
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

    // Other test files in the same run can bind the port getPort() released,
    // so only this app's page counts as ready.
    await waitForServer(DEV_BASE, 20_000, {
      expectBody: 'TanStack Start + Void',
      isAlive: () => child.exitCode === null && child.signalCode === null,
      diagnostics: collectServerOutput(child),
    });
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('TanStack Start + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
