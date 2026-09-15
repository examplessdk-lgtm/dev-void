# Themes

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-27
**Status:** Design

---

## Summary

Add a theme system to Void that lets authors ship pre-built layouts, components, styles, and composables as npm packages. Users activate a theme via `void.json` and write content in `pages/` — the theme provides the visual shell. Themes target a single rendering framework (Vue, React, etc.) while the contract, config, and CSS are framework-agnostic.

Distribution is layered: npm package for the theme runtime + optional starter template for scaffolding.

---

## User-Facing API

### Activating a theme

```jsonc
// void.json — shorthand
{
  "theme": "void-theme-docs",
}
```

```jsonc
// void.json — with theme options
{
  "theme": {
    "package": "void-theme-docs",
    "options": {
      "logo": "/logo.svg",
      "nav": [
        { "text": "Guide", "link": "/guide/" },
        { "text": "API", "link": "/api/" },
      ],
      "sidebar": {
        "/guide/": ["getting-started", "configuration"],
      },
    },
  },
}
```

When `theme` is a string, it's equivalent to `{ "package": "<string>", "options": {} }`.

### Typical user project

```
my-docs/
├── pages/
│   ├── index.md
│   ├── guide/
│   │   ├── getting-started.md
│   │   └── configuration.md
│   └── api/
│       └── overview.md
├── public/
│   └── logo.svg
├── void.json
└── package.json
```

The user owns all routes. The theme provides layouts that wrap the page content.

### Overriding theme layouts

Users can replace a theme layout entirely by placing their own `layout.vue` at the same directory level in `pages/`.

For partial overrides, theme layouts expose named slots. Users wrap the theme layout and fill specific slots:

```vue
<!-- pages/layout.vue — override just the sidebar -->
<script setup>
import ThemeLayout from 'void-theme-docs/layouts/layout.vue';
import MySidebar from '../components/MySidebar.vue';
</script>

<template>
  <ThemeLayout>
    <template #sidebar>
      <MySidebar />
    </template>
  </ThemeLayout>
</template>
```

### Customizing theme styles

Themes expose CSS custom properties. Users override them in their own CSS:

```css
:root {
  --void-docs-primary: #e06c75;
  --void-docs-sidebar-width: 320px;
}
```

### Using theme composables

Themes can export composables for runtime utilities (sidebar state, search, etc.):

```ts
import { useSidebar } from 'void-theme-docs/composables/useSidebar';
import { useThemeConfig } from 'void-theme-docs/composables/useThemeConfig';
```

---

## Theme Author API

### `defineTheme()`

A theme's entry point is a default export created with `defineTheme()`:

```ts
// void-theme-docs/theme.ts
import { defineTheme } from 'void';

export default defineTheme({
  // Required: which framework adapter this theme targets
  adapter: 'vue', // "vue" | "react" | "svelte" | "solid"

  // Default void.json values — user's config wins on conflict (deep merge)
  defaults: {
    output: 'static',
  },

  // Optional: validate user-provided theme options at build time
  options: {
    logo: { type: 'string', optional: true },
    nav: { type: 'array', optional: true },
    sidebar: { type: 'object', optional: true },
  },

  // Optional Vite plugins the theme needs
  plugins: (themeOptions) => [],
});
```

### Package structure

```
void-theme-docs/
├── layouts/
│   ├── layout.vue              # default root layout
│   ├── _layouts/
│   │   ├── home.vue            # named "home" layout
│   │   └── page.vue            # named "page" layout (blank)
│   └── docs/layout.vue         # nested layout for /docs/*
├── components/
│   ├── Sidebar.vue
│   ├── DocSearch.vue
│   └── TableOfContents.vue
├── composables/
│   ├── useThemeConfig.ts
│   └── useSidebar.ts
├── styles/
│   ├── theme.css               # complete theme styles
│   └── tokens.css              # CSS custom properties
├── theme.ts                    # defineTheme() entry
└── package.json
```

### package.json exports

```json
{
  "name": "void-theme-docs",
  "exports": {
    ".": "./theme.ts",
    "./layouts/*": "./layouts/*",
    "./components/*": "./components/*",
    "./composables/*": "./composables/*",
    "./styles/*": "./styles/*"
  }
}
```

### Layout conventions

Layouts live at `<theme-package>/layouts/` — this path is fixed by convention, not configurable.

Theme layouts should expose named slots for the overridable sections:

```vue
<!-- layouts/layout.vue -->
<template>
  <div class="docs-layout">
    <slot name="header">
      <DefaultHeader :nav="config.nav" />
    </slot>
    <div class="docs-main">
      <slot name="sidebar">
        <DefaultSidebar :items="sidebar" />
      </slot>
      <main>
        <slot />
      </main>
      <slot name="toc">
        <TableOfContents />
      </slot>
    </div>
    <slot name="footer">
      <DefaultFooter />
    </slot>
  </div>
</template>
```

Each named slot has a default implementation. When the user fills a slot, only that section is replaced.

### Accessing theme config from theme components

The framework provides the user's theme options via the active adapter's native context mechanism. For Vue, this is `provide`/`inject`.

Theme authors ship a typed composable:

```ts
// composables/useThemeConfig.ts
import { inject } from '@void/vue';

type DocsThemeConfig = {
  logo?: string;
  nav?: { text: string; link: string }[];
  sidebar?: Record<string, string[]>;
};

export function useThemeConfig(): DocsThemeConfig {
  return inject<DocsThemeConfig>('void-theme-options', {});
}
```

Theme layouts and components import this composable to read config:

```vue
<script setup>
import { useThemeConfig } from '../composables/useThemeConfig';
const config = useThemeConfig();
</script>
```

