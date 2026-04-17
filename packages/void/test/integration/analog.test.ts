import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/analog';
const PLAYGROUND_ROOT = join(ROOT, PLAYGROUND);
const CONFIG_FILES = ['void.json', 'wrangler.jsonc', 'wrangler.json'];
const CLEAN_ENV_KEYS = [
  'APPDATA',
  'ComSpec',
  'HOME',
  'LOCALAPPDATA',
  'PATHEXT',
  'PNPM_HOME',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const;
const configSnapshot = new Map<string, string | undefined>();

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

function getCleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  if (pathKey && process.env[pathKey]) {
    env[pathKey] = process.env[pathKey];
  }

  for (const key of CLEAN_ENV_KEYS) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
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
    // Use a clean child environment while letting cross-spawn resolve pnpm.cmd on Windows.
    const result = spawn.sync('pnpm', ['--dir', PLAYGROUND, 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: getCleanEnv(),
    });
    if (result.status !== 0) {
      const output = [result.error?.message, result.stderr?.toString(), result.stdout?.toString()]
        .filter(Boolean)
        .join('\n');
      throw new Error(`Build failed (exit ${result.status ?? result.signal}):\n${output}`);
    }
  });

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
  });

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
});
