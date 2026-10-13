import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getWorkerBundleDir, readBuildOutput } from '@cloudflare/build-output-utils';
import { PGlite } from '@electric-sql/pglite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createServer as createPgServer } from 'pglite-server';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { prepareCfFrameworkBuildOutput } from '../../src/cli/cf-build-output.ts';
import { bundleEntry } from '../../src/cli/wrapper.ts';
import { voidPlugin } from '../../src/index.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';

// Each case runs two Vite builds and starts workerd.
const TIMEOUT_MS = (process.platform === 'win32' ? 3 : 1) * 60_000;
const COMPATIBILITY_DATE = '2026-02-24';

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type KitApp = { root: string; compatibilityDate: string };

/**
 * A SvelteKit server build reduced to what Void sees: Kit's generated get_hooks module, a route
 * that queries void/db, and an entry that calls `handle` as the adapter's Worker does.
 */
async function buildKitServer(
  database: 'pg' | 'mysql',
  {
    hoisted = false,
    compatibilityDate = COMPATIBILITY_DATE,
    kit = 3,
  }: { hoisted?: boolean; compatibilityDate?: string; kit?: 2 | 3 } = {},
): Promise<KitApp> {
  // Windows runners report a short-name temp path, which Vite refuses to serve.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-kit-worker-')));
  roots.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', JSON.stringify({ type: 'module', dependencies: { '@sveltejs/kit': '*' } }));
  if (hoisted) {
    // npm, Yarn and Bun install void's drivers next to the app, as pnpm does when the app lists
    // them, so Vite can resolve them from the app root.
    const voidRequire = createRequire(new URL('../../package.json', import.meta.url));
    mkdirSync(join(root, 'node_modules'));
    for (const name of ['pg', 'mysql2']) {
      symlinkSync(
        dirname(voidRequire.resolve(`${name}/package.json`)),
        join(root, 'node_modules', name),
        'junction',
      );
    }
  }
  write(
    'void.json',
    JSON.stringify({
      database,
      worker: { compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'] },
    }),
  );
  write('db/schema.ts', 'export {};\n');
  // Kit 2 writes get_hooks to server/internal.js, Kit 3 to build/server.js.
  const hooksModule =
    kit === 2
      ? '.svelte-kit/generated/server/internal.js'
      : '.svelte-kit/generated/build/server.js';
  write(
    hooksModule,
    'export async function get_hooks() {\n  let handle;\n  return { handle };\n}\n',
  );
  // workerd has no node:tty at this compatibility date, and a Worker never calls this.
  write('src/terminal.cjs', "exports.isTerminal = () => require('tty').isatty(1);\n");
  write(
    'src/route.js',
    `import { db, sql } from 'void/db';
import { isTerminal } from './terminal.cjs';

export async function GET(request) {
  if (new URL(request.url).searchParams.has('terminal')) {
    return Response.json({ terminal: isTerminal() });
  }
  const result = await db.execute(sql\`select 1 as one\`);
  // Outside Void's request scope, each use of db builds its own pool.
  const pool = () => db.$client.options ?? db.$client.config;
  return Response.json({
    rows: Array.isArray(result) ? result[0] : result.rows,
    samePool: pool() === pool(),
  });
}
`,
  );
  write(
    'src/entry.js',
    `import { get_hooks } from '../${hooksModule}';

export default {
  async fetch(request, env) {
    const { handle = ({ event, resolve }) => resolve(event) } = await get_hooks();
    // Kit 2's adapter passes the bindings as platform.env. Kit 3 passes no platform.
    const platform = new URL(request.url).searchParams.has('platform') ? { env } : undefined;
    return handle({
      event: { request, platform },
      resolve: async () => (await import('./route.js')).GET(request),
    });
  },
};
`,
  );
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [voidPlugin()],
    build: { ssr: 'src/entry.js', outDir: 'build/server', emptyOutDir: true },
  });
  return { root, compatibilityDate };
}

/** Package the server build as the given deploy target does; return its modules. */
async function packageWorker(
  { root, compatibilityDate }: KitApp,
  target: 'hosted' | 'native',
): Promise<{ directory: string; mainModule: string; dispose(): Promise<void> }> {
  const entry = join(root, 'build/server/entry.js');
  if (target === 'hosted') {
    const { outputDir, entryFilename } = await bundleEntry(root, entry);
    return { directory: outputDir, mainModule: entryFilename, async dispose() {} };
  }
  mkdirSync(join(root, 'public'));
  writeFileSync(
    join(root, 'wrangler.json'),
    JSON.stringify({
      name: 'kit-worker',
      main: 'build/server/entry.js',
      compatibility_date: compatibilityDate,
      assets: { directory: 'public' },
    }),
  );
  const prepared = await prepareCfFrameworkBuildOutput({
    projectRoot: root,
    configPath: join(root, 'wrangler.json'),
    accountId: 'account-id',
  });
  if (!prepared) {
    throw new Error('Expected native build output.');
  }
  const built = await readBuildOutput(prepared.directory);
  return {
    directory: getWorkerBundleDir(prepared.directory),
    mainModule: built.workers.default.config.manifest!.mainModule,
    dispose: () => prepared.dispose(),
  };
}

