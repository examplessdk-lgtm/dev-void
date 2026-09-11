---
title: URL Rewrites
status: draft
created: 2026-04-14
---

# URL Rewrites

## Context

Void supports URL redirects (3xx) at the edge but not URL rewrites (status 200). A rewrite serves content from a different internal path without changing the browser URL. This is a fundamental routing primitive that unlocks several real-world patterns:

### Motivation

**i18n routing without route duplication.** The primary motivator. With locale-based routing (`/en/docs`, `/zh-CN/docs`), the default locale should be accessible without a prefix (`/docs`). Without rewrites, developers must duplicate every route file under both the root and a `[locale]/` directory. Rewrites let them define routes once under `[locale]/` and map the root paths to the default locale internally.

**Clean URL restructuring.** When reorganizing a site's internal route structure (renaming directories, splitting a monolithic `pages/` tree into feature folders), rewrites let you keep the public-facing URLs stable while the internal file layout evolves. Unlike redirects, the URL doesn't change — no SEO impact, no broken bookmarks, no flash of a different URL.

**Vanity URLs and marketing paths.** Map short, memorable paths (`/pricing`, `/start`) to longer internal routes (`/marketing/pricing-page`, `/onboarding/get-started`) without exposing implementation details in the URL bar.

**API versioning transparency.** Route `/api/users` to `/api/v3/users` internally, so consumers use clean unversioned endpoints while the server-side code is organized by version. Bump the rewrite when a new version ships — no client-side changes needed.

**Incremental migration.** When migrating from one route structure to another (e.g., moving from `/blog/:slug` to `/posts/:slug`), rewrites let the old URLs continue working at the edge level without the user seeing a redirect bounce, while the actual route handlers live at the new paths. This is especially useful during phased rollouts where both structures need to coexist.

**Micro-frontend / multi-app composition.** Serve different internal apps under a unified URL namespace. For example, `/docs/*` could rewrite to a separate documentation app's routes while `/app/*` maps to the main application — all behind a single domain.

## Framework wire contract

The platform depends on the framework emitting a specific manifest wire shape for routing rules: `redirectRules` / `fallbackRules` with `{ source, destination, status }` entries, no `force` field. `force` lives on the internal `DevRedirectRule` in the framework and is stripped by the CLI before serialising; the public `RedirectRule` does not carry it. When bumping the submodule, verify the framework's `packages/void/src/cli/types.ts` `RedirectRule` / `DevRedirectRule` contract has not changed without a corresponding platform update. `packages/dispatch/test/unit/framework-contract.test.ts` pins the wire shape on the platform side so silent drift shows up as a typecheck failure.

## Design

Rewrites use the existing `RedirectRule` type with `status: 200`. The deploy manifest splits routing rules into two fields so dispatch does not have to reason about per-rule phase flags at the edge:

- `redirectRules` (pre-asset) — all 3xx redirects plus status-200 "force" rewrites from `routing.rewrites` or `_redirects` `200!` entries. Evaluated before static-asset resolution and worker dispatch.
- `fallbackRules` (post-resolution) — plain status-200 entries from `routing.fallbacks` or `_redirects` `200` lines. For static/SPA deployments, evaluated only when the static-asset resolver would otherwise 404. For WfP/framework deployments, evaluated only when the first user-worker dispatch returns 404.

Last-match-wins applies within each list. Interleaved ordering from `_redirects` files is preserved within the pre-asset array; the post-asset array is its own independent pass.

