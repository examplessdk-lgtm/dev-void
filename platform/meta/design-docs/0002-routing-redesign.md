# Design Document: Typed File-Based API Routes for Hono

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-16
**Status:** Implemented

---

## Problem & Prior Art

Building type-safe APIs requires bridging server-side handlers and client-side fetching. Existing solutions each have tradeoffs:

- **Hono RPC:** Full type safety via inference, but IDE slowdowns at 50-100+ routes (TypeScript must instantiate the entire app type on every keystroke).
- **Nitro:** Code generation for response types avoids scaling problems, but only generates output types — no input types.
- **Next.js:** Clean file-based routing with colocated methods, but no type bridge to client.

**Our approach combines all three strengths:** Next.js-style file routing, `defineHandler` capturing both input and output types, Hono as runtime, and Nitro-style code generation covering inputs _and_ outputs.

---

## Architecture

```
Route files (defineHandler + withValidator)
  │
  ├── Runtime: Hono app with registered routes
  │
  └── Codegen: .void/routes.d.ts (typeof import(...))
        │
        └── Typed fetch client (void/client)
```

---

## Key Design Decisions

### Codegen over pure inference

Hono RPC's `typeof app` forces TypeScript to instantiate the entire app type tree on every keystroke. Code generation moves this to a one-time build step, producing a flat `.d.ts` that is trivially cheap to consume. IDE performance is O(1) per route.

### Curried `withValidator(schema)(handler)`

Chosen over a builder pattern for simpler type plumbing, minimal API surface, and no changes needed to Hono's core. The validator's inferred type constrains the handler's parameter type through closure.

### Separate validator slots (body/query/params)

Body, query, and params are semantically distinct in HTTP and map to different fields in fetch options. Separating them produces precise client types.

### `Serialize<T>` wrapper

Models JSON serialization boundary: `Date` → `string`, `undefined` stripped, functions removed. Without it, client types wouldn't match what arrives over the wire.

### Standard Schema over library-specific types

`withValidator` accepts `StandardSchemaV1` — works with Zod, Valibot, ArkType, etc. with zero adapters. Uses `InferInput` for client-facing types (can omit fields with defaults) and `InferOutput` for handler parameter types (defaults applied).

Standard Schema V1 types are **inlined** in both the void source and the generated `routes.d.ts` — no `@standard-schema/spec` dependency needed.

### Type extraction via `typeof import(...)`

The codegen emits `typeof import("../../routes/api/users").GET` references. TypeScript resolves all types from the actual handler source — the codegen never analyzes types itself. This works regardless of how the validator schema is constructed (inline, imported, factory function).

---

## Implementation Details

### Generated output (`.void/routes.d.ts`)

```typescript
export {};
declare module 'void/routes' {
  interface RouteMap {
    '/api/users': {
      GET: {
        input: {};
        output: Serialize<Awaited<ReturnType<typeof import('../../routes/api/users').GET>>>;
      };
      POST: {
        input: ExtractInput<(typeof import('../../routes/api/users').POST)['__validators']>;
        output: Serialize<Awaited<ReturnType<typeof import('../../routes/api/users').POST>>>;
      };
    };
  }
}
```

The `export {}` is critical — without it, TypeScript treats the file as an ambient declaration (replaces the module) rather than an augmentation (merges with existing exports like `db` and `createDb`).

### Runtime validation

Uses Standard Schema's `~standard.validate()` method. On failure, returns 400 with structured error details. Error format is consistent across validation libraries because Standard Schema normalizes the issue shape.

**ArkType caveat:** `ArkErrors.map()` returns `ArkErrors` (not a plain array), causing `Response.json()` to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead.

### Typed `fetch` client (`void/client`)

```typescript
import { fetch } from 'void/client';

const users = await fetch('/api/users'); // typed output
await fetch('/api/users', {
  method: 'POST',
  body: { name: 'Alice', email: 'a@b.com' }, // typed input
});
const user = await fetch('/api/users/:id', {
  params: { id: '123' }, // path interpolation
});
```

Route paths autocomplete. Invalid paths are TypeScript errors. Method-specific input requirements are enforced.

---

## Comparison

| Aspect                   | This Design              | Hono RPC            | Nitro                    |
| ------------------------ | ------------------------ | ------------------- | ------------------------ |
| Method colocation        | Yes (named exports)      | Yes (chaining)      | No (one file per method) |
| Output type safety       | Yes (codegen)            | Yes (inference)     | Yes (codegen)            |
| Input type safety        | Yes (codegen+validators) | Yes (inference)     | No                       |
| IDE scaling              | O(1) per route           | O(n) (all routes)   | O(1) per route           |
| Validator agnostic       | Yes (Standard Schema)    | Yes (per-route)     | Manual                   |
| Input/Output distinction | Yes (InferInput/Output)  | Yes (per validator) | N/A                      |
