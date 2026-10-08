import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-pages';
let DEV_BASE: string;

describe('playground/vinext-pages dev', () => {
  let child: ReturnType<typeof spawn>;
  let serverOutput = () => '';

  beforeAll(async () => {
    const server = await startServer((port) => {
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
          String(port),
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
      return child;
    }, 20_000);
    DEV_BASE = server.base;
    serverOutput = server.output;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (serverOutput().includes('error when starting dev server')) {
      throw new Error(serverOutput());
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext Pages Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
