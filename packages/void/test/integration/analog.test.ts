import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/analog';
const PLAYGROUND_ROOT = join(ROOT, PLAYGROUND);
const CONFIG_FILES = ['void.json', 'wrangler.jsonc', 'wrangler.json'];
const configSnapshot = new Map<string, string | undefined>();

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

beforeAll(() => {
  for (const file of CONFIG_FILES) {
    const filePath = join(PLAYGROUND_ROOT, file);
    configSnapshot.set(file, existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined);
  }
});

afterAll(() => {
  for (const [file, contents] of configSnapshot) {
    const filePath = join(PLAYGROUND_ROOT, file);
    if (contents === undefined) {
      rmSync(filePath, { force: true });
    } else {
      writeFileSync(filePath, contents);
    }
  }
});

describe('playground/analog build', () => {
  beforeAll(() => {
    const pg = PLAYGROUND_ROOT;
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    removeWranglerConfig(pg);
    // Angular's compiler conflicts with vitest's Node.js module hooks.
    // Use env -i to fully isolate the child process, preserving only PATH and HOME.
    const result = spawnSync(
      'env',
      [
        '-i',
        `PATH=${process.env.PATH}`,
        `HOME=${process.env.HOME}`,
        'pnpm',
        '--dir',
        PLAYGROUND,
        'build',
      ],
      { cwd: ROOT, stdio: 'pipe', timeout: 90_000 },
    );
    if (result.status !== 0) {
      throw new Error(`Build failed (exit ${result.status}):\n${result.stderr?.toString()}`);
    }
  }, 120_000);

  it('produces expected build artifacts', () => {
    const serverEntry = join(ROOT, `${PLAYGROUND}/dist/analog/server/index.mjs`);
    expect(existsSync(serverEntry)).toBe(true);

    const clientDir = join(ROOT, `${PLAYGROUND}/dist/analog/public`);
    expect(existsSync(clientDir)).toBe(true);
  });
});

describe('playground/analog dev', () => {
  let child: ReturnType<typeof spawn>;
  let DEV_PORT: number;
  let DEV_BASE: string;

  beforeAll(async () => {
    const pg = PLAYGROUND_ROOT;
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    removeWranglerConfig(pg);

    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        PLAYGROUND,
        'exec',
        'vite',
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

    child.stderr!.on('data', () => {});

    await waitForServer(DEV_BASE, 30_000);
  }, 45_000);

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('syncs wrangler.jsonc with bindings from void.json', () => {
    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, `${PLAYGROUND}/wrangler.jsonc`), 'utf-8'),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
  });
}, 60_000);
