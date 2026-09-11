# Named Layouts

**Date:** 2026-02-27
**Status:** Design

---

## Summary

Extend Void's layout system to support page-level layout selection. Pages can opt into named layouts via an exported `layout` constant (all frameworks) or frontmatter field (markdown), allowing multiple layout types within the same directory structure without conflating URL paths with visual structure.

This is a pages-level feature — useful with or without themes. When a theme is active, named layouts in the theme's `layouts/` directory serve as fallbacks.

---

## User-Facing API

### Defining named layouts

Named layouts live in `_layouts/` directories within `pages/`. The `_` prefix excludes them from routing (existing convention).

```
pages/
  _layouts/
    home.vue              # named "home"
    post.vue              # named "post"
    post.island.vue       # island modifier works cleanly
  layout.vue              # default root layout (unchanged)
  guide/
    _layouts/
      api.vue             # named "api", scoped to guide/*
    layout.vue            # default for guide/*
    getting-started.md
    reference.md
```

Default `layout.vue` files remain where they are — only named layouts go in `_layouts/`.

### Selecting a named layout

Pages select layouts by exporting a `layout` constant. This works across all frameworks:

**Vue:**

```vue
<script setup>
export const layout = 'home';
</script>
```

**React / Solid:**

```tsx
export const layout = "home";

export default function Page() { ... }
```

**Svelte:**

```svelte
<script context="module">
export const layout = "home";
</script>
```

**Markdown** (frontmatter):

```md
---
layout: home
---

# Welcome
```

The scanner already extracts `revalidate` and `prerender` constants from page files — `layout` follows the same pattern.

The value must be a **static literal** — no dynamic expressions. This is the same constraint as `revalidate` and `prerender`.

The field supports four forms:

