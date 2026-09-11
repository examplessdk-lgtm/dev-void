# Multi-Framework Support

**Date:** 2026-02-25
**Status:** Implemented (Nuxt + SvelteKit runtime env fix, binding inference across framework classes)

---

## Summary

Extend `void deploy` to support Vite-based meta-frameworks that can produce a Cloudflare Workers-compatible bundle. Three framework classes, each with a different integration depth:

- **Class A** — Frameworks that ship as a Vite plugin and deploy via CF's Vite plugin (TanStack Start, React Router). Already implemented.
- **Class B** — Frameworks that ship as a Vite plugin but use their own CF adapter (SvelteKit). Include `voidPlugin()` for DX features.
- **Class C** — Frameworks with their own CLIs and adapters (Nuxt). `void deploy` is primarily a deploy tool, plus runtime helpers and source-based binding inference.

Astro v6 runs server code in workerd, so it does not need the Nuxt/SvelteKit runtime env workaround described below.

---

## Framework Classification

Detection via `package.json` dependencies:

```typescript
type FrameworkClass = 'a' | 'b' | 'c';

type DetectedFramework = {
  name: string;
  class: FrameworkClass;
};

const FRAMEWORK_PACKAGES: Record<string, DetectedFramework> = {
  '@tanstack/react-start': { name: 'tanstack-start', class: 'a' },
  '@react-router/dev': { name: 'react-router', class: 'a' },
  '@sveltejs/kit': { name: 'sveltekit', class: 'b' },
  nuxt: { name: 'nuxt', class: 'c' },
  astro: { name: 'astro', class: 'c' }, // currently detected for deploy preset only
};
```

---

## Current Support Status

- **Class A**: Implemented and unchanged.
- **Class B (SvelteKit)**: Implemented, including `import { db } from "void/db"` / `void/kv` in server request handlers during local Node dev and deploy runtime.
- **Class C (Nuxt)**: Implemented, including `import { db } from "void/db"` / `void/kv` in Nitro server handlers during local Node dev and deploy runtime.
- **Binding inference**: Implemented across framework classes (A/B/C) for scanned server TS/JS files, with `void.json.bindings` as explicit override when needed.
- **Astro**: No special runtime env shim needed for Astro v6 because server code runs in workerd. Treat as standard worker runtime for env access.

---

## Feature Matrix

| Feature                        | Class A              | Class B (SvelteKit)                                               | Class C (Nuxt)                                                           | Class C + voidPlugin() |
| ------------------------------ | -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| Binding inference              | Yes                  | Yes                                                               | Yes                                                                      | Yes                    |
| `void/db`, `void/kv` etc.      | Yes                  | Yes                                                               | Yes                                                                      | Yes                    |
| Runtime env source for helpers | `cloudflare:workers` | ALS via hooks injection (dev) + `cloudflare:workers` (production) | `globalThis.__env__` (Nitro dev) + `cloudflare:workers` (worker runtime) | Same as Class C        |
| DB type codegen                | Yes (auto)           | Yes (auto)                                                        | No                                                                       | Yes (auto)             |
| Migrations (dev)               | Yes (auto)           | Yes (auto)                                                        | No                                                                       | Yes (auto)             |
| Migrations (deploy)            | Yes                  | Yes                                                               | Yes                                                                      | Yes                    |
| Auth                           | Yes                  | Yes (wrapper)                                                     | Yes (wrapper)                                                            | Yes (wrapper)          |
| Queues / Crons                 | Yes                  | Yes (wrapper)                                                     | Yes (wrapper)                                                            | Yes (wrapper)          |
| ISR / Revalidate               | Yes (config)         | Yes (config)                                                      | Yes (config)                                                             | Yes (config)           |
| Prerender                      | Yes (config)         | Yes (config)                                                      | Yes (config)                                                             | Yes (config)           |

Notes:

- Per-page `export const revalidate` / `prerender` auto-discovery is a void Pages mode feature, not available in any framework class. All framework classes use `void.json` `cache.revalidate` and `cache.prerender` config.
- `void.json.bindings` is optional. When set, it acts as explicit override; when omitted, bindings are inferred from source.
- Class C can optionally add `voidPlugin()` to Nuxt's Vite config for auto DB type codegen and dev-time migration management.

---

## Runtime Env Strategy (Implemented)

