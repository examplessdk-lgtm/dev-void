# @void/deploy-cloudflare

Public Cloudflare target adapter primitives for Void deployments.

This package owns Wrangler JSON/JSONC config reads and the final verified
Cloudflare upload boundary. Source inference and app builds remain in `void`;
provider-neutral contracts and plans remain in `@void/deploy-core`.

Existing Worker handoffs read the active version, validate resource identities,
and check the uploaded bindings before activation. Traffic-only activation uses
an isolated config to retain Worker settings and triggers. Trigger snapshots
record when configuration was preserved, so rollback can keep those settings
for versions originally deployed outside Void.

First-deployment readiness allows up to one minute for the new Worker's public
route to propagate, with bounded requests and backoff. A successful check still
requires the ready response, and Cloudflare Access denials fail immediately.
Subsequent version previews retain the shorter retry window.

Failed version uploads and first-deployment bootstraps return a bounded diagnostic
alongside the exit status and Cloudflare error code. It retains validation messages
and stack locations, strips terminal formatting, excludes stdout binding tables,
and redacts common credential formats before callers display or log it.
