# Islands Mode — Design Document

**Date:** 2026-02-23
**Status:** Design

---

## Summary

Islands mode adds selective hydration to Vite Cloud's pages routing. Pages opt in via a `.island.tsx` / `.island.vue` file suffix. Components within island pages are server-only by default — zero JavaScript shipped. Individual components opt into client-side hydration via import attributes:

```tsx
import Counter from '../components/Counter' with { island: 'load' };
```

The server-side story is completely unchanged: same `.server.ts` files, same `defineHandler`, same loaders, same actions, same middleware, same layouts, same edge caching. Islands is purely a client-side hydration strategy.

---

## Motivation

Vite Cloud's pages routing uses an Inertia-style model: full page hydration, SPA navigation via JSON swaps. This is ideal for interactive applications (dashboards, admin panels, SaaS apps) but ships more JavaScript than necessary for content-heavy pages (blogs, docs, marketing sites, landing pages).

Islands mode provides an alternative: server-render the entire page, hydrate only the interactive parts. Content-heavy pages get near-zero JS bundles while retaining interactivity where needed.

---

## Design Principles

1. **Per-file opt-in, not a separate directory.** Island pages live in `pages/` alongside regular pages. The `.island` suffix is the only difference. One router, one set of conventions.
2. **Components are shared.** A component like `Counter.tsx` works in both regular pages (full Inertia hydration) and island pages (selective hydration). No duplication, no special component files.
3. **Import attributes for directives.** Hydration strategy is declared at the import site using TC39 stage 4 import attributes. No invented JSX syntax, no type hacks, no framework-specific directives.
4. **Detection at the Vite layer.** The Vite plugin resolves import attributes in `resolveId` — no Babel plugins, no Vue template transforms. Framework-agnostic by design.
5. **Server side is identical.** `.server.ts` files, `defineHandler`, loaders, actions, middleware, layouts, edge caching — all unchanged.

---

## File Convention

```
pages/
  layout.tsx                # Inertia layout (full hydration)
  dashboard/
    index.tsx               # Regular page — full Inertia hydration, SPA nav
    index.server.ts
  index.island.tsx          # Island page — selective hydration, full-page nav
  index.server.ts
  blog/
    layout.island.tsx       # Island layout — switches subtree to islands mode
    [slug].island.tsx       # Island page
    [slug].server.ts
  pricing.island.tsx        # Island page with one interactive widget
  pricing.server.ts
```

### Rules

- `.island.tsx` / `.island.vue` pages are server-rendered with selective hydration.
- Regular `.tsx` / `.vue` pages behave exactly as today (Inertia protocol, full hydration).
- Both can coexist in the same route tree, share the same middleware, and use the same `.server.ts` files.
- A `layout.island.tsx` switches its subtree to islands mode. Child pages in that subtree should also be `.island` files.

---

## Hydration Directives via Import Attributes

Inside an `.island` page, all components are server-only by default. To hydrate a component on the client, annotate its import:

```tsx
// pages/index.island.tsx
import Counter from '../components/Counter' with { island: 'load' };
import NewsletterForm from '../components/NewsletterForm' with { island: 'visible' };
import PricingCalc from '../components/PricingCalc' with { island: 'idle' };
import MobileNav from '../components/MobileNav' with { island: 'media:(max-width: 768px)' };

export default function Home({ posts, stats }: Props) {
  return (
    <main>
      <h1>Welcome — {stats.visitors} visitors this month</h1>

      {/* Hydrates immediately on page load */}
      <Counter initial={stats.count} />

      {/* Hydrates when scrolled into view */}
      <NewsletterForm />

      {/* Hydrates on requestIdleCallback */}
      <PricingCalc tiers={stats.tiers} />

      {/* Hydrates when media query matches */}
      <MobileNav />

      {/* No island import — pure server HTML, zero JS */}
      <ul>
        {posts.map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
    </main>
  );
}
```

### Hydration Strategies

| Attribute value              | Behavior                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `"load"`                     | Hydrate immediately on page load. Default for interactive.  |
| `"visible"`                  | Hydrate when element enters viewport (IntersectionObserver) |
| `"idle"`                     | Hydrate on `requestIdleCallback`                            |
| `"media:(max-width: 768px)"` | Hydrate when media query matches                            |

### Vue Parity

Identical syntax in `<script setup>`:

```vue
<!-- pages/index.island.vue -->
<script setup lang="ts">
import Counter from '../components/Counter.vue' with { island: 'load' };
import NewsletterForm from '../components/NewsletterForm.vue' with { island: 'visible' };

defineProps<{ posts: Post[]; stats: Stats }>();
</script>

<template>
  <main>
    <h1>Welcome — {{ stats.visitors }} visitors this month</h1>
    <Counter :initial="stats.count" />
    <NewsletterForm />
    <ul>
      <li v-for="p in posts" :key="p.id">{{ p.title }}</li>
    </ul>
  </main>
</template>
```

