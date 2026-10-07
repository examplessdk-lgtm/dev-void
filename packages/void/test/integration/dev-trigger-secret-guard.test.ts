import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { devTriggerSecretGuardPlugin } from '../../src/plugin-dev-config.ts';

const TOKEN = 'dev-trigger-secret-0f3c9a';

// node:http sends the path exactly as written; fetch would normalize dot segments.
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Array<Buffer> = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dev server with the dev-trigger secret guard', () => {
  let root: string;
  let server: ViteDevServer;
  let port: number;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'void-dev-secret-')));
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(root, '.void', 'dev-trigger-token'), TOKEN);
    writeFileSync(join(root, '.void', 'dev-triggers.ts'), `export const token = "${TOKEN}";\n`);
    writeFileSync(join(root, '.void', 'routes.d.ts'), 'export {};\n');
    // Astro writes its background dev server output, startup hint included, here.
    mkdirSync(join(root, '.astro'), { recursive: true });
    writeFileSync(join(root, '.astro', 'dev.log'), `x-void-dev-trigger: ${TOKEN}\n`);

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [devTriggerSecretGuardPlugin()],
    });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server?.close();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const fsRoot = () => {
    const posix = root.replaceAll('\\', '/');
    return posix.startsWith('/') ? posix : `/${posix}`;
  };

  it.each([
    '/.void/dev-trigger-token',
    '/.VOID/dev-trigger-token',
    '/.void/./dev-trigger-token',
    '/.void//dev-trigger-token',
    '/%2evoid/dev-trigger-token',
    '/.void/dev-trigger-token?raw',
    '/.void/dev-trigger-token?import',
    '/@fs<root>/.void/dev-trigger-token',
    '/.void/dev-triggers.ts',
    '/.void/dev-triggers.ts?import',
    '/.void/dev-triggers.ts?raw',
    '/.astro/dev.log',
    '/.astro/dev.log?raw',
  ])('does not serve the token at %s', async (path) => {
    const response = await get(port, path.replace('<root>', fsRoot()));
    expect(response.status).toBe(404);
    expect(response.body).not.toContain(TOKEN);
  });

  it('still serves other files under .void', async () => {
    const response = await get(port, '/.void/routes.d.ts');
    expect(response.status).toBe(200);
  });
});
