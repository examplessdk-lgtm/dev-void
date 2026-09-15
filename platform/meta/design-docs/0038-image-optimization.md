# Image Optimization

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-28
**Status:** Design

---

## Summary

Add framework-level image optimization to Void using Cloudflare's `IMAGES` binding. An `<Image>` component (shipped in each framework adapter) generates responsive `srcSet` URLs pointing to a `/_void/image` endpoint in the user's worker. At runtime, the endpoint fetches the source asset, transforms it via `env.IMAGES`, and serves the optimized image with immutable caching and content negotiation (AVIF > WebP > JPEG). In dev mode, the endpoint passes through to the original asset with no transformation.

## Motivation

Image optimization is table-stakes for modern web frameworks. Next.js, Nuxt, and Astro all provide built-in `<Image>` components that handle responsive srcSet generation, format negotiation, and on-demand resizing. Without this, Void users must manually create responsive images or reach for third-party solutions.

Cloudflare's native `IMAGES` binding makes this cheap to implement — no external service, no sharp dependency at runtime, no build-time variant generation. The binding handles resize + transcode at the edge with a single API call.

## Architecture

### Layers

1. **`void/image`** — shared utilities in the base `void` package (URL construction, config types, validation)
2. **Framework adapter components** — `<Image>` in each adapter (`@void/vue`, `@void/react`, `@void/svelte`, `@void/solid`), imported via `@void/vue`, `@void/react`, etc.
3. **`/_void/image` endpoint** — injected into the worker entry as middleware (before user routes)
4. **Binding auto-detection** — `needsImages` flag in inference, provisions `IMAGES` binding
5. **Vite plugin** — `void:image-imports` extracts width/height from static image imports

### Request Flow

```
<Image src="/hero.jpg" width={1080} height={720} />
  ↓ renders to
<img src="/_void/image?url=%2Fhero.jpg&w=1080&q=75"
     srcset="/_void/image?url=...&w=640&q=75 640w, ...&w=1080&q=75 1080w, ..."
     sizes="100vw" loading="lazy" decoding="async" />
  ↓ browser requests with Accept header
Worker intercepts /_void/image
  → parse & validate params (url, w, q)
  → fetch source from env.ASSETS
  → negotiate format from Accept (AVIF > WebP > JPEG)
  → env.IMAGES.input(body).transform({ width }).output({ format, quality })
  → respond with Cache-Control: immutable, Vary: Accept
```

### Dev Mode

No `IMAGES` binding available. The `/_void/image` endpoint redirects to the original asset path (passthrough). The component still generates `/_void/image` URLs so markup is production-identical.

## Component API

Next.js-compatible props:

| Prop          | Type                        | Default        | Description                                  |
| ------------- | --------------------------- | -------------- | -------------------------------------------- |
| `src`         | `string \| StaticImageData` | required       | Image path or static import                  |
| `alt`         | `string`                    | required       | Accessibility text                           |
| `width`       | `number`                    | required\*     | Intrinsic width (\*not required if `fill`)   |
| `height`      | `number`                    | required\*     | Intrinsic height (\*not required if `fill`)  |
| `fill`        | `boolean`                   | `false`        | Stretch to fill parent (absolute positioned) |
| `priority`    | `boolean`                   | `false`        | Eager loading + high fetch priority          |
| `quality`     | `number`                    | `75`           | 1-100                                        |
| `sizes`       | `string`                    | `100vw` (fill) | Responsive sizes attribute                   |
| `placeholder` | `"blur" \| "empty"`         | `"empty"`      | Blur-up placeholder                          |
| `blurDataURL` | `string`                    | —              | Base64 data URL for blur placeholder         |
| `loader`      | `(params) => string`        | —              | Custom URL builder (escape hatch)            |
| `unoptimized` | `boolean`                   | `false`        | Skip optimization entirely                   |

### Static Image Imports

Vite plugin `void:image-imports` transforms static imports:

```ts
import hero from './hero.jpg';
// → { src: "/assets/hero-abc123.jpg", width: 1920, height: 1080 }
```

Uses `image-size` package at build time to extract dimensions. Cached per file path.

### Responsive Widths

Default device/image sizes (same as Next.js):

- `deviceSizes`: `[640, 750, 828, 1080, 1200, 1920, 2048, 3840]`
- `imageSizes`: `[16, 32, 48, 64, 96, 128, 256, 384]`

Component generates srcSet entries only for widths ≤ `originalWidth * 2` (prevent upscaling).

## Optimization Endpoint

`GET /_void/image?url=<path>&w=<width>&q=<quality>`

### Validation

- `url` must be path-relative (starts with `/`, no `//`, no backslashes)
- `w` must be 0 (no resize) or in the allowed widths set (max 3840)
- `q` must be 1-100
- SVG blocked (can contain embedded JavaScript)

### Response Headers

```
Cache-Control: public, max-age=31536000, immutable
Vary: Accept
Content-Security-Policy: script-src 'none'; frame-src 'none'; sandbox
X-Content-Type-Options: nosniff
```

### Error Responses

- Invalid params → 400
- Asset not found → 404
- IMAGES binding missing → 500
- SVG requested → 400

## Binding Auto-Detection

Follows the existing `void/ai` pattern:

**Tier 1 (import detection):** `import { Image } from "@void/vue"` where the component is used → `needsImages = true`

**Tier 2 (regex):** `/\benv\s*\.\s*IMAGES\b/`

**Tier 3 (AST walk):** Member expression `IMAGES` on env object.

**Deploy manifest:** `bindings.images = true`

**Platform provisioning:** API adds the native CF `IMAGES` binding to the user worker config during deploy.

## Configuration

In `void.json`:

```json
{
  "image": {
    "deviceSizes": [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    "imageSizes": [16, 32, 48, 64, 96, 128, 256, 384],
    "quality": 75,
    "formats": ["avif", "webp"],
    "remotePatterns": [{ "protocol": "https", "hostname": "**.example.com" }],
    "domains": ["cdn.example.com"]
  }
}
```

All fields optional — sensible defaults if omitted. Config injected at build time via Vite `define`.

## Security

- **SSRF prevention:** Only path-relative URLs allowed (no absolute URLs, no protocol-relative)
- **SVG blocking:** SVGs can embed JavaScript; blocked at the endpoint
- **CSP on responses:** `script-src 'none'; frame-src 'none'; sandbox`
- **Remote pattern validation:** Remote images validated against configured `remotePatterns`/`domains` with glob matching
- **Content-Type sniffing prevention:** `X-Content-Type-Options: nosniff`

## Framework Adapter Implementation

Each adapter exports `Image` from its runtime module:

- `@void/vue` → `<Image>` Vue component (SFC or render function)
- `@void/react` → `Image` React component
- `@void/svelte` → `<Image>` Svelte component
- `@void/solid` → `Image` Solid component

All import shared utilities from `void/image` (URL construction, config, validation). Users import via their framework module: `import { Image } from "@void/vue"`.

## Open Questions

- Should the `IMAGES` binding be provisioned on all user workers by default (zero-config) or only when detected via imports? Recommend: only when detected, consistent with `AI` binding.
- Should remote image optimization be supported in v1, or local assets only? Recommend: local-only for v1, add remote patterns later.
- Blur placeholder generation: should the framework auto-generate blurDataURL during build (like Next.js), or require users to provide it? Recommend: manual for v1, auto-generate later.