### Multiple Strategies for the Same Component

Import attributes are per-import. To use the same component with different hydration strategies on the same page (rare), use aliased imports:

```tsx
import Counter from '../components/Counter' with { island: 'load' };
import CounterLazy from '../components/Counter' with { island: 'visible' };
```

---

## Server Side (Unchanged)

Island pages use the exact same `.server.ts` convention as regular pages. The server doesn't know or care whether a page is an island page.

### Loaders

```ts
// pages/blog/[slug].server.ts
import { defineHandler } from 'vite-cloud';
import { db } from 'vite-cloud/db';

export type Props = {
  post: { title: string; body: string; publishedAt: string };
  comments: Array<{ id: number; author: string; body: string }>;
};

export const loader = defineHandler<Props>(async (c) => {
  const slug = c.req.param('slug');
  const post = await db.get('posts', { where: { slug } });
  if (!post) return c.notFound();
  const comments = await db.list('comments', { where: { post_id: post.id } });
  return { post, comments };
});
```

### Actions

Actions work via standard HTML forms (zero JS) or island-hydrated form components:

```ts
// pages/blog/[slug].server.ts
export const action = defineHandler.withValidator({
  body: commentSchema,
})(async (c, { body }) => {
  await db.insert('comments', { ...body, post_id: c.req.param('slug') });
  // No return → re-runs loader, full page reload with fresh data
});
```

```tsx
// pages/blog/[slug].island.tsx
import CommentForm from '../components/CommentForm' with { island: 'visible' };

export default function BlogPost({ post, comments }: Props) {
  return (
    <article>
      <h1>{post.title}</h1>
      <div>{post.body}</div>

      {/* Works with zero JS — standard HTML form */}
      <form method="post">
        <textarea name="body" />
        <button type="submit">Add Comment</button>
      </form>

      {/* Or use an island for a richer experience */}
      <CommentForm postId={post.id} />
    </article>
  );
}
```

### Edge Caching

Island pages are ideal for aggressive edge caching:

```ts
// pages/blog/[slug].server.ts
export const revalidate = 31536000; // cache until next deploy
```

The server-rendered HTML is cached at the edge. Island components hydrate independently on the client.

---

## Navigation Model

### Within Islands Pages

Standard full-page navigation. Plain `<a>` tags, browser handles everything. The edge cache makes this fast — most island pages serve from R2 in ~50ms.

View Transitions (already supported in pages mode) provide smooth cross-fades:

1. User clicks a link
2. Browser fetches the new page (R2 cache hit)
3. View Transition API cross-fades between documents
4. New page's islands hydrate independently

No client-side router. JS footprint stays tiny.

### Between Islands and Regular Pages

Crossing between an island page and a regular Inertia page is a full-page navigation in both directions:

- **Inertia → Island:** The Inertia client-side router sends a request with the `X-Inertia` header. The server detects the target is an island page and responds with full HTML instead of JSON. The Inertia client sees a non-JSON response and falls back to `window.location = url`.
- **Island → Inertia:** A plain `<a>` tag triggers a full page load. The Inertia page hydrates normally on load.

No special handling needed from the developer. Links between modes just work.

---

## Build Pipeline

### Detection (Vite Plugin — Framework Agnostic)

The Vite plugin intercepts import attributes in the `resolveId` hook:

```ts
resolveId(source, importer, options) {
  const hydrate = options.attributes?.island;
  if (hydrate && importer?.match(/\.island\.(tsx|vue)$/)) {
    const resolved = await this.resolve(source, importer);
    // Record in island manifest for this page
    this.islandManifest.add(importer, {
      component: resolved.id,
      hydrate,
    });
    // Return virtual module ID that wraps the component
    return `\0island:${resolved.id}?hydrate=${hydrate}`;
  }
}
```

This runs at the Vite level, below any framework. No Babel plugins, no Vue template transforms. React, Vue, and any future framework adapter get island detection for free.

### SSR Rendering

At SSR time, the virtual island module wraps the component's rendered output in marker elements:

```html
<div data-island="Counter" data-props='{"initial":42}' data-hydrate="load">
  <!-- Server-rendered Counter HTML -->
  <button>42</button>
</div>
```

The marker carries:

- `data-island` — component identifier (maps to the async chunk)
- `data-props` — serialized props (for client-side hydration)
- `data-hydrate` — hydration strategy

### Client Bundle

The adapter generates a lightweight client entry per island page (~1-2KB runtime + per-island async chunks):

1. Scan the DOM for `[data-island]` elements
2. For each, lazy-load the corresponding component chunk
3. Deserialize props from `data-props`
4. Hydrate according to `data-hydrate`:
   - `"load"` → hydrate immediately
   - `"visible"` → observe with `IntersectionObserver`, hydrate on intersect
   - `"idle"` → `requestIdleCallback(() => hydrate())`
   - `"media:(...)"` → `matchMedia(query).addEventListener("change", ...)`