Problem solved: Nuxt and SvelteKit server code often executes in Node during local dev, where `cloudflare:workers` globals are unavailable. This broke `import { db } from "void/db"` and similar helpers.

Implemented approach:

1. Add a framework-agnostic resolver in `packages/void/src/runtime/env.ts`.
2. Resolve runtime env in this order:
   - request-scoped `AsyncLocalStorage` (`withRuntimeEnv`) — SvelteKit dev via hooks injection
   - `globalThis.__env__` (Nuxt/Nitro dev)
   - `cloudflare:workers` env (workerd runtime / production)
3. Move runtime helpers (`void/db`, `void/kv`, `void/storage`, `void/queues`, `void/isr`, `void/ai`) to this resolver via `getRuntimeEnv`, `getRuntimeBinding`, `requireRuntimeBinding`.
4. SvelteKit dev: `void:sveltekit-hooks-inject` plugin transforms the generated `get_hooks()` in `.svelte-kit/generated/server/internal.js` to wrap the `handle` function with `withRuntimeEnv(event.platform.env, ...)`. This stores the env in AsyncLocalStorage so `void/db` resolves it via `envContext.getStore()` (stage 1). Uses adapter-cloudflare's single Miniflare instance (via `event.platform.env`), no private APIs, no second `getPlatformProxy()`.
5. SvelteKit production: `cloudflare:workers` resolves natively in workerd (stage 4).
6. `env.ts` is a named tsdown entry (`void/_env` subpath export) so `void/db` and the hooks inject plugin share the same module instance (same ALS).

Non-intrusive DX outcome:

- No user-generated bridge/shim files.
- No extra generated files to check in.
- Existing `import { db } from "void/db"` style works in Nuxt and SvelteKit server handlers.

---

## Framework Presets

Each framework has a preset defining its build output conventions:

```typescript
type FrameworkPreset = {
  buildCommand: string;
  workerDir: string;
  workerMain: string;
  assetsDir: string;
};

const FRAMEWORK_PRESETS: Record<string, FrameworkPreset> = {
  sveltekit: {
    buildCommand: 'vite build',
    workerDir: '.svelte-kit/cloudflare',
    workerMain: '_worker.js',
    assetsDir: '.svelte-kit/cloudflare',
  },
  nuxt: {
    buildCommand: 'nuxt build',
    workerDir: '.output/server',
    workerMain: 'index.mjs',
    assetsDir: '.output/public',
  },
  astro: {
    buildCommand: 'astro build',
    workerDir: 'dist/_worker.js',
    workerMain: 'index.js',
    assetsDir: 'dist',
  },
};
```

When `workerDir` is inside `assetsDir` (SvelteKit, Astro), worker files are excluded from asset collection.

---

## Wrangler Config Parsing

After the framework build, read `wrangler.json(c)` from the project root. Extract only:

- `compatibility_date`
- `compatibility_flags`

Output paths come from presets, not from the wrangler config.

---

## void.json Extensions

### Bindings (custom names / explicit override)

`bindings` accepts booleans or custom names. This field is optional across framework classes and overrides source inference when present:

```typescript
bindings?: {
  db?: boolean | string;      // true → "DB", string for custom name
  kv?: boolean | string;      // true → "KV"
  storage?: boolean | string; // true → "STORAGE"
  ai?: boolean;
}
```

Single instance per binding type. Multi-binding support deferred to a separate design.

### Build command override

```typescript
build?: string;   // overrides the preset's buildCommand
```

### Prerender paths

```typescript
cache?: {
  revalidate?: number | Record<string, number>;  // existing
  prerender?: string[];                           // new — explicit paths to prerender at deploy
}
```

### Auth

```typescript
auth?: boolean | AuthProvider[];  // already exists, used by Class C for explicit auth config
```

---

## DeployManifest Extensions

New optional fields on v1 (backward compatible, no version bump):

```typescript
type DeployManifest = {
  // ... existing fields ...
  workerMain?: string; // entry module filename (default: "index.js")
  compatibilityDate?: string; // from framework's wrangler config
  compatibilityFlags?: string[]; // from framework's wrangler config
};
```

---

## API Changes

In `packages/api/src/routes/deploy.ts`, the worker upload metadata uses the new manifest fields with fallbacks:

