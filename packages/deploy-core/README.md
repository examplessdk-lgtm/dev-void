# @void/deploy-core

Shared deployment contracts for the Void SDK and hosted Void platform.

This package owns the wire types exchanged by the `void` CLI and the managed
platform, including deployment manifests, progress events, assets, routing
rules, queues, append-only Durable Object migration planning and metadata, normalized upload artifacts, runtime
manifest validation, and provider-neutral resource planning. It has no
dependency on either deployment target and must remain usable from Node.js and
Cloudflare Workers.

The package also defines the adapter boundary implemented by deployment
targets. Target-specific orchestration belongs in `void` or `platform/`, not
here.
