---
title: Dev CSS Asset Collection for SSR FOUC Prevention
status: draft
created: 2026-05-15
---

# RFC: Dev CSS Asset Collection for SSR FOUC Prevention

## Summary

Void Pages mode can flash unstyled server-rendered HTML in development because the initial HTML does not include render-blocking CSS for the active page and layout graph. In production, Pages mode already uses the Vite manifest to emit route-scoped stylesheet links. The dev path should use Vite's module graph and CSS pipeline to discover and inline the CSS needed by the SSR render before sending HTML.

This RFC proposes a dev-only CSS asset collector for Void-owned Pages and island rendering, modeled after SvelteKit's current dev strategy: collect modules that are actually relevant to a route render, walk Vite's graph, load CSS with Vite's `?inline` CSS path, and emit inline `<style>` tags before the app HTML can paint.

The collector should be Vite-side infrastructure, graph-based, adapter-neutral where possible, and should avoid source-code regex extraction as the primary mechanism. Island rendering should use the same machinery in the initial implementation pass so Void does not stabilize two parallel dev CSS systems.

## Background

Vite development is unbundled and on-demand. CSS imported by client modules is injected by JavaScript after those modules execute. That is a good default for plain Vite apps, but it can cause FOUC for SSR frameworks: the browser can paint server HTML before the module graph has run and injected styles.

Vite production builds are different. Vite extracts CSS for chunks and coordinates loading so async chunks are evaluated only after their CSS is loaded. Void production Pages mode also has a manifest path that emits stylesheet links before the app HTML.

The Vite team has discussed a framework-level assets metadata API for SSR. The proposal centers on making client and route asset metadata available to server code so frameworks can emit stylesheet and preload tags. That API is not currently available as a stable Vite primitive, so frameworks still implement their own dev graph crawling.

References:

- Vite CSS behavior: https://vite.dev/guide/features.html#css
- Vite production CSS code splitting: https://vite.dev/guide/features.html#css-code-splitting
- Vite RFC discussion for SSR client assets metadata: https://github.com/vitejs/vite/discussions/20913
- SvelteKit dev implementation reference: https://github.com/sveltejs/kit/blob/2549a44e139e0fb3c34bbfd63236e4cf59245cbe/packages/kit/src/exports/vite/dev/index.js#L230-L260
- SvelteKit current dev implementation: https://github.com/sveltejs/kit/blob/%40sveltejs/kit%402.59.1/packages/kit/src/exports/vite/dev/index.js
- SvelteKit render integration: https://github.com/sveltejs/kit/blob/%40sveltejs/kit%402.59.1/packages/kit/src/runtime/server/page/render.js
- SvelteKit production eager CSS logic: https://github.com/sveltejs/kit/blob/%40sveltejs/kit%402.59.1/packages/kit/src/exports/vite/build/build_server.js
- Vite PR discussion context: https://github.com/vitejs/vite/pull/16018#issuecomment-2006385354

## Current Void Behavior

### Generic SSR

For `src/main.ssr.ts(x)`, Void builds asset tags around the configured client entry.

In development, `getDevClientTags()` returns `css: ""` and only injects:

- `/@vite/client`
- Void binding hints
- React Fast Refresh preamble when applicable
- the client entry script

In production, Void loads `.vite/manifest.json`, walks static imports from the client entry, and emits stylesheet links for manifest chunks that list `css`.

Relevant code:

- `packages/void/src/router/compile.ts`, `getDevClientTags()`
- `packages/void/src/router/compile.ts`, `getClientAssetTags()`

### Pages Mode

Pages mode has a better production story. The compiler builds `PAGE_CSS_KEYS` from the active page and its layout chain, then production `getPagesAssetTags()` uses the manifest to collect:

- CSS from the pages client entry static graph
- CSS from the active page component
- CSS from active layouts and named layouts

In development, `getPagesDevClientTags()` still returns `css: ""`. The browser receives SSR HTML first, then the client entry runs, dynamic imports discover the page and layout modules, and Vite injects CSS after that.

Relevant code:

