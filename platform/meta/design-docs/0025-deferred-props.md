---
title: Deferred Props
status: draft
created: 2026-02-24
---

# Deferred Props

## Problem

Some page data is slow to fetch (usage metrics, analytics, activity feeds) but the page shell and fast data should render immediately. Today, the loader blocks on all data before the page can render.

## Solution

A `defer()` wrapper in the loader return value that marks props as deferred. Deferred props are streamed to the client after the initial page render via a single HTTP response — no follow-up requests, no double computation.

## Design Decisions

| Decision   | Choice                                                    | Rationale                                                                                                                                                       |
| ---------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport  | Streaming (single response)                               | Loader runs once, no double computation, deferred resolvers share the same Worker invocation and Hono context                                                   |
| Grouping   | Named groups with single-prop shorthand                   | Flexible without extra concepts — a single deferred prop is just a group of one                                                                                 |
| Loader API | `defer()` wrapper inline in return value                  | Co-locates immediate and deferred props in one place                                                                                                            |
| Client API | `Deferred<T>` wrapper with `.value`, `.loading`, `.error` | Rich reactive state, explicit loading/error handling                                                                                                            |
| Props type | Inferred via `InferProps<typeof loader>`                  | Zero boilerplate. Vue's compiler falls back to `type: null` runtime validation (harmless — page router controls prop passing). Full TypeScript inference works. |

## Server API

### `defer()` function

```ts
// Single prop — group name auto-derived from object key
function defer<T>(resolver: (c: Context) => Promise<T>): Deferred<T>;

// Named group — multiple props resolved together
function defer<T extends Record<string, unknown>>(
  group: string,
  resolver: (c: Context) => Promise<T>,
): DeferredGroup<T>;

// DeferredGroup spreads — each key becomes Deferred<V>
type DeferredGroup<T> = { [K in keyof T]: Deferred<T[K]> };
```

### Loader usage

```ts
// pages/index.server.ts
import { defineHandler, defer, type InferProps } from "void";

export const loader = defineHandler(async (c) => {
  const projects = await db.query(...);
  return {
    projects,
    usage: defer((c) => fetchUsage(c)),
    ...defer("analytics", async (c) => ({
      metrics: await fetchMetrics(c),
      chart: await fetchChart(c),
    })),
  };
});

export type Props = InferProps<typeof loader>;
// {
//   projects: Project[];
//   usage: Deferred<UsageData>;
//   metrics: Deferred<Metrics>;
//   chart: Deferred<ChartData>;
// }
```

### `defer()` runtime sentinel

At runtime, `defer()` returns a marker object:

```ts
const DEFERRED = Symbol('deferred');

function defer(groupOrResolver, maybeResolver?) {
  const [group, resolver] = maybeResolver
    ? [groupOrResolver, maybeResolver]
    : [null, groupOrResolver];
  return { [DEFERRED]: true, group, resolver };
}
```

For single props, `separateDeferred()` uses the object key as the group name. For spreads, the explicit group name is used.

## Streaming Protocol

### SSR (initial page load)

```
Chunk 1 (immediate):
  <!doctype html>
  <div id="app" data-page='{"component":"index","props":{...},"deferred":["usage","analytics"]}'>
    <!-- renderToString() output with immediate props -->
  </div>
  <script type="module" src="/entry-client.js"></script>

Chunk 2..N (as each group resolves):
  <script>window.__resolveDeferred("usage",{"requests":1200})</script>

On error:
  <script>window.__rejectDeferred("analytics",{"message":"timeout"})</script>

Final: close stream
```

### SPA navigation

Client fetches with `X-VoidPages: true`, reads body as NDJSON:

```
{"component":"index","props":{"projects":[...]},"deferred":["usage","analytics"]}
{"__deferred":"usage","data":{"requests":1200}}
{"__deferred":"analytics","data":{"metrics":{...},"chart":{...}}}
```

On error: `{"__deferred":"analytics","error":"timeout"}`

### Timeout

If the Worker hits its CPU limit before all groups resolve, the stream closes. The client sets unresolved wrappers to `error: "Stream closed before resolution"`.

## Server Implementation

### `handlePageGet` changes

1. Run the loader — get return value with plain values and `defer()` sentinels
2. `separateDeferred()` splits them: immediate props → `PageObject.props`, sentinels → `deferredMap`
3. `PageObject.deferred` lists group names
4. Start streaming response via `TransformStream`:
   - SSR: `renderToString()` with immediate props → write HTML chunk
   - SPA: write PageObject as first NDJSON line
5. Fire all deferred resolvers in parallel
6. As each settles, write result to stream
7. Close stream when all done

### PageObject extension

```ts
type PageObject = {
  component: string;
  props: Record<string, unknown>;
  shared: Record<string, unknown>;
  url: string;
  errors: Record<string, string> | null;
  deferred: string[]; // NEW — group names
};
```

## Client Implementation

### `Deferred<T>` type

```ts
type Deferred<T> = {
  readonly value: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
};
```

At runtime, created as a Vue reactive object:

```ts
function createDeferred<T>(): Deferred<T> {
  return reactive({ value: null, loading: true, error: null });
}
```

### SSR hydration flow

1. Read `data-page` — see `deferred: ["usage", "analytics"]`
2. Create reactive `Deferred` wrappers, inject into `pageObj.props`
3. Hydrate with `createSSRApp()`
4. Register `window.__resolveDeferred(group, data)` and `window.__rejectDeferred(group, error)`
5. Streamed `<script>` tags execute as they arrive, updating reactive state

### SPA navigation flow

1. Fetch with `X-VoidPages: true`, read response as stream
2. First NDJSON line → mount page with immediate props + `Deferred` wrappers
3. Subsequent lines → resolve/reject corresponding wrappers
4. On navigation away: `AbortController.abort()` cancels the fetch, Worker stream closes, stale wrappers discarded with old page

### Component usage

```vue
<script setup lang="ts">
import type { Props } from './index.server';
const { projects, usage, metrics, chart } = defineProps<Props>();
</script>

<template>
  <ProjectList :projects="projects" />

  <div v-if="usage.loading"><Skeleton /></div>
  <div v-else-if="usage.error">Failed to load usage</div>
  <UsageChart v-else :data="usage.value" />

  <div v-if="metrics.loading"><Skeleton /></div>
  <div v-else>
    <MetricsTable :data="metrics.value" />
    <ChartView :data="chart.value" />
  </div>
</template>
```

## Type Safety

```ts
// Framework utility type
type InferProps<T> = T extends TypedHandler<any, infer R> ? R : never;
```

TypeScript resolves this fully — IDE autocomplete, `tsc` checking, all work. Vue's SFC compiler cannot resolve `infer`-based conditional types, so it falls back to `type: null` for runtime prop validation. This is harmless: the page router is the only thing passing these props, and TypeScript is the real safety net.
