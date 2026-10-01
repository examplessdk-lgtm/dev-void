import childProcess, { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getWorkerConfigPath } from '@cloudflare/build-output-utils';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  deployCloudflareVersionTriggers,
  encodeCloudflareVersionMessage,
} from '../../../deploy-cloudflare/src/version.ts';
import {
  operationFixture,
  operationFixtureRequest,
} from '../../../deploy-cloudflare/test/operation-fixture.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import { uploadPinnedCloudflareVersion } from '../../src/cli/cf-version-api.ts';
import {
  createActiveSecretPinner,
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
  pinActiveWorkerSecrets,
} from '../../src/cli/cf-version-runner.ts';

const roots: Array<string> = [];
const pinnedCfVersion = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('cf/package.json')), 'utf8'),
).version as string;
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves real cf provider codes so a missing Worker can reach its first upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-missing-worker-'));
  roots.push(root);
  const requests: Array<string> = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10007, message: 'The given script does not exist.' }],
        result: null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    const script = `
      import { createCfCommand } from ${JSON.stringify(new URL('../../src/cli/cf-version-runner.ts', import.meta.url).href)};
      const command = createCfCommand({
        accountId: 'test-account', apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
        env: () => process.env, verifyUploader: () => true,
      });
      console.log(JSON.stringify(await command(
        ['workers', 'deployments', 'list', '--worker', 'missing-worker'],
        { cwd: ${JSON.stringify(root)}, capture: true },
      )));
    `;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP,
            CI: 'true',
            CLOUDFLARE_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
          },
        },
        (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout)),
      );
    });
    const missing = JSON.parse(stdout);
    expect(missing.status).toBe(1);
    expect(missing.errorCode).toBe(10007);
    expect(requests).toEqual([
      '/client/v4/accounts/test-account/workers/scripts/missing-worker/deployments',
    ]);
    const operations: Array<string> = [];
    const result = await activateCloudflareVersion({
      workerName: 'missing-worker',
      message: 'review',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      runWrangler: operationFixture((args) => {
        operations.push(args.slice(0, 2).join(' '));
        return args[1] === 'upload'
          ? { status: 1, stdout: '', stderr: 'Test stopped before uploading.' }
          : missing;
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'upload-failed' });
    expect(operations).toEqual(['deployments status', 'versions list', 'versions upload']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('classifies the pinned prebuilt uploader’s missing-Worker diagnostic', async () => {
  const prepared = await output();
  const requests: Array<string> = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10007, message: 'The given script does not exist.' }],
        result: null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    const command = createCfCommand({
      accountId: 'account-id',
      apiBaseUrl,
      verifyUploader: () => true,
      env: () => ({
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        CI: 'true',
        CLOUDFLARE_API_TOKEN: 'synthetic-token',
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      }),
    });
    const result = await command(['workers', 'versions', 'create', '--prebuilt'], {
      cwd: prepared.directory,
      capture: true,
    });
    expect(result, result.stdout + result.stderr).toMatchObject({
      status: 1,
      failure: 'not-found',
      signal: null,
      error: null,
    });
    // cf deliberately omits the API code from this local error.
    expect(result.errorCode).toBeUndefined();
    expect(requests).toEqual(['/client/v4/accounts/account-id/workers/services/void-test']);
  } finally {
    prepared.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('captures a version list larger than Node’s default child-process buffer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-large-version-list-'));
  roots.push(root);
  const version = {
    id: '00000000-0000-0000-0000-000000000001',
    number: 1,
    modules: [{ name: 'index.js', content_base64: 'a'.repeat(2 * 1024 * 1024) }],
  };
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, errors: [], result: [version] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    const script = `
      import { createCfCommand } from ${JSON.stringify(new URL('../../src/cli/cf-version-runner.ts', import.meta.url).href)};
      const command = createCfCommand({
        accountId: 'test-account', apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
        env: () => process.env, verifyUploader: () => true,
      });
      const result = await command(
        ['workers', 'versions', 'list', '--worker-id', 'large-worker', '--per-page', '10'],
        { cwd: ${JSON.stringify(root)}, capture: true },
      );
      console.log(JSON.stringify({ status: result.status, length: result.stdout.length, error: result.error }));
    `;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP,
            CI: 'true',
            CLOUDFLARE_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
          },
        },
        (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout)),
      );
    });
    expect(JSON.parse(stdout)).toEqual({ status: 0, length: expect.any(Number), error: null });
    expect((JSON.parse(stdout) as { length: number }).length).toBeGreaterThan(1024 * 1024);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('treats a verified empty deployment list as missing but rejects malformed status', async () => {
  const prepared = await output();
  try {
    for (const body of [{ deployments: [] }, {}]) {
      const calls: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          calls.push(args);
          return args[1] === 'deployments'
            ? { status: 0, stdout: JSON.stringify(body), stderr: '' }
            : { status: 1, stdout: '', stderr: 'Test stopped before uploading.' };
        },
      });
      const result = await activateCloudflareVersion({
        workerName: 'void-test',
        message: 'review',
        verifyUploader: () => true,
        runWrangler: runner,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'deployments' in body ? 'upload-failed' : 'status-failed',
      });
      expect(calls).toHaveLength('deployments' in body ? 2 : 1);
    }
  } finally {
    prepared.dispose();
  }
});

