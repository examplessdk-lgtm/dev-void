import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  ENV_VALIDATION_TEST_KEY,
  captureChildOutput,
  getPort,
  installEnvValidationFixture,
  killChild,
  waitForEnvValidation,
  waitForServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-app';
let DEV_PORT: number;
let DEV_BASE: string;

// Temporarily disabled — Vinext integration removed from public docs
// oxlint-disable-next-line jest/no-disabled-tests
describe.skip('playground/vinext-app build', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('produces expected build artifacts', () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/dist/server/index.js`);
    expect(existsSync(workerEntry)).toBe(true);

    const clientDir = join(ROOT, `${PLAYGROUND}/dist/client`);
    expect(existsSync(clientDir)).toBe(true);
  });

  it('generates wrangler.json with inferred bindings', () => {
    const configPath = join(ROOT, `${PLAYGROUND}/dist/server/wrangler.json`);

    const wranglerConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
      assets?: { directory?: string };
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(wranglerConfig.assets?.directory).toBe('../client');
  });
});

// oxlint-disable-next-line jest/no-disabled-tests
describe.skip('playground/vinext-app dev', () => {
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

    await waitForServer(DEV_BASE, 30_000);
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

describe('playground/vinext-app env validation', () => {
  let child: ReturnType<typeof spawn>;
  let cleanupEnvFixture: (() => void) | undefined;
  let readDevOutput = () => '';

  beforeAll(async () => {
    cleanupEnvFixture = installEnvValidationFixture(join(ROOT, PLAYGROUND));
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
    readDevOutput = captureChildOutput(child);

    await waitForServer(DEV_BASE, 30_000, {
      isAlive: () => child.exitCode === null && child.signalCode === null,
    });
    await waitForEnvValidation();
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    cleanupEnvFixture?.();
  });

  it('accepts required env values from .env.local without warning', () => {
    expect(readDevOutput()).not.toContain(`${ENV_VALIDATION_TEST_KEY} is required but missing`);
  });
});
