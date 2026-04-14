import { type as arktype } from 'arktype';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineHandler } from '../../src/runtime/handler';
import type { StandardSchemaV1 } from '../../src/standard-schema';

/**
 * These types mirror what generateRouteTypes() emits in .void/routes.d.ts.
 * The test verifies they correctly extract types from real TypedHandler instances
 * produced by defineHandler / defineHandler.withValidator with real schemas.
 *
 * In codegen the pattern is:
 *   output: Serialize<Awaited<(typeof import("../routes/..."))["GET"]["__output"]>>
 *   input:  ExtractInput<(typeof import("../routes/..."))["POST"]["__validators"]>
 *
 * Here we use `typeof handler` in place of `typeof import(...)["METHOD"]`.
 */
type Serialize<T> = T extends Response
  ? never
  : T extends Date
    ? string
    : T extends bigint
      ? never
      : T extends Function
        ? never
        : T extends undefined
          ? never
          : T extends Array<infer U>
            ? Array<Serialize<U>>
            : T extends object
              ? { [K in keyof T as T[K] extends Function ? never : K]: Serialize<T[K]> }
              : T;

type ExtractInput<V> = {
  [K in keyof V as V[K] extends StandardSchemaV1 ? K : never]: V[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<V[K]>
    : never;
};

// ─── Output extraction ──────────────────────────────────────────────────────

describe('Serialize<Awaited<handler.__output>>', () => {
  it('extracts plain object return type', () => {
    const handler = defineHandler((_c) => {
      return { name: 'Alice' as string, age: 30 as number };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ name: string; age: number }>();

    // @ts-expect-error - 'email' is not in the output type
    void ({} as Output).email;
  });

  it('converts Date to string', () => {
    const handler = defineHandler((_c) => {
      return { createdAt: new Date(), label: 'test' as string };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ createdAt: string; label: string }>();
  });

  it('strips function-valued keys', () => {
    const handler = defineHandler((_c) => {
      return { id: 1 as number, toJSON: () => '{}', name: 'x' as string };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ id: number; name: string }>();

    // @ts-expect-error - 'toJSON' was stripped by Serialize
    void ({} as Output).toJSON;
  });

  it('serializes arrays of objects', () => {
    const handler = defineHandler((_c) => {
      return [{ id: '1' as string, name: 'Alice' as string }];
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<Array<{ id: string; name: string }>>();
  });

  it('preserves primitives', () => {
    const handler = defineHandler((_c) => {
      return { count: 0 as number, active: true as boolean, label: '' as string };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ count: number; active: boolean; label: string }>();
  });

  it('works with withValidator return types', () => {
    const handler = defineHandler.withValidator({
      body: z.object({ name: z.string() }),
    })((_c, { body }) => {
      return { greeting: `Hello ${body.name}` as string };
    });
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Output>().toEqualTypeOf<{ greeting: string }>();
  });
});

// ─── Input extraction ───────────────────────────────────────────────────────

describe('ExtractInput<handler.__validators>', () => {
  it('is empty for plain defineHandler', () => {
    const handler = defineHandler((_c) => ({ ok: true }));
    type Input = ExtractInput<(typeof handler)['__validators']>;

    expectTypeOf<Input>().toEqualTypeOf<{}>();
  });

  it('extracts body from zod schema', () => {
    const handler = defineHandler.withValidator({
      body: z.object({ name: z.string(), count: z.number() }),
    })((_c, { body }) => ({ received: body.name }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{ body: { name: string; count: number } }>();
  });

  it('extracts params + body from valibot schemas', () => {
    const handler = defineHandler.withValidator({
      params: v.object({ id: v.string() }),
      body: v.object({ title: v.string() }),
    })((_c, { params, body }) => ({
      id: params.id,
      title: body.title,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      params: { id: string };
      body: { title: string };
    }>();
  });

  it('extracts query from arktype schema', () => {
    const handler = defineHandler.withValidator({
      query: arktype({ page: 'string', limit: 'string' }),
    })((_c, { query }) => ({
      page: query.page,
      limit: query.limit,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      query: { page: string; limit: string };
    }>();
  });

  it('extracts all three slots combined', () => {
    const handler = defineHandler.withValidator({
      params: z.object({ id: z.string() }),
      query: z.object({ format: z.string() }),
      body: z.object({ data: z.array(z.number()) }),
    })((_c, { params, query, body }) => ({
      id: params.id,
      format: query.format,
      count: body.data.length,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    expectTypeOf<Input>().toEqualTypeOf<{
      params: { id: string };
      query: { format: string };
      body: { data: number[] };
    }>();
  });
});

// ─── Combined input + output (full pipeline) ────────────────────────────────

describe('full extraction pipeline (input + output)', () => {
  it('zod: body in, serialized object out', () => {
    const handler = defineHandler.withValidator({
      body: z.object({ email: z.string(), tags: z.array(z.string()) }),
    })((_c, { body }) => ({
      email: body.email,
      tagCount: body.tags.length,
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Input>().toEqualTypeOf<{
      body: { email: string; tags: string[] };
    }>();
    expectTypeOf<Output>().toEqualTypeOf<{ email: string; tagCount: number }>();
  });

  it('valibot: params + body in, array out', () => {
    const handler = defineHandler.withValidator({
      params: v.object({ userId: v.string() }),
      body: v.object({ role: v.string() }),
    })((_c, { params, body }) => [{ userId: params.userId, role: body.role }]);

    type Input = ExtractInput<(typeof handler)['__validators']>;
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Input>().toEqualTypeOf<{
      params: { userId: string };
      body: { role: string };
    }>();
    expectTypeOf<Output>().toEqualTypeOf<Array<{ userId: string; role: string }>>();
  });

  it('arktype: query in, nested object out', () => {
    const handler = defineHandler.withValidator({
      query: arktype({ q: 'string' }),
    })((_c, { query }) => ({
      results: [{ match: query.q }],
      meta: { query: query.q },
    }));

    type Input = ExtractInput<(typeof handler)['__validators']>;
    type Output = Serialize<Awaited<(typeof handler)['__output']>>;

    expectTypeOf<Input>().toEqualTypeOf<{ query: { q: string } }>();
    expectTypeOf<Output>().toEqualTypeOf<{
      results: Array<{ match: string }>;
      meta: { query: string };
    }>();
  });
});