async function output(config: Record<string, unknown> = {}, additionalAsset = false) {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-runner-test-'));
  roots.push(root);
  const worker = join(root, 'dist', 'ssr');
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, 'index.js'), 'export default { fetch: () => new Response("ok") };');
  const assets = config.assets as { directory?: string } | undefined;
  if (assets?.directory) {
    const directory = join(worker, assets.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.html'), '<h1>Public</h1>');
    if (additionalAsset) {
      writeFileSync(join(directory, 'module.js'), 'export const ready = true;');
      writeFileSync(join(directory, 'style.css'), 'body { color: red; }');
      writeFileSync(join(directory, 'image.png'), Buffer.from([137, 80, 78, 71]));
      writeFileSync(join(directory, 'opaque.unknown'), 'opaque');
    }
    writeFileSync(join(directory, 'private.txt'), 'Never upload this');
    writeFileSync(join(directory, '.assetsignore'), 'private.txt\n');
  }
  writeFileSync(
    join(worker, 'wrangler.json'),
    JSON.stringify({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      workers_dev: true,
      ...config,
    }),
  );
  const prepared = await prepareCfBuildOutput(worker, 'account-id');
  expect(prepared).not.toBeNull();
  return prepared!;
}

async function verifyPinnedUpload(atomic: boolean): Promise<void> {
  const prepared = await output(
    {
      secrets: { required: ['AUTH_SECRET'] },
      version_metadata: { binding: 'APP_VERSION' },
      keep_secrets: true,
      keep_vars: true,
      assets: { directory: '../client', binding: 'ASSETS', not_found_handling: 'none' },
    },
    true,
  );
  try {
    const activeVersionId = '11111111-1111-4111-8111-111111111111';
    const pinActiveSecrets = createActiveSecretPinner({
      output: prepared,
      handoffPending: false,
      requiredNames: ['AUTH_SECRET'],
    });
    expect(pinActiveSecrets).toBeDefined();
    expect(
      await pinActiveSecrets!(activeVersionId, [
        { name: 'AUTH_SECRET', type: 'secret_text' },
        { name: 'KEY', type: 'secret_key' },
      ]),
    ).toBe(true);
    const worker = JSON.parse(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8'));
    expect(worker.env.AUTH_SECRET).toEqual({ type: 'secret' });
    expect(prepared.activeSecrets).toEqual({
      versionId: activeVersionId,
      bindings: [
        { name: 'AUTH_SECRET', type: 'secret_text' },
        { name: 'KEY', type: 'secret_key' },
      ],
    });
    const requests: Array<{ url: string; body: string; authorization: string | undefined }> = [];
    let uploadedBatches = 0;
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const path = request.url ?? '';
      const result = path.endsWith('/assets-upload-session')
        ? {
            jwt: 'asset-token',
            buckets: Object.values(JSON.parse(requests.at(-1)!.body).manifest).map((entry) => [
              (entry as { hash: string }).hash,
            ]),
          }
        : path.includes('/assets/upload')
          ? ++uploadedBatches === 5
            ? { jwt: 'completion-token' }
            : {}
          : request.method === 'GET'
            ? {
                id: activeVersionId,
                bindings: [
                  { name: 'AUTH_SECRET', type: 'secret_text' },
                  { name: 'KEY', type: 'secret_key' },
                  { name: 'DASHBOARD_VAR', type: 'plain_text' },
                ],
              }
            : { id: '22222222-2222-4222-8222-222222222222', urls: [] };
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const uploaded = await uploadPinnedCloudflareVersion({
        output: prepared,
        accountId: 'account-id',
        apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
        workerName: 'void-test',
        token: 'synthetic-token',
        atomic,
        verifyUploader: () => true,
      });
      expect(uploaded.id).toBe('22222222-2222-4222-8222-222222222222');
      const upload = requests.find(({ url }) =>
        url.endsWith(atomic ? '/versions?deploy=true' : '/versions'),
      );
      expect(upload).toBeDefined();
      const body = JSON.parse(upload!.body);
      expect(body.bindings).toEqual(
        expect.arrayContaining([
          { name: 'AUTH_SECRET', type: 'inherit', version_id: activeVersionId },
          { name: 'KEY', type: 'inherit', version_id: activeVersionId },
          { name: 'DASHBOARD_VAR', type: 'inherit', version_id: activeVersionId },
          { name: 'APP_VERSION', type: 'version_metadata' },
        ]),
      );
      expect(body.modules).toEqual([expect.objectContaining({ name: 'index.js' })]);
      expect(body.assets).toEqual({
        jwt: 'completion-token',
        config: { not_found_handling: 'none' },
      });
      expect(body.bindings).toContainEqual({ name: 'ASSETS', type: 'assets' });
      const session = requests.find(({ url }) => url.endsWith('/assets-upload-session'));
      const manifest = JSON.parse(session!.body).manifest as Record<string, { hash: string }>;
      expect(Object.keys(manifest)).toEqual(
        expect.arrayContaining([
          '/index.html',
          '/module.js',
          '/style.css',
          '/image.png',
          '/opaque.unknown',
        ]),
      );
      expect(Object.keys(manifest)).toHaveLength(5);
      const assetUploads = requests.filter(({ url }) => url.includes('/assets/upload'));
      for (const [name, contentType, contents] of [
        ['index.html', 'text/html', Buffer.from('<h1>Public</h1>')],
        ['module.js', 'text/javascript', Buffer.from('export const ready = true;')],
        ['style.css', 'text/css', Buffer.from('body { color: red; }')],
        ['image.png', 'image/png', Buffer.from([137, 80, 78, 71])],
        ['opaque.unknown', 'application/null', Buffer.from('opaque')],
      ] as const) {
        const hash = manifest[`/${name}`].hash;
        const upload = assetUploads.find(({ body }) => body.includes(`name="${hash}"`));
        expect(upload?.body).toContain(`filename="${hash}"`);
        expect(upload?.body).toContain(`Content-Type: ${contentType}`);
        expect(upload?.body).toContain(contents.toString('base64'));
      }
      expect(assetUploads.map(({ authorization }) => authorization)).toEqual(
        Array(5).fill('Bearer asset-token'),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    prepared.dispose();
  }
}

it('uploads live secrets and multiple asset batches when the latest upload is inactive', () =>
  verifyPinnedUpload(false));

it('uploads live secrets and multiple asset batches for atomic publication', () =>
  verifyPinnedUpload(true));

it.each([false, true])(
  'publishes the intended custom domain before pinned-secret bootstrap readiness (atomic=%s)',
  async (atomic) => {
    const current = '11111111-1111-4111-8111-111111111111';
    const next = '22222222-2222-4222-8222-222222222222';
    const domain = 'app.example.com';
    const triggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: domain, custom_domain: true }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const prepared = await output({
      workers_dev: false,
      preview_urls: false,
      routes: triggerConfig.routes,
      secrets: { required: ['AUTH_SECRET'] },
    });
    const events: Array<string> = [];
    let active = current;
    let published = false;
    const server = createServer(async (request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const upload = request.method === 'POST';
      if (upload && request.url?.endsWith('?deploy=true')) {
        active = next;
        events.push('activate');
      }
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: upload
            ? { id: next, urls: [] }
            : { id: current, bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const pinActiveSecrets = createActiveSecretPinner({
        output: prepared,
        handoffPending: false,
        requiredNames: ['AUTH_SECRET'],
      })!;
      // A secret-only first Worker can already require version-pinned inheritance.
      await pinActiveSecrets(current, [{ name: 'AUTH_SECRET', type: 'secret_text' }]);
      const runCf = async (args: Array<string>, options: { cwd: string }) => {
        if (args.slice(0, 3).join(' ') === 'workers deployments list') {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              deployments: [{ versions: [{ version_id: active, percentage: 100 }] }],
            }),
          };
        }
        if (args.slice(0, 3).join(' ') === 'workers versions get') {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              id: args[3],
              bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
            }),
          };
        }
        expect(args).toEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
        const config = JSON.parse(readFileSync(getWorkerConfigPath(options.cwd), 'utf8'));
        expect(active).toBe(next);
        expect(config.domains).toEqual([domain]);
        expect(config.workersDev).toBe(false);
        expect(config.previewUrls).toBe(false);
        expect(config.env).toEqual({ AUTH_SECRET: { type: 'secret' } });
        published = true;
        events.push('publish-domain');
        return { status: 0, stdout: '', stderr: '' };
      };
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf,
        verifyResources: createCfResourceVerifier({
          configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
          runCf,
          runWrangler: () => {
            throw new Error('An app without paid bindings must not probe paid services.');
          },
          verifyCompatibilityRunner: () => true,
        }),
        pinnedUpload: {
          accountId: 'account-id',
          apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
          getToken: async () => 'synthetic-token',
          verifyUploader: () => true,
        },
      });
      const result = await activateCloudflareVersion({
        runWrangler: runner,
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
        verifyUploader: () => true,
        pinActiveSecrets,
        atomic,
        allowFirstDeploymentBootstrap: true,
        readinessAttempts: 1,
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: async (url) => {
          expect(url).toBe(`https://${domain}/__void/ready`);
          events.push('readiness');
          return Response.json({ ready: published });
        },
      });
      expect(result, JSON.stringify({ result, events })).toMatchObject({
        ok: true,
        versionId: next,
        previewUrl: `https://${domain}`,
      });
      expect(events).toEqual(['activate', 'publish-domain', 'readiness']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await prepared.dispose();
    }
  },
);

