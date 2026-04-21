import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyClient } from '../../src/runtime/remote/client';
import { ProxyD1Database } from '../../src/runtime/remote/d1';
import { createRemoteEnv } from '../../src/runtime/remote/index';
import { ProxyKVNamespace } from '../../src/runtime/remote/kv';
import { ProxyR2Bucket } from '../../src/runtime/remote/r2';

const TOKEN = 'test-jwt';
const PROJECT_ID = 'proj_test';

// Lightweight mock proxy server that validates requests and returns
// realistic responses matching the proxy worker's API shape.
let server: Server;
let baseUrl: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const body = await readBody(req);
        const json = body ? JSON.parse(body) : {};
        const url = req.url ?? '';

        // Validate auth header on every request
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        // Validate projectId on every request
        if (json.projectId !== PROJECT_ID) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'missing projectId' }));
          return;
        }

        // D1 query
        if (url === '/d1/query') {
          const isWrite = json.method === 'run';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: isWrite ? [] : [{ id: 1, name: 'alice' }],
              meta: {
                changes: isWrite ? 1 : 0,
                last_row_id: isWrite ? 5 : 0,
                duration: 0.1,
              },
              success: true,
            }),
          );
          return;
        }

        // D1 batch
        if (url === '/d1/batch') {
          const statements = json.statements as { sql: string }[];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              statements.map(() => ({
                results: [],
                meta: { changes: 0, last_row_id: 0, duration: 0.05 },
                success: true,
              })),
            ),
          );
          return;
        }

        // KV get
        if (url === '/kv/get') {
          if (json.key === 'missing') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('null');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify('hello-world'));
          return;
        }

        // KV put
        if (url === '/kv/put') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // KV delete
        if (url === '/kv/delete') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // KV list
        if (url === '/kv/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              keys: [{ name: 'key1' }, { name: 'key2' }],
              list_complete: true,
            }),
          );
          return;
        }

        // R2 get
        if (url === '/r2/get') {
          if (json.key === 'missing') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('null');
            return;
          }
          const body = Buffer.from('hello');
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Length': String(body.length),
            etag: '"abc123"',
            'last-modified': new Date().toISOString(),
          });
          res.end(body);
          return;
        }

        // R2 put
        if (url === '/r2/put') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              key: json.key,
              size: 5,
              etag: '"abc123"',
              uploaded: new Date().toISOString(),
              version: 'v1',
            }),
          );
          return;
        }

        // R2 delete
        if (url === '/r2/delete') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // R2 list
        if (url === '/r2/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              objects: [
                {
                  key: 'a.txt',
                  size: 3,
                  etag: '"e1"',
                  uploaded: new Date().toISOString(),
                  version: 'v1',
                },
                {
                  key: 'b.txt',
                  size: 4,
                  etag: '"e2"',
                  uploaded: new Date().toISOString(),
                  version: 'v1',
                },
              ],
              truncated: false,
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

describe('Remote bindings integration', () => {
  function makeClient() {
    return new ProxyClient(baseUrl, TOKEN, PROJECT_ID);
  }

  describe('D1', () => {
    it('executes a query and returns rows', async () => {
      const db = new ProxyD1Database(makeClient(), 'DB');
      const result = await db.prepare('SELECT * FROM users').all();
      expect(result.results).toEqual([{ id: 1, name: 'alice' }]);
      expect(result.success).toBe(true);
      expect(result.meta.changes).toBe(0);
    });

    it('executes a write and returns meta', async () => {
      const db = new ProxyD1Database(makeClient(), 'DB');
      const result = await db.prepare('INSERT INTO users VALUES (?)').bind('bob').run();
      expect(result.success).toBe(true);
      expect(result.meta.changes).toBe(1);
      expect(result.meta.last_row_id).toBe(5);
    });

    it('batches multiple statements', async () => {
      const db = new ProxyD1Database(makeClient(), 'DB');
      const results = await db.batch([
        db.prepare('INSERT INTO a VALUES (1)') as unknown as D1PreparedStatement,
        db.prepare('INSERT INTO b VALUES (2)') as unknown as D1PreparedStatement,
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
    });
  });

  describe('KV', () => {
    it('gets a value', async () => {
      const kv = new ProxyKVNamespace(makeClient(), 'KV');
      const val = await kv.get('mykey');
      expect(val).toBe('hello-world');
    });

    it('returns null for missing key', async () => {
      const kv = new ProxyKVNamespace(makeClient(), 'KV');
      const val = await kv.get('missing');
      expect(val).toBeNull();
    });

    it('puts a value', async () => {
      const kv = new ProxyKVNamespace(makeClient(), 'KV');
      await expect(kv.put('key', 'value')).resolves.toBeUndefined();
    });

    it('deletes a key', async () => {
      const kv = new ProxyKVNamespace(makeClient(), 'KV');
      await expect(kv.delete('key')).resolves.toBeUndefined();
    });

    it('lists keys', async () => {
      const kv = new ProxyKVNamespace(makeClient(), 'KV');
      const result = await kv.list();
      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
      expect(result.list_complete).toBe(true);
    });
  });

  describe('R2', () => {
    it('gets an object with body', async () => {
      const r2 = new ProxyR2Bucket(makeClient(), 'STORAGE');
      const obj = await r2.get('file.txt');
      expect(obj).not.toBeNull();
      const text = await obj!.text();
      expect(text).toBe('hello');
      expect(obj!.key).toBe('file.txt');
      expect(obj!.size).toBe(5);
    });

    it('returns null for missing object', async () => {
      const r2 = new ProxyR2Bucket(makeClient(), 'STORAGE');
      const obj = await r2.get('missing');
      expect(obj).toBeNull();
    });

    it('puts an object', async () => {
      const r2 = new ProxyR2Bucket(makeClient(), 'STORAGE');
      const head = await r2.put('file.txt', 'hello');
      expect(head).not.toBeNull();
      expect(head!.key).toBe('file.txt');
    });

    it('deletes an object', async () => {
      const r2 = new ProxyR2Bucket(makeClient(), 'STORAGE');
      await expect(r2.delete('file.txt')).resolves.toBeUndefined();
    });

    it('lists objects', async () => {
      const r2 = new ProxyR2Bucket(makeClient(), 'STORAGE');
      const result = await r2.list();
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].key).toBe('a.txt');
      expect(result.truncated).toBe(false);
    });
  });

  describe('createRemoteEnv', () => {
    it('wires all bindings through a live proxy', async () => {
      const env = createRemoteEnv({
        __VOID_PROXY_URL: baseUrl,
        __VOID_TOKEN: TOKEN,
        __VOID_PROJECT_ID: PROJECT_ID,
        __VOID_REMOTE: '1',
        DB: {},
        KV: {},
        STORAGE: {},
      });

      // D1
      const db = env.DB as D1Database;
      const rows = await db.prepare('SELECT 1').all();
      expect(rows.success).toBe(true);

      // KV
      const kv = env.KV as KVNamespace;
      const val = await kv.get('mykey');
      expect(val).toBe('hello-world');

      // R2
      const r2 = env.STORAGE as R2Bucket;
      const obj = await r2.get('file.txt');
      expect(obj).not.toBeNull();
    });
  });

  describe('auth validation', () => {
    it('rejects requests with wrong token', async () => {
      const client = new ProxyClient(baseUrl, 'wrong-token', PROJECT_ID);
      const db = new ProxyD1Database(client, 'DB');
      await expect(db.prepare('SELECT 1').all()).rejects.toThrow(/401/);
    });
  });
});