- `packages/void/src/router/compile.ts`, `getPagesDevClientTags()`
- `packages/void/src/router/compile.ts`, `PAGE_CSS_KEYS`
- `packages/void/src/router/compile.ts`, `collectRouteCss()`
- `packages/void/src/pages/protocol.ts`, `handlePageGet()`

There is also an ordering issue: `handlePageGet()` calls `getAssetTags()` before `renderFn()`. The framework renderers import the page and layout modules during render. For example, the React renderer loads `components[pageObj.component]()` and the active layout modules inside `renderReactPage()`.

Therefore, a collector bolted only onto `getPagesAssetTags()` would still run too early unless it can first make the active route roots known to Vite and transform them in the correct environment graph. The fix must make the active page and layout roots available before head emission, collect CSS from Vite's graph for those roots, and only then emit `assetTags.css` before the `<head>` is written.

### Islands

Island adapters already contain partial dev FOUC mitigation. They build virtual CSS modules for page and layout files and inject render-blocking `<link rel="stylesheet">` tags for some known CSS sources.

This works for some cases, but it is adapter-specific and based partly on file scans or regex extraction. It should be replaced or consolidated with the graph-based collector proposed here.

## Problem

Void should send SSR HTML in development with the CSS needed for the first paint.

Today, Pages mode does not do this. It relies on Vite's client-side CSS injection, which happens after the server HTML can paint. This is visible as FOUC, especially with:

- global CSS imported by page or layout modules
- SFC `<style>` blocks
- CSS modules
- preprocessor CSS
- CSS imported by components used during the initial SSR render

Regex extraction is not a correct long-term fix because it bypasses Vite's real CSS pipeline. It can miss transformed CSS, SFC-generated style modules, CSS modules, PostCSS, preprocessors, aliases, URL rebasing, and plugin-provided CSS.

## Goals

- Prevent dev FOUC for Void-owned Pages mode and island pages.
- Use Vite's module graph and CSS transform pipeline.
- Support React, Vue, Svelte, and Solid Pages mode through shared infrastructure where possible.
- Preserve production behavior for Pages and islands unless a bug is found.
- Replace the current island-specific dev CSS workaround with the shared collector in the same implementation pass.
- Keep HMR semantics correct enough for dev: CSS edits should update without requiring a full server restart.

## Non-Goals

- Do not solve all arbitrary manual SSR asset discovery in this RFC.
- Do not add a public API until the internal model is proven.
- Do not implement route CSS unmounting for SPA navigation.
- Do not replace Vite's production manifest handling wholesale. Production should remain manifest-based, but ordering bugs in Void's manifest traversal may be fixed as part of this work.
- Do not crawl the entire application graph on every request.

## SvelteKit Model

SvelteKit currently solves dev first-paint CSS by making CSS collection part of its Vite dev integration rather than part of a framework runtime package.

The important pieces to model are:

- When a route node/component is loaded, SvelteKit records the Vite module node for that loaded module.
- Each rendered node exposes a lazy `inline_styles()` hook.
- During HTML rendering, SvelteKit calls `inline_styles()` after route modules have been loaded, walks Vite's module graph from those recorded roots, identifies CSS requests with Vite's CSS request logic, imports each CSS URL through `?inline`, and adds the resulting CSS to the head.
- Production remains manifest-based and uses client/server dependency metadata to eagerly include only CSS associated with server-rendered route modules.

Void should follow the same ownership model:

- Dev CSS collection belongs to Vite/dev-server-side infrastructure.
- Framework adapters should expose route roots and loaded module identity, but should not own Vite server access.
- Runtime packages such as `@void/react`, `@void/vue`, `@void/svelte`, and `@void/solid` should not gain a direct dependency on Vite server internals.
- Production should remain manifest-based.

## Proposed Design

Add a dev-only CSS asset collection layer that can return CSS for a set of route-relevant module roots. This collector must run at the point in the render flow where the active page and layout modules are already known, and it must be hosted by Vite-side infrastructure rather than by adapter runtime packages.

At a high level:

