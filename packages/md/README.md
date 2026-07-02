# @void/md

Markdown pages plugin for Void — `.md` files as first-class routes with zero client JS, islands support, and Shiki syntax highlighting.

## Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidVue } from '@void/vue/plugin';
import { voidMarkdown } from '@void/md/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

Works with any framework adapter — auto-detects Vue, React, Svelte, or Solid from the plugin list.

## Plugin

`voidMarkdown(options?)` returns a Vite plugin array (`Plugin[]`). The plugin runs with `enforce: "pre"`.

Options:

- `shiki?.themes` — `{ light: string; dark: string }` (default: `github-light` / `github-dark`)
- `shiki?.langs` — additional Shiki languages to load (default: all bundled languages, lazy-loaded)

The plugin exposes an API:

- `api.getClientScripts()` — returns `Map<string, string>` of component ID → client code (used by the islands plugin)

## Runtime

Import from `@void/md`:

- **`useFrontmatter()`** — access the current page's frontmatter object. Uses framework-native context (`provide`/`inject` for Vue, `createContext`/`useContext` for React/Solid, `setContext`/`getContext` for Svelte).

## Virtual Modules

- **`@void/md`** — resolves to `useFrontmatter()` runtime
- **`@void/md/pages`** — flat array of all `MdPage` objects (HMR-aware), useful for building navs, sidebars, and search indexes

```ts
import pages from '@void/md/pages';
// MdPage { path, title, frontmatter, headings }
```

## Pages

`.md` files in the `pages/` directory become routes. They compile to static HTML at build time with zero client JS by default — auto-prerendered like static island pages.

```md
---
title: Getting Started
author: Jane
---

# Getting Started

Regular markdown content with **full** syntax support.
```

### Frontmatter

YAML frontmatter between `---` fences. Title is extracted from `frontmatter.title` or the first `<h1>`.

### Islands

Embed interactive components via a `<script>` block with `island` import attributes:

```md
---
title: Interactive Page
---

<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
</script>

# Page with Islands

Static content above, interactive island below:

<Counter />
```

Island strategies: `idle` (default), `visible`, `media(...)`.

### Client Scripts

Regular imports and statements in `<script>` blocks (without `island` attribute) are bundled as a client module, code-split per page:

```md
<script>
import { initAnalytics } from "../lib/analytics"
initAnalytics()
</script>

# My Page

Content here.
```

## Markdown Features

Full VitePress-parity feature set:

- **Syntax highlighting** — Shiki with dual light/dark themes
- **Line highlighting** — `{1,3-5}` meta in code fences
- **Notation transforms** — `[!code ++]`, `[!code --]`, `[!code highlight]`, `[!code focus]`, `[!code error]`, `[!code warning]`
- **Line numbers** — `:line-numbers` / `:no-line-numbers` per fence, `{=N}` start line
- **Code snippet imports** — `<<< ./file.ext` with region and line range support
- **Custom containers** — `:::tip`, `:::info`, `:::warning`, `:::danger`, `:::details`
- **GitHub alerts** — `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!IMPORTANT]`, `> [!CAUTION]`
- **Emoji** — `:emoji_name:` shortcodes
- **Footnotes** — `text[^1]` refs with matching `[^1]: definition` blocks
- **Attributes** — `{.class #id}` on elements via `markdown-it-attrs`
- **Anchor links** — auto-generated heading anchors
- **Table of contents** — `[[toc]]` directive
- **Image lazy loading** — automatic `loading="lazy"` on images
- **Link handling** — external links get `target="_blank"`, internal `.md` links normalized

## Theme

Two CSS exports for styling markdown content:

- **`@void/md/theme.css`** — full standalone theme (reset + prose + code + containers)
- **`@void/md/theme-content.css`** — content-only styles scoped to `.void-md` (prose + code + containers)

```ts
// In your layout or entry
import '@void/md/theme.css'; // or theme-content.css
```

## Architecture

- **Compilation pipeline** — `extractScript()` strips `<script>` blocks and collects island imports → `compile()` runs gray-matter + markdown-exit + Shiki → `emit-{framework}()` generates a framework-specific virtual component
- **Framework-agnostic** — adapter auto-detected from plugin list; emitters for Vue (SFC), React (JSX), Svelte, and Solid
- **Lightweight metadata extraction** — `extractMetadata()` parses frontmatter + headings without running Shiki, used for `@void/md/pages` scanning
- **Islands integration** — pages with island imports split HTML into render chunks with `data-island` markers; pages without islands emit static HTML with a frontmatter context provider
- **Svelte/Solid secondary modules** — emits a JS re-export pointing to a secondary virtual module (`/@void-md-svelte/` or `/@void-md-solid/`) so Vite processes through the framework's own plugin

## Tests

- `test/unit/compile.test.ts` — compilation pipeline: basic, frontmatter, title extraction, headings, Shiki, emoji, footnotes, anchors
- `test/unit/extract-script.test.ts` — script extraction: island imports, client code, edge cases
- `test/unit/plugins.test.ts` — markdown-it plugins: containers, GitHub alerts, links, images, line numbers, emoji, TOC
- `test/unit/emit-vue.test.ts` — Vue component emission with and without islands
- `test/unit/emit-react.test.ts` — React component emission with and without islands
- `test/unit/emit-svelte.test.ts` — Svelte component emission with and without islands
- `test/unit/emit-solid.test.ts` — Solid component emission with and without islands