The `void.json` config has separate `routing.rewrites` and `routing.fallbacks` keys for DX clarity:

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs/*": "/en/docs/:splat"
    },
    "fallbacks": {
      "/*": "/index.html"
    }
  }
}
```

Rewrites can also use the `_redirects` file with status `200`:

```text
/docs/* /en/docs/:splat 200!   # pre-asset "force" rewrite → redirectRules
/*      /index.html      200   # post-asset fallback (SPA shell) → fallbackRules
```

The `!` suffix is the framework-internal hint that routes the rule into `redirectRules` (pre-asset) rather than `fallbackRules` (post-asset); see the parsing note under "Files changed" below.

### How rewrites differ from redirects

- Redirects return a `Location` header and short-circuit the request pipeline.
- Rewrites modify the request pathname and continue through the normal pipeline (static assets, ISR, worker dispatch). The browser URL does not change.

### Pattern syntax

Patterns support named captures as well as legacy splat:

| Syntax       | Matches                      | Captured as |
| ------------ | ---------------------------- | ----------- |
| `:name`      | one path segment (`[^/]+`)   | `name`      |
| `:name*`     | zero or more segments (`.*`) | `name`      |
| `*` (legacy) | zero or more segments (`.*`) | `splat`     |

Destination substitution works via `:name` / `:name*` tokens. The anonymous `*` is internally captured as `splat`, so existing `:splat` destinations keep working. Named captures let patterns re-slot more than one segment (e.g., `/blog/:author/:slug` → `/articles/:author/:slug`), which a single anonymous capture cannot express. Named parameters also lay the groundwork for typed route codegen later.

The compiled matcher lives once, in `packages/dispatch/src/headers.ts#compilePattern`, and is mirrored inline by the framework's node-target emitter. When a pattern contains `*` in the middle (e.g., `/blog/*/x`), the captured splat is what actually matched the `*`, not "everything after the prefix" — the regex match is authoritative.

### Phases: `rewrites` vs `fallbacks`

`routing.rewrites` fires _before_ route/static resolution: the pathname is rewritten, then the request continues into the normal pipeline.

`routing.fallbacks` fires _after_ the platform's primary resolver misses — for "if nothing else matched, rewrite to X" patterns (SPA shells, default-locale catch-alls, migration fallbacks). For static/SPA deployments the primary resolver is the dispatch static-asset resolver; for WfP/framework deployments it is the first user-worker dispatch returning 404. Fallbacks are a distinct phase, not a flag on rewrites, so users don't have to reason about ordering inside a single rule list.

**Scope:** fallbacks are evaluated in dispatch for static/SPA deployments and for WfP/framework deployments. Worker-backed fallbacks are single-pass: dispatch calls the worker once for the requested path, applies the first matching fallback rule only if that response is 404, then returns the fallback target's response as-is even if it is also 404. Node-target self-hosted deploys likewise do not emit fallback middleware, because the generated Hono app already registers `app.notFound()` handlers for its own fallback logic (SSR/pages) and overriding them would be a footgun. This can be revisited if there's demand.

`_redirects` file syntax is unchanged: fallbacks are config-only. Keeping the line format unambiguous (`source destination [status]`) is more valuable than saving users a config block.

### Dispatch edge implementation

`applyRoutingRules()` returns a discriminated union: `{ type: 'redirect', destination, status }` or `{ type: 'rewrite', destination }`. For pre-asset rewrites, the dispatch worker updates `pathname` and `url.pathname`, then continues the request lifecycle. The rewritten pathname is used for static asset resolution, ISR cache lookup, and worker dispatch. For worker-backed fallback rewrites, the first worker response must be 404 before dispatch reissues the request to the fallback destination with `X-Void-Original-URL` preserved or set to the client URL.

### Node / CF-dev target implementation

The compiled Hono middleware handles both redirects and rewrites in a single pass. Rewrites use `app.fetch()` re-dispatch, with a module-level `WeakMap<Request, URL>` tracking the re-dispatched Request identity to prevent infinite loops. The WeakMap doubles as loop guard and pre-rewrite-URL storage: key presence short-circuits re-entry, and the stored `URL` is what `c.originalUrl()` returns.

Loop prevention is a framework-runtime concern only: Node/Bun/Deno targets re-enter the app via `app.fetch()` on a rewrite, so they need the guard. The same compiled middleware also runs on the Cloudflare target during `vite dev` (dispatch is absent locally), giving full dev-prod parity for static routing rules — see "Dev-prod parity" below. At the dispatch edge, rewrite evaluation is single-pass — a matched rewrite mutates `url.pathname` and continues through the same lifecycle without re-evaluating routing rules — so no loop guard is required.

### Middleware `rewrite()` helper and context methods

For dynamic rewrite logic (i18n locale negotiation, feature flags, etc.), rewrites are available as methods on the Hono context:

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (c.isRewritten()) return next();
  const locale = detectLocale(c.req);
  if (!hasLocalePrefix(c.req.path)) {
    return c.rewrite(`/${locale}${c.req.path}`);
  }
  return next();
});
```

- `c.rewrite(path)` — rewrite to an internal path.
- `c.originalUrl()` — returns the pre-rewrite `URL` (from the WeakMap, seeded either by dispatch's `X-Void-Original-URL` header at ingress or by the framework's own `c.rewrite()` re-dispatch) or `null`.
- `c.isRewritten()` — returns whether the current request was reached via a rewrite. Implemented as WeakMap key presence; at ingress the framework reads any `X-Void-Original-URL` header into the WeakMap once, so dispatch-applied static rewrites and framework `c.rewrite()` re-dispatches are observed identically.

