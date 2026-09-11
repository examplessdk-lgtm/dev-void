# Markdown Pages (`@void/md`)

**Date:** 2026-02-25
**Status:** Design

---

## Summary

Add `.md` files as first-class pages in Void's file-based routing via a new `@void/md` package. Markdown pages compile to static HTML at build time, integrate with the existing layout chain, and can embed interactive framework components as islands. Ships a minimal default theme (prose typography, code highlighting, admonitions) and VitePress-equivalent markdown features.

The package is opt-in — users who don't install it pay nothing.

---

## User-Facing API

### Setup

```ts
// vite.config.ts
import { voidPlugin } from 'void';
import { voidVue } from '@void/vue/plugin';
import { voidMarkdown } from '@void/md/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

### File structure

```
pages/
  layout.island.vue
  index.island.vue
  docs/
    layout.island.vue        # docs layout (sidebar, TOC, nav)
    getting-started.md
    configuration.md
    guides/
      deployment.md
```

A `.md` file is a page — it routes, inherits layouts, and auto-prerenders like any `.island.vue` page.

### Anatomy of a markdown page

```md
<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
import CodePlayground from "../components/CodePlayground.vue" with { island: "idle" }
</script>

---

title: Getting Started
description: Learn how to use Void

---

# Getting Started

Welcome to Void. Here's an interactive demo:

<Counter />

And a playground that hydrates when idle:

<CodePlayground />
```

- **`<script>` block** (optional) — extracted before markdown compilation. Imports components using the same `with { island: "..." }` syntax as island pages. Components must be Uppercase.
- **Frontmatter** — YAML metadata. Accessible in layouts via `useFrontmatter()`.
- **Body** — standard markdown + GFM. Uppercase tags (`<Counter />`) reference imported components, rendered as islands.

### Frontmatter access

```ts
import { useFrontmatter } from '@void/md';

const fm = useFrontmatter();
// fm.title, fm.description, etc.
```

Returns the current page's parsed frontmatter object. Used by layout components to render titles, build TOC, etc.

### Pages virtual module

```ts
import pages from '@void/md/pages';
// [{ path: "/docs/getting-started", title: "Getting Started", frontmatter: {...}, headings: [...] }, ...]
```

Generated at build time by scanning all `.md` pages. Provides path, title (from frontmatter or first h1), full frontmatter object, and extracted headings with depth/slug/text. Updates on HMR in dev. Flat array — users filter/sort/group as needed for sidebars and nav.

### Example: docs layout with sidebar

```vue
<!-- pages/docs/layout.island.vue -->
<script setup>
import { useFrontmatter } from '@void/md';
import pages from '@void/md/pages';
import { useRouter } from '@void/vue';

const fm = useFrontmatter();
const { path } = useRouter();
const docPages = pages.filter((p) => p.path.startsWith('/docs/'));
</script>

<style>
@import '@void/md/theme.css';
</style>

<template>
  <div class="docs-layout">
    <aside>
      <nav>
        <a
          v-for="page in docPages"
          :key="page.path"
          :href="page.path"
          :class="{ active: page.path === path }"
        >
          {{ page.title }}
        </a>
      </nav>
    </aside>
    <main class="void-md">
      <h1>{{ fm.title }}</h1>
      <slot />
    </main>
  </div>
</template>
```

### Default theme

The `.void-md` scoping class keeps styles from bleeding into non-markdown pages. Import the theme stylesheet:

```css
@import '@void/md/theme.css';
```

The `.void-md` scoping class keeps styles from bleeding into non-markdown pages. The theme covers:

- **Prose typography** — headings, paragraphs, lists, blockquotes, tables, inline code, links, horizontal rules. Customizable via CSS custom properties. Dark mode via `prefers-color-scheme`.
- **Code blocks** — Shiki dual theme (light/dark), CSS-driven switching, zero JS.
- **Admonitions** — `:::tip`, `:::warning`, `:::danger`, `:::info`, `:::details` containers.
- **GitHub alerts** — `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, etc.

