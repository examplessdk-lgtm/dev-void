---
title: Link Prefetch
status: draft
created: 2026-02-26
---

# Link Prefetch

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Problem

The `<Link>` component navigates via `router.visit()`, which fetches the page JSON and resolves the component JS sequentially on click. Every navigation pays full network latency for both the data fetch and the JS chunk download. For pages the user is likely to visit next, we can eliminate this latency by prefetching ahead of time.

## Solution

Add prefetch support to `<Link>` and `router.prefetch()`. Three prefetch targets depending on route type:

1. **Component JS** — fire the dynamic `import()` early to warm the browser module cache
2. **Page data** — fetch the `X-VoidPages` JSON and cache it client-side with TTL
3. **Island HTML** — for island/markdown routes, use `<link rel="prefetch">` to warm the browser HTTP cache

## Design Decisions

| Decision         | Choice                                          | Rationale                                                                                          |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| What to prefetch | Component JS + page data                        | Eliminates both JS download and data fetch latency for near-instant navigations                    |
| Strategies       | hover, click, mount, visible                    | Full suite covers all common patterns — users pick per-link via prop                               |
| Caching          | TTL with stale-while-revalidate                 | Matches Inertia's proven model; SWR avoids jarring stale-then-refetch for short-lived data         |
| Deferred props   | `Purpose: prefetch` header, server inlines      | Avoids NDJSON stream buffering complexity in the cache; trades server compute for navigation speed |
| Island routes    | `<link rel="prefetch">` via build-time manifest | Browser-native prefetch for HTML; requires emitting route metadata to the client                   |

## API Surface

### Link Component

```vue
<Link href="/projects" prefetch>Default — hover with 75ms delay</Link>
<Link href="/projects" prefetch="hover">Explicit hover</Link>
<Link href="/projects" prefetch="click">Prefetch on mousedown</Link>
<Link href="/projects" prefetch="mount">Prefetch on mount</Link>
<Link href="/projects" prefetch="visible">Prefetch when visible (IntersectionObserver)</Link>
<Link href="/projects" :prefetch="['mount', 'hover']">Multiple strategies</Link>

<!-- Cache control -->
<Link href="/projects" prefetch :cache-for="5000">5 seconds</Link>
<Link href="/projects" prefetch cache-for="1m">1 minute</Link>
<Link
  href="/projects"
  prefetch
  :cache-for="['30s', '1m']"
>SWR — fresh 30s, stale-revalidate up to 1m</Link>
```

New props on `<Link>`:

| Prop       | Type                                   | Default                                    |
| ---------- | -------------------------------------- | ------------------------------------------ |
| `prefetch` | `boolean \| Strategy \| Strategy[]`    | `false`                                    |
| `cacheFor` | `number \| string \| [string, string]` | `'30s'` (hover/mount/visible), `0` (click) |

Where `Strategy = 'hover' | 'click' | 'mount' | 'visible'`.

### Plugin Config

```ts
voidVue({
  prefetch: {
    hoverDelay: 75, // ms before hover triggers prefetch
    cacheFor: '30s', // default TTL for all prefetched links
  },
});
```

### Programmatic API

```ts
const router = useRouter();

router.prefetch('/projects'); // prefetch a URL manually
router.flush('/projects'); // flush single cache entry
router.flushAll(); // flush entire prefetch cache
```

## Prefetch Strategies

**hover** — `mouseenter` starts a timer (default 75ms). `mouseleave` clears it. If the timer fires, prefetch executes. Avoids prefetching on quick mouse-throughs.

**click** — `mousedown` triggers prefetch. The actual navigation happens on `click` (which fires after `mousedown` + `mouseup`). By the time the click handler calls `router.visit()`, the prefetch response is likely already cached. Default `cacheFor` is `0` (single-use — consumed on navigation, not persisted).

**mount** — `onMounted()` triggers prefetch immediately. Useful for "next step" links where you know the user will navigate (e.g., wizard flows, pagination).

**visible** — `IntersectionObserver` triggers prefetch when the link scrolls into view. Observer is disconnected on `onUnmounted()`. Good for content-heavy pages with many links below the fold.

Multiple strategies compose: `['mount', 'hover']` prefetches on mount, then re-prefetches on hover if the cache has gone stale.

## Response Cache

A singleton `PrefetchCache` on the router, keyed by `url + method`.

```ts
type CacheEntry = {
  url: string;
  method: string;
  response: Promise<PageObject>;
  staleAt: number; // Date.now() + stale ms
  expiresAt: number; // Date.now() + expires ms
  singleUse: boolean; // true when cacheFor === 0
  timer: ReturnType<typeof setTimeout>; // auto-eviction
};
```

### Lookup flow in `router.visit()`

1. Check cache for matching `url + method`
2. If hit and fresh (`Date.now() < staleAt`) — use cached response, skip fetch
3. If hit and stale (`staleAt < Date.now() < expiresAt`) — use cached response AND fire background refetch to update the entry
4. If expired or miss — normal fetch

### Cache invalidation

- Entries auto-evict via `setTimeout` at `expiresAt`
- `router.flush(url)` removes a specific entry
- `router.flushAll()` clears everything
- Any non-GET `router.visit()` (POST/PUT/DELETE) flushes the entire cache (mutations invalidate data)

