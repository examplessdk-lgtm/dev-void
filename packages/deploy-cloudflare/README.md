# @void/deploy-cloudflare

Public Cloudflare target adapter primitives for Void deployments.

This package owns Wrangler JSON/JSONC config reads and the final verified
Cloudflare upload boundary. Source inference and app builds remain in `void`;
provider-neutral contracts and plans remain in `@void/deploy-core`.
