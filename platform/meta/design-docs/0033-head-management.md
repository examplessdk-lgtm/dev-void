# Head Management

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-27
**Status:** Draft

---

## Summary

Add head management to Void so pages can set `<title>`, `<meta>`, inline scripts, and other `<head>` content. Works across all rendering modes: Inertia pages, islands, markdown, and static output.

## Motivation

Currently Void has no head management — the HTML `<head>` only contains build-system asset tags (CSS links, modulepreload hints, client entry scripts). This means:

- No way to set per-page `<title>` or SEO metadata (description, og:\*)
- No way to inject inline scripts before first paint (e.g. theme toggle to prevent FOUC)
- Markdown pages extract `title` and `description` from frontmatter but don't use them
- Every page has the same empty head

## API Design

### 1. Per-page head via `head()` export

Pages define head content by exporting a `head()` function from their `.server.ts` file, alongside `loader` and `action`:

```ts
// pages/posts/[slug].server.ts
export const loader = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  return { post };
});

export function head(c, props) {
  return {
    title: props.post.title,
    meta: [
      { name: 'description', content: props.post.excerpt },
      { property: 'og:title', content: props.post.title },
    ],
  };
}
```

`head()` receives the Hono context and the resolved loader props. Runs server-side only. This keeps head data-driven and colocated with the loader that produces the data — no new concepts to learn.

### 2. Static defaults in `void.json`

Global head defaults that apply to every page:

```json
{
  "head": {
    "titleTemplate": "%s | My Site",
    "htmlAttrs": { "lang": "en" },
    "meta": [
      { "charset": "utf-8" },
      { "name": "viewport", "content": "width=device-width, initial-scale=1" }
    ]
  }
}
```

### 3. Dynamic defaults via middleware

For request-scoped head content that depends on auth state, locale, or requires inline scripts:

```ts
// middleware/01.head.ts
export default defineMiddleware(async (c, next) => {
  c.set('headDefaults', {
    script: [
      {
        innerHTML: `const t = localStorage.getItem("theme");
        if (t) document.documentElement.dataset.theme = t;`,
      },
    ],
  });
  await next();
});
```

### 4. Markdown auto-head

Markdown frontmatter automatically populates head with zero user code:

```yaml
---
title: Getting Started
description: Learn how to use Void
---
```

Generates `<title>Getting Started</title>` and `<meta name="description" content="Learn how to use Void">`.

## HeadDescriptor Shape

```ts
type HeadDescriptor = {
  title?: string;
  meta?: Array<{ name?: string; property?: string; content?: string; charset?: string }>;
  link?: Array<{ rel: string; href: string; [key: string]: string }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
};

type HeadConfig = HeadDescriptor & {
  titleTemplate?: string; // "%s | My Site" — %s replaced with page title
};
```

## Merge Precedence

page `head()` > middleware `headDefaults` > void.json `head`

- **title**: page wins; `titleTemplate` wraps the final title (`%s` replaced)
- **meta**: page overrides entries with same `name` or `property`; others appended
- **link / script**: concatenated (config first, then middleware, then page)
- **htmlAttrs / bodyAttrs**: shallow merge, page wins on conflicts

## Rendering Modes

### Inertia Pages (SSR + client navigation)

Head is resolved server-side and included in the `PageObject`. On initial SSR, it renders into the HTML `<head>`. On Inertia SPA navigation (JSON response), the client updates `document.title` and managed `<meta>` tags from the pageObj.

Note: `script`, `htmlAttrs`, and `bodyAttrs` are SSR-only — they're not re-applied on client navigation (inline scripts only need to run on initial page load).

### Islands

Same as SSR. No client navigation, so head is purely baked into the HTML document.

### Markdown

Frontmatter `title` and `description` are auto-mapped to head. If a markdown page also has a `.server.ts` with an explicit `head()` export, the explicit head takes precedence.

### Static Output

Same rendering pipeline — head is baked into the prerendered HTML files.

### Custom SSR (`defineRender`)

Users who control the full HTML document via `defineRender` can optionally use a `resolveHead()` helper to access the merged head data. This is a future enhancement — not in the initial scope.

## Design Decisions

**Why server `head()` export, not `useHead()` composable?**

In Void's Inertia model, the server already produces the complete page data. Adding head to that data is natural and zero-cost. A `useHead()` composable would require per-framework SSR collection (context/provide in each adapter), create precedence ambiguity (multiple components calling useHead), and for the triggering use case (inline scripts for FOUC), a component-driven approach doesn't work — the script must run before any component renders.

**Why `head()` as a separate export, not part of loader return?**

The loader uses `defineHandler` which powers `InferProps<typeof loader>` for type inference. Mixing head into the return type would break this. A separate `head()` export keeps the type system clean and makes head derivation from props explicit.

**Why void.json for static defaults, middleware for dynamic?**

Static defaults (lang, charset, viewport, title template) don't change per-request — they belong in config. Dynamic head (inline scripts that depend on feature flags, locale-based meta) needs request context — middleware is the right place. This avoids forcing users to create middleware for common static configuration.
