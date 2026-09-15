# Headers & Redirects in void.json

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-27
**Status:** Draft

---

## Summary

Wire `void.json` `headers` and `redirects` config into the deploy pipeline by generating `_headers` and `_redirects` files in the build output. These are natively supported by Cloudflare Workers Static Assets — no custom runtime code needed.

Users with SSR/API routes who need server-side redirects can implement them in their own middleware or route handlers.

## Background

The `headers` field already exists in `VoidConfig` and is validated, but never used during deploy. The deploy pipeline hardcodes a default `_headers` file with cache-control rules. This design fixes that gap and adds `redirects` using the same pattern.

Cloudflare Workers Static Assets natively parses `_headers` and `_redirects` files from the assets directory and applies them to static asset responses. Requests handled by Worker code (SSR, API routes) are **not** affected by these files.

## void.json Schema

### Headers (existing, unchanged)

```json
{
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/api/*": ["Access-Control-Allow-Origin: *"]
  }
}
```

Keys are path patterns (supports `*` wildcard at end of segment). Values are arrays of `Header: Value` strings.

### Redirects (new)

```json
{
  "redirects": {
    "/old-page": "/new-page",
    "/blog/*": { "to": "/posts/:splat", "status": 301 }
  }
}
```

Keys are source path patterns. Values are either:

- **String** — destination path, defaults to status 302
- **Object** — `{ "to": string, "status": 301 | 302 | 307 | 308 }`

Supports `*` wildcard with `:splat` reference in destination, and `:placeholder` named params for single-segment captures. This matches the Cloudflare `_redirects` syntax.

## Build-Time File Generation

During deploy (in `deploy.ts`), after the Vite build completes:

1. **`_headers`**: If no `_headers` file exists in the user's `public/` directory, generate one from `void.json` `headers` config. Prepend the default cache-control rules (immutable for hashed assets, revalidate for everything else).
2. **`_redirects`**: If no `_redirects` file exists in the user's `public/` directory, generate one from `void.json` `redirects` config.

Both files are written to `dist/client/` and uploaded as static assets.

If the user provides their own `_headers` or `_redirects` in `public/`, skip generation for that file — the user's file is copied to the output as-is by Vite's `public/` directory handling.

### Generated `_headers` Format

```
# Default cache rules
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*
  Cache-Control: public, s-maxage=60, max-age=0, must-revalidate

# From void.json
/api/*
  Access-Control-Allow-Origin: *
```

### Generated `_redirects` Format

```
/old-page /new-page 302
/blog/* /posts/:splat 301
```

## Scope

- Static asset responses only (Cloudflare native behavior)
- No runtime middleware — users who need server-side redirects use route handlers or middleware
- `convertHeadersConfig()` and `parseHeadersFile()` (existing dead code) can be reused/adapted
- The `_headers` / `_redirects` generation replaces the current hardcoded `_headers` generation in `deploy.ts`

## Files to Change

| File                               | Change                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/void/src/config.ts`      | Add `redirects` to `VoidConfig`, add `convertRedirectsConfig()`, validation             |
| `packages/void/src/cli/deploy.ts`  | Replace hardcoded `_headers` generation with config-driven generation for both files    |
| `packages/void/src/cli/headers.ts` | Rename to something more general or add redirect conversion alongside header conversion |
