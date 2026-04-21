import { type } from 'arktype';
import { Hono } from 'hono';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineHandler, type CloudContext, type TypedHandler } from '../../src/runtime/handler';
import { convertReturnValue } from '../../src/runtime/response';

type ValidationIssueBody = {
  error: string;
  issues: Array<{
    slot: string;
    issues: Array<{ message: string; path?: string }>;
  }>;
};

function postJson(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createPostApp(handler: (c: CloudContext) => unknown, path = '/test') {
  const app = new Hono();
  app.post(path, async (c) => {
    return convertReturnValue(await handler(c as unknown as CloudContext));
  });
  return app;
}

function createGetApp(handler: (c: CloudContext) => unknown, path = '/test') {
  const app = new Hono();
  app.get(path, async (c) => {
    return convertReturnValue(await handler(c as unknown as CloudContext));
  });
  return app;
}

function createValidatedApp(method: 'get' | 'post', path: string, handler: TypedHandler) {
  const app = new Hono();
  app[method](path, async (c) => {
    return convertReturnValue(await handler(c as unknown as CloudContext));
  });
  return app;
}

// ─── Zod ─────────────────────────────────────────────────────────────────────

describe('withValidator + zod', () => {
  const CreateUser = z.object({
    name: z.string().min(1),
    email: z.string().email(),
  });

  it('type: infers body and rejects undeclared slots', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed();
      return body;
    });

    defineHandler.withValidator({
      body: CreateUser,
      // @ts-expect-error - 'query' was not declared in validators
    })((_c, { body, _query }) => {
      return body;
    });

    expect(true).toBe(true); // compile-time type test
  });

  it('accepts valid body', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return { name: body.name, email: body.email };
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { name: 'Alice', email: 'alice@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('rejects invalid body with 400', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return body;
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { name: '', email: 'not-an-email' }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
    expect(json.issues[0].issues.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects completely wrong shape', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return body;
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { garbage: 123 }));

    expect(res.status).toBe(400);
  });

  it('validates query params', async () => {
    const Pagination = z.object({
      page: z.string(),
      limit: z.string(),
    });

    const handler = defineHandler.withValidator({
      query: Pagination,
    })((_c, { query }) => {
      return { page: query.page, limit: query.limit };
    });

    const app = createGetApp(handler);
    const res = await app.request(new Request('http://localhost/test?page=2&limit=20'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: '2', limit: '20' });
  });

  it('validates params + body together', async () => {
    const Params = z.object({ id: z.string() });
    const Body = z.object({ role: z.enum(['admin', 'user']) });

    const handler = defineHandler.withValidator({
      params: Params,
      body: Body,
    })((_c, { params, body }) => {
      return { userId: params.id, role: body.role };
    });

    const app = createValidatedApp('post', '/users/:id/role', handler);

    const res = await app.request(postJson('/users/42/role', { role: 'admin' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: '42', role: 'admin' });
  });
});

// ─── Valibot ─────────────────────────────────────────────────────────────────

describe('withValidator + valibot', () => {
  const CreateUser = v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  });

  it('type: infers body and query types from schema', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed();
      return body;
    });

    defineHandler.withValidator({
      query: v.object({ q: v.string() }),
    })((_c, { query }) => {
      // @ts-expect-error - 'page' does not exist on { q: string }
      void query.page;
      return query;
    });

    expect(true).toBe(true); // compile-time type test
  });

  it('accepts valid body', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return { name: body.name, email: body.email };
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { name: 'Bob', email: 'bob@example.com' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Bob', email: 'bob@example.com' });
  });

  it('rejects invalid body with 400', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return body;
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { name: '', email: 'bad' }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
    expect(json.issues[0].issues.length).toBeGreaterThanOrEqual(1);
  });

  it('validates query params', async () => {
    const Search = v.object({
      q: v.string(),
    });

    const handler = defineHandler.withValidator({
      query: Search,
    })((_c, { query }) => {
      return { q: query.q };
    });

    const app = createGetApp(handler);
    const res = await app.request(new Request('http://localhost/test?q=hello'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ q: 'hello' });
  });

  it('validates params + body together', async () => {
    const Params = v.object({ id: v.string() });
    const Body = v.object({ title: v.string() });

    const handler = defineHandler.withValidator({
      params: Params,
      body: Body,
    })((_c, { params, body }) => {
      return { id: params.id, title: body.title };
    });

    const app = createValidatedApp('post', '/items/:id', handler);

    const res = await app.request(postJson('/items/7', { title: 'Updated' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '7', title: 'Updated' });
  });
});

// ─── ArkType ─────────────────────────────────────────────────────────────────

describe('withValidator + arktype', () => {
  const CreateUser = type({
    name: 'string >= 1',
    email: 'string.email',
  });

  it('type: infers body and params types from schema', () => {
    defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      // @ts-expect-error - 'age' does not exist on { name: string; email: string }
      void body.age;
      // @ts-expect-error - name is string, toFixed exists only on number
      void body.name.toFixed();
      return body;
    });

    defineHandler.withValidator({
      params: type({ id: 'string' }),
    })((_c, { params }) => {
      // @ts-expect-error - 'slug' does not exist on { id: string }
      void params.slug;
      return params;
    });

    expect(true).toBe(true); // compile-time type test
  });

  it('accepts valid body', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return { name: body.name, email: body.email };
    });

    const app = createPostApp(handler);
    const res = await app.request(
      postJson('/test', { name: 'Charlie', email: 'charlie@example.com' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Charlie', email: 'charlie@example.com' });
  });

  it('rejects invalid body with 400', async () => {
    const handler = defineHandler.withValidator({
      body: CreateUser,
    })((_c, { body }) => {
      return body;
    });

    const app = createPostApp(handler);
    const res = await app.request(postJson('/test', { name: '', email: 'not-email' }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as ValidationIssueBody;
    expect(json.error).toBe('Validation failed');
    expect(json.issues[0].slot).toBe('body');
    expect(json.issues[0].issues.length).toBeGreaterThanOrEqual(1);
  });

  it('validates query params', async () => {
    const Query = type({ tag: 'string' });

    const handler = defineHandler.withValidator({
      query: Query,
    })((_c, { query }) => {
      return { tag: query.tag };
    });

    const app = createGetApp(handler);
    const res = await app.request(new Request('http://localhost/test?tag=featured'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: 'featured' });
  });

  it('validates params + body together', async () => {
    const Params = type({ slug: 'string' });
    const Body = type({ published: 'boolean' });

    const handler = defineHandler.withValidator({
      params: Params,
      body: Body,
    })((_c, { params, body }) => {
      return { slug: params.slug, published: body.published };
    });

    const app = createValidatedApp('post', '/posts/:slug', handler);

    const res = await app.request(postJson('/posts/my-post', { published: true }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'my-post', published: true });
  });
});
