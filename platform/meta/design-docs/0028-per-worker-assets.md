# Per-Worker Static Assets

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-26
**Status:** Approved

> **Note:** This design is partially superseded by [0055-kv-r2-static-deployments](./0055-kv-r2-static-deployments.md). Per-worker assets apply only to **worker-based deployments** (types `"void"` and `"framework"`). Static-only deployments (types `"static"` / `"spa"`) bypass WfP entirely and use KV/R2-based content-addressed storage instead. Sections affected: "Static-only deploys", "Dispatch Worker Changes" (dispatch retains static serving for KV/R2 path), "Simplified RoutingEntry" (`workerName` remains optional, `staticDeploymentId` added), and "Deletion Summary" (static serving code is rewritten, not deleted).

> **Note (2026-04-23):** As of [0066-wfp-asset-r2-fallback](./0066-wfp-asset-r2-fallback.md), WfP deploys additionally mirror their assets to the same platform R2/KV that static-only deploys use. CF's per-worker asset binding remains primary; dispatch consults the mirror only when CF's asset dedupe returns the poisoning stub (see [0065](./0065-cloudflare-asset-dedupe-poisoning.md)).

---

## Summary

Migrate from R2-based static asset serving to Cloudflare's native per-worker static assets. Workers for Platforms has supported per-worker assets since Jan 2025. Void currently reimplements asset storage (R2), deduplication (SHA-256 manifest), stale cleanup, cache headers, SPA/SSG fallback logic, and edge caching — all of which CF now provides as a built-in primitive. Additionally, the lack of an `ASSETS` binding forces a `globalThis.__VITE_MANIFEST__` hack in the framework CLI and blocks third-party framework support (vinext, Nuxt on CF Vite plugin, etc.).

Moving to per-worker assets eliminates ~400 lines of custom infrastructure across dispatch and the API deploy route, removes the manifest inlining hack, and gives user workers a native `ASSETS` binding — enabling any framework that uses `@cloudflare/vite-plugin` to work on Void without patching.

---

## Motivation

| Concern                | Current (R2)                                                                        | Per-worker assets                          |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| Asset storage          | R2 with `{projectId}/current/*` keys                                                | CF edge, managed automatically             |
| Deduplication          | Custom SHA-256 manifest, `POST /assets/check`                                       | Built-in content-hash dedup across uploads |
| Stale cleanup          | Diff old vs new manifest, delete orphaned R2 keys                                   | Automatic — old version's assets replaced  |
| Cache headers          | Dispatch detects hashed vs non-hashed paths, sets `immutable` / `s-maxage` manually | `_headers` file, applied by CF at the edge |
| SPA/SSG fallback       | Dispatch reimplements `index.html` fallback, nested index, 404.html logic           | Built-in `not_found_handling` config       |
| Worker asset access    | Not available — manifest inlined via `globalThis.__VITE_MANIFEST__` hack            | Native `env.ASSETS.fetch()` binding        |
| Third-party frameworks | Each needs custom patching to work without ASSETS                                   | Drop-in compatible                         |

---

## New Deploy Pipeline (API)

The current deploy route uploads assets to R2 and worker code to the dispatch namespace separately. The new flow uses CF's 3-step asset upload API to bundle assets with the worker.

### Current flow

```
CLI → API:  FormData { manifest, worker:*, asset:*, migration:* }
API:        1. Upload assets to R2 (projectId/current/*)
            2. Upload worker to dispatch namespace (PUT .../scripts/workerName)
            3. Diff + delete stale R2 assets
            4. Write asset-manifest.json to R2
```

### New flow

```
CLI → API:  FormData { manifest, worker:*, asset:*, migration:* }
API:        1. Create asset upload session (POST .../assets-upload-session)
               → sends manifest of {path: hash, size} for each asset
               → CF returns: completion JWT + list of files that need uploading
            2. Upload needed file contents (POST .../workers/assets/upload)
               → only files CF doesn't already have (built-in dedup)
            3. Upload worker + attach assets (PUT .../scripts/workerName)
               → metadata includes { assets: { jwt, config }, bindings: [...] }
               → worker gets ASSETS binding automatically
```

The API still receives assets from the CLI the same way (as `asset:*` FormData entries). The difference is where they go — CF's asset API instead of R2. The CLI protocol (`FormData` with `asset:`, `worker:`, `migration:` prefixes) stays unchanged. The `POST /assets/check` dedup endpoint can be removed since CF handles deduplication natively.

### Asset config in worker metadata

```ts
metadata: {
  main_module: "index.js",
  assets: {
    jwt: completionToken,
    config: {
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",  // worker handles 404s for SSR
    }
  },
  bindings: [
    ...existingBindings,
    { name: "ASSETS", type: "assets" }
  ]
}
```

### Static-only deploys

Currently static-only deploys have no worker. With per-worker assets, every deploy needs a worker script. For SPA/SSG projects, the API generates a minimal passthrough worker:

```js
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
```