Implementation: compiled routes inject a `__rewrite` closure into Hono context variables. The closure has access to `app` and calls `app.fetch()` with a new Request (rewritten pathname + `X-Void-Original-URL` set to the pre-rewrite URL), and records the new Request in the module-level WeakMap before dispatching. The context methods are attached per-instance in the same middleware that wires `__rewrite`, so they only exist on Void-managed contexts at runtime. (Vanilla Hono contexts and mounted sub-apps in the same dep graph hit a runtime `TypeError` when calling `c.rewrite`/`c.originalUrl`/`c.isRewritten`; a type-level `CloudEnv` scope was considered and not shipped.)

### `X-Void-Original-URL` header

When a static rewrite rule matches at the edge, the dispatch worker sets `X-Void-Original-URL` on the request forwarded to the user worker. This is the wire handoff `c.originalUrl()` is seeded from; middleware can also access the raw header directly if needed.

Dispatch strips any client-supplied `X-Void-Original-URL` on ingress before applying routing rules, so the header is always dispatch-authored by the time it reaches the worker. The framework's compiled rewrite middleware reciprocates: it only reads the inbound header on the CF production target — the one configuration where dispatch is known to be upstream. On CF `vite dev` (no dispatch in front of the miniflare worker) and on node/bun/deno self-hosted targets (user owns ingress), the framework compiles out the header-read entirely, so a client-spoofed `X-Void-Original-URL` cannot influence `c.originalUrl()` / `c.isRewritten()`. Internal `c.rewrite()` re-dispatches seed the WeakMap directly on the re-issued Request and never depend on the header-read path, so the guard never breaks rewrite flow.

### Query preservation on redirects

Redirects preserve the request's query string. `applyRoutingRules` returns `{ type: 'redirect', destination, status }` and the caller (dispatch `index.ts` and the compiled Hono middleware) builds the `Location` header with the request's query merged into the destination via `packages/dispatch/src/routing-rules.ts#mergeQueryIntoLocation`.

Merge semantics: if the destination contains `?`, its parameters take precedence on per-key conflict; otherwise the request's query is appended verbatim. No opt-out flag — users who genuinely need to drop query can write the destination with an explicit `?` reset.

Rewrites already preserve query since only `url.pathname` is mutated.

### Constraints

- **Status code allowlists.** `redirectRules` accepts `[200, 301, 302, 303, 307, 308]` — 200 is a pre-asset "force" rewrite, the 3xx values are redirects. `fallbackRules` accepts `[200]` only — fallbacks are rewrites by definition. 303 was added alongside the shared framework/platform status allowlist so OAuth-style `POST → 303 → GET` flows can be expressed at the edge. Both lists are enforced at config validation in the framework and again on manifest ingest in `packages/api/src/routes/deploy.ts`.
- Only internal paths (starting with `/`) are supported as rewrite destinations. External URLs are rejected at config validation time and at the API on manifest ingest (`redirectRules` with `status: 200` and all `fallbackRules` entries must have a path-absolute `destination`).
- Rewrite and fallback destinations must not contain a query string — rejected at config validation time.
- Single-pass evaluation within each phase: a rewritten path is not re-evaluated against the same phase's rules. A request can still traverse both phases in one trip — pre-asset `redirectRules` (possible rewrite) → static asset resolution → post-asset `fallbackRules` (possible rewrite) — but each phase evaluates its own list exactly once; neither re-runs.
- Middleware rewrites run inside the worker (not at the edge). Use static `routing.rewrites` for zero-cost edge rewrites.
- **Rollback is not transparent once status-200 entries are in flight.** `redirectRules` with `status: 200` (force rewrites) are accepted by dispatch from this release forward, but a pre-rewrites dispatch interpreting the same entry would try to build a `Location` response with HTTP 200 — broken, not crashing. Rolling dispatch back to a pre-rewrites build while projects still have 200-status `redirectRules` in their KV routing entry will serve malformed redirects on matching paths until the rules are removed or dispatch rolls forward. Fallbacks are safer: old dispatch parses routing entries via `JSON.parse` and silently ignores the unknown `fallbackRules` field.

### Two-phase traversal + cross-system loop guard

A single request can be rewritten twice if it first matches a pre-asset `redirectRules` entry, then misses the static resolver, and then matches a `fallbackRules` entry. This is not a loop — each phase is a distinct list with its own single-pass evaluation — but it means `X-Void-Original-URL` can be set by a rule in the first phase and then preserved (not overwritten) if a rule in the second phase also rewrites.