```typescript
const metadata = {
  main_module: manifest.workerMain ?? "index.js",
  compatibility_date: manifest.compatibilityDate ?? "2026-02-12",
  compatibility_flags: manifest.compatibilityFlags ?? ["nodejs_compat"],
  bindings: /* unchanged */,
  triggers: /* unchanged */,
};
```

---

## The Wrapper

For Class B and C, void features that hook into the worker (auth, queues, crons) are implemented via a **wrapper entry module** that wraps the framework's original worker.

Generated when **any** of auth, queues, or crons are present. Bundled with Vite as a post-build step.

```javascript
// generated void-wrapper.js (conceptual)
import original from './index.mjs';
import { authContext, resolveSession, handleAuth } from './void-auth.js';
import { handleScheduled } from './void-scheduled.js';
import { handleQueue } from './void-queue.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__auth/')) return handleAuth(request, env, ctx);

    const user = await resolveSession(request, env);
    return authContext.run({ user }, () => original.fetch(request, env, ctx));
  },
  scheduled: handleScheduled,
  queue: handleQueue,
};
```

- If no auth: fetch is a direct passthrough to `original.fetch`
- If no crons: no `scheduled` export
- If no queues: no `queue` export
- If none of the above: no wrapper generated, framework's entry used directly

The wrapper source is generated at deploy time and bundled with Vite (targeting `webworker`, ESM output). The framework's built worker is treated as a pre-built dependency. The `workerMain` in the manifest points to the wrapper instead of the framework's original entry.

### Auth via ALS

The wrapper validates the session cookie and runs the framework's fetch inside an `AsyncLocalStorage` context. `void/auth` runtime reads the current user from this context — framework-agnostic.

For Class C, users add `void` as a dependency to access `void/auth`.

### Queue/Cron Handlers

`crons/` and `queues/` directories are scanned the same way as Class A. Handler files are compiled as part of the wrapper Vite bundle.

---

## voidPlugin() for Class B and C

When a Class B or C framework is detected, `voidPlugin()` runs in a lighter mode:

```
Class A:
  voidPlugin() → [dbTypesPlugin, migrationPlugin, ...cloudflare({ viteEnvironment, config })]

Class B:
  voidPlugin() → [wranglerSyncPlugin, svelteKitHooksInjectPlugin, dbTypesPlugin, migrationPlugin]

Class C (optional — added to framework's Vite config):
  voidPlugin() → [wranglerSyncPlugin, dbTypesPlugin, migrationPlugin]
```

Class B and C no longer have identical composition because only SvelteKit needs the hooks injection plugin for dev-time env resolution.

Nuxt can add `voidPlugin()` in its Vite config:

```typescript
// nuxt.config.ts
import { voidPlugin } from 'void';
export default defineNuxtConfig({
  vite: { plugins: [voidPlugin()] },
});
```

### What's included

- **DB type codegen** — generates `.void/db.d.ts` from schema
- **Migration plugin** — watches `migrations/`, auto-applies in dev
- **Binding inference** (Class B and C) — scans `.ts`/`.js` server files in `FRAMEWORK_SCAN_DIRS`
- **Wrangler.jsonc binding sync** — keeps local dev bindings in sync (see below)

### What's excluded

- **`cloudflare()` Vite plugin** — framework's adapter handles the CF worker build
- **Routing plugin** — framework owns routing
- **Entry generation** — framework controls worker entry

### Wrangler.jsonc binding sync

`voidPlugin()` syncs bindings to `wrangler.jsonc` on dev startup so local dev Just Works:

| Class                  | Binding source                                 | Sync to wrangler.jsonc  |
| ---------------------- | ---------------------------------------------- | ----------------------- |
| Class B (SvelteKit)    | Inferred from source                           | Yes (auto)              |
| Class C + voidPlugin() | Inferred from source (or `void.json` override) | Yes (auto)              |
| Class C (no plugin)    | Inferred from source (deploy path)             | User maintains manually |

SvelteKit additionally uses hooks injection to wrap `handle` with `withRuntimeEnv()` for runtime env access in `void/*` helpers during dev.

---

## Deploy Flow

### Class A (existing, no changes)

1. `vite build` (CF plugin produces worker)
2. Infer bindings
3. Inject Vite manifest into worker entry
4. Package manifest + worker + assets + migrations
5. Upload

### Class B (SvelteKit)

