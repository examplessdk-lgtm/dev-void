import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  getPort,
  killChild,
  type IsolatedPlayground,
  waitForServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/spa';
let playground: IsolatedPlayground;
let playgroundFilter = '';
let authMiddleware = '';
let documentRoute = '';
let middlewareDir = '';
let middlewareBackupDir = '';
let publicDir = '';
let protectedAsset = '';
let wranglerConfig = '';
let dist = '';
const AUTH_HEADER = 'Basic Z3Vlc3Q6d2VkZGluZw==';

const middlewareSource = `import { basicAuth } from 'void';

export default basicAuth({
  username: 'guest',
  password: 'wedding',
  realm: 'Preview',
});
`;

const documentRouteSource = `export const GET = () =>
  new Response('document route response', {
    headers: { 'Content-Type': 'text/plain' },
  });
`;

const staleWranglerSource = `{
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "none",
    "run_worker_first": ["/", "/*.html"]
  }
}
`;

let child: ReturnType<typeof spawn> | undefined;
let stderr = '';
let previousWrangler: string | undefined;
let middlewareBackedUp = false;
let publicDirCreated = false;

function saveWranglerConfig(): void {
  previousWrangler = existsSync(wranglerConfig) ? readFileSync(wranglerConfig, 'utf-8') : undefined;
}

function restoreWranglerConfig(): void {
  if (previousWrangler === undefined) {
    rmSync(wranglerConfig, { force: true });
  } else {
    writeFileSync(wranglerConfig, previousWrangler);
  }
  previousWrangler = undefined;
}

function disableMiddlewareDir(): void {
  rmSync(middlewareBackupDir, { recursive: true, force: true });
  if (existsSync(middlewareDir)) {
    renameSync(middlewareDir, middlewareBackupDir);
    middlewareBackedUp = true;
  }
}

function restoreMiddlewareDir(): void {
  if (!middlewareBackedUp) {
    return;
  }
  rmSync(middlewareDir, { recursive: true, force: true });
  if (existsSync(middlewareBackupDir)) {
    renameSync(middlewareBackupDir, middlewareDir);
  }
  middlewareBackedUp = false;
}

function writeProtectedAsset(): void {
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir);
    publicDirCreated = true;
  }
  writeFileSync(protectedAsset, 'protected static asset');
}

async function startSpaDevServer(): Promise<string> {
  const port = await getPort();
  const base = `http://127.0.0.1:${port}`;
  stderr = '';
  child = spawn(
    'vp',
    ['run', '--filter', playgroundFilter, 'dev', '--host', '127.0.0.1', '--port', String(port)],
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

  await waitForServer(base, 30_000, {
    isAlive: () => child?.exitCode === null && child.signalCode === null,
  });
  return base;
}

function readBuiltAssetConfig(): {
  not_found_handling?: string;
  run_worker_first?: boolean | Array<string>;
} {
  const emittedWrangler = JSON.parse(readFileSync(join(dist, 'ssr/wrangler.json'), 'utf-8')) as {
    assets?: {
      not_found_handling?: string;
      run_worker_first?: boolean | Array<string>;
    };
  };
  return emittedWrangler.assets ?? {};
}

beforeAll(() => {
  playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
  playgroundFilter = `./${playground.workspacePath}`;
  authMiddleware = join(playground.root, 'middleware/00.basic-auth-regression.ts');
  documentRoute = join(playground.root, 'routes/dashboard.ts');
  middlewareDir = join(playground.root, 'middleware');
  middlewareBackupDir = join(playground.root, `.middleware.e2e-backup-${process.pid}`);
  publicDir = join(playground.root, 'public');
  protectedAsset = join(publicDir, 'void-basic-auth-regression.txt');
  wranglerConfig = join(playground.root, 'wrangler.jsonc');
  dist = join(playground.root, 'dist');
});

afterAll(() => {
  playground?.cleanup();
});

afterEach(async () => {
  if (child) {
    await killChild(child);
    child = undefined;
  }
  rmSync(documentRoute, { force: true });
  restoreMiddlewareDir();
  rmSync(authMiddleware, { force: true });
  rmSync(protectedAsset, { force: true });
  if (publicDirCreated) {
    rmSync(publicDir, { recursive: true, force: true });
    publicDirCreated = false;
  }
  restoreWranglerConfig();
  if (stderr.includes('error when starting dev server')) {
    throw new Error(stderr);
  }
});

describe('SPA asset routing policy', () => {
  it('keeps API-only projects on static SPA fallback while routing API requests to the worker', () => {
    saveWranglerConfig();
    disableMiddlewareDir();
    writeFileSync(wranglerConfig, staleWranglerSource);
    rmSync(dist, { recursive: true, force: true });

    execSync(`vp run --filter ${playgroundFilter} build`, { cwd: ROOT, stdio: 'pipe' });

    const assetConfig = readBuiltAssetConfig();
    expect(assetConfig.not_found_handling).toBe('single-page-application');
    expect(assetConfig.run_worker_first).toEqual(['/api', '/api/*', '/__void', '/__void/*']);
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    saveWranglerConfig();
    disableMiddlewareDir();
    writeFileSync(wranglerConfig, staleWranglerSource);
    writeFileSync(documentRoute, documentRouteSource);

    const base = await startSpaDevServer();
    const response = await fetch(`${base}/dashboard`, {
      headers: { Accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('document route response');
  });

  it('runs middleware before serving SPA fallback HTML on nested navigations', async () => {
    saveWranglerConfig();
    writeFileSync(authMiddleware, middlewareSource);
    writeFileSync(wranglerConfig, staleWranglerSource);
    writeProtectedAsset();

    const base = await startSpaDevServer();
    const unauthenticatedAsset = await fetch(`${base}/void-basic-auth-regression.txt`);
    expect(unauthenticatedAsset.status).toBe(401);
    expect(await unauthenticatedAsset.text()).toBe('Authentication required');

    const authenticatedAsset = await fetch(`${base}/void-basic-auth-regression.txt`, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(authenticatedAsset.status).toBe(200);
    expect(await authenticatedAsset.text()).toBe('protected static asset');

    const unauthenticated = await fetch(`${base}/nested/spa/path`, {
      headers: { Accept: 'text/html' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      'Basic realm="Preview", charset="UTF-8"',
    );
    expect(await unauthenticated.text()).toBe('Authentication required');

    const authenticated = await fetch(`${base}/nested/spa/path`, {
      headers: {
        Accept: 'text/html',
        Authorization: AUTH_HEADER,
      },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('content-type')).toContain('text/html');
    expect(await authenticated.text()).toContain('<title>Vite Cloud Playground</title>');
  });
});
