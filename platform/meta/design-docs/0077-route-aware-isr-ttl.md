---
title: Route-Aware ISR TTL Resolution (Design + SDD Plan)
status: implemented
created: 2026-07-10
---

# Design 0077 — Route-Aware ISR TTL Resolution

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

Shared design across the framework and platform packages.
Fixes the ISR revalidate-map precedence gap surfaced during PR #228 review:
a catch-all page's TTL can be applied to a more-specific page (or an API route)
that never opted into ISR, because dispatch resolves per-path TTLs from a **flat**
pattern→TTL map that has lost route specificity.

**Lineage:** this refines the ISR stack established in
[0008 (ISR)](./0008-isr.md) and [0020 (deploy-time prerender)](./0020-prerender.md) —
specifically it supersedes the "resolve TTL by matching the path against the flat
`manifest.revalidate`" step (0020 §"Platform-side: rendering") with route-aware
resolution. The persistent store is KV per [0048](./0048-isr-kv-cache.md). The
task-by-task implementation plan is the **Implementation Plan** section at the end
of this doc.

---

## Problem

The deploy manifest ships `routing.revalidate`: a flat map `{ <pattern>: <ttl> }`.
At the edge, `platform/packages/dispatch/src/isr.ts` `resolvePathTtl(revalidate, path)`
returns the TTL of the **first** map pattern that matches `path` (iteration =
insertion order), via `matchSegmentPattern`.

Post-framework-#268, page patterns enter the map as:

| page file                                                            | revalidate key           | matcher               |
| -------------------------------------------------------------------- | ------------------------ | --------------------- |
| `pages/blog/[slug].tsx`                                              | `/blog/:slug`            | one segment (`[^/]+`) |
| `pages/docs/[...path].tsx`                                           | `/docs/*`                | crosses `/` (`.*`)    |
| `pages/docs/setup/install.tsx` **without** `export const revalidate` | _(omitted — not in map)_ | —                     |

A page whose per-page `revalidate` is `undefined` is **omitted** from the map
(`packages/void/src/isr-config.ts` `collectRevalidate`). So for a request to
`/docs/setup/install`:

- the framework worker renders the **specific** page (route specificity: static
  beats catch-all),
- but dispatch's `resolvePathTtl` only sees `/docs/*` in the map → returns the
  catch-all TTL,
- dispatch caches a page that never opted into ISR. Direct ISR keys omit the
  query string, so the first query-dependent 200 can be replayed to later
  requests.

The same class also lets a root catch-all page `/*` (with a TTL) apply to
`/api/*` — an API route the worker would never treat as ISR.

**This is pre-existing** (single-segment overlaps already leaked on the flat map)
and **bounded** (needs an overlapping non-ISR page and no `export const
revalidate = 0` opt-out), but it is real and reachable, and the flat map cannot
express the precedence needed to fix it.

## Non-goals

- Re-deriving the framework's full router in dispatch. We only need to pick the
  **same winning page route the framework worker itself resolves** — achieved by
  mirroring the framework's authoritative route order, not by reinventing a
  specificity ranking (see Prior art).
- Changing ISR semantics for correctly-configured apps. A catch-all page's own
  nested paths **should** get its TTL; that stays true.
- Shipping API route patterns to dispatch. API-route protection is handled by a
  local dispatch guard (Part 2), not by manifest data.

## Prior art (how other frameworks solve this)

Verified against primary sources (Next.js/Vercel, Nuxt/Nitro, SvelteKit, Astro,
Remix/React Router, Gatsby). The universal pattern:

> The request resolves to **one route via specificity-ranked matching**
> (static > dynamic param > catch-all/splat), and the cache/ISR TTL is read off
> **that resolved route**. A catch-all can never shadow a more-specific route
> because the specific route wins the match first. A route with no ISR policy
> simply has no TTL. **Nobody ships a flat `{pattern: ttl}` first-match map to a
> front edge** — that is exactly the bug we have.

- **Next.js/Vercel** — Build Output API `routes[]` is phased; the `filesystem`
  phase resolves the concrete output _first_, and TTL lives per-output in
  `*.prerender-config.json` (`expiration`). `getSortedRoutes` orders static →
  dynamic → catch-all-last. API/static routes are non-prerender outputs → no TTL.
- **Nuxt/Nitro `routeRules`** — the closest analog; also starts from a flat rule
  object, but resolves it with a radix matcher:
  `defu({}, ...matcher.matchAll(path).reverse())` = specificity-**merge**,
  most-specific-wins-per-key. For a **scalar** TTL, merge is equivalent to
  first-match over a specificity-sorted list, so we do not need merge machinery.
  Nitro also has **no** structural API protection — a broad `/**` rule caches
  `/api/**` unless a narrower opt-out exists; this is why Part 2 is required.
- **SvelteKit / Remix / Astro / Gatsby** — each route owns its config; the router
  ranks by specificity (React Router `computeScore`, SvelteKit `sort.js`) before
  reading policy. Per-route, no flat edge map.

**Implications adopted below:** (1) emit `pages` in the framework's own
authoritative resolution order and mirror it in dispatch (do not re-rank), so
dispatch's winner equals the worker's; (2) include ALL pages so a no-TTL specific
page can win over a catch-all; (3) scalar TTL ⇒ first-match-of-sorted suffices.

## Design

### Part 1 — page-shadow fix (framework + platform)

**Framework:** emit a new, optional deploy-manifest
field carrying the **full ordered page-route table** — every page route, whether
or not it has a TTL:

```ts
// packages/void/src/cli/types.ts — DeployManifest
pages?: Array<{ pattern: string; revalidate?: number }>;
```

- Built from `pageScan.pages`, which is **already sorted in the framework's
  authoritative match order** (`packages/void/src/pages/scan.ts` —
  catch-all last, then dynamic, then `localeCompare`) — the same order the
  framework worker's own `matchRoute` (`pages/manifest.ts`) uses to pick which
  page renders. Emit in that exact order. Dispatch MUST NOT re-sort it: mirroring
  the worker's order is what guarantees dispatch resolves the **same** winning
  route the worker will actually render, so the two never disagree on which
  route's TTL applies.
- `pattern` is the same serialized route pattern used for the flat map key
  (`/blog/:slug`, `/docs/*`); `revalidate` is `page.revalidate` (may be
  `undefined`).
- Populated for Void **pages-mode** apps only (where `pageScan` exists). Wired
  through `buildVoidManifest` / `buildFrameworkManifest` in `cli/package.ts`.
- The existing flat `revalidate` map is **unchanged** (kept for old dispatch +
  user-authored `void.json` patterns). The `pages` list is additive and
  redundant with the per-page entries in `revalidate` — that redundancy is the
  price of backward-compat.

**Platform API (`platform/packages/api`):**

- Add `pages` to the manifest type (`src/types.ts`).
- Validate additively in `validateManifestShape` (`src/routes/deploy.ts`) — an
  array of `{ pattern: string, revalidate?: number }`; reject only on a malformed
  shape, never on absence.
- Pass through verbatim into the routing blob in `buildRoutingJson`
  (`src/routing.ts`): `...(manifest?.pages ? { pages } : {})`.

**Platform dispatch (`platform/packages/dispatch`):**

