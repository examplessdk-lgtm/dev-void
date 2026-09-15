---
title: ISR Cache — R2 to KV Migration
status: approved
created: 2026-03-03
---

# ISR Cache — R2 to KV Migration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Motivation

ISR cached pages are rendered HTML — well under KV's 25 MiB value limit. KV provides faster reads than R2 (built-in regional caching), a simpler API, and native edge distribution. Switching the ISR persistent store from R2 to KV simplifies the architecture and improves L2 cache latency.

## Architecture

Two-layer cache, unchanged in shape — only the L2 backing store changes:

```
L1 (unchanged):  caches.default — per-colo edge cache via Cache-Control headers
L2 (R2 → KV):   ISR_CACHE KV namespace — binary-packed responses
```

`caches.default` remains L1 because:

- KV's `cacheTtl` minimum is 30s and cannot be purged externally
- On-demand revalidation requires instant global purge (Zone Cache Purge API)
- Edge cache `s-maxage` gives precise per-response TTL control

## Value Format

Binary length-prefix packing — zero overhead on the response body:

```
┌──────────────────┬─────────────────────┬─────────────────┐
│ 4 bytes (uint32) │ N bytes (UTF-8 JSON)│ remaining bytes │
│ header length    │ serialized headers  │ raw body        │
└──────────────────┴─────────────────────┴─────────────────┘
```

KV metadata (small fixed fields, easily fits 1024 bytes):

```ts
{
  s: number;
  c: number;
  t: number;
} // status, createdAt, ttl
```

**Write path:**

1. `response.arrayBuffer()` → get body bytes
2. `JSON.stringify(headers)` → encode to UTF-8
3. Prepend 4-byte uint32 LE length + header bytes to body
4. `ISR_CACHE.put(key, combined, { metadata: { s, c, t } })`

**Read path:**

1. `ISR_CACHE.getWithMetadata(key, "arrayBuffer")`
2. Read first 4 bytes as uint32 LE → `headerLen`
3. Slice `[4, 4+headerLen]` → `JSON.parse()` → response headers
4. Slice `[4+headerLen, end]` → response body

## Infrastructure

New KV namespace bound to both `dispatch` and `api` workers:

| Environment | Binding     | Namespace name           |
| ----------- | ----------- | ------------------------ |
| Production  | `ISR_CACHE` | `void-isr-cache`         |
| Staging     | `ISR_CACHE` | `void-isr-cache-staging` |

## File Changes

| File                                    | Change                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `dispatch/src/env.ts`                   | Replace `ASSETS: R2Bucket` → `ISR_CACHE: KVNamespace`   |
| `dispatch/src/isr.ts`                   | Rewrite read/write/delete for KV + binary pack/unpack   |
| `dispatch/wrangler.jsonc`               | Remove `r2_buckets`, add `ISR_CACHE` kv_namespaces      |
| `api/src/env.ts`                        | Add `ISR_CACHE: KVNamespace`                            |
| `api/wrangler.jsonc`                    | Add `ISR_CACHE` kv_namespaces (prod + staging)          |
| `api/src/routes/deploy.ts`              | `clearIsrCache`: KV list+delete; prerender: pack+KV put |
| `api/src/routes/internal-revalidate.ts` | R2 ops → KV ops                                         |
| `dispatch/test/unit/isr.test.ts`        | Update for new format                                   |

## What Stays the Same

- Edge cache (L1): `caches.default`, `Cache-Control` headers, stale-while-revalidate flow
- Zone Cache Purge API for on-demand revalidation
- Key format: `${projectId}/isr/${normalized}`
- Staleness: manual check via `createdAt` + `ttl` in metadata (no `expirationTtl`)
- Pages protocol JSON edge cache
- Public API: `revalidate()` from `void/isr`, `x-revalidate` response header

## Migration

No data migration — ISR cache is ephemeral (cleared on every user deploy). After platform deploy, existing R2 ISR entries become orphaned (new code reads from KV). A one-time cleanup script deletes `*/isr/*` keys from the R2 ASSETS bucket.