it('does not pin active secrets during an existing-Worker handoff', async () => {
  const prepared = await output();
  try {
    expect(
      createActiveSecretPinner({ output: prepared, handoffPending: true, requiredNames: [] }),
    ).toBeUndefined();
  } finally {
    prepared.dispose();
  }
});

it('refuses to pin when a required secret is absent from the live version', async () => {
  const prepared = await output({ secrets: { required: ['AUTH_SECRET'] } });
  try {
    expect(
      await pinActiveWorkerSecrets({
        output: prepared,
        activeVersionId: '11111111-1111-4111-8111-111111111111',
        bindings: [],
        requiredNames: ['AUTH_SECRET'],
      }),
    ).toBe(false);
  } finally {
    prepared.dispose();
  }
});

it('does not delegate credentialed commands to a project-local cf', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-pinned-command-'));
  roots.push(root);
  const local = join(root, 'node_modules', 'cf');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(
    join(local, 'package.json'),
    JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
  );
  writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
  const command = createCfCommand({
    accountId: 'test-account',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    verifyUploader: () => true,
    env: () => ({ PATH: process.env.PATH, CI: 'true', CLOUDFLARE_API_TOKEN: 'synthetic-token' }),
  });
  const result = await command(['--version'], { cwd: root, capture: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain('UNPINNED_PROJECT_CF_EXECUTED');
  expect(result.stdout).toContain(pinnedCfVersion);
});

it('captures noninteractive cf output when Void owns the terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-quiet-command-'));
  roots.push(root);
  const command = createCfCommand({
    accountId: 'test-account',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    verifyUploader: () => true,
    env: () => ({ PATH: process.env.PATH, CI: 'true' }),
  });
  const result = await command(['--version'], { cwd: root, capture: false });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(pinnedCfVersion);
});