Between dispatch and the framework there is one more loop-guard concern. Framework-side middleware (`c.rewrite()`) re-dispatches via `app.fetch()` with `X-Void-Original-URL` set on the new Request; the framework's module-level WeakMap tracks the Request identity to break re-entry. The framework middleware also checks `if (!rewriteReq.headers.has('X-Void-Original-URL'))` before setting the header on its re-dispatched Request, so a request that dispatch already rewrote at the edge arrives at the worker with the dispatch-set header and is not re-rewritten by the framework layer on top of it. This keeps the two systems composable without a shared in-process state channel — the header is the handoff.

### Dev-prod parity

On the framework's CF target, static routing rules (`routing.rewrites`, `routing.redirects`, `routing.fallbacks`) are applied by dispatch in production. In `vite dev` there is no dispatch in front of the worker, so the framework compiles the same rules into the worker's Hono middleware whenever `options.dev === true`, regardless of target. This gives full dev-prod parity for static routing rules on CF, node, bun, and deno: the rules fire locally, `X-Void-Original-URL` is set on rewrites, and `c.originalUrl()` / `c.isRewritten()` reflect them. `c.rewrite()` middleware and `c.redirect()` run inside the user worker and are parity-preserving by construction.

Caveat: the dev-mode middleware runs the rules inside the user worker rather than at an edge hop, so behaviors that depend on dispatch specifically (asset-miss ordering, ISR cache variant keying, metering, etc.) are still only exercised end-to-end in production or against staging.

### Interaction with header rules

Header rules are evaluated against the post-rewrite pathname — the same path used for static asset resolution and worker dispatch. If a pattern like `/docs` is rewritten internally to `/en/docs`, a header rule with `pattern: '/docs'` will not match; the rule should target the destination pattern (`/en/docs`) instead. This keeps the header-rules model stateless and consistent with how the request is actually served.

### Interaction with ISR caching

ISR cache slots are keyed per (deployment, pathname, `X-Void-Original-URL`). User code can branch on `c.isRewritten()` / `c.originalUrl()` to vary rendered output, so a direct hit to `/en/docs` and a rewrite from `/docs → /en/docs` must not share a cache slot. Both the edge cache URL (`caches.default`) and the R2/KV key include a variant suffix derived from the original request URL when the request was dispatch-rewritten; direct hits use the unsuffixed key.

Fallback rewrites participate in the same variant key even though they are discovered later in the request lifecycle. On an ISR-eligible path that matches `fallbackRules`, dispatch computes the fallback original-URL variant before the ISR lookup and uses that variant for both read and write. This avoids writing fallback-rendered HTML under the direct key: the fallback dispatch sends `X-Void-Original-URL` to the user worker, and allowlisted query params may legitimately change the rendered body. The tradeoff is conservative variant keying for a direct worker 200 on a path that also matches a fallback pattern; query fanout remains bounded by `revalidateQueryAllowlist` and the per-path ISR variant cap.

The key prefix ships as `v2` (`<projectId>/isr/v2/<deploymentId>/…`) to accommodate the new format. Pre-rewrite entries were written under an unversioned prefix (`<projectId>/isr/<deploymentId>/…`) — the new dispatch reads only the `v2/` prefix with no legacy fallback, so every pre-existing entry is unreachable on the first deploy after this feature rolls out. That's a clean, one-shot cutover rather than a migration: the stranded entries expire naturally via their existing TTLs (and their deployments age out), and production sees a one-time cache-miss wave on every path proportional to traffic × TTL as the `v2` slots warm up. A future incompatible format change would bump to `v3` the same way — do not remove the version prefix as "dead weight."

Only dispatch-phase rewrites (`routing.rewrites`, `routing.fallbacks`, and `_redirects` status-200 entries) contribute to the variant key. Middleware-phase `c.rewrite()` calls do set `X-Void-Original-URL` on the re-dispatched Request — that header is the handoff both dispatch and the framework use, so `c.originalUrl()` / `c.isRewritten()` observe middleware rewrites exactly the same way they observe dispatch rewrites (`packages/void/src/router/compile.ts`, the `c.rewrite` closure and the compiled static-rewrite middleware both write the header on the re-issued Request when one is not already present). The reason middleware rewrites don't split the ISR slot is timing, not header participation: ISR cache resolution runs in dispatch before the request enters the user worker, so the cache layer has already committed to the pre-middleware pathname by the time `c.rewrite()` fires. The re-dispatched request therefore reads and writes the slot dispatch handed in, not a new variant — branching on `c.isRewritten()` inside a middleware-rewritten render won't split the cache the way a dispatch rewrite would. Users who need per-rewrite cache isolation should express the rule in `routing.rewrites` / `routing.fallbacks` rather than in middleware.