- Add `pages` to `RoutingEntry` (`src/index.ts`).
- New resolver `resolvePageTtl(pages, revalidate, path)` in `src/isr.ts`:

  ```
  if pages present:
    // first-match over the framework-authoritative order (do NOT re-sort).
    // matchSegmentPattern already mirrors the worker's patternToRegex
    // (`:name`→[^/]+, `:name{.+}`/`*`→cross-slash), so this picks the SAME
    // winning route the worker renders.
    winner = first page route whose matchSegmentPattern(pattern, path) is true
    if winner:
      return winner.revalidate && winner.revalidate > 0 ? winner.revalidate : 0
    // no page route matches this path (e.g. a user void.json glob path)
    return resolvePathTtl(revalidate, path)         // flat-map fallback
  else:
    return resolvePathTtl(revalidate, path)         // today's behavior
  ```

  - A specific page that matches but has no TTL now returns **0** — the catch-all
    can no longer shadow it. (The fix.)
  - Paths matching no page route fall back to the flat map, preserving
    user-authored `void.json` `routing.revalidate` patterns.
  - When `pages` is absent (pre-upgrade deploys), behavior is byte-identical to
    today.

- The two ISR call sites (`index.ts:606` primary ladder, `index.ts:995`
  write-back) switch from `resolvePathTtl(routing.revalidate, …)` to
  `resolvePageTtl(routing.pages, routing.revalidate, …)`.

**Write-side parity (`platform/packages/api/src/routes/deploy.ts`):** the prewarm gate
`resolvePathTtl` (local, segment-anchored) becomes route-aware the same way,
using `manifest.pages`, so prerender warming and edge reads agree on the winning
route.

### Part 2 — API-route guard (dispatch-only)

Today the **primary** ISR ladder (`index.ts:605`) is entered whenever
`resolvePathTtl(...) > 0`, with **no** request-type guard, so a page catch-all
TTL matching `/api/foo` enters the ladder and caches the API response. The
**write-back** path (`index.ts:987`) already guards on `requestType === 'ssr'`
(`index.ts:999`), which excludes `/api/*` and extension paths.

Compute the SSR classification **before** the ladder and gate the ladder entry on
it, mirroring the write-back guard:

```
isSsrPath = routing.ssr && !hasExtension(pathname)
            && !(pathname === '/api' || pathname.startsWith('/api/'))
```

Gate the primary ISR ladder (`index.ts:612` condition) on `isSsrPath`. API and
asset-extension paths then skip the ISR ladder entirely and render live. This is
a dispatch-local heuristic (same one the write-back path already trusts), needs
no manifest data, and composes with Part 1.

## Data flow

```
framework pageScan (sorted) ──▶ manifest.pages: [{ pattern, revalidate? }]
                                       │ additive; old ingest/dispatch ignore it
                                       ▼
             api validateManifestShape (additive)  ──▶  routing blob { …, pages }
                                       ▼
             dispatch RoutingEntry.pages ──▶ resolvePageTtl(pages, revalidate, path)
                                       │       winning page route → its TTL, else flat-map fallback
                                       ▼
                        + SSR-path guard on the primary ISR ladder (Part 2)
```

## Backward-compatibility

- `pages` is an **additive** optional manifest field. `validateManifestShape` is
  per-field opt-in (no unknown-key rejection), so:
  - new worker → old api ingest: `pages` ignored; still buggy but no break.
  - old worker → new api ingest: no `pages`; resolver falls back to flat map.
  - new routing blob → old dispatch: `pages` ignored; flat-map path runs.
  - old routing blob → new dispatch: no `pages`; resolver falls back to flat map.
- No manifest `version` bump (additive change; deploy protocol stays backward
  compatible).
- The finding-F catch-all matcher (already merged on this branch) and the
  prewarm-metadata fix are unaffected and remain.

## Implementation order

The manifest producer must emit the new page table before the platform can
consume it. Framework and platform changes now share a workspace; verify the
producer, API validation, routing serialization and dispatch behavior together.

## Testing

**Framework:** unit test that `[...path]`, `[slug]`, static, and optional pages
serialize into `manifest.pages` in specificity order with the right
`revalidate` values; catch-all-with-TTL plus overlapping specific-without-TTL is
represented as two distinct entries.