it.each([
  { diagnostic: 'synthetic provider failure [10007]', args: ['--version'] },
  {
    diagnostic: 'You cannot upload a new version of a Worker that does not yet exist.',
    args: ['workers', 'versions', 'create', '--prebuilt'],
  },
])(
  'does not classify buffered diagnostics from a terminated real cf process ($diagnostic)',
  async ({ diagnostic, args }) => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-interrupted-command-'));
    roots.push(root);
    const preload = join(root, 'interrupt.cjs');
    writeFileSync(
      preload,
      `process.stderr.write(${JSON.stringify(diagnostic + '\n')});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const command = createCfCommand({
      accountId: 'test-account',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      verifyUploader: () => true,
      env: () => ({
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        CI: 'true',
      }),
    });
    const spawn = childProcess.spawn;
    // Windows does not report a signal when a process kills itself. Terminate
    // the real child from its parent after the diagnostic is buffered instead.
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = spawn(...args);
      child.stderr?.once('data', () => child.kill('SIGTERM'));
      return child;
    });
    syncBuiltinESMExports();
    let result: Awaited<ReturnType<typeof command>>;
    try {
      result = await command(args, { cwd: root, capture: true });
    } finally {
      spawnSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toContain(diagnostic);
    expect(result.errorCode).toBeUndefined();
    expect(result.errors).toBeUndefined();
    expect(result.failure).toBeUndefined();
  },
);

it('preserves interruption provenance before interpreting an empty cf deployment list', async () => {
  const prepared = await output();
  try {
    const run = createCfVersionRunner({
      output: prepared,
      workerName: 'site',
      runCf: async () => ({
        status: 0,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        data: { deployments: [] },
      }),
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const result = await run({ type: 'deployments.status', workerName: 'site' }, { capture: true });
    expect(result.signal).toBe('SIGTERM');
    expect(result.errorCode).toBeUndefined();
  } finally {
    prepared.dispose();
  }
});

it('uses the configured HTTP proxy for direct cf activation reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-proxy-read-'));
  roots.push(root);
  const requests: Array<string> = [];
  const respond = (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => {
    requests.push(new URL(request.url ?? '/', 'http://cf-proxy-test.invalid').href);
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        result: [{ id: '00000000-0000-0000-0000-000000000001', number: 1 }],
      }),
    );
  };
  const api = createServer(respond);
  const proxy = createServer(respond);
  const tunnels = new Set<Duplex>();
  proxy.on('connect', (_request, socket, head) => {
    const upstream = connect((api.address() as AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    tunnels.add(socket);
    tunnels.add(upstream);
    socket.on('close', () => tunnels.delete(socket));
    upstream.on('close', () => tunnels.delete(upstream));
    upstream.on('error', () => socket.destroy());
  });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const apiBaseUrl = 'http://cf-proxy-test.invalid/client/v4';
    const script = `
      import { createCfCommand } from ${JSON.stringify(new URL('../../src/cli/cf-version-runner.ts', import.meta.url).href)};
      const command = createCfCommand({
        accountId: 'test-account', apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
        env: () => process.env, verifyUploader: () => true,
      });
      const result = await command(
        ['workers', 'versions', 'list', '--worker-id', 'proxy-worker'],
        { cwd: ${JSON.stringify(root)}, capture: true },
      );
      console.log(JSON.stringify({ status: result.status, stdout: result.stdout }));
    `;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP,
            CI: 'true',
            HTTP_PROXY: proxyUrl,
            NO_PROXY: '',
            CLOUDFLARE_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
          },
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
      );
    });
    const result = JSON.parse(stdout) as { status: number; stdout: string };
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('00000000-0000-0000-0000-000000000001');
    expect(requests).toEqual([
      'http://cf-proxy-test.invalid/client/v4/accounts/test-account/workers/workers/proxy-worker/versions',
    ]);
  } finally {
    for (const tunnel of tunnels) {
      tunnel.destroy();
    }
    await Promise.all(
      [api, proxy].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  }
}, 30_000);

it('preserves activation metadata and sorts cf version history for the existing protocol', async () => {
  const prepared = await output();
  try {
    const calls: Array<Array<string>> = [];
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        if (args[1] === 'deployments' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify({
              deployments: [{ versions: [{ version_id: 'one', percentage: 100 }] }],
            }),
            stderr: '',
          };
        }
        if (args[1] === 'versions' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 'two', number: 2 },
              { id: 'one', number: 1 },
            ]),
            stderr: '',
          };
        }
        return {
          status: 0,
          stdout: 'Worker Version ID: 00000000-0000-0000-0000-000000000001',
          stderr: '',
        };
      },
    });
    const common = ['-c', 'generated.json', '--env=', '--name', 'void-test'];
    const deployment = await runner(
      operationFixtureRequest(['deployments', 'status', ...common, '--json']),
      {
        capture: true,
      },
    );
    expect(deployment.data).toEqual({
      versions: [{ version_id: 'one', percentage: 100 }],
    });
    const versions = await runner(
      operationFixtureRequest(['versions', 'list', ...common, '--json']),
      { capture: true },
    );
    expect((versions.data as Array<{ id: string }>).map((item: { id: string }) => item.id)).toEqual(
      ['one', 'two'],
    );
    expect(calls.at(-1)).toEqual([
      'workers',
      'versions',
      'list',
      '--worker-id',
      'void-test',
      '--per-page',
      '10',
      '--page',
      '1',
    ]);
    await runner(
      operationFixtureRequest([
        'versions',
        'upload',
        ...common,
        '--message',
        'void:metadata',
        '--preview-alias',
        'void-ready',
        '--strict',
      ]),
      { capture: true },
    );
    expect(calls.at(-1)).toEqual([
      'workers',
      'versions',
      'create',
      '--prebuilt',
      '--message',
      'void:metadata',
      '--preview-alias',
      'void-ready',
    ]);
    await runner(
      operationFixtureRequest([
        'versions',
        'deploy',
        '00000000-0000-0000-0000-000000000001@100',
        ...common,
        '--message',
        'void:metadata',
        '--yes',
      ]),
      { capture: false },
    );
    const deployArgs = calls.at(-1)!;
    expect(deployArgs.slice(0, 3)).toEqual(['workers', 'deployments', 'create']);
    expect(JSON.parse(deployArgs[deployArgs.indexOf('--body') + 1]!)).toMatchObject({
      strategy: 'percentage',
      annotations: { 'workers/message': 'void:metadata' },
      versions: [{ version_id: '00000000-0000-0000-0000-000000000001', percentage: 100 }],
    });
  } finally {
    prepared.dispose();
  }
});

it.each(['newest-first', 'oldest-first'] as const)(
  'reads the actual latest ten versions when cf pages %s',
  async (order) => {
    const prepared = await output();
    try {
      const history = Array.from({ length: 25 }, (_, index) => ({
        id: `version-${index + 1}`,
        number: index + 1,
      }));
      const ordered = order === 'newest-first' ? history.reverse() : history;
      const pages: Array<number> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          const page = Number(args[args.indexOf('--page') + 1]);
          pages.push(page);
          return {
            status: 0,
            stdout: JSON.stringify(ordered.slice((page - 1) * 10, page * 10)),
            stderr: '',
          };
        },
      });
      const result = await runner(
        operationFixtureRequest(['versions', 'list', '--name', 'void-test']),
        { capture: true },
      );
      expect(
        (result.data as Array<{ number: number }>).map((item: { number: number }) => item.number),
      ).toEqual(Array.from({ length: 10 }, (_, index) => index + 16));
      expect(pages).toEqual(order === 'newest-first' ? [1, 2] : [1, 2, 3]);
    } finally {
      prepared.dispose();
    }
  },
);

it('applies the immutable trigger snapshot through a private cf output copy', async () => {
  const prepared = await output();
  const triggerConfig = join(roots[0]!, 'trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({
      name: 'void-test',
      workers_dev: false,
      preview_urls: true,
      triggers: { crons: ['0 * * * *'] },
    }),
  );
  let privateDirectory = '';
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args, run) => {
        expect(args).toEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
        privateDirectory = run.cwd;
        expect(run.cwd).not.toBe(prepared.directory);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const result = await runner(
      operationFixtureRequest([
        'triggers',
        'deploy',
        '-c',
        triggerConfig,
        '--env=',
        '--name',
        'void-test',
      ]),
      { capture: false },
    );
    expect(result.status).toBe(0);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(existsSync(prepared.directory)).toBe(true);
  } finally {
    prepared.dispose();
  }
});

it.each(['restore', 'remove'] as const)(
  'replays workflow exports and schedules when triggers %s the previous workflow state',
  async (operation) => {
    const workflow = {
      binding: 'JOB',
      name: 'void-job',
      class_name: 'Job',
      schedules: ['0 * * * *'],
    };
    const prepared = await output({
      vars: { FIXED: 'value' },
      durable_objects: { bindings: [{ name: 'STATE', class_name: 'State' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['State'] }],
      workflows: operation === 'restore' ? [workflow] : [],
    });
    const desiredWorkflow = { ...workflow, schedules: ['30 * * * *'], concurrency: { limit: 2 } };
    try {
      const calls: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args, { cwd }) => {
          calls.push(args);
          const worker = JSON.parse(readFileSync(getWorkerConfigPath(cwd), 'utf8'));
          expect(worker.exports.Job).toEqual({
            type: 'workflow',
            name: 'void-job',
            ...(operation === 'restore'
              ? { schedules: ['30 * * * *'], concurrency: { limit: 2 } }
              : {}),
          });
          expect(worker.env.JOB).toMatchObject({
            type: 'workflow',
            name: 'void-job',
            worker: 'void-test',
            exportName: 'Job',
          });
          expect(worker.exports.State).toMatchObject({ type: 'durable-object', storage: 'sqlite' });
          expect(worker.env.STATE).toMatchObject({ type: 'durable-object' });
          expect(worker.env.FIXED).toEqual({ type: 'text', value: 'value' });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const base = {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
      };
      const result = await deployCloudflareVersionTriggers({
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        runWrangler: runner,
        triggerConfig: {
          ...base,
          workflows: operation === 'restore' ? [desiredWorkflow] : [],
        },
        previousTriggerConfig: { ...base, workflows: [workflow] },
      });
      expect(result.status).toBe(0);
      expect(calls).toEqual([['workers', 'triggers', 'deploy', '--prebuilt']]);
      const original = JSON.parse(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8'));
      expect(original.exports.Job?.schedules).toEqual(
        operation === 'restore' ? ['0 * * * *'] : undefined,
      );
    } finally {
      prepared.dispose();
    }
  },
);

it('uses cf for Queue triggers, consumer cleanup, and version binding reads', async () => {
  const prepared = await output();
  const triggerConfig = join(roots.at(-1)!, 'legacy-trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({ name: 'void-test', queues: { consumers: [{ queue: 'jobs' }] } }),
  );
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        if (args[0] === 'queues' && args[1] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([{ queue_name: 'jobs', queue_id: 'queue-id' }]),
            stderr: '',
          };
        }
        if (args[0] === 'queues' && args[1] === 'consumers' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([{ script: 'void-test', consumer_id: 'consumer-id' }]),
            stderr: '',
          };
        }
        if (args[0] === 'workers' && args[1] === 'versions' && args[2] === 'get') {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: 'version-id',
              bindings: [{ name: 'SECRET', type: 'secret_text' }],
            }),
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const invalid = await runner(
      operationFixtureRequest(['versions', 'deploy', 'invalid@100', '--name', 'void-test']),
      {
        capture: true,
      },
    );
    expect(invalid.status).toBe(1);
    const triggerArgs = ['triggers', 'deploy', '-c', triggerConfig, '--name', 'void-test'];
    expect((await runner(operationFixtureRequest(triggerArgs), { capture: false })).status).toBe(0);
    const removeArgs = ['queues', 'consumer', 'remove', 'jobs', 'void-test'];
    expect((await runner(operationFixtureRequest(removeArgs), { capture: false })).status).toBe(0);
    const viewArgs = ['versions', 'view', 'version-id', '--name', 'void-test'];
    const version = await runner(operationFixtureRequest(viewArgs), { capture: true });
    expect(
      (version.data as { resources: { bindings: Array<unknown> } }).resources.bindings,
    ).toEqual([{ name: 'SECRET', type: 'secret_text' }]);
    expect(calls).toContainEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
    expect(calls).toContainEqual([
      'queues',
      'consumers',
      'delete',
      'consumer-id',
      '--queue-id',
      'queue-id',
      '--force',
    ]);
  } finally {
    prepared.dispose();
  }
});

it('accepts only the staged static assets directory already sealed into prebuilt output', async () => {
  const prepared = await output();
  prepared.assetsDirectory = '/staged/assets';
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const common = ['--name', 'void-test', '--assets'];
    expect(
      (
        await runner(operationFixtureRequest(['versions', 'upload', ...common, '/staged/assets']), {
          capture: true,
        })
      ).status,
    ).toBe(0);
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['workers', 'versions', 'create', '--prebuilt']);
    expect(
      (
        await runner(operationFixtureRequest(['deploy', ...common, '/wrong/assets']), {
          capture: true,
        })
      ).status,
    ).toBe(1);
    expect(calls).toHaveLength(1);
  } finally {
    prepared.dispose();
  }
});

it.each(['r2', 'queue'] as const)(
  'refuses every prebuilt mutation when a %s binding does not exist',
  async (missing) => {
    const prepared = await output({
      ...(missing === 'r2' ? { r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket' }] } : {}),
      ...(missing === 'queue'
        ? { queues: { producers: [{ binding: 'QUEUE', queue: 'jobs' }] } }
        : {}),
    });
    const triggerConfig = join(roots.at(-1)!, 'triggers.json');
    writeFileSync(triggerConfig, JSON.stringify({ name: 'void-test', workers_dev: true }));
    const cfCalls: Array<Array<string>> = [];
    const runCf = (args: Array<string>) => {
      cfCalls.push(args);
      return { status: 1, stdout: '', stderr: 'Resource not found.' };
    };
    const verifier = createCfResourceVerifier({
      configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
      runCf,
      verifyCompatibilityRunner: () => true,
      runWrangler: operationFixture(async () => ({
        status: 1,
        stdout: '',
        stderr: 'Queue not found.',
      })),
    });
    try {
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf,
        verifyResources: verifier,
      });
      expect(
        (
          await runner(operationFixtureRequest(['versions', 'upload', '--name', 'void-test']), {
            capture: true,
          })
        ).status,
      ).toBe(1);
      expect(
        (
          await runner(operationFixtureRequest(['deploy', '--name', 'void-test']), {
            capture: true,
          })
        ).status,
      ).toBe(1);
      expect(
        (
          await runner(
            operationFixtureRequest([
              'triggers',
              'deploy',
              '-c',
              triggerConfig,
              '--name',
              'void-test',
            ]),
            {
              capture: true,
            },
          )
        ).status,
      ).toBe(1);
      expect(cfCalls.every((args) => args[0] === 'r2' && args[1] === 'buckets')).toBe(true);
      expect(cfCalls).toHaveLength(missing === 'r2' ? 3 : 0);
    } finally {
      prepared.dispose();
    }
  },
  15_000,
);

it('uploads when existing R2 and Queue bindings are verified by exact identity', async () => {
  const prepared = await output({
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket', jurisdiction: 'eu' }],
    queues: { producers: [{ binding: 'QUEUE', queue: 'jobs' }] },
  });
  const cfCalls: Array<Array<string>> = [];
  const queueCalls: Array<Array<string>> = [];
  const runCf = (args: Array<string>) => {
    cfCalls.push(args);
    return {
      status: 0,
      stdout: args[0] === 'r2' ? JSON.stringify({ name: 'bucket' }) : '',
      stderr: '',
    };
  };
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf,
      verifyResources: createCfResourceVerifier({
        configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        runCf,
        verifyCompatibilityRunner: () => true,
        runWrangler: operationFixture(async (args) => {
          queueCalls.push(args);
          return { status: 0, stdout: 'Queue Name: jobs\n', stderr: '' };
        }),
      }),
    });
    expect(
      (
        await runner(operationFixtureRequest(['versions', 'upload', '--name', 'void-test']), {
          capture: true,
        })
      ).status,
    ).toBe(0);
    expect(cfCalls).toEqual([
      ['r2', 'buckets', 'get', 'bucket', '--cf-r2-jurisdiction', 'eu'],
      ['workers', 'versions', 'create', '--prebuilt'],
    ]);
    expect(queueCalls).toEqual([
      [
        'queues',
        'info',
        'jobs',
        '-c',
        join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        '--env=',
      ],
    ]);
  } finally {
    prepared.dispose();
  }
});
