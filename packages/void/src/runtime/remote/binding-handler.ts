import { Hono } from 'hono';

/**
 * Creates a Hono app that handles `/__void/*` routes for native binding access.
 * Deployed user workers expose this so the proxy can dispatch D1/KV/R2 operations
 * via Workers for Platforms instead of the Cloudflare REST API (~1-5ms vs ~50-200ms).
 *
 * Authenticated via `x-void-internal` header against `env.__VOID_PROXY_TOKEN`.
 * Response formats match the proxy's existing REST API responses so the
 * ProxyClient doesn't need changes.
 */
export function createBindingHandler(env: Record<string, unknown>): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const token = c.req.header('x-void-internal');
    const expected = env.__VOID_PROXY_TOKEN as string | undefined;
    if (!token || !expected || token !== expected) {
      return c.json({ error: 'unauthorized' }, 403);
    }
    await next();
  });

  // --- D1 ---

  app.post('/d1/query', async (c) => {
    const body = await c.req.json<{
      binding: string;
      sql: string;
      params?: unknown[];
      method?: string;
    }>();

    if (!body.binding || !body.sql) {
      return c.json({ error: 'binding and sql required' }, 400);
    }

    const db = env[body.binding] as D1Database | undefined;
    if (!db) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const stmt = db.prepare(body.sql).bind(...(body.params ?? []));

    switch (body.method) {
      case 'first': {
        const row = await stmt.first();
        return c.json(row);
      }
      case 'raw': {
        const raw = await stmt.raw({ columnNames: true });
        const columns = raw.length > 0 ? (raw[0] as string[]) : [];
        const results = raw.slice(1) as unknown[][];
        return c.json({ columns, results, meta: {} });
      }
      case 'run': {
        const result = await stmt.run();
        return c.json({ success: true, meta: result.meta });
      }
      case 'all':
      default: {
        const result = await stmt.all();
        return c.json({
          results: result.results,
          success: true,
          meta: result.meta,
        });
      }
    }
  });

  app.post('/d1/batch', async (c) => {
    const body = await c.req.json<{
      binding: string;
      statements: { sql: string; params?: unknown[] }[];
    }>();

    if (!body.binding || !Array.isArray(body.statements)) {
      return c.json({ error: 'binding and statements required' }, 400);
    }

    const db = env[body.binding] as D1Database | undefined;
    if (!db) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const stmts = body.statements.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])));
    const results = await db.batch(stmts);
    return c.json(
      results.map((r) => ({
        results: r.results,
        success: true,
        meta: r.meta,
      })),
    );
  });

  // --- KV ---

  app.post('/kv/get', async (c) => {
    const body = await c.req.json<{
      binding: string;
      key: string;
      type?: string;
    }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const kv = env[body.binding] as KVNamespace | undefined;
    if (!kv) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const type = body.type ?? 'text';
    if (type === 'json') {
      const val = await kv.get(body.key, 'json');
      return c.json(val);
    }
    if (type === 'arrayBuffer') {
      const val = await kv.get(body.key, 'arrayBuffer');
      if (val === null) {
        return c.json(null);
      }
      return new Response(val, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (type === 'stream') {
      const val = await kv.get(body.key, 'stream');
      if (val === null) {
        return c.json(null);
      }
      return new Response(val, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    // Default: text
    const val = await kv.get(body.key, 'text');
    if (val === null) {
      return c.json(null);
    }
    return c.json(val);
  });

  app.post('/kv/put', async (c) => {
    const body = await c.req.json<{
      binding: string;
      key: string;
      value: unknown;
      base64?: boolean;
      expiration?: number;
      expiration_ttl?: number;
    }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const kv = env[body.binding] as KVNamespace | undefined;
    if (!kv) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const opts: KVNamespacePutOptions = {};
    if (body.expiration) {
      opts.expiration = body.expiration;
    }
    if (body.expiration_ttl) {
      opts.expirationTtl = body.expiration_ttl;
    }

    let value: string | ArrayBuffer;
    if (body.base64 && typeof body.value === 'string') {
      const binary = atob(body.value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      value = bytes.buffer as ArrayBuffer;
    } else {
      value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
    }

    await kv.put(body.key, value, opts);
    return c.json({ success: true });
  });

  app.post('/kv/delete', async (c) => {
    const body = await c.req.json<{ binding: string; key: string }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const kv = env[body.binding] as KVNamespace | undefined;
    if (!kv) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    await kv.delete(body.key);
    return c.json({ success: true });
  });

  app.post('/kv/list', async (c) => {
    const body = await c.req.json<{
      binding: string;
      prefix?: string;
      limit?: number;
      cursor?: string;
    }>();

    if (!body.binding) {
      return c.json({ error: 'binding required' }, 400);
    }

    const kv = env[body.binding] as KVNamespace | undefined;
    if (!kv) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const opts: KVNamespaceListOptions = {};
    if (body.prefix) {
      opts.prefix = body.prefix;
    }
    if (body.limit) {
      opts.limit = body.limit;
    }
    if (body.cursor) {
      opts.cursor = body.cursor;
    }

    const result = await kv.list(opts);
    return c.json({
      keys: result.keys,
      list_complete: result.list_complete,
      cursor: result.list_complete ? null : result.cursor,
    });
  });

  // --- R2 ---

  app.post('/r2/get', async (c) => {
    const body = await c.req.json<{ binding: string; key: string }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const bucket = env[body.binding] as R2Bucket | undefined;
    if (!bucket) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const obj = await bucket.get(body.key);
    if (!obj) {
      return c.json(null);
    }

    const headers = new Headers();
    headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
    if (obj.size !== undefined) {
      headers.set('content-length', String(obj.size));
    }
    if (obj.httpEtag) {
      headers.set('etag', obj.httpEtag);
    }

    return new Response(obj.body, { headers });
  });

  app.post('/r2/put', async (c) => {
    const body = await c.req.json<{
      binding: string;
      key: string;
      base64?: string;
      value?: string;
      contentType?: string;
    }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const bucket = env[body.binding] as R2Bucket | undefined;
    if (!bucket) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const data = body.base64
      ? Uint8Array.from(atob(body.base64), (ch) => ch.charCodeAt(0))
      : new TextEncoder().encode(body.value ?? '');

    await bucket.put(body.key, data, {
      httpMetadata: { contentType: body.contentType ?? 'application/octet-stream' },
    });

    return c.json({ success: true });
  });

  app.post('/r2/delete', async (c) => {
    const body = await c.req.json<{
      binding: string;
      key?: string;
      keys?: string[];
    }>();

    if (!body.binding) {
      return c.json({ error: 'binding required' }, 400);
    }

    const keys: string[] = body.keys ? body.keys : body.key ? [body.key] : [];
    if (keys.length === 0) {
      return c.json({ error: 'key or keys required' }, 400);
    }

    const bucket = env[body.binding] as R2Bucket | undefined;
    if (!bucket) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    await bucket.delete(keys);
    return c.json({ success: true });
  });

  app.post('/r2/list', async (c) => {
    const body = await c.req.json<{
      binding: string;
      prefix?: string;
      limit?: number;
      cursor?: string;
      delimiter?: string;
    }>();

    if (!body.binding) {
      return c.json({ error: 'binding required' }, 400);
    }

    const bucket = env[body.binding] as R2Bucket | undefined;
    if (!bucket) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const opts: R2ListOptions = {};
    if (body.prefix) {
      opts.prefix = body.prefix;
    }
    if (body.limit) {
      opts.limit = body.limit;
    }
    if (body.cursor) {
      opts.cursor = body.cursor;
    }
    if (body.delimiter) {
      opts.delimiter = body.delimiter;
    }

    const result = await bucket.list(opts);
    return c.json({
      objects: result.objects.map((o) => ({
        key: o.key,
        size: o.size,
        lastModified: o.uploaded?.toISOString() ?? '',
      })),
      truncated: result.truncated,
      cursor: result.truncated ? result.cursor : null,
    });
  });

  app.post('/r2/head', async (c) => {
    const body = await c.req.json<{ binding: string; key: string }>();

    if (!body.binding || !body.key) {
      return c.json({ error: 'binding and key required' }, 400);
    }

    const bucket = env[body.binding] as R2Bucket | undefined;
    if (!bucket) {
      return c.json({ error: `unknown binding "${body.binding}"` }, 404);
    }

    const obj = await bucket.head(body.key);
    if (!obj) {
      return c.json(null);
    }

    return c.json({
      key: body.key,
      size: obj.size,
      etag: obj.httpEtag ?? '',
      lastModified: obj.uploaded?.toISOString() ?? '',
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    });
  });

  return app;
}
