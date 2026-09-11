---
outline: deep
---

# Durable State

Use typed Durable Objects when state must be strongly consistent and coordinated by a stable name, such as a shopping cart, collaborative room, rate limiter, or workflow.

Void turns each module in `durable-objects/` into a SQLite-backed Cloudflare Durable Object. The filename determines the binding, worker class, and initial Cloudflare migration, so no Wrangler configuration is needed.

Void writes the inferred binding and migration entry to `wrangler.jsonc`. Commit that file: Cloudflare Durable Object migrations are append-only, and the persisted order ensures a newly added module is migrated after every class already deployed.

## Define state and methods

```ts
// durable-objects/counter.ts
import { defineDurableState } from 'void/durable';

export const Counter = defineDurableState({
  initialState: { count: 0 },
  methods: {
    increment(context, amount: number) {
      context.state.count += amount;
      return context.state.count;
    },
    read(context) {
      return context.state.count;
    },
  },
});

export default Counter;
```

The default export must be the object returned by `defineDurableState()`. Void uses it to export the generated Cloudflare class and associate the inferred binding at worker startup.

For `counter.ts`, Void generates:

| Resource                 | Generated name            |
| ------------------------ | ------------------------- |
| Binding                  | `COUNTER`                 |
| Worker class             | `CounterDurableObject`    |
| Cloudflare migration tag | `void-durable-counter-v1` |

Names are derived from kebab-case filenames: `shopping-cart.ts` becomes `SHOPPING_CART` and `ShoppingCartDurableObject`.

## Call it from a route

Import the same named definition and select an object by name. Calls are typed from the method definitions, including arguments and return values.

```ts
// routes/api/counter.ts
import { defineHandler } from 'void';
import { Counter } from '../../durable-objects/counter';

export const POST = defineHandler(async () => {
  const counter = Counter.get('global');
  const count = await counter.increment(1);
  return { count };
});
```

The same name always resolves to the same Durable Object. Use `getById(id)` when you already have a `DurableObjectId`. For advanced cases, both helpers also accept an explicit `DurableObjectNamespace` as their first argument.

## Execution and persistence

Void loads state before the first operation, serializes RPC method calls, and writes the state record after each successful method, `fetch`, or `alarm` handler. If a handler or the state write fails, Void restores `context.state` to its value before the operation so later operations cannot persist the failed mutation. Direct writes through `context.storage` are outside this rollback guarantee. A method receives:

- `context.state`, which can be mutated or replaced
- `context.env`, the Durable Object environment
- `context.id` and `context.storage`
- `context.setAlarm()` and `context.deleteAlarm()`

Methods named `fetch`, `alarm`, or `constructor` are reserved. Define `fetch` and `alarm` as top-level hooks instead:

```ts
export const Room = defineDurableState({
  initialState: { wakeups: 0 },
  methods: {},
  fetch(context) {
    return Response.json(context.state);
  },
  async alarm(context) {
    context.state.wakeups += 1;
    await context.setAlarm(Date.now() + 60_000);
  },
});

export default Room;
```

## State migrations

Version the persisted value when its shape changes. Versions start at `1`, must be contiguous, and run in order before an operation handles the migrated state.

```ts
export const Counter = defineDurableState({
  initialState: { count: 0, label: 'Counter' },
  version: 2,
  migrations: [
    {
      version: 1,
      migrate(old) {
        return { count: (old as { count: number }).count, label: 'Counter' };
      },
    },
    {
      version: 2,
      migrate(old) {
        return { ...(old as { count: number; label: string }), label: 'Total' };
      },
    },
  ],
  methods: {
    read(context) {
      return context.state;
    },
  },
});

export default Counter;
```

These state migrations are separate from Cloudflare's Durable Object class migration. Void generates the latter with `new_sqlite_classes` when it discovers the file.

Do not delete or reorder generated Durable Object migrations in `wrangler.jsonc` after deployment. Renaming or removing a Durable Object class requires an explicit Cloudflare class migration and is not automated yet.

## Deployment support

Typed durable state currently requires a native Void app targeting Cloudflare. It works in local development, manual Wrangler deploys, and `void deploy --platform cloudflare`. The direct deploy path supports it because the generated class is SQLite-backed.

Void-managed deployment does not yet carry custom Durable Object modules in its deploy manifest, so `void deploy --platform void` fails before building and points to the direct Cloudflare path. Meta-framework adapter mode and `node`, `bun`, or `deno` targets also fail with guidance when `durable-objects/` is present.

This is separate from [typed WebSocket routes](./websockets.md), whose current `*.ws.ts` classes use a legacy key-value-backed migration and therefore remain unsupported by direct Cloudflare deploys.
