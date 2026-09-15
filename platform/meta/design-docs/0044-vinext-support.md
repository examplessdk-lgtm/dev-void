# vinext Framework Support

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-03-02
**Status:** Approved

---

## Overview

Add vinext as a Class A meta-framework in Void. vinext is a Vite plugin that reimplements the Next.js API surface for Cloudflare Workers. It supports two routers — App Router (RSC) and Pages Router (SSR) — each requiring different Vite environment configurations.

---

## Detection

Add to `FRAMEWORK_PACKAGES` in `plugin-inference.ts`:

```ts
vinext: { name: "vinext", class: "a" },
```

vinext is the npm package name. Presence in `dependencies` or `devDependencies` triggers framework mode.

---

## Router Detection

vinext projects use one of two routers, determined by directory structure:

| Router       | Indicator                      | Vite Environment                              | Server Entry                                  |
| ------------ | ------------------------------ | --------------------------------------------- | --------------------------------------------- |
| App Router   | `app/` directory exists        | `{ name: "rsc", childEnvironments: ["ssr"] }` | `vinext/server/app-router-entry` (npm export) |
| Pages Router | `pages/` directory (no `app/`) | `{ name: "ssr" }`                             | Generated at `.void/vinext-pages-entry.ts`    |

Detection happens in `voidPlugin()` via `existsSync(join(root, "app"))`.

---

## Plugin Composition

The framework branch in `voidPlugin()` currently uses a single `viteEnvironment: { name: "ssr" }` for all Class A frameworks. vinext requires router-specific configuration:

**App Router:**

- `workerConfig.main = "vinext/server/app-router-entry"`
- `cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })`

**Pages Router:**

- `workerConfig.main = generatedPagesEntry` (path to `.void/vinext-pages-entry.ts`)
- `cloudflare({ viteEnvironment: { name: "ssr" } })`

The generated Pages Router entry is a minimal worker fetch handler:

```ts
// @ts-expect-error — virtual module resolved by vinext at build time
import { renderPage, handleApiRoute } from 'virtual:vinext-server-entry';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.replaceAll('\\', '/').startsWith('//')) {
      return new Response('404 Not Found', { status: 404 });
    }
    const urlWithQuery = pathname + url.search;
    if (pathname.startsWith('/api/') || pathname === '/api') {
      return await handleApiRoute(request, urlWithQuery);
    }
    return await renderPage(request, urlWithQuery, null);
  },
};
```

---

## Type Changes

Expand the `Framework` type to include vinext:

```ts
export type Framework = 'tanstack-start' | 'react-router' | 'vinext';
```

`FRAMEWORK_ENTRIES` becomes conditional for vinext (router-dependent), so the entry lookup is moved into a function rather than a static record.

---

## Deploy Pipeline

vinext uses the same `runFullDeploy()` path as TanStack Start and React Router (`isFrameworkMode = true`).

**Worker dir detection:** `detectWorkerDir()` currently only checks for `dist/ssr/`. With vinext App Router, the CF Vite plugin outputs to `dist/rsc/` (matching the environment name). Add `dist/rsc/` as a fallback.

**Assets prefix:** vinext uses Vite's default `assets/` prefix. The existing `assetsPrefix` detection from the client manifest handles this automatically.

**Scan dirs:** vinext projects use `app/`, `pages/`, `src/`, `server/`. The existing `FRAMEWORK_SCAN_DIRS` (`["src", "app", "routes", "server"]`) covers most cases. Add `"pages"` for vinext Pages Router projects.

---

## Files to Modify

### Framework packages (`packages/`)

1. **`packages/void/src/plugin-inference.ts`**
   - Add `vinext` to `FRAMEWORK_PACKAGES`
   - Expand `Framework` type to include `"vinext"`
   - Add `"pages"` to `FRAMEWORK_SCAN_DIRS`

2. **`packages/void/src/index.ts`**
   - Add vinext-specific branch in framework mode plugin composition
   - Handle router detection (`app/` vs `pages/`)
   - Generate Pages Router entry when needed
   - Configure CF Vite plugin with correct environment

3. **`packages/void/src/cli/deploy.ts`**
   - Update `detectWorkerDir()` to also check `dist/rsc/`

---

## What Void Does NOT Do

- No runtime env shims (vinext handles its own `next/*` shims)
- No wrapper generation (Class A — Void manages the build directly)
- No custom build command (uses `vite build` like other Class A frameworks)
- No preset in `FRAMEWORK_PRESETS` (that's for Class B/C only)