1. Determine the active route's roots.
2. Ensure those roots have been transformed in the relevant Vite environment graph.
3. Walk static dependencies from the Vite module graph.
4. Select CSS module nodes using Vite's CSS request semantics.
5. Load each CSS URL with `?inline` through Vite.
6. Inline the resulting CSS in the SSR `<head>` before app HTML.

The output should be an `assetTags.css` string containing `<style>` tags in development. Production should continue to emit `<link rel="stylesheet">` tags from the manifest.

### Route Roots

For Pages mode, roots are known from Void's scanner:

- `virtual:void-pages-client`
- active page component file
- active layout files
- active named layout files

This mirrors production `PAGE_CSS_KEYS`, but uses source module URLs instead of built manifest keys.

Current production key generation emits the page key before layout keys. Production `collectRouteCss()` also walks manifest imports with a LIFO stack and `Set`, so CSS order can be governed by traversal artifacts rather than Vite/Rollup import order. If the dev implementation uses root-layout-to-page ordering, production must be updated to match so dev and production cascade behavior stay aligned. This RFC treats the existing production page-before-layout order and unordered production manifest traversal as bugs to fix as part of this work.

Today, the generated runtime manifest only exposes component import functions and `layoutTree`. It does not expose the source module URL for each component or layout id. Virtual Pages manifest generation must emit a source-id map, for example `componentModuleIds` and `layoutModuleIds`, so the Vite-side collector can resolve the actual page and layout roots once the active route is known.

The browser CSS source of truth is the client environment graph. This matters for Vue and Svelte SFC style modules, CSS modules, preprocessors, and plugin-provided CSS. The collector must therefore collect CSS for active page and layout roots through `server.environments.client.moduleGraph` / `server.environments.client.transformRequest()`.

The SSR/worker environment graph can be used as an additive signal for modules that were actually loaded during SSR, but it must not be the only source of CSS discovery. In the default Cloudflare target, Pages rendering may execute in the `void_worker` environment, while node targets use the SSR/module-runner path. The collector must be environment-aware.

`virtual:void-pages-client` should be collected through the client dev graph separately from route roots. The SSR render path loads page and layout modules for SSR; it should not SSR-load the browser client entry just to discover client-entry CSS. The final dev CSS set should merge CSS found from:

- the pages client entry static graph,
- the active page/layout source roots in the client graph,
- and optionally SSR/worker-loaded route roots that are known to participate in the initial render.

For islands, roots are:

- the island page component
- active island layout files
- active island named layout files
- island components imported with `with { island: ... }`
- island client entry only when the page needs client JavaScript
- markdown client entry when the markdown plugin contributes client scripts

Island roots should be passed to the same collector as Pages roots, with an island-specific root phase list. The collector API should therefore accept an explicit ordered list of normalized client-environment roots rather than assuming every call is a full Pages render.

The initial implementation should remove the current island-specific dev CSS path instead of layering the new collector beside it. In practice this means deleting or substantially simplifying:

- `islandCssMap` and `rebuildIslandCssMap()`
- `configureIslandCssServer()`
- virtual `.css` dev serving for island page/layout CSS
- adapter-generated `__cssPaths` maps and render-time `<link rel="stylesheet">` injection
- source-scanning helpers used only for dev FOUC mitigation, such as `fileHasCssImports()` and `extractCssImports()`

Island import-attribute transforms, island manifest generation, island client entry generation, hydration strategy code, and markdown island integration remain in place. Production may still need explicit island build inputs until the ordered manifest traversal fully owns island CSS.

For generic manual SSR, Void does not know route roots beyond the client entry. See "Manual SSR" below.

This should fix the core Pages-mode and island dev FOUC for normal page and layout CSS imports, SFC styles, CSS modules, preprocessors, island component CSS, markdown island CSS, and CSS imported by statically imported nested components.

### Graph Crawl

The collector should prefer transform metadata over broad `importedModules` traversal:

- For client graph traversal, use ordered static import edge metadata only. In Vite 8 this means an explicit Void-maintained ordered static edge map, seeded from `EnvironmentModuleNode.staticImportedUrls` when available and filled by Void's own transform-time capture when it is unavailable or incomplete. Do not use broad `importedModules` traversal in the client graph.
- `transformResult.deps` is not sufficient as the normal client import-analysis static edge list. It can be used only in environments where it is known to represent static dependencies for the node being walked.
- In legacy SSR compatibility paths, use `ssrTransformResult.deps` only for SSR/module-runner nodes where it represents the server transform's static imports.
- Treat `dynamicDeps` conservatively. Do not blindly include every dynamic dependency from a route root. Include dynamically imported modules only if they were actually loaded as part of the SSR shell and are present as loaded graph roots.
- Do not fall back to `importedModules` for client CSS discovery. `importedModules` can include literal dynamic imports, which would over-include route CSS and reintroduce the bug this RFC is meant to avoid.

This matters because dev module graphs can include dynamic imports that are not part of the initial render. Pulling all dynamic CSS into every page would hide FOUC but over-include route CSS and make dev behavior diverge from production.

Traversal must be deterministic. Do not use unordered parallel recursion to decide final CSS order. The collector should process explicit root phases in order and use first-seen deduplication:

1. pages client entry static graph
2. root layout to leaf layout roots
3. active page root
4. optional SSR/worker-loaded roots that are known to be part of the initial shell

Within each root, walk static dependency URLs in the order recorded in Void's ordered static edge map. Use cycle protection, but keep traversal sequential enough that CSS insertion order cannot depend on promise scheduling.

The ordered static edge map is a required implementation piece, not an optional fallback. It should be populated before the CSS collector is used:

- Add a Void dev-only Vite plugin that runs after framework/SFC transforms and before or alongside Vite import analysis, using `enforce: 'post'` unless implementation proves a more precise order is needed.
- Capture static imports from the transformed client code that Vite will serve to the browser. This is the source of truth for nested component CSS discovery.
- Seed from Vite's `staticImportedUrls` when present, but do not depend on it being present for virtual modules, Vue/Svelte SFC submodules, CSS modules, or plugin-transformed modules.
- Resolve every captured static import through the client environment resolver before storing it. Raw specifiers are not valid graph keys.
- Normalize stored edges to Vite client module URLs that `server.environments.client.moduleGraph.getModuleByUrl()` can resolve. Resolution must preserve aliases, bare imports, extension resolution, virtual module IDs, query strings, hashes, and SFC style queries.
- Store map keys using the same normalized client environment URL/id convention as the graph lookup path. Add tests for relative imports, aliases, bare imports, extensionless imports, virtual modules, query/hash-bearing imports, Vue/Svelte SFC style modules, CSS modules, and plugin-added imports.
- Preserve source order. Dynamic imports must be tracked separately or ignored for first-paint CSS.
- Store the map by normalized client environment module URL/id and invalidate entries on transform invalidation, HMR invalidation, and route structure changes.
- Add unit fixtures for plain JS/TS, React/Solid TSX, Vue SFC, Svelte SFC, CSS modules, virtual modules, and literal dynamic imports.

Pseudo-code:

```ts
async function collectDevCss(server, environmentName, rootPhases, loadInlineCss) {
  const environment = server.environments[environmentName];
  const graph = environment.moduleGraph;
  const seen = new Set();
  const cssUrls = [];
  const seenCssUrls = new Set();

  async function addByUrl(url) {
    await environment.transformRequest(url);
    const node = await graph.getModuleByUrl(url);
    if (node) await visit(node);
  }

  async function visit(node) {
    if (seen.has(node)) return;
    seen.add(node);

    if (isCssRequest(node.url) && !hasViteCssBypassQuery(node.url)) {
      if (!seenCssUrls.has(node.url)) {
        seenCssUrls.add(node.url);
        cssUrls.push(node.url);
      }
      return;
    }

    const staticUrls = getOrderedStaticImportUrls(node);
    if (!staticUrls) {
      return;
    }

    for (const dep of staticUrls) {
      await addByUrl(dep);
    }
  }

  for (const roots of rootPhases) {
    for (const root of roots) {
      await addByUrl(root);
    }
  }

  const styles = [];
  for (const url of cssUrls) {
    styles.push(await loadInlineCss(url));
  }
  return styles;
}
```