Each island component is its own async chunk. A page with 3 islands loads 3 small chunks — not the entire page component tree.

### Code Splitting

```
dist/client/
  _island-runtime.js          # ~1-2KB shared runtime
  _Counter-[hash].js           # Island chunk
  _NewsletterForm-[hash].js    # Island chunk
  _PricingCalc-[hash].js       # Island chunk
  assets/                      # CSS, images, etc.
```

Regular pages continue to produce full page bundles as today. Island pages produce only the runtime + individual island chunks.

---

## Layout Inheritance

Layouts control the hydration mode for their subtree:

| Layout file         | Child pages        | Behavior                                 |
| ------------------- | ------------------ | ---------------------------------------- |
| `layout.tsx`        | `index.tsx`        | Inertia (full hydration, SPA nav)        |
| `layout.tsx`        | `index.island.tsx` | Island (page overrides layout)           |
| `layout.island.tsx` | `index.island.tsx` | Island (layout and page agree)           |
| `layout.island.tsx` | `index.tsx`        | Error — regular page under island layout |

An island layout is server-only. It can contain island components (interactive nav, theme toggle) via the same import attribute mechanism:

```tsx
// pages/blog/layout.island.tsx
import MobileNav from '../../components/MobileNav' with { island: 'media:(max-width: 768px)' };

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header>
        <nav>
          <a href="/">Home</a>
          <a href="/blog">Blog</a>
        </nav>
        <MobileNav />
      </header>
      <main>{children}</main>
    </div>
  );
}
```

---

## Comparison with Regular Pages

|                  | Regular pages (`.tsx`)             | Island pages (`.island.tsx`)            |
| ---------------- | ---------------------------------- | --------------------------------------- |
| Server rendering | Full SSR                           | Full SSR                                |
| Client hydration | Full page hydration                | Selective — only island components      |
| Navigation       | SPA (Inertia JSON protocol)        | Full page load (+ View Transitions)     |
| JS shipped       | Full page component tree           | Island runtime (~1-2KB) + island chunks |
| `.server.ts`     | Same `defineHandler` API           | Same `defineHandler` API                |
| Actions          | `useForm` (typed, SPA)             | HTML forms or island form components    |
| Edge caching     | Supported                          | Ideal — most pages are highly cacheable |
| Middleware       | Shared                             | Shared                                  |
| Layouts          | `layout.tsx`                       | `layout.island.tsx`                     |
| Best for         | Interactive apps, dashboards, SaaS | Content sites, blogs, marketing, docs   |

---

## Resolved Decisions

### Mixed Framework Islands

Single framework per project for v1. Mixed React + Vue islands are architecturally possible (independent hydration per island) but double the runtime cost. Revisit if there's demand.

### Fallback / Loading States

CSS-only approach. The runtime adds `data-hydrated` after hydration completes. No extra API needed:

```css
[data-island]:not([data-hydrated]) button {
  opacity: 0.6;
  pointer-events: none;
}
```

### Streaming SSR

Deferred to post-v1, but design should leave the door open. Island pages are good candidates for streaming — the server can flush the HTML shell immediately and stream island content as it resolves. The SSR rendering pipeline should not assume synchronous completion.

### `useIslandForm`

Ship `useIslandForm` in v1. Simple: `fetch()` to submit, full page reload on success to pick up fresh loader data. No optimistic updates.

```tsx
import { useIslandForm } from '@vite-cloud/react';

function CommentForm({ postId }: { postId: string }) {
  const form = useIslandForm({ body: '' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post(`/blog/${postId}`);
      }}
    >
      <textarea value={form.data.body} onChange={(e) => form.setData('body', e.target.value)} />
      <button disabled={form.processing}>Submit</button>
    </form>
  );
}
```

Emit a build-time warning if `useForm` (Inertia) is imported in an `.island` page — it requires a client-side router that doesn't exist in islands mode.

### Nested Islands

Islands are self-contained component trees. Once inside an island, everything is fully JS-powered — child components are bundled normally, no markers, no separate hydration. The `with { island }` attribute is only meaningful at the page level:

```tsx
// pages/index.island.tsx
import Counter from "../components/Counter" with { island: "load" };

// Counter.tsx — island root. Children are normal imports, part of Counter's chunk.
import Tooltip from "./Tooltip";
import Button from "./Button";

export default function Counter({ initial }) {
  return (
    <Tooltip text="Click to increment">
      <Button onClick={...}>{count}</Button>
    </Tooltip>
  );
}
```

### Props Serialization

Only serializable props cross the island boundary (`data-props` is JSON). Functions, class instances, Dates, etc. are not supported. Build-time check should error on non-serializable prop types. This matches Astro's model.

### HMR

Island components support HMR — editing an island component hot-updates it in place. The containing island page itself does a full page reload on change (since it's server-rendered HTML, not a hydrated SPA).