### Styling conventions

Themes ship two CSS files:

- **`styles/tokens.css`** — CSS custom properties for customization
- **`styles/theme.css`** — complete styles that consume the tokens

```css
/* styles/tokens.css */
:root {
  --void-docs-primary: #5b7ee5;
  --void-docs-sidebar-width: 280px;
  --void-docs-font-body: system-ui, sans-serif;
  --void-docs-font-code: 'Fira Code', monospace;
}
```

```css
/* styles/theme.css */
@import './tokens.css';

.docs-layout {
  /* uses var(--void-docs-*) */
}
.docs-sidebar {
  width: var(--void-docs-sidebar-width);
}
```

The framework auto-imports `<theme-package>/styles/theme.css` when the theme is active.

---

## Framework Behavior

### Layout resolution

When a theme is active, the page scanner resolves layouts from two sources with user-wins-on-conflict priority:

1. **User's `pages/`** — highest priority
2. **Theme's `layouts/`** — fallback

For a page at `pages/guide/getting-started.md`, the layout chain resolves as:

| Level               | User has? | Theme has? | Result                             |
| ------------------- | --------- | ---------- | ---------------------------------- |
| Root (`layout.vue`) | Yes       | Yes        | User's `pages/layout.vue`          |
| `guide/`            | No        | Yes        | Theme's `layouts/guide/layout.vue` |

### Config resolution

Theme defaults are **deep-merged** under the user's `void.json`. User keys override at every nesting level; theme defaults for unspecified keys are preserved.

1. **User's `void.json`** — highest priority
2. **Theme's `defaults`** — fallback

Example:

```jsonc
// Theme defaults: { "output": "static", "markdown": { "toc": true, "lineNumbers": true } }
// User void.json: { "markdown": { "lineNumbers": false } }
// Resolved:       { "output": "static", "markdown": { "toc": true, "lineNumbers": false } }
```

### Theme options injection

At app creation, the framework reads `theme.options` from the resolved config and provides it via the active adapter's context mechanism:

| Adapter        | Mechanism                                        |
| -------------- | ------------------------------------------------ |
| `@void/vue`    | `app.provide("void-theme-options", options)`     |
| `@void/react`  | `<ThemeOptionsContext.Provider value={options}>` |
| `@void/svelte` | `setContext("void-theme-options", options)`      |
| `@void/solid`  | `<ThemeOptionsContext.Provider value={options}>` |

### CSS auto-import

When a theme is active, the framework auto-imports `<theme-package>/styles/theme.css` into the client bundle. Theme CSS loads **before** user CSS so that user styles can override theme defaults via the cascade. This is resolved via the theme's package exports — the theme must export `./styles/theme.css`.

### Theme package resolution

The framework resolves the theme package from `void.json`:

1. Read `theme` field — normalize string to `{ package, options }` form
2. Resolve `<package>` via Node module resolution
3. Import default export, validate it's a `defineTheme()` result
4. **Validate adapter** — check that the theme's declared `adapter` matches the active framework adapter in the project. If mismatched or the adapter is not installed, fail with a clear error (see below)
5. **Validate options** — if the theme defines an `options` schema, validate the user's `theme.options` against it. Fail with a clear error on unknown or invalid keys
6. Resolve `<package>/layouts/` for layout scanning
7. Resolve `<package>/styles/theme.css` for CSS auto-import
8. Deep-merge `defaults` under user config
9. Call `plugins(options)` and inject returned Vite plugins

### Adapter validation errors

The framework detects the active adapter by checking which `@void/*` plugin is present in the Vite config. If the theme's `adapter` field doesn't match:

```
Error: Theme "void-theme-docs" requires the "vue" adapter (@void/vue),
but the active adapter is "react" (@void/react).
```

If no adapter is detected:

```
Error: Theme "void-theme-docs" requires the "vue" adapter (@void/vue),
but no framework adapter was found. Install @void/vue and add it to your Vite config.
```

---

## Framework-Specificity

Themes target a single rendering framework. The layouts, components, and composables are written in that framework's native idioms.

The following are **framework-agnostic** (shared across all targets):

- `defineTheme()` contract and return type
- `void.json` `theme` field schema
- CSS files and custom properties
- Theme options JSON shape
- Layout directory convention (`layouts/`)
- Resolution order (user wins on conflict)

The following are **framework-specific** (different per target):

- Layout component files (`.vue`, `.tsx`, `.svelte`)
- Slot/override patterns (Vue slots, React component props, Svelte slots)
- Config access composable (provide/inject, createContext, getContext)

A theme author who wants multi-framework support publishes separate packages that share styles and tokens:

```
void-theme-docs          # Vue
void-theme-docs-react    # React
void-theme-docs-svelte   # Svelte
```

---

## Distribution

### npm package

The primary distribution is an npm package containing layouts, components, composables, and styles. Users install it and reference it in `void.json`.

### Starter template

Optionally, theme authors provide a starter template (e.g. via `npm create void-docs`) that scaffolds a project pre-configured with the theme, example pages, and recommended structure. The user owns the scaffolded code and can modify it freely.

The npm package enables upstream updates (install new version, get layout improvements). The starter template provides a frictionless starting point.

---

## Dependencies

### Named layouts (0034-named-layouts.md)

Themes benefit from page-level layout selection — e.g. a docs theme offering `layout: home`, `layout: doc`, `layout: page`. This is a pages-level feature (useful with or without themes) designed separately. When available, themes can ship named layout variants in their `layouts/_layouts/` directory and pages select them via `export const layout` or markdown frontmatter.