`loadInlineCss()` in this pseudo-code is implemented by the Node-side dev asset provider described in "Inline CSS Loading" below. The implementation must not require adapter runtimes or the Cloudflare workerd runtime to import or hold a Vite server instance.

`getOrderedStaticImportUrls(node)` must not read `node.importedModules` in the client graph. It should use the Void-maintained ordered static edge map. For SSR/module-runner nodes only, SSR transform `deps` may be used as an additive SSR-root signal, not as the default client graph strategy.

If a client node has no static edge metadata, the collector should stop at that node rather than traverse broad edges and should emit a dev diagnostic that identifies the missing edge-map entry. Under-including uncertain dynamic CSS is preferable to over-including unrelated route CSS, but missing static metadata for page/layout roots or their static children is a collector bug to cover with tests.

Deduplication should keep the first occurrence and never reorder existing CSS.

### Inline CSS Loading

CSS discovery and inline CSS evaluation are separate:

- Discovery should happen in the client environment graph for browser CSS correctness.
- CSS bytes should come from the client environment transform result, because client Vite plugins, resolver conditions, and CSS transforms are the browser source of truth.
- Evaluation/parsing should happen inside the Node-side dev asset provider, not inside the Cloudflare workerd runtime or adapter runtime packages.

To load a CSS URL:

1. Append `inline` safely with `URLSearchParams`, preserving any existing query and hash. Do not use string replacement that can corrupt query ordering or duplicate `inline`.
2. Call `server.environments.client.transformRequest(inlineUrl)` and treat that client transform output as authoritative.
3. Extract the default CSS string from the exact Vite CSS inline JS module shapes that Vite emits (`export default <json-string>` or `__vite__css = <json-string>`). This helper must reject arbitrary JS and must be covered by unit tests.
4. Do not prefer `server.ssrLoadModule()` or an SSR/module-runner environment for client CSS bytes. An SSR runner path may only be added later if tests prove equivalence for environment-specific plugins, resolver conditions, preprocessors, CSS modules, and SFC style modules.

The provider returns structured CSS records, not only strings:

```ts
type DevCssAsset = {
  url: string;
  css: string;
};
```

HTML serialization turns those records into `<style data-void-dev-css="...">...</style>` tags after escaping.

### HTML Injection

Development should inline CSS:

```html
<style data-void-dev-css="/pages/layout.vue?vue&type=style&index=0">
  ...
</style>
```

Reasons to inline in dev:

- It avoids an extra render-blocking request for every CSS module.
- It uses Vite's `?inline` path, so the CSS is still processed by Vite.
- It matches SvelteKit's proven approach.
- It avoids depending on synthetic CSS URLs for every adapter.

The `data-void-dev-css` attribute should be stable and include the source URL for debugging and deduplication.

Inline CSS must be serialized safely:

- Escape `</style` boundaries so user CSS cannot terminate the style tag.
- Escape the `data-void-dev-css` attribute.
- Preserve source URLs in a stable form for debugging.
- Generate a per-response dev style nonce whenever dev CSS is inlined. Add it to each generated `<style>` tag.
- In development only, adjust HTML response `Content-Security-Policy` headers so generated inline styles are allowed. If a response has `style-src`, `style-src-elem`, or `default-src` without a compatible nonce/`unsafe-inline`, append the generated quoted nonce source expression `'nonce-<value>'` to the applicable style directive. If only `default-src` exists, add or update `style-src` so styles are allowed without relaxing unrelated directives.
- Preserve production CSP unchanged.
- Add tests for responses with no CSP, `style-src 'self'`, `style-src-elem 'self'`, `default-src 'self'`, an existing nonce, and report-only CSP if supported.

### Ordering

The Vite-side collector should be connected through an internal dev asset provider.

Recommended approach:

1. Keep `handlePageGet()` and adapter renderers free of direct Vite server dependencies.
2. Generate source module id maps (`componentModuleIds` / `layoutModuleIds`) alongside `components` and `layoutTree`.
3. In dev, have Vite-side infrastructure derive the active page and layout roots from the route/component id.
4. Collect CSS from the client graph for those roots and from `virtual:void-pages-client`.
5. Optionally merge CSS from SSR/worker-loaded route roots when those roots are known.
6. Inject or provide `assetTags.css` before the first HTML head is emitted.

The chosen bridge is:

- **Internal dev asset provider**: a Vite-side provider computes `assetTags.css`, and the generated route module calls it through a dev-only bridge before rendering. This keeps injection before render without post-processing HTML, preserves the existing asset-tags flow, and avoids giving adapter runtime packages direct access to Vite internals.

The provider bridge must be concrete:

- The Vite plugin installs a Node-side internal HTTP/RPC endpoint, for example `POST /__void/dev/pages-css`, during `configureServer()`.
- The endpoint is registered before the Cloudflare worker fallback so workerd requests to that path are handled by the Node Vite server, not by the generated app.
- The endpoint should also be reachable through an internal origin that bypasses user routing when possible, for example the Vite dev server origin plus the reserved path. The generated worker call must use this internal URL, not an arbitrary user URL that can be rewritten into the app.
- A server-only virtual module, for example `virtual:void-pages-dev-assets`, is imported by the generated route module in dev only. This virtual module does not access Vite internals directly. It calls the internal endpoint with a dev-only bearer token and a JSON body containing the component id plus ordered source roots.
- The token is generated per dev-server process and embedded only in server/worker code, never in client bundles.
- The token-bearing virtual module must be environment-gated. Its `resolveId`/`load` hooks must reject the client environment, and direct browser requests such as `/@id/virtual:void-pages-dev-assets` or `/@id/__x00__virtual:void-pages-dev-assets` must not return token-bearing code.
- Client imports of the dev asset module should fail with a clear dev error. Server/worker imports should resolve normally.
- The endpoint validates the token, rejects non-POST requests, and returns `DevCssAsset[]` plus explicit non-HTML metadata only. It must not return pre-rendered `<style>` tags.
- The generated route response builder owns per-response nonce generation, `<style>` tag serialization, and CSP header adjustment so the nonce in the tags and the nonce in the `Content-Security-Policy` header always match.
- The virtual module adds a non-recursion guard header, for example `X-Void-Dev-Asset-Request: pages-css`. The endpoint rejects requests missing the guard header, and the generated route/app must not handle this reserved path.
- The virtual module uses a short timeout. If the endpoint is unavailable, returns 401/403, times out, or throws during transform, the page render must continue with `css: ""` so Vite's normal client-side CSS injection still works. In dev, Void should log or surface a warning/error overlay with the collection failure, but it must not recurse, hang, or turn every page into a 500 unless the user explicitly enables strict dev asset failures.
- Production builds must not import the virtual module or include the endpoint/token path.

This makes the Cloudflare path explicit: generated route code running in workerd reaches the Node-side provider via an internal same-origin HTTP request before rendering the head. Node targets can either use the same internal endpoint for parity or call the same provider function directly from their dev middleware, but the generated route module should keep the same narrow abstraction.

This fixes the current ordering problem, where `handlePageGet()` asks for assets before render-time imports have happened.

An alternate approach is to make the route compiler pass precomputed source roots to `getPagesAssetTags()` and have it transform those roots before rendering. This is simpler, but it must still be Vite-side and client-graph-aware. A collector bolted only onto the existing generated `getPagesAssetTags()` function would preserve the current ordering bug if it cannot access the client module graph and transformed route roots.

A render-aware approach is more correct and closer to how SvelteKit works: collect CSS after the modules needed for the route are known, while keeping the Vite server dependency in Vite-side infrastructure.

CSS behind render-time dynamic imports, Suspense boundaries, or lazy components may still require careful handling. React streaming SSR is the sharpest case because Void must know the CSS before the first head chunk is sent, while some components may not be loaded until render work has progressed.

For the first implementation:

- Target static page/layout/nested component CSS and SFC styles.
- Do not claim full support for arbitrary lazy/Suspense CSS.
- In dev, buffering until the head CSS is known is acceptable if needed. Correct first paint is more important than preserving React streaming micro-optimizations in development.
- Keep production streaming behavior unchanged.

## Manual SSR

Manual SSR has a different boundary.

Void can discover assets for the configured client entry. It cannot reliably infer every route-level client asset in arbitrary user SSR code. If a manual SSR app has route-level lazy components whose CSS is not statically reachable from `src/main.client.ts(x)`, production can also miss first-paint CSS.

This RFC does not propose solving that fully. The likely future direction is an explicit SSR asset API:

```ts
export default defineRender(async (c, assets) => {
  const routeAssets = await assets.forModules(['/src/routes/home.tsx']);
  return html(routeAssets);
});
```

That API should wait until the internal dev collector and production manifest lookup model are stable.

## HMR, Caching, and Invalidation

For CSS edits, Vite's client HMR will still update the page after hydration. The important improvement is that a fresh document request should receive updated inline CSS without restarting the dev server.

Because the dev asset provider is on the critical path before the first HTML byte, the first implementation should include a bounded provider cache rather than re-walking and re-serializing on every document request. The only acceptable reason to defer the cache is measured warm-graph performance below the threshold below.

Cache requirements:

- Key by ordered root phases, normalized source roots, and a client graph invalidation/version token.
- Include the current static-edge-map version and a digest of CSS asset URLs in the key or value.
- Invalidate on page/layout changes, CSS file changes, static-edge-map updates, Vite graph invalidation, route structure changes, and dependency optimizer restarts.
- Bound memory with an LRU size cap, for example 100 route entries or a small byte cap, whichever is hit first.
- Cache structured CSS records before HTML serialization so each response can still get its own CSP nonce.
- If implementation proves per-request collection is already below a strict threshold, for example p95 under 5 ms on warm graph for representative playgrounds, the cache may be deferred, but that threshold must be measured and documented in tests or benchmark output.

## Production

Pages mode production should remain manifest-based:

- keep `PAGE_CSS_KEYS`
- keep route-scoped manifest walking
- keep stylesheet links instead of inline CSS

This is already the correct shape. If production FOUC exists in Pages mode, it is more likely a bug in route key generation, manifest traversal, or adapter build inputs than the same dev-only issue described above.

## Alternatives Considered

### Keep relying on Vite client CSS injection

This is the current behavior and causes FOUC.

### Source-code regex extraction

This is too fragile. It cannot faithfully model Vite CSS handling and will miss framework/plugin-generated CSS.

### Synthetic dev CSS links per source file

This is the current island direction. It can work for simple imports but requires adapter-specific virtual CSS modules and does not naturally cover all CSS discovered by Vite's transform graph.

The shared collector should replace this path for island pages. Keeping both systems would create duplicate ordering, CSP, HMR, and cache invalidation surfaces.

### Crawl the entire app graph at startup

This conflicts with Vite's on-demand model and makes dev startup slower. It also includes CSS for routes that are not needed for the current page.

### Wait for a stable Vite assets metadata API

Void should track the RFC, but users need a fix now. The internal collector can later be replaced or simplified if Vite ships a framework asset primitive.

## Risks

- Environment API differences may make module graph access target-specific.
- Over-including dynamic CSS can make dev differ from production.
- Under-including CSS from lazy SSR modules can leave some FOUC.
- Inline CSS can duplicate CSS that Vite later injects on the client.
- React streaming SSR needs careful handling so head CSS is known before the first chunk is sent.
- Collecting inside the existing `getPagesAssetTags()` path alone would preserve the current ordering bug and should be avoided.
- Removing the current island virtual CSS path changes a pre-release implementation detail across all four adapters, so the rollout must include framework-specific island tests rather than relying only on Pages tests.

## Implementation Plan

