# @void/isr

Shared Incremental Static Regeneration contracts for Void runtimes and deployment targets.

The package is public so the Void SDK, the hosted platform, and deployment adapters can consume the same cache-key and edge-cache URL protocol directly. Applications normally use `void/isr`; this lower-level package is intended for runtime and adapter authors.

## Purpose

When a request is served via a dispatch-side rewrite (`routing.rewrites` or `routing.fallbacks`), the ISR slot splits per original-request URL via the `#rw=` variant suffix — so user code that branches on `c.isRewritten()` / `c.originalUrl()` doesn't share a cache entry with the direct-hit path to the same destination.

ISR cache entries are written by `platform/packages/dispatch` and purged by `platform/packages/api`. The two workers must produce byte-identical keys and URLs — if the purger and the writer disagree on a single character, purges silently miss and stale HTML survives revalidation. This package centralizes every helper that constructs an ISR KV key or an edge-cache URL so the two sides cannot drift.

Any new helper that touches the key or URL format belongs here, not in `api/` or `dispatch/`. Duplication is the failure mode this package exists to prevent.

## Public API

The package has three entry points:

- `@void/isr` owns the immutable, versioned KV-key and edge-cache URL protocol.
- `@void/isr/core` owns target-neutral codecs, validation, TTL selection, request bypass rules, response construction, header sanitization, Void Pages data extraction, and query-variant normalization.
- `@void/isr/runtime` implements the fail-open, single-tenant Cloudflare KV and Cache API ladder used by direct Void deployments, including bounded variants from `routing.revalidateQueryAllowlist`.

The direct runtime applies ISR only to public page requests. API paths, requests carrying `Cookie`, `Authorization`, or `Cf-Access-Jwt-Assertion` credentials, Range requests, and EventSource requests render live. A rendered response is shared only when it is a complete `200` response without `Cache-Control: private`, `no-store`, or `no-cache`, and without `Set-Cookie`. When a background revalidation returns one of those opt-outs, the runtime removes the old HTML, Pages JSON, and KV variants so previously public content cannot remain reachable.

| Symbol                        | Description                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `isrCacheKey`                 | Build a full ISR KV key, optionally including a rewrite-variant suffix derived from the original request URL.            |
| `isrCachePrefix`              | Prefix for listing/purging ISR keys by deployment (or all deployments when `deploymentId` is `undefined`).               |
| `isrCacheVariantPrefix`       | Prefix that matches every rewrite variant of a given pathname under a deployment (for listing/purging).                  |
| `isrLegacyCachePrefix`        | `v2` (hostless) counterpart of `isrCachePrefix`. Transition-only — purge path sweeps the pre-host-scoping namespace.     |
| `isrLegacyCacheKey`           | `v2` (hostless) direct-hit key for a pathname. Transition-only — purge path reaps the orphaned pre-host-scoping key.     |
| `isrLegacyCacheVariantPrefix` | `v2` (hostless) counterpart of `isrCacheVariantPrefix`. Transition-only — purge path recovers pre-host-scoping variants. |
| `splitIsrCacheKey`            | Split a full key into `{ normalizedPath, variantToken }` — `variantToken` is `null` for direct-hit (non-rewrite) keys.   |
| `denormalizeIsrPath`          | Turn a normalized path segment back into a pathname starting with `/`. Paired with `splitIsrCacheKey` on purge.          |
| `isrEdgeCacheUrl`             | Build the internal edge-cache URL used as the `caches.default` key. Takes the original URL; hashes it internally.        |
| `isrEdgeCacheUrlForToken`     | Same shape, but takes a pre-hashed variant token (the form returned by `splitIsrCacheKey`). Used by the purge path.      |
| `hashOriginalUrl`             | Sync FNV-1a 64-bit hex hash of the original URL. Exposed for callers that need to compute the token outside the helpers. |

The legacy (`v2`) sweep helpers `isrLegacyCachePrefix`, `isrLegacyCacheKey`, and `isrLegacyCacheVariantPrefix` are exported for the API purge path only — they target the pre-host-scoping `v2` namespace during the host-scoping rollout. Dispatch never uses them.

Path normalization (`normalizeIsrPath` / `canonicalIsrPathname`), the version prefixes (`isrCacheVersionPrefix` / `isrLegacyCacheVersionPrefix`), and the version constants (`ISR_CACHE_KEY_VERSION` / `ISR_LEGACY_CACHE_KEY_VERSION`) are package-internal. Consumers work through the key-building helpers above so the format contract lives in one place; add a new exported helper rather than reaching for an internal if a call site needs one.

## Key Format

The current version is `v3` (host-scoped):

```
<projectId>/isr/v3/<deploymentId>/<host>/<normalizedPath>[#rw=<variantTokenHex>]
```

The legacy `v2` namespace is hostless (still swept by the purger during the rollout, never written or read by dispatch):

```
<projectId>/isr/v2/<deploymentId>/<normalizedPath>[#rw=<variantTokenHex>]
```

