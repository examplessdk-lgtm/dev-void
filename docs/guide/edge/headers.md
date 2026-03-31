---
outline: deep
---

# Custom Headers

Define custom response headers in [`void.json`](../../reference/config) using the `routing.headers` field. Keys are URL patterns, values are arrays of `"Name: value"` strings.

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
      "/*.html": ["Cache-Control: no-cache"]
    }
  }
}
```

## Rules

- **Pattern keys** start with `/`. `*` matches any characters including `/`.
- **Header values** use `Name: value` format. The value may contain colons.
- All matching rules are merged. When multiple rules set the same header name, the **last match wins**.
- User-defined `Cache-Control` overrides the built-in default. The default still applies when no rule matches.

## Example: security headers

```json
{
  "routing": {
    "headers": {
      "/*": [
        "X-Frame-Options: DENY",
        "X-Content-Type-Options: nosniff",
        "Referrer-Policy: strict-origin-when-cross-origin"
      ]
    }
  }
}
```

## Example: override caching

```json
{
  "routing": {
    "headers": {
      "/*.html": ["Cache-Control: public, max-age=300"],
      "/config.json": ["Cache-Control: no-store"]
    }
  }
}
```

## Scope

Header rules apply to **all responses** served through the dispatch worker, including static assets, SSR pages, and API routes. They do not apply to:

- Hashed asset cache hits (these use immutable caching set by the dispatch worker itself)
- ISR cache responses (these have their own cache-control headers)

## Framework `_headers` files

Meta-frameworks like SvelteKit, Nuxt, and Astro generate a `_headers` file with cache rules for their hashed asset directories. Void automatically parses this file during deploy and merges the rules into the deploy manifest.

- Framework-generated rules are applied **before** `void.json` rules. Since the last match wins, `routing.headers` in `void.json` takes precedence and can override framework defaults.
- The `_headers` file is not uploaded as a static asset. Its contents are parsed and included in the manifest only.

No configuration is needed. If the framework generates a `_headers` file, it is picked up automatically.

## How headers work

1. `void deploy` reads header rules from the framework `_headers` file (if present) and `routing.headers` in `void.json`, then includes them in the deploy manifest.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker applies matching rules to static responses before edge caching.

Because rules are evaluated at the edge, there is no extra latency cost. Headers are applied inline before the response is returned and cached.