1. Detect framework from `package.json`
2. `vite build` (SvelteKit adapter produces worker)
3. Infer bindings from source
4. Scan `crons/` and `queues/`, read auth config
5. If wrapper needed: generate wrapper entry, bundle with Vite
6. Read `wrangler.jsonc` for compat settings
7. Use preset for output paths
8. Collect migrations
9. Package manifest + worker + assets + migrations
10. Upload

### Class C (Nuxt)

1. Detect framework from `package.json`
2. Run framework build command (e.g. `nuxt build`)
3. Infer bindings from source (`FRAMEWORK_SCAN_DIRS`) unless overridden by `void.json.bindings`
4. Scan `crons/` and `queues/`
5. Collect migrations from `migrations/` if present
6. If wrapper needed: generate wrapper entry, bundle with Vite
7. Read `wrangler.jsonc` for compat settings
8. Use preset for output paths
9. Package manifest + worker + assets + migrations
10. Upload

---

## What Changes Where

| File                                | Change                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `framework/.../runtime/env.ts`      | New runtime env resolver with Nuxt/SvelteKit/workerd fallbacks               |
| `framework/.../runtime/db.ts`       | Use resolver (`requireRuntimeBinding("DB")`)                                 |
| `framework/.../runtime/kv.ts`       | Use resolver (`requireRuntimeBinding("KV")`)                                 |
| `framework/.../runtime/storage.ts`  | Use resolver (`requireRuntimeBinding("STORAGE")`)                            |
| `framework/.../runtime/queues.ts`   | Use resolver (`requireRuntimeBinding("QUEUE_*")`)                            |
| `framework/.../runtime/isr.ts`      | Use resolver (`getRuntimeBinding(...)`)                                      |
| `framework/.../runtime/ai.ts`       | Resolve all AI env/bindings via runtime resolver                             |
| `framework/.../plugin-inference.ts` | Extend `detectFramework()` with class info; add Class B/C framework entries  |
| `framework/.../index.ts`            | Class B/C plugin composition + SvelteKit hooks injection + wrangler sync     |
| `framework/.../cli/deploy.ts`       | Class B/C deploy paths — preset lookup, wrangler parsing, wrapper bundling   |
| `framework/.../cli/package.ts`      | Support `workerMain`, `compatibilityDate`, `compatibilityFlags` in manifest  |
| `framework/.../cli/preset.ts`       | Add `FRAMEWORK_PRESETS` for SvelteKit, Nuxt, Astro                           |
| `framework/.../cli/wrangler.ts`     | New — parse wrangler.json/jsonc for compat settings                          |
| `framework/.../cli/wrapper.ts`      | New — generate + Vite-bundle the wrapper entry with auth/cron/queue handlers |
| `framework/.../config.ts`           | Extend `bindings` to accept `string`; add `build` and `cache.prerender`      |
| `packages/api/src/types.ts`         | Add optional `workerMain`, `compatibilityDate`, `compatibilityFlags`         |
| `packages/api/src/routes/deploy.ts` | Use new manifest fields in worker upload metadata                            |

---

## Validation Status

- Unit coverage: `packages/void/test/unit/env.test.ts` validates runtime env fallback order and error behavior.
- Integration coverage:
  - `packages/void/test/integration/nuxt.test.ts` validates SSR plus `void/db` + `void/kv` in Nuxt dev/build (including inference-only mode without `void.json.bindings`).
  - `packages/void/test/integration/sveltekit.test.ts` validates SSR plus `void/db` + `void/kv` in SvelteKit dev/build.

---

## Binding Inference Notes

Current inference scans `**/*.{ts,tsx,mts,js,jsx,mjs}` — no `.vue`, `.svelte`, or `.astro` files.

- **Class A**: Works today. Server code in `.ts` route files under `FRAMEWORK_SCAN_DIRS`.
- **Class B (SvelteKit)**: Works. Server code lives in `+page.server.ts`, `hooks.server.ts` etc. — all `.ts` files under `src/routes/`, covered by `FRAMEWORK_SCAN_DIRS`.
- **Class C (Nuxt)**: Works. Server code in `server/` and other framework scan dirs is inferred the same way as Class B.

If `void.json.bindings` is set, it overrides inference.

Pre-existing gap (void default mode, not framework classes): `pages/` directory and `.vue` SFC `<script server>` blocks are not scanned. Separate fix, not part of this design.
