import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getPort, killChild, waitForServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = join(ROOT, 'playground/spa');
const PLAYGROUND_FILTER = './playground/spa';
const AUTH_MIDDLEWARE = join(PLAYGROUND, 'middleware/00.basic-auth-regression.ts');
const DOCUMENT_ROUTE = join(PLAYGROUND, 'routes/dashboard.ts');
const MIDDLEWARE_DIR = join(PLAYGROUND, 'middleware');
const MIDDLEWARE_BACKUP_DIR = join(PLAYGROUND, `.middleware.e2e-backup-${process.pid}`);
const PUBLIC_DIR = join(PLAYGROUND, 'public');
const PROTECTED_ASSET = join(PUBLIC_DIR, 'void-basic-auth-regression.txt');
const WRANGLER_CONFIG = join(PLAYGROUND, 'wrangler.jsonc');
const DIST = join(PLAYGROUND, 'dist');
const AUTH_HEADER = 'Basic Z3Vlc3Q6d2VkZGluZw==';

const middlewareSource = `import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (c.req.raw.headers.get('Authorization') !== '${AUTH_HEADER}') {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Basic realm="Preview", charset="UTF-8"',
      },
    });
  }

  await next();
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
  previousWrangler = existsSync(WRANGLER_CONFIG)
    ? readFileSync(WRANGLER_CONFIG, 'utf-8')
    : undefined;
}

function restoreWranglerConfig(): void {
  if (previousWrangler === undefined) {
    rmSync(WRANGLER_CONFIG, { force: true });
  } else {
    writeFileSync(WRANGLER_CONFIG, previousWrangler);
  }
  previousWrangler = undefined;
}

function disableMiddlewareDir(): void {
  rmSync(MIDDLEWARE_BACKUP_DIR, { recursive: true, force: true });
  if (existsSync(MIDDLEWARE_DIR)) {
    renameSync(MIDDLEWARE_DIR, MIDDLEWARE_BACKUP_DIR);
    middlewareBackedUp = true;
  }
}

function restoreMiddlewareDir(): void {
  if (!middlewareBackedUp) {
    return;
  }
  rmSync(MIDDLEWARE_DIR, { recursive: true, force: true });
  if (existsSync(MIDDLEWARE_BACKUP_DIR)) {
    renameSync(MIDDLEWARE_BACKUP_DIR, MIDDLEWARE_DIR);
  }
  middlewareBackedUp = false;
}

function writeProtectedAsset(): void {
  if (!existsSync(PUBLIC_DIR)) {
    mkdirSync(PUBLIC_DIR);
    publicDirCreated = true;
  }
  writeFileSync(PROTECTED_ASSET, 'protected static asset');
}

async function startSpaDevServer(): Promise<string> {
  const port = await getPort();
  const base = `http://127.0.0.1:${port}`;
  stderr = '';
  child = spawn(
    'vp',
    ['run', '--filter', PLAYGROUND_FILTER, 'dev', '--host', '127.0.0.1', '--port', String(port)],
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
  const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr/wrangler.json'), 'utf-8')) as {
    assets?: {
      not_found_handling?: string;
      run_worker_first?: boolean | Array<string>;
    };
  };
  return wranglerConfig.assets ?? {};
}

afterEach(async () => {
  if (child) {
    await killChild(child);
    child = undefined;
  }
  rmSync(DOCUMENT_ROUTE, { force: true });
  restoreMiddlewareDir();
  rmSync(AUTH_MIDDLEWARE, { force: true });
  rmSync(PROTECTED_ASSET, { force: true });
  if (publicDirCreated) {
    rmSync(PUBLIC_DIR, { recursive: true, force: true });
    publicDirCreated = false;
  }
  restoreWranglerConfig();
  if (stderr.includes('error when starting dev server')) {
    throw new Error(stderr);
  }
});

describe('SPA asset routing policy', () => {
  it('keeps API-only projects on static SPA fallback even with stale wrangler asset rules', () => {
    saveWranglerConfig();
    disableMiddlewareDir();
    writeFileSync(WRANGLER_CONFIG, staleWranglerSource);
    rmSync(DIST, { recursive: true, force: true });

    execSync(`vp run --filter ${PLAYGROUND_FILTER} build`, { cwd: ROOT, stdio: 'pipe' });

    const assetConfig = readBuiltAssetConfig();
    expect(assetConfig.not_found_handling).toBe('single-page-application');
    expect(assetConfig.run_worker_first).toBeUndefined();
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    saveWranglerConfig();
    disableMiddlewareDir();
    writeFileSync(WRANGLER_CONFIG, staleWranglerSource);
    writeFileSync(DOCUMENT_ROUTE, documentRouteSource);

    const base = await startSpaDevServer();
    const response = await fetch(`${base}/dashboard`, {
      headers: { Accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('document route response');
  });

  it('runs middleware before serving SPA fallback HTML on nested navigations', async () => {
    saveWranglerConfig();
    writeFileSync(AUTH_MIDDLEWARE, middlewareSource);
    writeFileSync(WRANGLER_CONFIG, staleWranglerSource);
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
