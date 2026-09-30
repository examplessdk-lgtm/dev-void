import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { expect, it } from 'vite-plus/test';
import { withConditionalPlatformWorkerCreate } from '../../src/cli/platform-installer.ts';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

it('accepts the bundled uploader query while preserving the create-only precondition', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-worker-upload-contract-'));
  const uploads: Array<{ url: string; precondition: string | undefined }> = [];
  const requests: Array<string> = [];
  // This is a local fake API. A synthetic credential and isolated config ensure
  // this contract test cannot deploy to any real Cloudflare account.
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(`${request.method} ${url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'PUT') {
      uploads.push({ url, precondition: request.headers['if-none-match'] });
      request.resume();
      response.writeHead(412);
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: 'Simulated concurrent creation.' }],
        }),
      );
    } else if (url.endsWith('/workers/subdomain')) {
      response.end(JSON.stringify({ success: true, result: { subdomain: 'test' } }));
    } else {
      response.writeHead(404);
      response.end(
        JSON.stringify({ success: false, errors: [{ code: 10007, message: 'Worker not found.' }] }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
  try {
    writeFileSync(
      join(directory, 'worker.mjs'),
      'export default { fetch() { return new Response("local test"); } };',
    );
    const config = join(directory, 'wrangler.json');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'void-contract',
        account_id: 'account',
        main: 'worker.mjs',
        compatibility_date: '2026-02-24',
        workers_dev: false,
        preview_urls: false,
        no_bundle: true,
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(process.cwd());
    let output = '';
    const failure = await withConditionalPlatformWorkerCreate(
      'account',
      'void-contract',
      async (apiBase) => {
        await new Promise<void>((resolve) => {
          const child = execFile(
            command!,
            [
              ...prefix,
              'deploy',
              '--config',
              config,
              '--strict',
              '--experimental-provision=false',
              '--experimental-auto-create=false',
              '--autoconfig=false',
            ],
            {
              cwd: directory,
              encoding: 'utf8',
              timeout: 20_000,
              maxBuffer: 1024 * 1024,
              env: {
                PATH: process.env.PATH,
                SYSTEMROOT: process.env.SYSTEMROOT,
                WINDIR: process.env.WINDIR,
                TMP: process.env.TMP,
                TEMP: process.env.TEMP,
                CI: 'true',
                CLOUDFLARE_API_TOKEN: 'synthetic-token',
                CLOUDFLARE_API_BASE_URL: apiBase,
                WRANGLER_SEND_METRICS: 'false',
                WRANGLER_LOG_PATH: join(directory, 'logs'),
              },
            },
            (_error, stdout, stderr) => {
              output = stdout + stderr;
              resolve();
            },
          );
          child.stdin?.end();
        });
      },
      origin,
    ).catch((error: unknown) => error);
    expect(String(failure), output + '\n' + requests.join('\n')).toContain(
      'created concurrently (HTTP 412)',
    );
    expect(uploads).toHaveLength(1);
    const url = new URL(uploads[0]!.url, origin);
    expect(url.pathname).toBe('/client/v4/accounts/account/workers/scripts/void-contract');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      excludeScript: 'true',
      bindings_inherit: 'strict',
    });
    expect(uploads[0]!.precondition).toBe('*');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

it.each([false, true])(
  'uploads static assets before the guarded create of a new Worker (single-file uploads: %s)',
  async (singleAssetUploads) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-worker-assets-contract-'));
    const sessionJwt = unsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(singleAssetUploads ? { wrangler_single_asset_uploads: true } : {}),
    });
    const completionJwt = unsignedJwt({ exp: Math.floor(Date.now() / 1000) + 3600, done: true });
    const requests: Array<{
      authorization: string | undefined;
      body: string;
      precondition: string | undefined;
      request: string;
    }> = [];
    // A local fake API with a synthetic credential; nothing can reach a real account.
    const server = createServer((request, response) => {
      const url = request.url ?? '';
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body,
          precondition: request.headers['if-none-match'],
          request: `${request.method} ${url}`,
        });
        response.setHeader('Content-Type', 'application/json');
        const path = new URL(url, 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path.endsWith('/assets-upload-session')) {
          const { manifest } = JSON.parse(body) as {
            manifest: Record<string, { hash: string }>;
          };
          response.end(
            JSON.stringify({
              success: true,
              result: {
                jwt: sessionJwt,
                buckets: [Object.values(manifest).map((entry) => entry.hash)],
              },
            }),
          );
        } else if (request.method === 'POST' && path.includes('/workers/assets/upload')) {
          response.writeHead(201);
          response.end(JSON.stringify({ success: true, result: { jwt: completionJwt } }));
        } else if (request.method === 'PUT') {
          response.writeHead(412);
          response.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: 'Simulated concurrent creation.' }],
            }),
          );
        } else {
          response.writeHead(404);
          response.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 10007, message: 'Worker not found.' }],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    try {
      writeFileSync(
        join(directory, 'worker.mjs'),
        'export default { fetch() { return new Response("local test"); } };',
      );
      mkdirSync(join(directory, 'public'));
      writeFileSync(join(directory, 'public', 'client.js'), 'console.log("admin");');
      const config = join(directory, 'wrangler.json');
      writeFileSync(
        config,
        JSON.stringify({
          name: 'void-contract',
          account_id: 'account',
          main: 'worker.mjs',
          compatibility_date: '2026-02-24',
          workers_dev: false,
          preview_urls: false,
          no_bundle: true,
          assets: { directory: toSlash(join(directory, 'public')) },
        }),
      );
      const [command, ...prefix] = resolveWranglerArgv(process.cwd());
      let output = '';
      const failure = await withConditionalPlatformWorkerCreate(
        'account',
        'void-contract',
        async (apiBase) => {
          await new Promise<void>((resolve) => {
            const child = execFile(
              command!,
              [
                ...prefix,
                'deploy',
                '--config',
                config,
                '--strict',
                '--experimental-provision=false',
                '--experimental-auto-create=false',
                '--autoconfig=false',
              ],
              {
                cwd: directory,
                encoding: 'utf8',
                timeout: 20_000,
                maxBuffer: 1024 * 1024,
                env: {
                  PATH: process.env.PATH,
                  SYSTEMROOT: process.env.SYSTEMROOT,
                  WINDIR: process.env.WINDIR,
                  TMP: process.env.TMP,
                  TEMP: process.env.TEMP,
                  CI: 'true',
                  CLOUDFLARE_API_TOKEN: 'synthetic-token',
                  CLOUDFLARE_API_BASE_URL: apiBase,
                  WRANGLER_SEND_METRICS: 'false',
                  WRANGLER_LOG_PATH: join(directory, 'logs'),
                },
              },
              (_error, stdout, stderr) => {
                output = stdout + stderr;
                resolve();
              },
            );
            child.stdin?.end();
          });
        },
        origin,
      ).catch((error: unknown) => error);
      const trace = output + '\n' + requests.map((entry) => entry.request).join('\n');
      expect(String(failure), trace).toContain('created concurrently (HTTP 412)');
      const mutations = requests.filter((entry) => !entry.request.startsWith('GET '));
      const hash = /upload\/([0-9a-f]{32})$/.exec(mutations[1]?.request ?? '')?.[1];
      expect(
        mutations.map((entry) => entry.request),
        trace,
      ).toEqual([
        'POST /client/v4/accounts/account/workers/scripts/void-contract/assets-upload-session',
        singleAssetUploads
          ? `POST /client/v4/accounts/account/workers/assets/upload/${hash}`
          : 'POST /client/v4/accounts/account/workers/assets/upload?base64=true',
        'PUT /client/v4/accounts/account/workers/scripts/void-contract?excludeScript=true&bindings_inherit=strict',
      ]);
      expect(mutations.map((entry) => entry.authorization)).toEqual([
        'Bearer synthetic-token',
        `Bearer ${sessionJwt}`,
        'Bearer synthetic-token',
      ]);
      expect(mutations.map((entry) => entry.precondition)).toEqual([undefined, undefined, '*']);
      expect(mutations[2]!.body).toContain(completionJwt);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
