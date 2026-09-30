import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vite-plus/test';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

it.each([200, 503])(
  'reports HTTP %i when domain cleanup returns a non-JSON response',
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-cf-domain-error-'));
    const server = createServer((request, response) => {
      request.resume();
      response.statusCode = status;
      response.end('temporary upstream response');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const configPath = join(directory, 'wrangler.json');
      writeFileSync(
        configPath,
        JSON.stringify({ name: 'test-worker', account_id: 'test-account' }),
      );
      const [command, ...prefix] = resolveWranglerArgv(directory);
      const output = await new Promise<{ status: number; stderr: string }>((resolve) => {
        execFile(
          command!,
          [...prefix, 'triggers', 'clear-domains', '-c', configPath, '--name', 'test-worker'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              CI: 'true',
              CLOUDFLARE_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (error, _stdout, stderr) => resolve({ status: error ? 1 : 0, stderr }),
        );
      });
      expect(output.status).toBe(1);
      expect(output.stderr).toContain(`HTTP ${status}`);
      expect(output.stderr).not.toContain('synthetic-token');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it.each(['clear-crons', 'clear-domains'])(
  'clears %s through the pinned account API',
  async (operation) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-cf-clear-crons-'));
    let requested = false;
    const server = createServer(async (request, response) => {
      requested = true;
      expect(request.method).toBe('PUT');
      expect(request.url).toBe(
        `/client/v4/accounts/test-account/workers/scripts/test-worker/${operation === 'clear-crons' ? 'schedules' : 'domains/records'}`,
      );
      expect(request.headers.authorization).toBe('Bearer synthetic-token');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      expect(JSON.parse(body)).toEqual(
        operation === 'clear-crons'
          ? []
          : {
              override_scope: true,
              override_existing_origin: false,
              override_existing_dns_record: false,
              origins: [],
            },
      );
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, result: { schedules: [] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const configPath = join(directory, 'wrangler.json');
      writeFileSync(
        configPath,
        JSON.stringify({ name: 'test-worker', account_id: 'test-account' }),
      );
      const [command, ...prefix] = resolveWranglerArgv(directory);
      const output = await new Promise<{ status: number; stderr: string }>((resolve) => {
        execFile(
          command!,
          [...prefix, 'triggers', operation, '-c', configPath, '--name', 'test-worker'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              CI: 'true',
              CLOUDFLARE_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (error, _stdout, stderr) => resolve({ status: error ? 1 : 0, stderr }),
        );
      });
      expect(output.status, output.stderr).toBe(0);
      expect(requested).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it.each(['clear-crons', 'clear-domains'])(
  'uses encrypted browser credentials for %s',
  async (operation) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-cf-clear-crons-oauth-'));
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer synthetic-oauth-token');
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, result: { schedules: [] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const configPath = join(directory, 'wrangler.json');
      const preload = join(directory, 'mock-cf.mjs');
      writeFileSync(
        configPath,
        JSON.stringify({ name: 'test-worker', account_id: 'test-account' }),
      );
      writeFileSync(
        preload,
        `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setKeyProviderFactoryForTesting } from ${JSON.stringify(import.meta.resolve('@cloudflare/workers-auth'))};
import { createCfAuth } from ${JSON.stringify(import.meta.resolve('@cloudflare/workers-auth/cf'))};
let key;
setKeyProviderFactoryForTesting(() => ({ getKey: () => key, setKey: (value) => { key = value; }, deleteKey: () => { key = undefined; }, describe: () => 'synthetic provider' }));
const logger = { debug() {}, info() {}, log() {}, warn() {}, error() {} };
const auth = createCfAuth({ logger, userAgent: 'void-test', prompt: async () => '', select: async () => '', isNoDefaultValueProvidedError: () => false });
auth.writeAuthCredentials({ oauth_token: 'synthetic-oauth-token', refresh_token: 'synthetic-refresh', expiration_time: new Date(Date.now() + 3600000).toISOString(), scopes: [] });
const credentialPath = auth.getCredentialStore().path();
child.spawnSync = (_binary, args, options) => {
  if (args[1] !== 'auth' || args[2] !== 'whoami' || options.env.CLOUDFLARE_AUTH_USE_KEYRING !== 'true') {
    return { status: 1, stdout: '', stderr: 'Wrong authentication source.' };
  }
  return { status: 0, stdout: JSON.stringify({ authenticated: true, tokenValid: true, authSource: 'OAuth token from ' + credentialPath }), stderr: '' };
};
syncBuiltinESMExports();
`,
      );
      const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'cf-compat.ts');
      const output = await new Promise<{ status: number; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [
            '--import',
            pathToFileURL(preload).href,
            entry,
            'triggers',
            operation,
            '-c',
            configPath,
            '--name',
            'test-worker',
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              CI: 'true',
              CLOUDFLARE_AUTH_USE_KEYRING: 'true',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
              HOME: directory,
              USERPROFILE: directory,
              XDG_CONFIG_HOME: directory,
            },
          },
          (error, _stdout, stderr) => resolve({ status: error ? 1 : 0, stderr }),
        );
      });
      expect(output.status, output.stderr).toBe(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it('reports an absent cf session as authentication failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-no-auth-'));
  try {
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [...prefix, 'whoami', '--json'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              HOME: directory,
              USERPROFILE: directory,
              XDG_CONFIG_HOME: directory,
              CI: 'true',
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stdout).toBe(1);
    expect(JSON.parse(output.stdout)).toEqual({ loggedIn: false });
    expect(output.stderr).toContain('authentication is required');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('discovers KV namespaces beyond the first cf API page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-kv-pages-'));
  const requestedPages: Array<number> = [];
  const namespaces = Array.from({ length: 100 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, '0'),
    title: `other-${index}`,
  }));
  const target = { id: 'f'.repeat(32), title: 'existing-void-kv' };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://127.0.0.1');
    expect(url.pathname).toBe('/client/v4/accounts/test-account/storage/kv/namespaces');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('order')).toBe('id');
    expect(url.searchParams.get('direction')).toBe('asc');
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: page === 1 ? namespaces : page === 2 ? [target] : [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [...prefix, 'kv', 'namespace', 'list', '-c', configPath, '--env=', '--json'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              CI: 'true',
              CF_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([...namespaces, target]);
    expect(requestedPages).toEqual([1, 2]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('finds existing Queues beyond the first cf API page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-queue-pages-'));
  const requestedPages: Array<number> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://127.0.0.1');
    expect(url.pathname).toBe('/client/v4/accounts/test-account/queues');
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        result: [
          page === 1
            ? { queue_id: 'first-queue', queue_name: 'another-queue' }
            : { queue_id: 'target-queue', queue_name: 'existing-void-queue' },
        ],
        result_info: { page, per_page: 1, total_pages: 2, total_count: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [...prefix, 'queues', 'info', 'existing-void-queue', '-c', configPath],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              CI: 'true',
              CF_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(output.stdout).toContain('Queue Name: existing-void-queue');
    expect(requestedPages).toEqual([1, 2]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('uses pinned cf despite a project-local CLI and preserves D1 results and the CF token alias', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-d1-contract-'));
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: [{ results: [{ name: '0001_setup.sql' }], success: true, meta: {} }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = join(directory, 'node_modules', 'cf');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(
      join(local, 'package.json'),
      JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
    );
    writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        account_id: 'test-account',
        d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [
            ...prefix,
            'd1',
            'execute',
            'DB',
            '--remote',
            '--command',
            'SELECT name FROM d1_migrations',
            '--json',
            '-c',
            configPath,
            '--env=',
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              TMP: process.env.TMP,
              TEMP: process.env.TEMP,
              CI: 'true',
              CF_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (_error, stdout, stderr) => resolve({ status: _error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([
      { results: [{ name: '0001_setup.sql' }], success: true, meta: {} },
    ]);
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/client/v4/accounts/test-account/d1/database/test-database/query',
        authorization: 'Bearer synthetic-token',
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('uses the configured HTTP proxy for cf resource requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-resource-proxy-'));
  let proxied = 0;
  let queried = 0;
  const api = createServer((request, response) => {
    queried++;
    expect(request.url).toBe('/client/v4/accounts/test-account/d1/database/test-database/query');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, result: [{ results: [], success: true }] }));
  });
  const proxy = createServer((request, response) => {
    proxied++;
    const upstream = httpRequest(
      request.url!,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    request.pipe(upstream);
    upstream.on('error', () => response.destroy());
  });
  proxy.on('connect', (request, socket, head) => {
    proxied++;
    const [host, port] = request.url!.split(':');
    const upstream = connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        account_id: 'test-account',
        d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stderr: string }>((resolve) => {
      execFile(
        command!,
        [...prefix, 'd1', 'execute', 'DB', '--command', 'SELECT 1', '-c', configPath],
        {
          cwd: directory,
          timeout: 20_000,
          env: {
            ...process.env,
            CF_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`,
            HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
            HTTPS_PROXY: '',
            NO_PROXY: '',
          },
        },
        (error, _stdout, stderr) => resolve({ status: error ? 1 : 0, stderr }),
      );
    });
    expect(output.status, output.stderr).toBe(0);
    expect(queried).toBe(1);
    expect(proxied).toBe(1);
  } finally {
    await Promise.all(
      [api, proxy].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('stops a prebuilt platform upload before cf can create a missing R2 bucket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-platform-r2-preflight-'));
  const requests: Array<string> = [];
  const api = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: false, errors: [{ code: 10006 }] }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      join(directory, 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        account_id: 'test-account',
        compatibility_date: '2026-09-29',
        main: 'index.js',
        no_bundle: true,
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'missing-bucket' }],
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stderr: string }>((resolve) => {
      execFile(
        command!,
        [...prefix, 'versions', 'upload', '-c', configPath],
        {
          cwd: directory,
          timeout: 20_000,
          env: {
            ...process.env,
            CF_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            http_proxy: '',
            https_proxy: '',
          },
        },
        (error, _stdout, stderr) => resolve({ status: error ? 1 : 0, stderr }),
      );
    });
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('refusing automatic provisioning');
    expect(requests).toEqual(['GET /client/v4/accounts/test-account/r2/buckets/missing-bucket']);
  } finally {
    await new Promise<void>((resolve) => {
      api.close(() => resolve());
      api.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('allows a prebuilt platform upload when named resources already exist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-platform-resource-preflight-'));
  const requests: Array<string> = [];
  const jurisdictions: Array<string | undefined> = [];
  const api = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(`${request.method} ${path}`);
    if (path.includes('/r2/buckets/')) {
      jurisdictions.push(request.headers['cf-r2-jurisdiction'] as string | undefined);
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        result:
          path.endsWith('/queues') || path.includes('/queues?page=')
            ? [{ queue_id: 'queue-id', queue_name: 'existing-queue' }]
            : {},
        ...(path.includes('/queues?page=') ? { result_info: { page: 1, total_pages: 1 } } : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      join(directory, 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        account_id: 'test-account',
        compatibility_date: '2026-09-29',
        main: 'index.js',
        no_bundle: true,
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'existing-bucket', jurisdiction: 'eu' }],
        queues: { producers: [{ binding: 'JOBS', queue: 'existing-queue' }] },
        dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'existing-namespace' }],
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [...prefix, 'versions', 'upload', '-c', configPath, '--dry-run'],
          {
            cwd: directory,
            timeout: 20_000,
            env: {
              ...process.env,
              CF_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`,
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              http_proxy: '',
              https_proxy: '',
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(output.stdout).toContain('Dry run complete');
    expect(requests).toEqual([
      'GET /client/v4/accounts/test-account/r2/buckets/existing-bucket',
      'GET /client/v4/accounts/test-account/workers/dispatch/namespaces/existing-namespace',
      'GET /client/v4/accounts/test-account/queues?page=1',
    ]);
    expect(jurisdictions).toEqual(['eu']);
  } finally {
    await new Promise<void>((resolve) => {
      api.close(() => resolve());
      api.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('inspects existing Worker versions through an HTTP proxy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-proxy-contract-'));
  const versionId = '11111111-1111-4111-8111-111111111111';
  let proxied = 0;
  let inspected = 0;
  const api = createServer((request, response) => {
    inspected++;
    expect(request.url).toBe(
      `/client/v4/accounts/test-account/workers/scripts/test-worker/versions/${versionId}`,
    );
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        result: {
          resources: { bindings: [], script: { handlers: ['fetch'] }, script_runtime: {} },
        },
      }),
    );
  });
  const proxy = createServer();
  proxy.on('connect', (request, socket, head) => {
    proxied++;
    const [host, port] = request.url!.split(':');
    const upstream = connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    const configPath = join(directory, 'wrangler.json');
    const preload = join(directory, 'mock-cf.mjs');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ id: '${versionId}', bindings: [] }), stderr: '' });
syncBuiltinESMExports();
`,
    );
    const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'cf-compat.ts');
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            '--import',
            pathToFileURL(preload).href,
            entry,
            'versions',
            'view',
            versionId,
            '-c',
            configPath,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
              ...process.env,
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`,
              HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
              HTTPS_PROXY: '',
              NO_PROXY: '',
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).resources.bindings).toEqual([]);
    expect(proxied).toBe(1);
    expect(inspected).toBe(1);
  } finally {
    await Promise.all(
      [api, proxy].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