| Value                        | Behavior                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `"home"`                     | Replace the innermost layout in the chain with `_layouts/home.vue`. Outer ancestor layouts still apply. |
| `"!home"`                    | Replace the **entire** layout chain. Only `_layouts/home.vue` wraps the page.                           |
| `false`                      | No layout wrapping at all. Page renders standalone.                                                     |
| `"../components/Custom.vue"` | Relative path to any component (resolved from the page file's location).                                |

"Innermost" means the deepest layout in the resolved chain. If the chain is `[root, guide/layout]`, it replaces `guide/layout`. If the chain is only `[root]`, it replaces the root. Use the `!` prefix when you want to discard all ancestor layouts entirely.

When no `layout` export is present, behavior is unchanged — the default `layout.vue` chain applies.

### Resolution order for named layouts

When a page specifies `layout: home`, the scanner walks up the directory tree looking for `_layouts/home.vue`:

```
pages/guide/intro.md  (layout: home)

1. Check pages/guide/_layouts/home.vue  → not found
2. Check pages/_layouts/home.vue        → found, use it
```

Closest ancestor wins, same as default layout chain resolution.

### Examples

**Blog with post and archive layouts:**

```
pages/
  _layouts/
    post.vue              # blog post layout (sidebar, date, author)
    archive.vue           # archive layout (grid, no sidebar)
  layout.vue              # default (nav + footer)
  blog/
    hello-world.md        # layout: post
    second-post.md        # layout: post
    archive.md            # layout: archive
```

`layout: post` resolves the chain as: `layout.vue` → `_layouts/post.vue` → Page. The root layout still wraps (nav + footer stay), but the post layout replaces the nearest level with post-specific structure.

**Vue page with named layout:**

```vue
<!-- pages/dashboard/settings.vue -->
<script setup>
export const layout = 'dashboard';
</script>

<template>
  <div>Settings page content</div>
</template>
```

Uses `_layouts/dashboard.vue` for the nearest layout, root `layout.vue` still wraps.

**Fullscreen landing page (no layout):**

```vue
<!-- pages/landing.vue -->
<script setup>
export const layout = false;
</script>

<template>
  <div class="hero fullscreen">
    <h1>Welcome</h1>
  </div>
</template>
```

No layout wrapping — page renders standalone.

**Standalone layout replacing entire chain:**

```md
---
layout: !home
---
```

Only `_layouts/home.vue` wraps the page. Root `layout.vue` is skipped.

**Relative path to arbitrary component:**

```tsx
// pages/slides/intro.tsx
export const layout = "../components/Presentation.vue";

export default function Slide() { ... }
```

Resolved relative to the page file. Replaces the nearest layout in the chain (use `"!../components/Presentation.vue"` to replace the entire chain).

---

## Interaction with Themes

When a theme is active, named layout resolution walks the **user's entire tree first**, then the **theme's entire tree**. Any user `_layouts/home.vue` takes precedence over any theme `_layouts/home.vue`, regardless of directory depth.

Resolution order for `layout: home` on `pages/guide/intro.md`:

1. `pages/guide/_layouts/home.vue` — user (closest)
2. `pages/_layouts/home.vue` — user (root)
3. `theme/layouts/guide/_layouts/home.vue` — theme (closest)
4. `theme/layouts/_layouts/home.vue` — theme (root)

First match wins.

A docs theme can ship named layouts (e.g. `home`, `page`, `doc`) and users select them via the `layout` export. Users can override any named layout by placing their own file at the same name in their `pages/_layouts/`.

```
# Theme package
void-theme-docs/
  layouts/
    layout.vue            # default theme layout
    _layouts/
      home.vue            # theme's home layout
      page.vue            # theme's blank page layout

# User project
pages/
  _layouts/
    home.vue              # overrides theme's home layout
  index.md                # layout: home → user's _layouts/home.vue
  guide/
    intro.md              # layout: home → user's _layouts/home.vue (user tree checked first)
    reference.md          # (no layout field) → theme's layout.vue
```

---

## Framework Behavior

### Scanner changes (`scan.ts`)

The page scanner gains:

1. **Named layout detection**: Scan `_layouts/` directories for component files. Each file becomes a `NamedLayoutDefinition`:

```typescript
type NamedLayoutDefinition = {
  name: string; // e.g., "home", "post"
  directory: string; // e.g., "" (root) or "guide"
  filePath: string; // e.g., "_layouts/home.vue"
  island?: boolean;
};
```

2. **`layout` extraction**: For all page types, extract the `layout` field. For `.vue`/`.tsx`/`.svelte` pages, parse the exported `layout` constant (same mechanism used for `revalidate` and `prerender`). For `.md` pages, read from frontmatter.

3. **Named layout resolution**: New function `resolveNamedLayout(name, componentId, namedLayouts)` that walks up the directory tree to find the closest `_layouts/<name>.vue`.

### Layout chain computation

The layout chain for a page depends on the `layout` field:

| `layout` value | Chain computation                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- |
| (none)         | Current behavior: walk directories, collect `layout.vue` files                            |
| `home`         | Walk directories for `layout.vue` chain, but replace the nearest with `_layouts/home.vue` |
| `!home`        | Skip entire default chain. Only `_layouts/home.vue` wraps the page.                       |
| `false`        | Empty chain. No layouts.                                                                  |
| `./path.vue`   | Walk directories for `layout.vue` chain, replace nearest with resolved component          |
| `!./path.vue`  | Skip entire default chain. Only resolved component wraps the page.                        |

### Manifest changes (`pages-manifest.ts`)

Named layout components are added to the `components` map:

```typescript
const components = {
  // ... existing pages and layouts ...
  '_layouts/home': () => import('./pages/_layouts/home.vue'),
  '_layouts/post': () => import('./pages/_layouts/post.vue'),
  'guide/_layouts/api': () => import('./pages/guide/_layouts/api.vue'),
};
```

The `layoutTree` remains a static map, computed at scan time per page based on the resolved `layout` field:

```typescript
const layoutTree = {
  index: ['_layouts/home'], // layout: !home
  'guide/getting-started': ['layout', 'guide/layout'], // no layout field
  'guide/reference': ['layout', 'guide/_layouts/api'], // layout: api
  'blog/hello': ['layout', '_layouts/post'], // layout: post
};
```

### Rendering (unchanged)

The rendering loop is unchanged — it still iterates `layoutTree[componentId]` and wraps the page in each layout via slots. The only difference is what IDs appear in the array.

---

## Edge Cases

**Named layout not found:** If `layout: home` is specified but no `_layouts/home.vue` exists in any ancestor directory (or theme), the build fails with a clear error: `Page "guide/intro.md" specifies layout "home" but no _layouts/home.vue was found.`

**Both named and default at same level:** A directory can have both `layout.vue` and `_layouts/post.vue`. They serve different purposes — `layout.vue` is the default for all pages in that directory, `_layouts/post.vue` is opt-in.

**Relative path outside pages/:** Allowed. `layout: ../../components/Shell.vue` resolves relative to the page file. The resolved path must point to an existing file or the build fails.

**Island named layouts:** `_layouts/post.island.vue` works as expected — the `.island` modifier applies to the named layout the same way it applies to default layouts.