- `<projectId>/isr/v3/` — namespacing plus the current format version. The version prefix exists so a format change can coexist with stale entries from the previous version; bump `ISR_CACHE_KEY_VERSION` rather than reusing the current prefix.
  - `v1`→`v2` added the rewrite-variant (`#rw=`) suffix.
  - `v2`→`v3` added the `<host>` segment (host-scoping). This bump was **mandatory**, not cosmetic: under a single version a host-scoped key `<D>/<host>/<path>` and a legacy hostless key `<D>/<path>` are byte-identical whenever the hostless path's leading segment looks like a hostname. Dotted leading path segments are legal (a route param `[domain]` compiles to `:domain` = `[^/]+`, and `[...slug]` to `(.+)`), so the hostless page `/example.com/about` produces the key `<D>/example.com/about` — exactly the host-scoped key for `(host=example.com, /about)`. Encoding the shape in the version removes the ambiguity: `v3` keys are always host-scoped, `v2` keys always hostless, so the version segment alone classifies the key — no runtime heuristic needed. Do not remove the version prefix as "dead weight" — that silently breaks cache compatibility the next time the format evolves.
- Every KV entry carries `{s,c,t,p}` metadata. `p` is the shared-response privacy-policy version. Readers reject entries without the current value because older writers stripped private headers before storage, leaving no reliable way to prove their bodies safe to share.
- `<deploymentId>` — scopes each entry to the deployment that produced it. Cached HTML embeds hashed asset URLs from a specific deployment; reading it after a new deploy ships would serve stale HTML pointing at assets that no longer exist. Scoping by deployment makes that structurally impossible.
- `<host>` — the request hostname dispatch saw (`new URL(request.url).hostname`). The same path served under a project slug and a custom domain (or two custom domains) never shares a cache slot. `v3` only; absent in `v2`.
- `<normalizedPath>` — the pathname passed through `normalizeIsrPath`. Root `/` becomes `__index__`; other paths have leading and trailing slashes stripped.
- `#rw=<token>` — optional rewrite-variant suffix. When a request was served via a dispatch-phase rewrite (`routing.rewrites`, `routing.fallbacks`, or a `_redirects` `200`/`200!` entry), the ISR slot splits per original request URL so direct hits and rewrite-served hits do not share cache entries (user code can branch on `c.isRewritten()` / `c.originalUrl()`). `#` is used as the separator because it cannot appear inside `url.pathname` — the browser strips fragments before the request reaches the edge — and it never survives `normalizeIsrPath`, so the suffix is unambiguous.

## Variant Tokens

Variant tokens are a fixed-length hex hash (FNV-1a 64-bit, 16 chars) of the UTF-8 bytes of the original request URL. The same hash is used as the KV-key suffix and as the `__void_orig=<token>` query value on the internal edge-cache URL, so the writer (dispatch) and the purger (api) compute byte-identical tokens for the same URL.

Hashing — rather than reversibly encoding the URL — is deliberate:

- **KV is operator-readable.** A reversible token (the prior `btoa` encoding) let any operator with KV list access read the original URLs, including sensitive query strings (`?token=…`, `?email=…`).
- **Variant tokens are KV-key suffixes.** A fixed-length hash bounds the total key size regardless of how long the original URL was, so KV's name-length limit can't be approached by any single request.

The hash is sync (BigInt FNV-1a; Workers' `crypto.subtle.digest` is async and we don't want to push async through every read/write). Collision resistance is ~2^32 (birthday) — fine for the per-deployment, per-pathname variant set we ever store; the per-pathname variant cap (see `isr` issue #6) keeps that population well under the threshold.

Because the original URL is not recoverable from a variant token, `splitIsrCacheKey` returns the token directly (as `variantToken`), and the purger calls `isrEdgeCacheUrlForToken` rather than re-hashing.

## Monorepo Consumers

- `platform/packages/api/src/isr-cache.ts` — hosted purge path. Uses `splitIsrCacheKey` to decode variant KV entries and `isrEdgeCacheUrl` to reconstruct the matching edge-cache URL.
- `platform/packages/dispatch/src/isr.ts` — hosted read/write path. Uses `isrCacheKey` and `isrEdgeCacheUrl` to resolve the slot for every ISR-backed page request.
- `packages/void` — direct Cloudflare runtime and CLI integration.

## Rules for Adding Helpers

1. Any new helper that touches ISR key or URL format MUST live in this package. Do not inline a new format in `api/` or `dispatch/`.
2. Any incompatible change to the format (different prefix, different separators, different encoding, or a new key segment like `<host>`) requires bumping `ISR_CACHE_KEY_VERSION`. Writers after the bump must produce keys under the new version; the old keys expire naturally as their deployments age out. Do not reuse a version number. The `v2`→`v3` (host-scoping) bump is the cautionary example: shipping host-scoping WITHOUT the bump let a `<host>/<path>` key alias a legacy hostless `<path>` key (see Key Format), so the purger's legacy sweep is written against the `v2` namespace explicitly rather than trusting a runtime heuristic to tell the shapes apart.
3. Additive changes that extend an existing key suffix (new query parameters on the edge URL, new optional suffix segments on the KV key) are safe without a version bump as long as readers at both versions treat the absence of the new component as the previous default.