Users who want full control skip the import and write their own CSS.

### Plugin options

```ts
voidMarkdown({
  shiki?: {
    themes?: { light: string; dark: string },  // default: sensible pair
    langs?: string[],                           // default: common web langs
    transformers?: ShikiTransformer[],          // additional shiki transformers
  },
  markdown?: {
    anchor?: MarkdownItAnchorOptions | false,
    attrs?: MarkdownItAttrsOptions | false,
    emoji?: boolean,                            // default: true
    containers?: boolean,                       // default: true
    githubAlerts?: boolean,                     // default: true
    lineNumbers?: boolean,                      // default: false (per-block override always works)
    toc?: boolean,                              // default: true
  },
})
```

---

## Markdown Features (VitePress parity)

All features produce static HTML at build time with zero client JS unless islands are embedded.

### Ported from VitePress

| Feature                 | Description                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Containers**          | `:::tip`, `:::warning`, `:::danger`, `:::info`, `:::details` (collapsible)                               |
| **GitHub Alerts**       | `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`                                |
| **Shiki highlighting**  | Build-time syntax highlighting with dual themes (light/dark)                                             |
| **Shiki transformers**  | Line highlighting `{1,3-5}`, diff `[!code ++]`/`[!code --]`, focus `[!code focus]`, error/warning levels |
| **Code wrapper**        | Language label + copy button on code blocks                                                              |
| **Snippet imports**     | `<<< ./path/to/file.ext` — import code from external files, with region/line range support               |
| **Line numbers**        | `:line-numbers` / `:no-line-numbers` per code fence, configurable starting number                        |
| **Emoji**               | `:tada:` → unicode via `markdown-it-emoji`                                                               |
| **Attrs**               | `{.class #id attr=val}` on any element via `markdown-it-attrs`                                           |
| **Anchor links**        | Permalink anchors on headings via `markdown-it-anchor`                                                   |
| **Image handling**      | Path normalization, optional lazy loading                                                                |
| **Link handling**       | External links get `target="_blank" rel="noreferrer"`, internal `.md` references resolve to routes       |
| **Table accessibility** | `tabindex="0"` for keyboard-scrollable tables                                                            |
| **Heading extraction**  | Extract headings with depth/slug/text for TOC generation                                                 |
| **TOC directive**       | `[[toc]]` renders inline table of contents                                                               |
| **Frontmatter**         | YAML frontmatter via `gray-matter`                                                                       |

### Copy button

The code block copy button is the only feature requiring client JS — a small inline script (~200 bytes) for the clipboard API. Injected only when code blocks are present.

---

## Architecture

### Package: `@void/md`

```
packages/md/
  src/
    plugin.ts             # voidMarkdown() plugin entry
    compile.ts            # markdown-exit pipeline (init, compile)
    extract-script.ts     # <script> block extraction + island import parsing
    extract-frontmatter.ts # frontmatter parsing
    plugins/              # ported VitePress markdown-it plugins
      containers.ts
      github-alerts.ts
      snippet.ts
      pre-wrapper.ts
      line-numbers.ts
      image.ts
      link.ts
      heading-extract.ts
      toc.ts
    theme/
      index.css           # default theme entry (prose + code + admonitions)
      prose.css
      code.css
      containers.css
    runtime/
      frontmatter.ts      # useFrontmatter() — framework-agnostic context read
      pages.ts            # virtual module: @void/md/pages — all md pages metadata
  package.json
```

### Compilation pipeline

```
.md file
  → extract <script> block (island imports)
  → extract frontmatter (gray-matter)
  → compile markdown body (markdown-exit + shiki + plugins)
  → emit framework-specific component
```

The Vite plugin detects which framework adapter is active (`@void/vue`, `@void/react`, `@void/svelte`, `@void/solid`) and emits the component in the corresponding format:

- **Vue**: virtual SFC — `<template><div v-html="..." /></template>` + frontmatter injection via `provide()`
- **React**: virtual component — `export default () => <div dangerouslySetInnerHTML={{__html}} />` + frontmatter via context
- **Svelte**: virtual component — `{@html content}` + frontmatter via context
- **Solid**: virtual component — `innerHTML` + frontmatter via context

Island mount points: Uppercase tags in the compiled HTML become `<div data-island="ComponentName" data-hydrate="visible" data-props="...">` markers. The framework adapter's existing island hydration machinery handles the rest.

### Integration with page scanner

`COMPONENT_EXTENSIONS` in `scan.ts` needs to be extensible. The markdown plugin registers `"md"` so `scanPages()` picks up markdown files. Markdown pages:

- Route like any other page (file-based)
- Support companion `.server.ts` for dynamic data (rare but possible)
- Auto-prerender when static (no loader, no dynamic params) — same rule as island pages
- Inherit the layout chain normally

### `useFrontmatter()` runtime

Implemented per-framework using each adapter's context mechanism:

- **Vue**: `provide()` / `inject()` in the generated component
- **React**: React context
- **Svelte**: Svelte context (`setContext` / `getContext`)
- **Solid**: Solid context (`createContext` / `useContext`)

The generated page component provides the frontmatter; layout components consume it via `useFrontmatter()`. Exported from `@void/md` and resolved by the markdown plugin at build time.

### `@void/md/pages` virtual module

Generated at build time by scanning all `.md` files in `pages/`. Each entry contains:

```ts
type MdPage = {
  path: string; // route path, e.g. "/docs/getting-started"
  title: string; // from frontmatter.title or first h1
  frontmatter: Record<string, unknown>; // full parsed frontmatter
  headings: { depth: number; slug: string; text: string }[]; // extracted headings
};
```

Flat array, sorted by path. Users filter/sort/group as needed for sidebars and nav. The plugin resolves `@void/md/pages` to a virtual module that exports this array. Updates on HMR in dev when `.md` files are added, removed, or their frontmatter changes.

### Dependencies

| Dependency              | Purpose                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `markdown-exit`         | Markdown compilation (markdown-it compatible, TypeScript, async rendering) |
| `shiki`                 | Syntax highlighting (build-time)                                           |
| `@shikijs/markdown-it`  | Shiki integration with markdown-it/exit pipeline                           |
| `@shikijs/transformers` | Line highlighting, diff, focus, error level transformers                   |
| `gray-matter`           | Frontmatter parsing                                                        |
| `markdown-it-anchor`    | Heading permalink anchors                                                  |
| `markdown-it-attrs`     | Attribute syntax `{.class}`                                                |
| `markdown-it-emoji`     | Emoji shortcodes                                                           |
| `markdown-it-container` | Container syntax `:::type`                                                 |

All dependencies stay in `@void/md`. Users who don't install the package pay zero cost.

---

## Auto-static behavior

Markdown pages follow the same auto-prerender rule as island pages:

- No loader + no dynamic params + prerender not explicitly false → `prerender = true`
- `prerender = true` + no explicit revalidate → `revalidate = MAX_REVALIDATE`

Markdown pages with embedded islands still auto-prerender — islands hydrate client-side and don't affect server HTML determinism.

---

## Future extensions

- **VitePress theme compatibility** — VitePress themes are Vue components. With `@void/vue` handling Vue SSR + islands, a VitePress theme could work as a Void layout with minimal adaptation. Maintained in a separate repo.
- **Content collections** — typed, schema-validated content queries for sites that need to list/filter/paginate content programmatically. Separate feature, opt-in.
- **Math support** — LaTeX via MathJax/KaTeX, opt-in (following VitePress pattern).
- **CJK emphasis fix** — `markdown-it-cjk-friendly` for CJK text emphasis handling.
- **Custom remark/rehype plugin hooks** — extend the pipeline beyond markdown-it plugins.