1. Add a shared dev CSS collector in `packages/void/src/pages/`.
2. Design the collector API around explicit ordered root phases so both Pages and islands can call it without adapter-specific CSS discovery.
3. Update virtual Pages and island renderer generation to emit source module id maps, for example `componentModuleIds`, `layoutModuleIds`, named layout module ids, island component module ids, and markdown client script roots where applicable.
4. Fix production route CSS key order if needed so production and dev both apply root layout to leaf layout to page cascade ordering.
5. Replace production manifest CSS walking with ordered phase traversal matching dev root phases and Vite/Rollup import order where the manifest exposes it.
6. Implement the required ordered static edge capture plugin for the client graph.
7. Resolve captured static imports through the client environment and normalize them to graph-resolvable client URLs.
8. Implement an internal dev asset provider bridge for Cloudflare dev and node targets, backed by a Node-side authenticated internal endpoint with timeout and non-recursion handling.
9. Environment-gate the token-bearing virtual module so client requests/imports cannot retrieve it.
10. Implement bounded provider caching or measure and document warm-graph p95 under the accepted threshold before deferring cache.
11. Collect `virtual:void-pages-client` CSS through the client dev graph as a separate pass using static edge metadata only.
12. Collect active page/layout CSS through the client dev graph using generated source module id maps and static edge metadata only.
13. Collect island page, island layout, island component, markdown client script, and conditional island client entry CSS through the same collector using island-specific ordered root phases.
14. Remove the island-specific dev CSS workaround: `islandCssMap`, virtual source-file `.css` dev serving, adapter `__cssPaths` injection, and source regex extraction that only existed to feed dev FOUC CSS links.
15. Keep production island build inputs only where still required to get island CSS into the manifest, but route production CSS emission through the same ordered manifest traversal model as Pages.
16. Optionally merge CSS from SSR/worker-loaded route roots when the bridge can identify them without adding runtime Vite dependencies.
17. Inject or provide dev `assetTags.css` before every HTML head is emitted, with per-response nonce generation and dev CSP header adjustment, without changing production output beyond the explicit ordering fix.
18. Add unit tests for graph traversal, deterministic ordering, deduplication, CSS URL filtering, ordered static edge capture, client-environment edge resolution/normalization, inline URL creation, inline CSS module extraction from client transform output, bridge request validation, timeout/fallback behavior, token module environment gating, CSP adjustment, cache invalidation, safe style serialization, and island root phase generation.
19. Add integration tests that assert initial SSR HTML contains dev CSS for:

- page CSS import
- layout CSS import
- Vue/Svelte SFC style block
- CSS module
- nested component CSS imported by an SSR-loaded component
- island page CSS import
- island layout CSS import
- island component CSS imported with `with { island: ... }`
- markdown island CSS and markdown client script CSS where applicable
- island pages with no hydration JavaScript

20. Add regression tests that assert:

- unrelated route CSS is not included
- CSS from literal dynamic imports is not included unless the module participated in the SSR shell
- layout/page cascade order is deterministic
- a fresh document request receives edited CSS after HMR invalidation
- dev HTML contains inline CSS before app/client scripts
- production output remains manifest-linked and not dev-inlined
- island dev HTML does not include duplicate CSS from both the old virtual CSS link path and the new inline collector path
- island production output remains manifest-linked and includes the route/island CSS needed for first paint
- direct client requests for the dev asset virtual module do not expose the bearer token
- strict dev CSP responses such as `style-src 'self'` still allow generated inline dev CSS through nonce/header adjustment
- cached CSS records are reused on warm requests and invalidated after CSS/static edge changes
- endpoint unavailability, invalid token, and transform failure fall back without recursion or request hang
- validation/action error HTML responses from `handlePageMutation()` include the same dev CSS as GET renders
- post-mutation HTML rerenders include the same dev CSS as GET renders
- error HTML generated from Pages render failures includes available layout/client CSS where possible, or falls back without blocking the error response

21. Test both the default Cloudflare dev target and a node target.
22. Run relevant package tests with `vp test run packages/void packages/react packages/vue packages/svelte packages/solid`.
23. Run `vp run check`.

## Open Questions

- Should manual SSR get an experimental private `assets.forModules()` API in a later implementation cycle?