Revalidation (`POST /projects/:id/revalidate`) purges every variant of the requested path: the direct-hit key is deleted by name, and every `<path>#rw=<token>` variant is scanned and deleted. Edge cache URLs for each observed variant are reconstructed from the decoded token so the CF cache purge covers them too. `body.all` scans every variant across every deployment namespace in one pass.

Framework docs (`docs/guide/edge/revalidation.md`) call out the shared-slot semantics from the user's point of view — a single `fetch('/api/revalidate', { paths: ['/en/docs'] })` invalidates both direct and rewrite-served copies of `/en/docs`.

## Files changed

- `framework: src/config.ts` -- `RoutingConfig.rewrites`, `RoutingConfig.fallbacks`, validation, `convertRewritesConfig()`
- `framework: schema.json` -- `routing.rewrites` and `routing.fallbacks` schema
- `framework: src/cli/headers.ts` -- accept status 200 in `parseRedirectsFile`; parse `_redirects` `200!` suffix as a framework-internal "force" flag used to route the rule into `redirectRules` (pre-asset) vs `fallbackRules` (post-asset). The shipped manifest does not carry the flag — it is encoded by list identity.
- `framework: src/cli/deploy.ts` -- merge rewrite + fallback rules at deploy paths
- `framework: src/router/compile.ts` -- combined redirect+rewrite Hono middleware for node targets; `c.rewrite` / `c.originalUrl` / `c.isRewritten` wiring
- `framework: src/runtime/handler.ts` -- Hono module augmentation for `c.rewrite` / `c.originalUrl` / `c.isRewritten`, `__rewrite` in `CloudContextVariables`. Scoping to `CloudEnv` was considered (to surface sub-app / vanilla-Hono misuse as a type error) and not shipped; misuse currently produces a runtime `TypeError` at call time.
- `platform: packages/dispatch/src/headers.ts` -- shared pattern compiler (`compilePattern`, `substituteParams`) used by both header rules and routing rules; named `:param` and `:name*` captures
- `platform: packages/dispatch/src/routing-rules.ts` -- `applyRoutingRules()` returns a discriminated union (not a `Response`); `mergeQueryIntoLocation` helper for query preservation on redirects
- `platform: packages/dispatch/src/index.ts` -- handle rewrite result (modify pathname, continue pipeline), set `X-Void-Original-URL` header, apply fallbacks after static miss
- `platform: packages/api/src/routing.ts` -- propagate `fallbackRules` from the manifest into the KV routing entry (alongside `redirectRules`)
- `platform: packages/api/src/types.ts` -- `DeployManifest.fallbackRules` field. Entries in both `redirectRules` and `fallbackRules` are `{ source, destination, status }` — no per-rule phase flag; phase is encoded by which array the rule lives in.

## Considered and rejected

Two adjacent concepts were evaluated and declined. Documenting them here so the same ground isn't re-litigated.

### External rewrite destinations

A tempting generalization would be to allow `/api/* → https://api.example.com/:path*` as a rewrite target, enabling incremental migration and external API composition at the edge.

**Declined because:** the edge router becomes, in effect, an open HTTP proxy configured by user input. Every deployment could fetch arbitrary internet URLs server-side, which expands the SSRF surface (internal-network discovery via cloud metadata endpoints, bypassing of outbound allowlists), complicates egress accounting (bytes billed against the platform, not the user), and removes the current invariant that a request routed via `redirectRules` stays entirely within the tenant's own infrastructure.

Users who need this pattern can write a worker-side handler that performs the outbound fetch under explicit authentication and rate limits. That puts the decision, the credentials, and the cost with the party that actually owns them.

### Conditional matching on cookies/headers/query

Another common generalization is letting static rules gate on request state — "rewrite if cookie `experiment=b`", "redirect unless header `X-Beta` is set", "match only when `?preview=1`".

**Declined because:**

1. **It's already what middleware is for.** Void exposes a `defineMiddleware` handler with full request access plus `c.rewrite(path)`. Anything a conditional static rule could express is expressible as three lines of middleware, with typed access to the request and no new DSL.
2. **Two ways to do the same thing.** Shipping both forces users to learn which one to reach for and creates inconsistencies when the answers diverge (order of evaluation, interaction with caching, debuggability).
3. **Cache-key contamination.** The dispatch worker caches static asset responses per deployment version. Rules that branch on per-request state would need to participate in the cache key — or the cache would serve the wrong variant. Either outcome is worse than keeping the static layer stateless and pushing request-scoped logic one hop in to the worker, where the cache boundary is already handled.

Host-based matching is the one subcase that has independent justification (multi-domain projects). It is already covered implicitly: the KV routing entry is keyed per-hostname, so the rule set for `app.example.com` is different from the rule set for `api.example.com` without any new matching primitive. No change needed.
