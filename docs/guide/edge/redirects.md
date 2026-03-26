---
outline: deep
---

# Redirects

Define URL redirects in [`void.json`](../../reference/config) using the `routing.redirects` field. Keys are source URL patterns, values are destination strings or objects with an explicit status.

```json
{
  "routing": {
    "redirects": {
      "/old": "/new",
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

## Rules

- **Source patterns** start with `/`. `*` matches any characters including `/`.
- **Destinations** can be strings (defaults to `302` temporary redirect) or objects with `to` and optional `status` (`301`, `302`, `307`, `308`).
- `:splat` in the destination is replaced with the portion of the path matched by `*` in the source pattern.
- When multiple rules match, the **last match wins**.
- Redirects are evaluated **before** the request reaches the worker, so they short-circuit static asset serving, ISR, and SSR.

## Example: permanent redirect

```json
{
  "routing": {
    "redirects": {
      "/old-page": { "to": "/new-page", "status": 301 }
    }
  }
}
```

## Example: path prefix migration

```json
{
  "routing": {
    "redirects": {
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

A request to `/blog/hello-world` redirects to `/posts/hello-world` with a `301` status.

## Framework `_redirects` files

Meta-frameworks may generate a `_redirects` file during build. Void parses this file at deploy time and merges the rules into the deploy manifest.

- Framework-generated rules are applied **before** `void.json` rules. Since the last match wins, `routing.redirects` in `void.json` takes precedence.
- Only 3xx redirect rules are included. Rewrite rules (status `200`) in `_redirects` files are ignored.
- The `_redirects` file is not uploaded as a static asset. Its contents are parsed and included in the manifest only.

## How redirects work

1. `void deploy` reads redirect rules from the framework `_redirects` file (if present) and `routing.redirects` in `void.json`, then includes them in the deploy manifest.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker checks redirect rules before any worker invocation, so matching requests get a redirect response immediately.

Because rules are evaluated at the edge before invoking the worker, redirects add no latency to the request path.
