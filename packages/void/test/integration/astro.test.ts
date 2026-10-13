import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import spawn from 'cross-spawn';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/astro';
let DEV_BASE: string;

function readWranglerConfig(root: string): {
  compatibility_flags?: Array<string>;
  d1_databases?: Array<{ binding: string }>;
  kv_namespaces?: Array<{ binding: string }>;
} {
  return JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8'));
}

describe('playground/astro dev', () => {
  let child: ReturnType<typeof spawn>;

  const startDev = async () => {
    const server = await startServer((port) => {
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
          String(port),
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ASTRO_DEV_BACKGROUND: 'false',
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  };

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });

    // Dev must generate the inferred binding config itself in a fresh CI checkout.
    await startDev();
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('syncs wrangler config with compat flag and inferred bindings', () => {
    const wranglerConfig = readWranglerConfig(join(ROOT, PLAYGROUND));

    expect(wranglerConfig.compatibility_flags?.includes('nodejs_als')).toBe(true);
    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(existsSync(join(ROOT, `${PLAYGROUND}/wrangler.jsonc`))).toBe(false);
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Astro + Void');
  });

  it('navigates to smoke route from home page', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(DEV_BASE);
      await page.click('a[href="/smoke"]');
      await page.waitForURL('**/smoke');
      const d1User = await page.textContent('[data-testid="d1-user"]');
      const kvValue = await page.textContent('[data-testid="kv-value"]');
      expect(d1User).toBe('Alice');
      expect(kvValue).toBe('ok');
    } finally {
      await browser.close();
    }
  });
});

// Astro owns its Worker entry, so void/db runs without Void's request scope.
describe('playground/astro with PostgreSQL', () => {
  const USERS = [
    { id: 1, name: 'Ada', email: 'ada@example.com' },
    { id: 2, name: 'Linus', email: 'linus@example.com' },
  ];
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn> | undefined;
  let base: string;
  let output = () => '';

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.exec(
      'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);',
    );
    for (const user of USERS) {
      await pglite.query('INSERT INTO users (name, email) VALUES ($1, $2)', [
        user.name,
        user.email,
      ]);
    }
    pgServer = createServer(pglite);
    pgServer.listen(0, '127.0.0.1');
    await once(pgServer, 'listening');
    const { port } = pgServer.address() as AddressInfo;

    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    const root = playground.root;
    const configPath = join(root, 'void.config.ts');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8')
        .replace('defineConfig({', "defineConfig({\n  database: 'pg',")
        .replace(
          "compatibility_flags: ['nodejs_als']",
          "compatibility_flags: ['nodejs_compat', 'nodejs_als']",
        ),
    );
    rmSync(join(root, 'db/migrations'), { recursive: true, force: true });
    writeFileSync(
      join(root, 'db/schema.ts'),
      `import { pgTable, serial, text } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});
`,
    );
    mkdirSync(join(root, 'src/pages/api'), { recursive: true });
    writeFileSync(
      join(root, 'src/pages/api/users.ts'),
      `import { users } from '@schema';
import { db } from 'void/db';

export const prerender = false;

export async function GET() {
  return Response.json(await db.select().from(users));
}
`,
    );
    writeFileSync(
      join(root, '.env'),
      `DATABASE_URL=postgresql://postgres@127.0.0.1:${port}/postgres\n`,
    );

    const server = await startServer((serverPort) => {
      const astro = join(root, 'node_modules/astro/bin/astro.mjs');
      child = spawn(
        process.execPath,
        [astro, 'dev', '--host', '127.0.0.1', '--port', String(serverPort)],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ASTRO_DEV_BACKGROUND: 'false', VOID_INSPECTOR_PORT: 'false' },
        },
      );
      return child;
    }, 30_000);
    base = server.base;
    output = server.output;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    await pglite?.close();
    playground?.cleanup();
  });

  it('queries PostgreSQL through void/db from an API route in dev', async () => {
    const response = await fetch(`${base}/api/users`);
    const result = { status: response.status, body: await response.text() };
    expect(result, output().slice(-4000)).toEqual({ status: 200, body: JSON.stringify(USERS) });
  });
});