This is generated server-side in the API deploy route — the CLI doesn't need to know about it. The `not_found_handling` config (`"single-page-application"` for SPA, `"404-page"` for SSG) handles the fallback behavior that `static.ts` currently implements.

---

## Cache Headers & `_headers` File

### Current behavior

- Hashed assets (`/assets/*`): `Cache-Control: public, max-age=31536000, immutable`
- Non-hashed (`index.html`, etc.): `Cache-Control: public, s-maxage=60, max-age=0, must-revalidate`
- Custom headers from `_headers` file: parsed by the framework CLI into `HeaderRule[]`, stored in the KV routing entry, applied by dispatch via `applyHeaderRules()`

### New behavior

With per-worker assets, CF serves files directly and respects `_headers` files natively (same convention as Cloudflare Pages).

**For Void's own framework builds**, the CLI generates a `_headers` file in `dist/client/` before packaging:

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*
  Cache-Control: public, s-maxage=60, max-age=0, must-revalidate
```

This replicates the exact caching behavior dispatch currently applies in `buildResponse()`. The file gets uploaded as a regular asset and CF applies the rules at the edge.

**For meta-frameworks** (Nuxt, SvelteKit, Astro, vinext) that generate their own `_headers` files, we pass them through as-is. No parsing needed — CF handles it natively.

### What gets removed

- `platform/packages/dispatch/src/headers.ts` — the `applyHeaderRules()` logic
- `HeaderRule` type and `headers` field from the KV routing entry
- Header parsing in the framework CLI as it relates to dispatch
- The `assetsDir` heuristic for detecting hashed paths — the `_headers` file handles it explicitly

---

## Dispatch Worker Changes

Dispatch gets significantly simpler. It no longer serves static assets — CF's edge serves them before the worker code even runs.

### Remaining responsibilities

- **Routing**: KV lookup (slug → worker), custom domains
- **Metering**: Record every request to Analytics Engine + usage queue
- **Limits**: CPU/subrequest enforcement via dispatch options
- **Suspension**: Check + enforce suspended projects
- **ISR**: Stale-while-revalidate for SSR pages (stays in R2)
- **Queue relay**: Route queue batches to user workers

### Deleted files

- `src/static.ts` — entirely removed (~170 lines)
- `src/headers.ts` — entirely removed (~40 lines)

### Deleted from `src/index.ts`

- All imports from `static.ts` and `headers.ts`
- The `!routing.workerName` branch (static-only deploys) — every deploy now has a worker
- Edge caching logic for static assets (`cacheResponse()`, versioned cache keys, hashed path detection)
- The `conditionalResponse()` ETag/304 logic — CF handles conditional responses
- The `assetsDir`, `mode`, and `headers` fields from `RoutingEntry`

### Simplified RoutingEntry

```ts
type RoutingEntry = {
  workerName: string; // no longer optional — every deploy has a worker
  projectId: string;
  userId?: string;
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string; // kept for ISR cache invalidation
  limits?: Record<string, number>;
  suspended?: string;
};
```

### Simplified fetch handler

```ts
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const slug = extractSlug(url.hostname, env.BASE_HOSTNAME);
  const routingKey = slug ?? `domain:${url.hostname}`;

  const routingRaw = await env.ROUTING.get(routingKey);
  if (!routingRaw) return new Response("Not Found", { status: 404 });

  const routing: RoutingEntry = JSON.parse(routingRaw);
  if (routing.suspended) {
    return Response.json(
      { error: "usage limit exceeded", reason: routing.suspended },
      { status: 429 },
    );
  }

  const startTime = Date.now();
  let requestType: RequestType = "static";

  // ISR: stale-while-revalidate for configured paths
  if (routing.ssr && routing.revalidate) {
    const isrTtl = resolvePathTtl(routing.revalidate, url.pathname);
    if (isrTtl > 0 && request.method === "GET" && !shouldBypassIsr(request)) {
      const cached = await readIsrCache(env, routing.projectId, url.pathname);
      if (cached) {
        requestType = "isr";
        if (isStale(cached)) {
          ctx.waitUntil(revalidateInBackground(env, routing, request, url.pathname, isrTtl));
        }
        return meter(isrCacheResponse(cached, isStale(cached)));
      }
    }
  }

  // Dispatch to user worker — CF handles static assets transparently
  const worker = getWorker(env, routing);
  try {
    const response = await worker.fetch(request);

    // Classify for metering
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      requestType = "api";
    } else if (routing.ssr && !hasExtension(url.pathname)) {
      requestType = "ssr";
    }

    // Write ISR cache on miss
    if (routing.revalidate) {
      const isrTtl = resolvePathTtl(routing.revalidate, url.pathname);
      if (isrTtl > 0 && response.ok && requestType === "ssr") {
        ctx.waitUntil(writeIsrCache(env, routing.projectId, url.pathname, response, isrTtl));
      }
    }

    return meter(response);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Worker exceeded")) {
      return meter(Response.json({ error: "CPU limit exceeded" }, { status: 429 }));
    }
    throw err;
  }
}
```

### Env

```ts
export type Env = {
  DISPATCH: DispatchNamespace;
  ASSETS: R2Bucket; // kept — used for ISR cache only
  ROUTING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  BASE_HOSTNAME?: string;
};
```

R2 bucket stays for ISR. Future cleanup could rename binding to `ISR_CACHE`.

### Metering

When dispatch calls `env.DISPATCH.get(workerName).fetch(request)`, CF's asset serving intercepts the request if it matches a static file. Dispatch still sees the request for metering before dispatching. Needs verification during implementation — if CF short-circuits before dispatch sees asset requests, we'd need `run_worker_first` or an alternative metering approach.

---

## Framework CLI Changes

### Drop the manifest inlining hack

The block in `deploy.ts:509-517` that prepends `globalThis.__VITE_MANIFEST__` to the worker entry is deleted entirely. The worker now has a real `ASSETS` binding in production. The generated `loadSsrManifest()` code in `compile.ts` already has the `env.ASSETS.fetch("/.vite/manifest.json")` path — that becomes the primary path.

### Generate `_headers` file

Before packaging, the CLI writes `dist/client/_headers` with the caching rules described above. Uses the existing `assetsDir` detection (reading the Vite manifest to find the hashed prefix) to generate the correct pattern. If a user-authored `_headers` file already exists (meta-frameworks, or user's `public/_headers`), it's left as-is.

### Include `.vite/manifest.json` in assets

Already works — client files are collected from `dist/client/` which includes `.vite/manifest.json`. No change needed.

### Drop `assetHashes` from manifest

The `computeAssetHashes()` and `checkAssets()` dedup flow is removed. CF's asset upload API handles deduplication natively. The `POST /assets/check` endpoint and `PlatformClient.checkAssets()` are deleted.

---

## ISR (No Change)

ISR stays exactly as-is. It stores rendered HTML in R2, not build-time files.

- R2 bucket remains for `{projectId}/isr/*` entries
- `isr.ts` in dispatch is unchanged
- Deploy-time prerendering in the API still writes ISR entries to R2
- `clearIsrCache()` on each deploy still runs
- `revalidate` field in routing entry still drives ISR behavior

---

## Migration Strategy

### Hard cutoff — no v1 backward compat

Bump the `DeployManifest` version to `2`. The API rejects version 1 manifests with a clear error telling the user to update the CLI. The CLI drops all v1 logic — no `assetHashes`, no `checkAssets()`, no `computeAssetHashes()`. Clean break.

This is viable because Void is pre-launch — there are no third-party CLI consumers that need a deprecation window. All deploys go through the first-party CLI, and we control the release cadence.

### Version 2 manifest

```ts
type DeployManifest = {
  version: 2;
  bindings: { ... };          // unchanged
  // Removed: assetHashes, assetsDir, static, headers
  // Added:
  assetConfig?: {
    not_found_handling?: "none" | "single-page-application" | "404-page";
    html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  };
  // Unchanged:
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  prerender?: string[];
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  vars?: Record<string, string>;
  migrations?: { name: string; destructive: boolean }[];
  schedules?: ScheduleMeta[];
  queues?: QueueMeta[];
  framework?: boolean;
};
```

The `assetConfig` maps directly to CF's asset config in the upload session. For static-only deploys (previously `manifest.static`), the CLI sets `assetConfig.not_found_handling` to `"single-page-application"` or `"404-page"` and omits worker files — the API generates the passthrough worker.

### Rollout

Ship API, dispatch, and CLI together. All v1 code is removed in one pass — no dual code paths, no sunset period.

Existing live deployments on v1 continue to work (their KV routing entries and R2 assets are untouched). The next `void deploy` uses v2 and migrates the project to per-worker assets. R2 static assets for migrated projects become orphaned and can be cleaned up in a batch job later.

---

## Deletion Summary

| File / Code                                   | Lines    | Reason                          |
| --------------------------------------------- | -------- | ------------------------------- |
| `dispatch/src/static.ts`                      | ~170     | CF serves assets natively       |
| `dispatch/src/headers.ts`                     | ~40      | CF handles `_headers` natively  |
| Static-only branch in `dispatch/src/index.ts` | ~30      | Every deploy has a worker       |
| Edge cache logic in `dispatch/src/index.ts`   | ~50      | CF caches its own assets        |
| `conditionalResponse()` in dispatch           | ~20      | CF handles ETags/304s           |
| R2 asset upload in `api/src/routes/deploy.ts` | ~30      | Replaced by CF asset upload API |
| Asset manifest diff/cleanup in API            | ~20      | CF handles lifecycle            |
| `POST /assets/check` endpoint in API          | ~15      | CF handles dedup                |
| `guessContentType()` in API                   | ~20      | CF handles content types        |
| Manifest inlining hack in framework CLI       | ~8       | Worker has real ASSETS binding  |
| **Total**                                     | **~400** |                                 |