/** Serve the packaged Worker in workerd and request the route as Kit 3 and as Kit 2. */
async function fetchRoute(
  worker: { directory: string; mainModule: string },
  compatibilityDate: string,
  connectionString: string,
): Promise<Array<unknown>> {
  const modules = readdirSync(worker.directory, { recursive: true })
    .map(String)
    .filter((file) => /\.m?js$/.test(file))
    .sort((a, b) => Number(b === worker.mainModule) - Number(a === worker.mainModule))
    .map((file) => ({ type: 'ESModule' as const, path: join(worker.directory, file) }));
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: worker.directory,
      modules,
      compatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      bindings: { HYPERDRIVE: { connectionString } },
    }),
  );
  try {
    const bodies: Array<unknown> = [];
    for (const path of ['/', '/?platform']) {
      const response = await miniflare.dispatchFetch(`http://localhost${path}`);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      bodies.push(JSON.parse(body));
    }
    return bodies;
  } finally {
    await miniflare.dispose();
  }
}

describe.each([
  ['only under void', false],
  ['next to the app', true],
])('SvelteKit production builds with a Hyperdrive driver installed %s', (_layout, hoisted) => {
  it.each(['hosted', 'native'] as const)(
    'serves PostgreSQL queries from the %s Worker in one pool per request',
    async (target) => {
      const app = await buildKitServer('pg', { hoisted });
      const worker = await packageWorker(app, target);
      const pglite = new PGlite();
      // pglite-server does not wait for PGlite: a query that arrives during startup spins forever.
      await pglite.waitReady;
      const server = createPgServer(pglite);
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        const bodies = await fetchRoute(
          worker,
          app.compatibilityDate,
          `postgresql://postgres@127.0.0.1:${port}/postgres`,
        );
        expect(bodies).toEqual([
          { rows: [{ one: 1 }], samePool: true },
          { rows: [{ one: 1 }], samePool: true },
        ]);
      } finally {
        server.close();
        await pglite.close();
        await worker.dispose();
      }
    },
    TIMEOUT_MS,
  );

  it.each(['hosted', 'native'] as const)(
    'serves MySQL queries from the %s Worker in one pool per request',
    async (target) => {
      const app = await buildKitServer('mysql', { hoisted });
      const worker = await packageWorker(app, target);
      const mysql = await startFakeMySqlServer([{ one: 1 }]);
      try {
        const bodies = await fetchRoute(
          worker,
          app.compatibilityDate,
          `mysql://void@127.0.0.1:${mysql.port}/app`,
        );
        expect(bodies).toEqual([
          { rows: [{ one: 1 }], samePool: true },
          { rows: [{ one: 1 }], samePool: true },
        ]);
      } finally {
        await mysql.close();
        await worker.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

it(
  "serves MySQL queries in one pool per request through Kit 2's generated hooks module",
  async () => {
    const app = await buildKitServer('mysql', { kit: 2 });
    const worker = await packageWorker(app, 'hosted');
    const mysql = await startFakeMySqlServer([{ one: 1 }]);
    try {
      const [, withPlatform] = await fetchRoute(
        worker,
        app.compatibilityDate,
        `mysql://void@127.0.0.1:${mysql.port}/app`,
      );
      expect(withPlatform).toEqual({ rows: [{ one: 1 }], samePool: true });
    } finally {
      await mysql.close();
      await worker.dispose();
    }
  },
  TIMEOUT_MS,
);

it(
  'serves MySQL queries from a Worker whose compatibility date predates the native node:process',
  async () => {
    // The Cloudflare preset lists node:process only from 2025-09-15, and mysql2 requires it
    // when it loads.
    const app = await buildKitServer('mysql', { compatibilityDate: '2025-06-01' });
    const worker = await packageWorker(app, 'hosted');
    const mysql = await startFakeMySqlServer([{ one: 1 }]);
    try {
      const bodies = await fetchRoute(
        worker,
        app.compatibilityDate,
        `mysql://void@127.0.0.1:${mysql.port}/app`,
      );
      expect(bodies).toEqual([
        { rows: [{ one: 1 }], samePool: true },
        { rows: [{ one: 1 }], samePool: true },
      ]);
    } finally {
      await mysql.close();
      await worker.dispose();
    }
  },
  TIMEOUT_MS,
);
