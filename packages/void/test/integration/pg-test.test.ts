import { once } from 'node:events';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import spawn from 'cross-spawn';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ENV_LOCAL_PATH = join(ROOT, 'playground/pg-test/.env.local');

describe('playground/pg-test', () => {
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let pgPort: number;
  let devChild: ReturnType<typeof spawn>;
  let devPort: number;
  let BASE: string;
  let stderr = '';

  beforeAll(async () => {
    // 1. Start PGlite + TCP server
    pglite = new PGlite();
    await pglite.waitReady;

    // Run migrations
    const migrationSql = readFileSync(
      join(ROOT, 'playground/pg-test/db/migrations/0000_initial.sql'),
      'utf-8',
    );
    await pglite.exec(migrationSql);

    // Start wire protocol server
    pgServer = createServer(pglite);
    pgServer.listen(0);
    await once(pgServer, 'listening');
    pgPort = (pgServer.address() as import('node:net').AddressInfo).port;

    // 2. Write .env.local with dynamic DATABASE_URL
    // Vite's loadEnv reads .env.local and passes vars to the workerd runtime.
    const databaseUrl = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
    writeFileSync(ENV_LOCAL_PATH, `DATABASE_URL=${databaseUrl}\n`);

    // 3. Start vite dev server
    devPort = await getPort();
    BASE = `http://127.0.0.1:${devPort}`;

    devChild = spawn(
      'pnpm',
      [
        '--dir',
        'playground/pg-test',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        String(devPort),
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

    devChild.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(BASE, 20_000);
  }, 30_000);

  afterAll(async () => {
    if (devChild) {
      await killChild(devChild);
    }
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    if (pglite) {
      await pglite.close();
    }
    try {
      unlinkSync(ENV_LOCAL_PATH);
    } catch {
      // Ignore missing cleanup files between test runs.
    }
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('renders the database page', async () => {
    const res = await fetch(BASE + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Database (PostgreSQL)');
  });

  it('creates a user via action', async () => {
    // POST to named action
    const createRes = await fetch(BASE + '/?create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
      },
      body: JSON.stringify({ name: 'Alice', email: 'alice@test.com' }),
      redirect: 'manual',
    });
    expect(createRes.status).toBeLessThan(400);

    // Verify user appears in page props
    const propsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true' },
    });
    const data = (await propsRes.json()) as any;
    expect(data.props.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Alice', email: 'alice@test.com' })]),
    );
  });

  it('creates a post via action', async () => {
    // Get the user id first
    const propsRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const data = (await propsRes.json()) as any;
    const alice = data.props.users.find((u: any) => u.name === 'Alice');
    expect(alice).toBeTruthy();

    // Create post via named action
    const createRes = await fetch(BASE + '/?create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
      },
      body: JSON.stringify({
        title: 'Hello World',
        body: 'Test post',
        authorId: alice.id,
      }),
      redirect: 'manual',
    });
    expect(createRes.status).toBeLessThan(400);

    // Verify post appears
    const postsRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const postsData = (await postsRes.json()) as any;
    expect(postsData.props.posts).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Hello World', author: 'Alice' })]),
    );
  });

  it('deletes a post via action', async () => {
    const propsRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const data = (await propsRes.json()) as any;
    const post = data.props.posts.find((p: any) => p.title === 'Hello World');
    expect(post).toBeTruthy();

    const deleteRes = await fetch(BASE + '/?delete-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
      },
      body: JSON.stringify({ id: post.id }),
      redirect: 'manual',
    });
    expect(deleteRes.status).toBeLessThan(400);

    const afterRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const afterData = (await afterRes.json()) as any;
    expect(afterData.props.posts.find((p: any) => p.title === 'Hello World')).toBeUndefined();
  });

  it('deletes a user and cascade-deletes their posts', async () => {
    // Create a post for Alice first
    const propsRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const data = (await propsRes.json()) as any;
    const alice = data.props.users.find((u: any) => u.name === 'Alice');

    await fetch(BASE + '/?create-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VoidPages': 'true' },
      body: JSON.stringify({
        title: 'To Be Deleted',
        body: 'Gone soon',
        authorId: alice.id,
      }),
      redirect: 'manual',
    });

    // Delete Alice (should cascade-delete posts)
    const deleteRes = await fetch(BASE + '/?delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VoidPages': 'true' },
      body: JSON.stringify({ id: alice.id }),
      redirect: 'manual',
    });
    expect(deleteRes.status).toBeLessThan(400);

    const afterRes = await fetch(BASE + '/', { headers: { 'X-VoidPages': 'true' } });
    const afterData = (await afterRes.json()) as any;
    expect(afterData.props.users.find((u: any) => u.name === 'Alice')).toBeUndefined();
    expect(afterData.props.posts.find((p: any) => p.author === 'Alice')).toBeUndefined();
  });

  it('API routes: create and list users', async () => {
    // Create user via API
    const createRes = await fetch(BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;
    expect(created.name).toBe('Bob');

    // List users via API
    const listRes = await fetch(BASE + '/api/users');
    expect(listRes.status).toBe(200);
    const users = (await listRes.json()) as any;
    expect(users).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Bob', email: 'bob@test.com' })]),
    );

    // Get single user
    const getRes = await fetch(BASE + `/api/users/${created.id}`);
    expect(getRes.status).toBe(200);
    const user = (await getRes.json()) as any;
    expect(user.name).toBe('Bob');
  });
}, 60_000);