**Platform api:** `validateManifestShape` accepts/reject cases for `pages`;
`buildRoutingJson` passes `pages` through; prewarm route-aware resolution (a
specific prerendered path under a catch-all resolves to the specific page's TTL,
not the catch-all's).

**Platform dispatch:**

- `resolvePageTtl`: specific-page-without-TTL under a catch-all-with-TTL → 0
  (not the catch-all TTL); catch-all's own nested path → catch-all TTL;
  non-page path → flat-map fallback; `pages` absent → flat-map behavior;
  query-key isolation unaffected.
- Part-2 guard: `/api/*` and extension paths under a root catch-all TTL are not
  cached (primary ladder skipped); SSR page paths still cache.
- Each new test must fail without its fix (revert-proof).

## Alternatives considered

- **Exclusion-only manifest field** (framework emits TTL-0 entries only for
  specific pages overlapping a catch-all): more complex to compute, less general,
  and still cross-repo. Rejected in favor of the full ordered `pages` list.
- **Framework-runtime `x-revalidate: 0`** for non-ISR pages: only protects the
  write path, not a pre-worker cache read on a poisoned slot; still a framework
  change. Rejected.
- **Platform-only ingest-time guard:** impossible — the shadowed specific page
  has no TTL, so it is absent from everything the platform receives today.

---

## Implementation Plan

**Goal:** Stop a catch-all page's ISR TTL from being applied to a more-specific non-ISR page (or an API route) by resolving the winning page route before applying its TTL — mirroring the framework's own route resolution.

**Architecture:** The framework emits an ordered `pages: [{pattern, revalidate?}]` list (its authoritative page-scan order) in the deploy manifest. The platform passes it through the routing blob. Dispatch first-matches over it (via the existing `matchSegmentPattern`, no re-sort) to pick the same winning route the worker renders, then applies that route's TTL — `0` when the winning page opts out — falling back to today's flat `revalidate` map when no page matches or `pages` is absent. A dispatch-side SSR-path guard keeps a catch-all from caching `/api/*` or extension paths.

**Tech Stack:** TypeScript. Framework and platform tests use Vitest through Vite+ (`vp test run`) in the unified workspace. Matching uses `matchSegmentPattern` (dispatch) / `matchLiteralPattern` (api) / `patternToRegex` (framework) — already in parity.

### Global Constraints

- **Emit RAW `page.pattern`** into `pages` (e.g. `/docs/:path{.+}`, `/blog/:slug`). Do NOT `*`-normalize catch-alls — that transform is only for the flat `revalidate` map (`collectRevalidate`, `isr-config.ts:65`). `matchSegmentPattern`/`matchLiteralPattern`/`patternToRegex` all handle `:name{.+}` natively.
- **`pages` includes ALL page routes**, TTL or not, in `pageScan.pages` array order (already specificity-sorted at `scan.ts:250-260`). Dispatch and the write-side resolver MUST iterate it **without re-sorting** — mirroring the framework's `matchRoute` order is the correctness property.
- **Resolver precedence:** winning page route found → its `revalidate` if `> 0`, else `0` (opt-out); no page route matches → fall back to the flat `revalidate` map; `pages` absent → today's flat-map behavior.
- **DESIGN — config-driven page ISR is preserved via build-time TTL resolution (closed 2026-07-11, reverses the 2026-07-09 acceptance).** The 2026-07-09 plan accepted a "config-inheritance" limitation: a matched page with no `export const revalidate` would resolve to `0`, so a Void Pages app that configured ISR through `void.json` `routing.revalidate` (rather than per-page exports) would lose ISR once the `pages` table shipped. Two facts surfaced during PR #272 review (codex P1) that the acceptance under-weighted forced a revisit: (1) a naive fallback to the merged flat `revalidate` map is **unsafe** — `collectRevalidate` folds sibling pages' per-page exports into that same map, so a match-but-no-TTL fallback would re-open the exact catch-all shadowing this design exists to fix; and (2) the **severity is total for the simplest config**: a bare global-number `void.json { routing: { revalidate: 3600 } }` made **every** page resolve to `0` — page ISR OFF for the whole site — which is a **regression #272 itself introduces** (pre-#272 dispatch resolved `3600` from the flat map). Fixed in the framework (PR #272): `collectPages` resolves each page's effective TTL at **build time** and bakes it into the table — per-page `export const revalidate` first (an explicit `0` is an authoritative opt-out, never overridden), else a **global-number** `void.json` `routing.revalidate` (applies to every page), else `0`. Because resolution consults **config only** (never sibling per-page exports), the catch-all shadowing fix is preserved: a specific no-export page under a sibling catch-all-with-export still resolves `0`. The `pages` table is self-sufficient; dispatch/prewarm are unchanged (they read the baked TTL). An OBJECT (per-path map) `routing.revalidate` is resolved at the EDGE per-path, not baked — via a 3-STATE `pages` table plus a new `manifest.pathRevalidate` field (closed 2026-07-12, supersedes both the interim probe-baking AND the "not baked, documented limitation" step). **Why the earlier steps were wrong:** (a) the FIRST attempt baked an object config by first-matching each page against a single representative _probe_ path — a further PR #272 review (codex P1) showed a page can straddle several object entries INCLUDING a per-path `0` opt-out (page `/blog/:slug` under `{ "/blog/private": 0, "/blog/*": 3600 }`), and the probe (`/blog/_`) misses the `0`, baking `3600` and OVER-caching `/blog/private` — a wrong-serve; (b) the SECOND step then dropped object baking entirely and documented the loss, but codex re-flagged (P1) that this REGRESSES a **documented feature** — `docs/guide/edge/revalidation.md` promises object `routing.revalidate` applies to Pages routes at precedence level 3 (below per-page exports, above the global-number fallback) — and that exact/static rules like `/about: 60` are perfectly safe. **The final fix** keeps baking for the two cases that map 1:1 to a single TTL (per-page `export const revalidate` → precedence 2; a global-NUMBER config → precedence 4) and defers the per-PATH object form to the edge, where the concrete request path makes resolution exact: `collectPages` emits a 3-state entry per page — `revalidate: N` (ISR on), `revalidate: 0` (EXPLICIT per-page opt-out; dispatch honors verbatim, never falls back), or ABSENT `revalidate` (INHERIT-eligible). The RAW user object config ships as `manifest.pathRevalidate` (object-only; a number is already baked into every page), threaded through `buildRoutingJson` → dispatch `RoutingEntry.pathRevalidate`. Dispatch's `resolvePageTtl`/`matchedPageTtl` (mirrored in the api prewarm and `isDottedPathIsrEligible`/`matchesLiteralPage`) resolve a matched inherit-eligible page against `pathRevalidate` **using the actual request path** — so `/blog/private` → `0` and `/blog/other` → `3600` are BOTH correct, per-path, with no collapse. Two invariants preserved: (1) the explicit-`0` vs absent distinction keeps a per-page `export const revalidate = 0` winning over any config rule (precedence 2 > 3); (2) `pathRevalidate` is the RAW user config, NOT the folded `collectRevalidate` map (which folds sibling per-page exports and would re-open catch-all shadowing) — a no-export page under a sibling catch-all-with-export still resolves `0` unless the USER's own config names it. Backward compatible: old dispatch reads a 3-state table as before (absent/`0` → no ISR; the transitional degradation is under-cache, never wrong-serve) and ignores `pathRevalidate`; new dispatch on an old manifest sees no `pathRevalidate` and resolves inherit pages to `0`. This restores the documented behavior with zero regression and no wrong-serve.
- **DESIGN — fallback ISR writes cache ONLY an exact declared page (closed 2026-07-10).** A fallback render may enter the shared ORIGINAL page key ONLY when the TARGET is the winning EXACT declared literal ISR page and the render is HTML: `isFallbackTargetCacheable(pages, target, response) = isHtmlResponse(response) && matchesLiteralPage(pages, target)`, where `matchesLiteralPage` requires a pattern with no `:` param, `{` regex, or `*` wildcard (matches only the exact path, positively identifying the target as that specific author-declared page). There is NO path-shape trust arm: a dotted `text/html` target (`/account.html`, `/session.json`) is indistinguishable here from a dynamic per-user endpoint, so path shape is never trusted — this closed the earlier `hasExtension` shell arm and its dotted-dynamic-HTML residual. A catch-all/param page (`/:path{.+}`, `/:slug`) matches arbitrary paths and is deliberately NOT accepted (else a common ISR catch-all plus `/* → /graphql` would poison the page key). `hasCacheOptOut` remains defense-in-depth. This TIGHTENED behavior: an extensionless non-declared page→page fallback, a dynamic dotted endpoint, AND a **static SPA shell reached via fallback** are no longer ISR-cached under a page key — they are still SERVED live (the shell's cache home is the static-asset path; opportunistic page-key caching of it needed an unprovable static-asset guess). Applied identically at the miss-write and background-revalidation write sites, and a fallback render is barred from EVICTING the origin entry (`!fallbackResult.applied`, since a fallback firing means the origin merely 404'd — often transiently). No cross-user residual remains on this path. (A future async asset-manifest lookup could restore verified static-shell caching, but is out of scope.) Also note the normal write-back is NOT a serving vector (it keys `target#hash(original-request-url)`, unreadable by any later read, and `shouldBypassIsr` excludes cookie/auth responses there). Documented at all sites in `platform/packages/dispatch/src/index.ts`.
- **KNOWN LIMITATION — extension SSR ISR requires a non-catch-all page match (accepted 2026-07-10).** A dotted request path (`/feed.xml`, `/blog/release.v2`) is ISR-eligible only when it matches a declared page route that is NOT a broad catch-all (`isDottedPathIsrEligible` + `isBroadCatchAll`): a literal (`/feed.xml`) or a single-segment param (`/blog/:slug`, which serves `/blog/release.v2` as a page) qualifies, but a broad catch-all (`/:path{.+}`, `/docs/*`) that merely happens to match `/robots.txt` does NOT — that keeps genuine static assets out of page-ISR (test 488) while restoring ISR for legitimate dotted param VALUES the interim literal-extension-only gate had wrongly excluded. Narrow residual: under a bare **global-number** `revalidate` (no per-pattern map, no `pages`) a dotted path declares no pattern, so it stays out of ISR; such apps opt in via a per-pattern `revalidate` map or a `pages` entry. This restores the origin/main behavior that the interim `!hasExtension` gate had regressed to a deployment-lifetime static cache.
- **KNOWN LIMITATION — pre-existing static-candidate 1-year shared cache for dynamic dotted SSR paths (accepted 2026-07-10, follow-up filed).** When a dotted path is NOT ISR-eligible (above), it falls through the ISR ladder to the deploy-versioned **static-candidate** edge cache (`platform/packages/dispatch/src/index.ts` ~848-865 read, ~1027 write): a `GET` 200 with no `Cache-Control` opt-out is stored in `caches.default` under `<origin><path>?_v=<version>` (no cookie, no `Vary`, no per-user `#rw` hash) with `s-maxage=31536000` — a **1-year, cross-user** entry. For an SSR project whose page config is a broad catch-all (`/:path{.+}`), a **dynamically rendered** dotted endpoint (`/session.json`) that omits `Cache-Control` is therefore shared-cached and served to other users, on the mere ABSENCE of an opt-out — the same anti-pattern the ISR write sites were hardened against (they require positive identification via `isFallbackTargetCacheable`), but the static-candidate branch predates and is outside this work. **This is PRE-EXISTING, not introduced by #228:** the static-candidate read+write is byte-identical to the merge base, and the realistic per-user (cookied/`Authorization`) case already reached it on `main` because `shouldBypassIsr` (Cookie/Authorization/EventStream, `isr.ts:277`) diverts credentialed requests PAST the ISR ladder into this exact branch. The only #228 delta is a narrow duration widening: an **uncookied** dynamic dotted response under a broad catch-all that used to get a short-TTL ISR entry (also shared) now gets the 1-year static entry — and even that requires an app to serve per-user content on an uncookied, no-`Cache-Control`, dotted endpoint (an app-side misconfiguration that is the precondition for exposure at all). Deliberately NOT fixed here: the only fix flips the shared static-asset write gate (used by legitimate `/logo.png`-style assets served via both the CF ASSETS binding AND the KV/R2 mirror) from "cache unless opt-out" to "cache only on a positive static-asset validator (`ETag`/`Last-Modified`)", scoped to `routing.ssr && hasExtension(pathname)` — a safety-sensitive change to a currently-untested surface whose full blast radius (does every asset-serving path set a validator?) is out of scope for this ISR-TTL work. Follow-up: gate the ~1027 write on a positive validator after verifying the KV/R2 mirror header behavior; real assets (which carry `ETag`) stay cached, dynamic dotted no-header renders are served live.
- **KNOWN LIMITATION — deploy prewarm can write orphaned ISR entries for prerendered dotted/API paths (accepted 2026-07-11, minor).** The api deploy prewarm (`platform/packages/api/src/routes/deploy.ts` ~3801) gates a prerendered path on `resolvePageTtl(...) > 0` only; it does NOT also mirror dispatch's READ-side `isIsrEligiblePath` gate, which additionally rejects `/api/*` and a dotted path whose only page match is a **broad catch-all**. So if `manifest.prerender` contains a dotted path (`/robots.txt`) that first-matches only a broad catch-all page (`/:path{.+}`, TTL>0) — or an `/api/*` path — prewarm resolves TTL>0 and WRITES an ISR KV entry that dispatch never reads (`isSsrPath` is false for that path, so its ladder is never entered). The warmed entry is orphaned: a harmless wasted per-deploy KV write — NO wrong-serve (the ISR KV store is distinct from the static-candidate edge cache) and NO leak. Deliberately not fixed here: closing it duplicates dispatch's dotted-eligibility gate (`isDottedPathIsrEligible`/`isBroadCatchAll`) a THIRD time into api (against the already-accepted api↔dispatch mirror debt). Clean follow-up: promote the eligibility helper to `packages/isr` and gate both the dispatch read and the api prewarm on the one shared function.
- **KNOWN LIMITATION — anonymous catch-all `/prefix/*` under-caches its bare parent (pre-existing, benign).** `matchSegmentPattern('/docs/*', '/docs')` is false (it compiles to `^/docs/.*$`), but Hono's `/docs/*` route DOES match bare `/docs`. So a `pages/docs/[...].tsx` page with `export const revalidate = N`, when the worker renders it for bare `/docs`, resolves TTL 0 at dispatch and is served LIVE (un-cached) instead of ISR-cached. The direction is benign: `*`→`.*` only ever UNDER-matches vs Hono (never over-matches), so it can only MISS caching — never apply a catch-all's TTL to a page the worker renders differently (no wrong-serve). Pre-existing: the same `*` semantics governed the flat `revalidate` map on the merge base; the `pages` table merely propagates it. Authors needing bare-parent ISR add an explicit `/docs` page entry.
- **KNOWN LIMITATION — a broad page catch-all TTL can ISR-cache a non-`/api` `routes/` handler (PRE-EXISTING, bounded; codex P1 on #272, accepted 2026-07-12).** `manifest.pages` (`collectPages`, `isr-config.ts`) is built from `pageScan.pages` ONLY — it is **route-unaware**. In a Void pages app that ALSO has API routes, the generated worker registers `routes/` handlers BEFORE pages (`router/compile.ts` ~1114-1149 then ~1200), so at runtime a concrete route wins over a broad page catch-all. But dispatch resolves ISR TTL against the page-only table: a broad catch-all page (`/:path{.+}`, TTL>0) first-matches a route path in `resolvePageTtl`/`isDottedPathIsrEligible`, so a request the WORKER serves from a route handler can be ISR-cached-and-served at the edge, bypassing the handler. **codex's exact `/api/user` example is already blocked** — `isApiPath` (`/api/` prefix) rejects it at both the read gate (`isIsrEligiblePath`) and the miss-write (test `index.test.ts:471`). The residual is a **non-`/api` route** (`/graphql`, `/webhook`, `/health`). **PRE-EXISTING, not introduced by the pages table:** a bare global-number `routing.revalidate = 3600` ALREADY ISR-cached `/graphql` on the merge base — with _looser_ guards (merge-base miss-write was `ttl>0 && response.ok`, no `isApiPath`/`status===200`/`hasCacheOptOut`). The catch-all page TTL is the pages-mode analog of a global-number config — same class; this branch only _tightened_ the adjacent guards (`isApiPath`, `status===200`, `hasCacheOptOut`, fallback positive-ID). **Bounded:** `shouldBypassIsr` (Cookie/Authorization, `isr.ts:277`) diverts credentialed requests PAST the ISR ladder, so the cross-user AUTH-leak subset is closed; the residual is shared-caching of PUBLIC, COOKIELESS dynamic content (a `/health` timestamp, geo/IP-varying output) — a correctness bug, not an auth breach — and requires the author to place a dynamic handler at a non-`/api` path (against the `/api/*` convention), returning 200 with no `Cache-Control` opt-out. **Deliberately not fixed here:** the clean fix is framework `collectPages` prepending non-`/api` route patterns as `revalidate: 0` opt-out entries ahead of pages (`routeScan.routes` is in scope at `deploy.ts` ~1730; first-match then mirrors the worker's route-before-page order — a net wrong-serve→under-cache safety improvement), but it trades correctness edge cases (a POST-only route path would wrongly disable ISR for a GET _page_ at the same path; dynamic route/page pattern overlap) and is a route-arbitration change outside this route-aware-TTL work. Same genre + boundary as the static-candidate limitation above. Clean follow-up: route-aware `collectPages` exclusion, or ship the route table to dispatch.
- **KNOWN LIMITATION — a whole-segment leading-colon `revalidate`/`pathRevalidate` key is matched as a param (bounded, near-zero reachability; codex P2 on #228, accepted 2026-07-12).** `resolvePathTtl` (`isr.ts` ~290) matches config keys with `matchSegmentPattern`, which compiles a WHOLE-SEGMENT `:name` (a `:` right after `/` or at the start) to `[^/]+`. So a user-authored key whose segment STARTS with a literal colon — `/:batchGet` — compiles to `^/[^/]+$` and OVER-matches unrelated single-segment paths (`/foo`), handing them a TTL they never opted into (a wrong-serve). **Why segment matching is used (and can't simply revert):** the folded flat `revalidate` map (`collectRevalidate`) contains GENERATED page-pattern keys (`:slug`, `:path{.+}`) that MUST param-match; on the merge base `resolvePathTtl` used `matchLiteralPattern`, under which those generated keys matched _literally_ and thus never matched any real path — a genuine pre-existing bug the segment matcher (commit `3282937e`) fixed. User keys and generated keys are folded into ONE map with no marker, so the matcher cannot switch to literal for one without re-breaking the other. **Scope is narrow:** only a whole-segment LEADING colon triggers it. A MID-segment colon — `/v1/users:batchGet` (Google AIP-136 custom methods), the realistic colon-in-URL shape — stays LITERAL and is SAFE. A path segment that _starts_ with `:` is not a real URL shape and is undocumented (`revalidation.md` sanctions only literal paths + `*` globs). **Bounded** by `shouldBypassIsr` (the cross-user subset is closed; residual is anonymous single-segment paths). **`pathRevalidate` (raw user keys, no generated keys) could use literal matching** and be strictly more correct, but that splits the matcher (a matched-inherit page would resolve the key literally while the rare no-page-match flat-map fallback resolves it segment-wise) — an inconsistency not worth trading for a bug this unreachable. Accepted; authors simply do not start a `revalidate` key segment with `:` (nor does any real URL).
- **DESIGN — bounded stale convergence for permanently-removed pages (closed 2026-07-10).** Because the fallback write gate refuses to cache a non-declared render (above) and the authoritative-opt-out eviction is gated on `!fallbackResult.applied`, a page that starts permanently 404ing (e.g. its backing record is deleted) and falls back to a non-cacheable shell could neither refresh nor evict its stale entry — and ISR KV puts set no `expirationTtl` (`packages/isr/src/index.ts`), so it would serve its last cached body until the next deploy. A final grace branch in `revalidateInBackground` evicts a stale entry only when BOTH: (a) the ORIGIN page's own pre-fallback render is `404`/`410` (positive removal evidence — never a `5xx`/`429`/timeout, which are degraded-dependency signals that MUST keep serving stale), and (b) the entry has been STALE (measured from `createdAt + ttl`, not creation) for longer than `ISR_STALE_EVICT_GRACE_SECONDS` (24h). Deliberate tradeoff: a transient origin failure — including a prolonged 5xx outage — keeps serving stale (stale-while-revalidate resilience) indefinitely; only a page that has genuinely 404'd beyond the grace converges (stops serving). Only reached when the write and opt-out branches did not fire, so a healthy refresh is never evicted. Eviction is request-triggered (a no-traffic stale entry simply isn't served).
- **`validateManifestShape` returns `string | null`; it never throws.** Mirror that style.
- **Additive, backward-compatible** manifest field. No `version` bump. New field ignored by old ingest/dispatch; new dispatch falls back to the flat map when `pages` is absent.
- **`pages` is a Void pages-mode concept** — emit only on the void deploy path (`runFullDeploy` → `buildVoidManifest`). The 3rd-party framework path (`runFrameworkDeploy`) has no page scan; leave it alone. Static deploys have no SSR ISR.

---

### Phase A — Framework: emit `pages`

All Phase-A paths are under `packages/void/`.

#### Task A1: `collectPages` helper

**Files:**

- Modify: `packages/void/src/isr-config.ts`
- Test: `packages/void/test/unit/isr-config.test.ts`

**Interfaces:**

- Produces: `export function collectPages(pageScan: PageScanResult | null): Array<{ pattern: string; revalidate?: number }> | undefined`
- Consumes: `PageScanResult` from `../pages/types.ts` (already imported in `isr-config.ts`).

- [ ] **Step 1: Write the failing test.** Append to `test/unit/isr-config.test.ts` (reuse the file's existing `makePage`/`makeScan` helpers; `makePage(pattern, revalidate?)` builds a `PageDefinition`):

```ts
import { collectPages } from '../../src/isr-config.ts';

describe('collectPages', () => {
  it('returns undefined when there is no page scan', () => {
    expect(collectPages(null)).toBeUndefined();
  });

  it('returns undefined when the scan has no pages', () => {
    expect(collectPages(makeScan([]))).toBeUndefined();
  });

  it('emits every page in scan order with raw patterns; revalidate only when set', () => {
    // makeScan preserves array order; a real scan is pre-sorted static→dynamic→catch-all.
    const scan = makeScan([
      makePage('/docs/setup/install'), // specific, no revalidate (opt-out)
      makePage('/blog/:slug', 120), // single-segment dynamic
      makePage('/docs/:path{.+}', 3600), // named catch-all — RAW pattern, not `*`
    ]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/setup/install' },
      { pattern: '/blog/:slug', revalidate: 120 },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `vp test run packages/void/test/unit/isr-config.test.ts` → FAIL (`collectPages` not exported).

- [ ] **Step 3: Implement `collectPages`** in `src/isr-config.ts` (add below `collectRevalidate`):

```ts
/**
 * Build the ordered page-route table shipped in the deploy manifest as
 * `pages`. Emits EVERY page route (with or without a TTL) in `pageScan.pages`
 * order — which is already specificity-sorted (static → dynamic → catch-all)
 * and is the exact order the framework's own `matchRoute` (pages/manifest.ts)
 * resolves in. Patterns are emitted RAW (`:slug`, `:path{.+}`, `*`); the edge
 * matcher (`matchSegmentPattern`) handles `:name{.+}` natively, so — unlike the
 * flat `revalidate` map — catch-alls are NOT collapsed to `*`.
 *
 * Consumers (dispatch, deploy prewarm) first-match over this list to pick the
 * winning route, then apply that route's `revalidate` (0/absent = not ISR).
 */
export function collectPages(
  pageScan: PageScanResult | null,
): Array<{ pattern: string; revalidate?: number }> | undefined {
  if (!pageScan || pageScan.pages.length === 0) {
    return undefined;
  }
  return pageScan.pages.map((page) =>
    page.revalidate != null
      ? { pattern: page.pattern, revalidate: page.revalidate }
      : { pattern: page.pattern },
  );
}
```

- [ ] **Step 4: Run it, verify it passes.** `vp test run packages/void/test/unit/isr-config.test.ts` → PASS.

#### Task A2: `DeployManifest.pages` type + `buildVoidManifest` emits it

**Files:**

- Modify: `packages/void/src/cli/types.ts` (`DeployManifest`, ~line 173, beside `revalidate`)
- Modify: `packages/void/src/cli/package.ts` (`buildVoidManifest`, opts ~488-525, set ~595-609)
- Test: `packages/void/test/unit/package.test.ts`

**Interfaces:**

- Produces: `DeployManifest.pages?: Array<{ pattern: string; revalidate?: number }>`; `buildVoidManifest` gains `pages?: Array<{ pattern: string; revalidate?: number }>`.

- [ ] **Step 1: Failing test** in `test/unit/package.test.ts` (reuse `makeBindings`):

```ts
it('carries a pages array verbatim into manifest.pages', () => {
  const pages = [
    { pattern: '/docs/setup/install' },
    { pattern: '/docs/:path{.+}', revalidate: 3600 },
  ];
  const manifest = buildVoidManifest({ bindings: makeBindings(), pages });
  expect(manifest.pages).toEqual(pages);
});

it('omits manifest.pages when the pages array is empty or missing', () => {
  expect(buildVoidManifest({ bindings: makeBindings(), pages: [] }).pages).toBeUndefined();
  expect(buildVoidManifest({ bindings: makeBindings() }).pages).toBeUndefined();
});
```

- [ ] **Step 2: Run it, verify it fails.** `vp test run packages/void/test/unit/package.test.ts` → FAIL (type error / `pages` undefined).

- [ ] **Step 3a: Add the field to `DeployManifest`** in `src/cli/types.ts`, directly after the `revalidateQueryAllowlist?` line:

```ts
  /** Ordered page-route table for route-aware ISR resolution (pages mode). */
  pages?: Array<{ pattern: string; revalidate?: number }>;
```

- [ ] **Step 3b: Add `pages` to `buildVoidManifest`** in `src/cli/package.ts` — add `pages?: Array<{ pattern: string; revalidate?: number }>;` to the opts type, add `pages` to the destructure, and set it beside `revalidate` (after the `revalidate`/`revalidateQueryAllowlist` block, ~line 604):

```ts
if (pages && pages.length > 0) {
  manifest.pages = pages;
}
```

- [ ] **Step 4: Run it, verify it passes.** `vp test run packages/void/test/unit/package.test.ts` → PASS. Then `vp run check` (framework) → clean.

#### Task A3: Wire `collectPages` into the void deploy path

**Files:**

- Modify: `packages/void/src/cli/deploy.ts` (`runFullDeploy`: compute near `collectRevalidate` ~1728; pass to `buildVoidManifest` ~1874)
- Test: `packages/void/test/integration/kitchen-sink-build.test.ts`

**Interfaces:**

- Consumes: `collectPages` (A1), `buildVoidManifest.pages` (A2).

- [ ] **Step 1: Add the wiring.** In `runFullDeploy`, right after `const revalidate = collectRevalidate(deployConfig, pageScan);` (~1728):

```ts
const pages = collectPages(pageScan);
```

and add `pages,` to the `buildVoidManifest({ ... })` call object (~1874, alongside `revalidate,`). Import `collectPages` from `../isr-config.ts` (extend the existing `collectRevalidate` import).

- [ ] **Step 2: Write the integration assertion.** Open `test/integration/kitchen-sink-build.test.ts`, find where it asserts on the built deploy manifest (the kitchen-sink app has pages incl. ISR), and add:

```ts
// kitchen-sink is a Void pages app → manifest.pages is emitted, in scan order.
expect(Array.isArray(manifest.pages)).toBe(true);
expect(manifest.pages!.length).toBeGreaterThan(0);
// every entry has a string pattern; catch-alls are RAW (`{.+}`/`*`), not normalized away
for (const p of manifest.pages!) expect(typeof p.pattern).toBe('string');
```

(If the test builds the manifest via a helper, assert on that manifest object. Read the file first to place the assertion in the existing manifest-assertion block.)

- [ ] **Step 3: Run it.** `vp test run packages/void/test/integration/kitchen-sink-build.test.ts` → PASS. Then the framework ISR/package suites: `vp test run packages/void/test/unit/isr-config.test.ts packages/void/test/unit/package.test.ts` → PASS. `vp run check` → clean.

---

### Phase B — Shared contract verification

The separate-repository dependency update is retired. Verify the manifest
producer and consumers together in this workspace.

### Phase C — Platform: consume `pages`

#### Task C1: Platform manifest type + `validateManifestShape`

**Files:**

- Modify: `platform/packages/api/src/types.ts` (`DeployManifest`, beside `revalidateQueryAllowlist` ~205)
- Modify: `platform/packages/api/src/routes/deploy.ts` (`validateManifestShape`, add a `pages` block; add a `MAX_PAGES` cap const near the other `MAX_*` caps)
- Test: `platform/packages/api/test/integration/api-deploy.test.ts`

**Interfaces:**

- Produces: `DeployManifest.pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>`.

- [ ] **Step 1: Failing test** — add a `validateManifestShape` unit block in `api-deploy.test.ts` (import `validateManifestShape` from `../../src/routes/deploy.ts`):

```ts
describe('validateManifestShape — pages', () => {
  const base = { version: 3, bindings: {} };
  it('accepts a valid pages array', () => {
    expect(
      validateManifestShape({
        ...base,
        pages: [{ pattern: '/a' }, { pattern: '/b/:x', revalidate: 60 }],
      }),
    ).toBeNull();
  });
  it('accepts absence of pages', () => {
    expect(validateManifestShape(base)).toBeNull();
  });
  it('rejects non-array pages', () => {
    expect(validateManifestShape({ ...base, pages: {} })).toMatch(/pages must be an array/);
  });
  it('rejects an entry with a non-string pattern', () => {
    expect(validateManifestShape({ ...base, pages: [{ pattern: 5 }] })).toMatch(
      /pattern must be a string/,
    );
  });
  it('rejects an entry with a non-number revalidate', () => {
    expect(validateManifestShape({ ...base, pages: [{ pattern: '/a', revalidate: 'x' }] })).toMatch(
      /revalidate must be a number/,
    );
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `vp test run platform/packages/api/test/integration/api-deploy.test.ts -t "validateManifestShape — pages"` → FAIL.

- [ ] **Step 3a: Add the field** to `platform/packages/api/src/types.ts` `DeployManifest`, after `revalidateQueryAllowlist?`:

```ts
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
```

- [ ] **Step 3b: Add the validation block** to `validateManifestShape` in `deploy.ts` (near the `revalidateQueryAllowlist` block; add `const MAX_PAGES = 5000;` beside the other cap consts):

```ts
if (manifest.pages !== undefined) {
  if (!Array.isArray(manifest.pages)) {
    return 'invalid manifest shape: pages must be an array';
  }
  if (manifest.pages.length > MAX_PAGES) {
    return `invalid manifest shape: pages has ${manifest.pages.length} entries, exceeds the ${MAX_PAGES} entry limit`;
  }
  for (const entry of manifest.pages as Array<unknown>) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'invalid manifest shape: each pages entry must be an object';
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.pattern !== 'string' || e.pattern === '') {
      return 'invalid manifest shape: pages entry pattern must be a string';
    }
    if (e.revalidate !== undefined && typeof e.revalidate !== 'number') {
      return 'invalid manifest shape: pages entry revalidate must be a number';
    }
  }
}
```

- [ ] **Step 4: Run it, verify it passes.** Same command → PASS. `vp run check` → clean.

#### Task C2: Pass `pages` through the routing blob

**Files:**

- Modify: `platform/packages/api/src/routing.ts` (`buildRoutingJson`, ~190)
- Test: the existing routing test file (search `buildRoutingJson` under `platform/packages/api/test/`)

- [ ] **Step 1: Failing test** — add to the `buildRoutingJson` test suite:

```ts
it('passes manifest.pages through to the routing blob', () => {
  const pages = [{ pattern: '/a' }, { pattern: '/b/:x', revalidate: 60 }];
  const json = JSON.parse(
    buildRoutingJson({ /* ...existing required opts... */, manifest: { type: 'void', ssr: true, pages } as any }),
  );
  expect(json.pages).toEqual(pages);
});

it('omits pages when the manifest has none', () => {
  const json = JSON.parse(buildRoutingJson({ /* ...required opts... */, manifest: { type: 'void' } as any }));
  expect(json.pages).toBeUndefined();
});
```

(Read the existing `buildRoutingJson` tests to copy the required `opts` shape — `workerName`, `projectId`, `userId`, `deploymentId`, `dispatchLimits`.)

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Add the passthrough** in `buildRoutingJson` (after the `revalidate` line ~190):

```ts
    ...(manifest?.pages?.length ? { pages: manifest.pages } : {}),
```

- [ ] **Step 4: Run it, verify it passes.** `vp run check` → clean.

#### Task C3: `resolvePageTtl` + `RoutingEntry.pages`

**Files:**

- Modify: `platform/packages/dispatch/src/index.ts` (`RoutingEntry`, ~25-48 — add `pages?`)
- Modify: `platform/packages/dispatch/test/unit/index.test.ts` (local `RoutingEntry` type ~29-43 — add `pages?`)
- Modify: `platform/packages/dispatch/src/isr.ts` (add `resolvePageTtl`)
- Test: `platform/packages/dispatch/test/unit/isr.test.ts`

**Interfaces:**

- Produces: `export function resolvePageTtl(pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined, revalidate: number | Record<string, number> | undefined, pathname: string): number`
- Consumes: `matchSegmentPattern` (`./pattern.ts`), `resolvePathTtl` (same file).

- [ ] **Step 1: Failing test** in `test/unit/isr.test.ts` (import `resolvePageTtl` from `../../src/isr.ts`):

```ts
describe('resolvePageTtl', () => {
  // Emitted in framework scan order: static → dynamic → catch-all last.
  const pages = [
    { pattern: '/docs/setup/install' }, // specific, no TTL (opts out of ISR)
    { pattern: '/blog/:slug', revalidate: 120 }, // single-segment dynamic
    { pattern: '/docs/:path{.+}', revalidate: 3600 }, // named catch-all (crosses '/')
  ];

  it('a specific page without a TTL wins over a catch-all and opts OUT (0)', () => {
    expect(resolvePageTtl(pages, undefined, '/docs/setup/install')).toBe(0);
  });
  it("a catch-all's own nested path gets the catch-all TTL", () => {
    expect(resolvePageTtl(pages, undefined, '/docs/a/b')).toBe(3600);
  });
  it('a single-segment dynamic page gets its own TTL, anchored to one segment', () => {
    expect(resolvePageTtl(pages, undefined, '/blog/hello')).toBe(120);
    // /blog/a/b does not match :slug; it also matches no other page → flat-map fallback (none) → 0
    expect(resolvePageTtl(pages, undefined, '/blog/a/b')).toBe(0);
  });
  it('a path matching NO page route falls back to the flat revalidate map', () => {
    expect(resolvePageTtl(pages, { '/legacy/*': 90 }, '/legacy/x')).toBe(90);
  });
  it('when pages is undefined it is exactly the flat-map behavior', () => {
    expect(resolvePageTtl(undefined, { '/docs/*': 300 }, '/docs/a')).toBe(300);
    expect(resolvePageTtl(undefined, undefined, '/docs/a')).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `vp test run platform/packages/dispatch/test/unit/isr.test.ts -t resolvePageTtl` → FAIL.

- [ ] **Step 3a: Add `resolvePageTtl`** to `src/isr.ts` (below `resolvePathTtl`):

```ts
/**
 * Route-aware ISR TTL resolution. Iterates `pages` in the framework's
 * authoritative order (do NOT re-sort — it is already the order the worker's
 * own matchRoute resolves in) and first-matches via `matchSegmentPattern`, so
 * dispatch picks the SAME winning route the worker renders. The winner's TTL
 * (0 when it opts out) is authoritative. Only when NO page route matches do we
 * fall back to the flat `revalidate` map (user void.json patterns). When
 * `pages` is absent, behavior is identical to `resolvePathTtl`.
 */
export function resolvePageTtl(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (pages && pages.length > 0) {
    for (const page of pages) {
      if (matchSegmentPattern(page.pattern, pathname)) {
        return page.revalidate && page.revalidate > 0 ? page.revalidate : 0;
      }
    }
    return resolvePathTtl(revalidate, pathname);
  }
  return resolvePathTtl(revalidate, pathname);
}
```

- [ ] **Step 3b: Add `pages?` to `RoutingEntry`** in `src/index.ts` (after `revalidate?`):

```ts
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
```

and add the same optional field to the LOCAL `RoutingEntry` type in `test/unit/index.test.ts` (~29-43) so tests can set it.

- [ ] **Step 4: Run it, verify it passes.** `vp test run platform/packages/dispatch/test/unit/isr.test.ts` → PASS. `vp run check` → clean.

#### Task C4: Use `resolvePageTtl` at the two dispatch ISR sites

**Files:**

- Modify: `platform/packages/dispatch/src/index.ts` (read gate ~605/606; write-back gate ~988/995)
- Test: `platform/packages/dispatch/test/unit/index.test.ts`

**Interfaces:**

- Consumes: `resolvePageTtl` (C3). Update the `resolvePathTtl` import to also import `resolvePageTtl` from `./isr.ts` (~line 14).

- [ ] **Step 1: Failing test** in `test/unit/index.test.ts` (mirror the existing ISR request tests + `createEnv`):

```ts
it('does NOT cache a specific non-ISR page shadowed by a catch-all (route-aware)', async () => {
  const { env, workerFetch, kvStore } = createEnv({
    routing: {
      workerName: 'user-app',
      projectId: 'proj_1',
      ssr: true,
      // catch-all has a TTL; the specific page opts out (present, no revalidate)
      revalidate: { '/docs/*': 3600 },
      pages: [{ pattern: '/docs/setup/install' }, { pattern: '/docs/:path{.+}', revalidate: 3600 }],
    },
    workerResponse: new Response('<html>specific</html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  });
  const ctx = createCtx();
  await app.fetch(new Request('https://my-app.apps.example.com/docs/setup/install'), env, ctx);
  await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
  // no ISR entry written for the shadowed specific page
  expect([...kvStore.keys()].some((k) => k.includes('/docs/setup/install'))).toBe(false);
});

it("DOES cache the catch-all's own nested path", async () => {
  const { env, kvStore } = createEnv({
    routing: {
      workerName: 'user-app',
      projectId: 'proj_1',
      ssr: true,
      revalidate: { '/docs/*': 3600 },
      pages: [{ pattern: '/docs/setup/install' }, { pattern: '/docs/:path{.+}', revalidate: 3600 }],
    },
    workerResponse: new Response('<html>catch-all</html>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  });
  const ctx = createCtx();
  await app.fetch(new Request('https://my-app.apps.example.com/docs/a/b'), env, ctx);
  await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
  expect([...kvStore.keys()].some((k) => k.includes('/docs/a/b'))).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails** (today's flat map caches the shadowed page).

- [ ] **Step 3: Wire the resolver** in `src/index.ts`:
  - Read path (~605-606): widen the gate and switch the resolver:
    ```ts
    if (routing.ssr && (routing.revalidate || routing.pages?.length)) {
      const isrTtl = resolvePageTtl(routing.pages, routing.revalidate, pathname);
    ```
  - Write-back (~988, 995): widen the gate `if (routing.revalidate || routing.pages?.length) && ...` and switch:
    ```ts
    const configTtl = resolvePageTtl(routing.pages, routing.revalidate, pathname);
    ```

- [ ] **Step 4: Run it, verify it passes.** Run the full dispatch ISR suite too: `vp test run platform/packages/dispatch/test/unit/index.test.ts platform/packages/dispatch/test/unit/isr.test.ts` → PASS (existing flat-map-only tests still pass because `pages` is absent there). `vp run check` → clean.

#### Task C5: API-route guard on the primary ISR ladder

**Files:**

- Modify: `platform/packages/dispatch/src/index.ts` (compute `isSsrPath` before the read ladder ~605; gate the ladder on it)
- Test: `platform/packages/dispatch/test/unit/index.test.ts`

**Interfaces:**

- Consumes: `hasExtension` (already defined at `index.ts:1338`, hoisted).

- [ ] **Step 1: Failing test** in `test/unit/index.test.ts`:

```ts
it('does NOT ISR-cache /api/* even under a root catch-all page with a TTL', async () => {
  const { env, kvStore } = createEnv({
    routing: {
      workerName: 'user-app',
      projectId: 'proj_1',
      ssr: true,
      pages: [{ pattern: '/:path{.+}', revalidate: 3600 }], // root catch-all
    },
    workerResponse: new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const ctx = createCtx();
  await app.fetch(new Request('https://my-app.apps.example.com/api/thing'), env, ctx);
  await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
  expect([...kvStore.keys()].some((k) => k.includes('/api/thing'))).toBe(false);
});

it('does NOT ISR-cache an extension path under a root catch-all', async () => {
  const { env, kvStore } = createEnv({
    routing: {
      workerName: 'user-app',
      projectId: 'proj_1',
      ssr: true,
      pages: [{ pattern: '/:path{.+}', revalidate: 3600 }],
    },
    workerResponse: new Response('data', { headers: { 'Content-Type': 'text/plain' } }),
  });
  const ctx = createCtx();
  await app.fetch(new Request('https://my-app.apps.example.com/robots.txt'), env, ctx);
  await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
  expect([...kvStore.keys()].some((k) => k.includes('robots.txt'))).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails** (the primary ladder currently caches any `isrTtl > 0` path).

- [ ] **Step 3: Add the guard** in `src/index.ts`. Just before the read ladder (~605), compute:

```ts
// ISR applies to SSR page paths only. An API route or an asset-extension
// path that happens to match a catch-all page pattern must render live and
// never enter the ISR cache — mirrors the write-back guard (requestType ===
// 'ssr') below and how meta-frameworks resolve API routes to non-ISR outputs.
const isSsrPath =
  routing.ssr === true &&
  !hasExtension(pathname) &&
  !(pathname === '/api' || pathname.startsWith('/api/'));
```

Change the ladder gate from `if (routing.ssr && (routing.revalidate || routing.pages?.length))` to:

```ts
    if (isSsrPath && (routing.revalidate || routing.pages?.length)) {
```

- [ ] **Step 4: Run it, verify it passes.** Full dispatch suite: `vp test run platform/packages/dispatch` → PASS. `vp run check` → clean.

#### Task C6: Route-aware prewarm (write side)

**Files:**

- Modify: `platform/packages/api/src/routes/deploy.ts` (prewarm gate ~3758; local resolver ~4540)
- Test: `platform/packages/api/test/integration/api-deploy.test.ts`

**Interfaces:**

- Produces (local, file-private): `resolvePageTtl(pages, revalidate, pathname)` mirroring dispatch's, using the existing local `matchLiteralPattern`.

- [ ] **Step 1: Failing test** in `api-deploy.test.ts` (mirror the existing prewarm tests; a prerendered SPECIFIC path under a catch-all must warm at its OWN TTL, and a pages-only manifest with no flat `revalidate` must still warm):

```ts
it('prewarms a prerendered specific page at its own TTL under a catch-all (route-aware)', async () => {
  // catch-all TTL 3600; the specific prerendered page declares 60 → must warm at 60, not 3600.
  // ...deploy with manifest { version:3, bindings:{}, prerender:['/docs/intro'],
  //     pages:[{pattern:'/docs/intro', revalidate:60}, {pattern:'/docs/:path{.+}', revalidate:3600}] }
  // assert the ISR_CACHE metadata.t for /docs/intro is 60.
});

it('prewarms when only manifest.pages carries TTLs (no flat revalidate)', async () => {
  // manifest { version:3, bindings:{}, prerender:['/a'], pages:[{pattern:'/a', revalidate:120}] }
  // assert /a is warmed with metadata.t === 120.
});
```

(Fill the deploy setup by copying the nearest existing prewarm test, e.g. `:2666` "prerenders pages and writes ISR cache entries", swapping in the `pages` field and asserting `metadata.t`.)

- [ ] **Step 2: Run it, verify it fails** (prewarm resolves via the flat map only; a pages-only manifest doesn't warm, and a shadowed specific path resolves the catch-all TTL).

- [ ] **Step 3: Make prewarm route-aware.**
  - Add a local `resolvePageTtl` in `deploy.ts` beside the local `resolvePathTtl` (~4540), using the existing local `matchLiteralPattern`:
    ```ts
    function resolvePageTtl(
      pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
      revalidate: number | Record<string, number> | undefined,
      pathname: string,
    ): number {
      if (pages && pages.length > 0) {
        for (const page of pages) {
          if (matchLiteralPattern(page.pattern, pathname)) {
            return page.revalidate && page.revalidate > 0 ? page.revalidate : 0;
          }
        }
        return resolvePathTtl(revalidate, pathname);
      }
      return resolvePathTtl(revalidate, pathname);
    }
    ```
  - Widen the prewarm gate (~3758) from `&& manifest.revalidate` to `&& (manifest.revalidate || manifest.pages?.length)`, and inside the loop replace `resolvePathTtl(manifest.revalidate, pathname)` with `resolvePageTtl(manifest.pages, manifest.revalidate, pathname)`.

- [ ] **Step 4: Run it, verify it passes.** `vp test run platform/packages/api/test/integration/api-deploy.test.ts` → PASS. `vp run check` → clean.

#### Task C7: Full verification + docs

**Files:**

- Modify: `platform/meta/design-docs/0077-route-aware-isr-ttl.md` (`status: draft` → `implemented`), this plan (`status`)
- Modify (if applicable): `packages/isr/README.md` / `platform/packages/dispatch/README.md` route-aware ISR note.

- [ ] **Step 1:** `vp run check` (all packages) → clean.
- [ ] **Step 2:** `vp test run platform/packages/dispatch platform/packages/api packages/isr` → all green.
- [ ] **Step 3:** `vp fmt --check` → clean; `vp lint` → clean.
- [ ] **Step 4:** Update doc statuses + any package README route-aware note.

---

### Self-review notes

- **Spec coverage:** Part 1 (framework emit → api passthrough → dispatch resolver) = A1–A3, C1–C4. Part 2 (API guard) = C5. Write-side parity = C6. Backward-compat is inherent (every consumer falls back to the flat map when `pages` is absent; validated by the "pages undefined" cases in C3/C4). Prior-art refinement (mirror framework order, no re-sort) = C3 (`resolvePageTtl` iterates `pages` as-given).
- **Naming consistency:** `resolvePageTtl(pages, revalidate, pathname)` used identically in dispatch (C3/C4) and the deploy prewarm (C6, file-local). `collectPages` (A1) → `manifest.pages` (A2/A3) → `routing.pages` (C2) → `RoutingEntry.pages` (C3).
- **Raw-pattern invariant:** `collectPages` (A1) emits raw `page.pattern`; `matchSegmentPattern`/`matchLiteralPattern` handle `:name{.+}` — no `*`-normalization on the `pages` path (contrast `collectRevalidate`).