### `cacheFor` parsing

- Number → milliseconds
- String → `'30s'`, `'1m'`, `'2h'`, `'1d'`, `'500ms'`
- Tuple → `['30s', '1m']` = stale after 30s, expires after 1m (SWR)
- Single value → `staleAt === expiresAt` (no SWR window)

## Deferred Props Interaction

When prefetching, the request includes a `Purpose: prefetch` header. The server detects this in `handlePageGet()` and resolves all deferred props inline — returning plain JSON instead of an NDJSON stream.

```
Client:  GET /projects  X-VoidPages: true  Purpose: prefetch
Server:  200  { component, props: { ...all props including deferred }, deferred: [] }
```

The `deferred` array is empty because everything was resolved. When the user navigates and `router.visit()` consumes the cached response, it sees no deferred keys and does a simple prop assignment — no streaming needed.

This trades server compute (resolving deferred props eagerly) for navigation speed. Since prefetch requests are speculative and may never be consumed, this is a reasonable tradeoff — the server does slightly more work, but the user gets instant navigation when they do click.

## Island & Markdown Routes

Island and markdown routes don't participate in the `X-VoidPages` JSON protocol — they always return HTML and trigger full-page navigation via `window.location.href`. Prefetching them requires a different mechanism.

### Build-time route metadata table

The client manifest (`pages-manifest.ts`) currently emits `components` and `layoutTree`. We add a third structure — `routeMeta`:

```js
const routeMeta = {
  index: { island: true },
  'blog/[slug]': { island: true },
  'projects/[id]': {},
};
```

Only pages with non-default metadata get entries (sparse — most pages omit the key entirely). Bundle cost is near-zero for apps without islands.

### Prefetch behavior for islands

When `<Link>` prefetch triggers for an island route (detected via `routeMeta`), instead of fetching page JSON, it injects a `<link rel="prefetch">` element into `<head>`:

```html
<link rel="prefetch" href="/blog/hello-world" as="document" />
```

The browser fetches and caches the HTML response. When `router.visit()` later hits the `window.location.href` fallback, the browser serves the prefetched HTML from its cache.

### URL-to-componentId matching

The client needs to resolve a URL like `/projects/123` to a `componentId` like `"projects/[id]"` to look up `routeMeta` and fire the right component `import()`. We add a lightweight pattern matcher to the client entry, generated from the scan result's `pattern` field:

```js
const routes = [
  { pattern: /^\/$/, id: 'index' },
  { pattern: /^\/projects$/, id: 'projects/index' },
  { pattern: /^\/projects\/([^/]+)$/, id: 'projects/[id]' },
  { pattern: /^\/blog\/([^/]+)$/, id: 'blog/[slug]' },
];

function matchRoute(url) {
  for (const r of routes) {
    if (r.pattern.test(url)) return r.id;
  }
  return null;
}
```

## Complete Prefetch Flow

```
router.prefetch(url)
  │
  ├─ matchRoute(url) → componentId
  │   └─ null? → bail (unknown route, let visit() handle it)
  │
  ├─ routeMeta[componentId].island?
  │   └─ yes → inject <link rel="prefetch" href={url} as="document">
  │            return (no component JS or data to prefetch)
  │
  ├─ Component JS prefetch:
  │   ├─ components[componentId]()
  │   └─ layoutTree[componentId]?.map(id => components[id]())
  │
  └─ Data prefetch:
      ├─ check cache → fresh hit? → done
      ├─ check cache → stale hit? → return stale, fire background refetch
      └─ miss? → fetch(url, { headers: { "X-VoidPages": "true", "Purpose": "prefetch" } })
                 → cache the PageObject with TTL
```

`router.visit()` is modified to check the cache before fetching:

```
router.visit(url)
  │
  ├─ cache.get(url)?
  │   ├─ fresh → use cached PageObject, skip fetch
  │   ├─ stale → use cached PageObject, fire background refetch
  │   └─ miss → normal fetch (existing behavior)
  │
  └─ (rest of visit unchanged — resolve component, apply update, pushState, scroll)
```

Component resolution in `visit()` already calls the dynamic import — since prefetch already fired it, the import resolves instantly from the browser's module cache.

## Implementation Scope

### Files to modify

| File                                     | Changes                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/vue/src/runtime/link.ts`       | Add `prefetch`/`cacheFor` props, hover/click/mount/visible listeners                               |
| `packages/vue/src/plugin-pages.ts`       | Add `prefetch()` method on router, prefetch cache, `matchRoute()`, modify `visit()` to check cache |
| `packages/vue/src/pages-manifest.ts`     | Emit `routeMeta` and `routes` pattern table                                                        |
| `packages/vue/src/runtime/use-router.ts` | Add `prefetch`/`flush`/`flushAll` to router type                                                   |
| `packages/void/src/pages/protocol.ts`    | Detect `Purpose: prefetch` header, inline deferred props                                           |

No changes needed to: `scan.ts` (already has `island` flag), `compile.ts` (server routing unchanged), React runtime (Vue-only for now).
