import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vite-plus/test';
import { app } from '../../src/index.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

const cli = fileURLToPath(
  new URL('../../../../../packages/void/dist/cli/cli.mjs', import.meta.url),
);
let env: TestEnv;
let server: Server;
let origin: string;
let operatorToken: string;
let requests: number;

beforeAll(async () => {
  env = await setupEnv();
  server = createServer(async (incoming, outgoing) => {
    requests++;
    try {
      const parts: Array<Buffer> = [];
      for await (const part of incoming) {
        parts.push(Buffer.from(part));
      }
      const body = Buffer.concat(parts);
      const response = await app.fetch(
        new Request(`${origin}${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(body.length ? { body } : {}),
        }),
        env,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'fixture_failure', message: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await teardownEnv();
});

beforeEach(async () => {
  requests = 0;
  await clearTables(env.db);
  await env.ROUTING.put('signup:enabled', 'false');
  const admin = await createTestUser(
    env.db,
    'terminal-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  const response = await app.fetch(
    new Request(`${origin}/operator/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  const session = (await response.json()) as { token: string };
  operatorToken = session.token;
});

function run(args: Array<string>, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'platform', ...args], {
      env: {
        ...process.env,
        VOID_API_URL: origin,
        VOID_OPERATOR_TOKEN: operatorToken,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Operator CLI fixture timed out.'));
    }, 15_000);
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test('built CLI authenticates, previews, changes access, and reads the actual database audit', async () => {
  const status = await run(['auth', 'status', '--json']);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ user: { login: 'terminal-admin' } });
  const list = await run(['user', 'list', '--json']);
  expect(list.code).toBe(0);
  expect(JSON.parse(list.stdout).users[0].login).toBe('terminal-admin');

  await env.ROUTING.put('signup:enabled', 'false');
  const preview = await run(['signup', 'restrict', '--plan', '--json']);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, action: 'signup.restrict' });
  expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  const restricted = await run(['signup', 'restrict', '--yes', '--json']);
  expect(restricted.code).toBe(0);
  expect(await env.ROUTING.get('signup:enabled')).toBe('true');
  const events = await run(['system', 'events', '--json']);
  expect(events.code).toBe(0);
  expect(JSON.parse(events.stdout)).toMatchObject({
    total: 1,
    events: [{ login: 'terminal-admin', status: 'success' }],
  });
});

test('built CLI requires acknowledgement, exposes API validation, and honors revoked sessions', async () => {
  const mutation = await run(['signup', 'restrict', '--json']);
  expect(mutation.code).toBe(1);
  expect(await env.ROUTING.get('signup:enabled')).not.toBe('true');
  const invalid = await run(['user', 'list', '--limit', '101', '--json']);
  expect(invalid.code).toBe(1);
  expect(invalid.stdout).toBe('');
  expect(JSON.parse(invalid.stderr)).toHaveProperty('message');
  const requestsBefore = requests;
  const status = await run(['auth', 'status', '--typo', '--json']);
  expect(status.code).toBe(1);
  expect(requests).toBe(requestsBefore);
  await app.fetch(
    new Request(`${origin}/operator/v1/session/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  const revoked = await run(['user', 'list', '--json']);
  expect(revoked.code).toBe(1);
  expect(JSON.parse(revoked.stderr)).toMatchObject({ error: 'unauthorized', status: 401 });
});
