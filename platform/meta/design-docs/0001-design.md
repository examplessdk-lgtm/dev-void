# Void — Design Document

**Date:** 2026-03-08
**Status:** Historical architecture record.

> This record describes the March 2026 design. For the current installation
> model and supported core, see [platform architecture](../architecture.md) and
> [the self-hosted platform guide](../../../docs/guide/self-hosted-platform.md).

Void has two halves:

- the framework and CLI in `packages/`, which give developers a Vite-native fullstack DX
- the platform in `platform/packages/`, which provisions resources, deploys apps, routes traffic, and meters usage in an operator-owned Cloudflare account

Both are maintained in this repository. The feature and roadmap sections below
record the design at the time; they do not define the supported self-hosted core.

---

## 1. Platform Architecture

### Mental Model

Void is a Vite-first framework and deployment platform for Cloudflare.

The framework turns app structure and source imports into a deployable worker + assets bundle. The platform owns the hosted control plane: auth, projects, deploys, resource provisioning, routing, usage metering, logs, and dashboard surfaces.

### High-Level System

```text
Developer machine
  ├─ Vite dev / framework dev
  ├─ voidPlugin() + adapters + codegen
  └─ void CLI (auth, deploy, db, project, secret, domain)
          │
          ▼
Void Platform API (`platform/packages/api`)
  ├─ users / projects / deployments / domains / secrets / usage
  ├─ deploy pipeline + rollback
  ├─ resource provisioning (D1, KV, R2, Queues)
  ├─ administrator UI
  └─ platform metadata in PostgreSQL via Hyperdrive
          │
          ├─ Routing KV + static-asset KV/R2
          ├─ Workers for Platforms dispatch namespace
          ├─ Analytics Engine
          └─ Cloudflare account resources
                 │
                 ├─ Dispatch (`platform/packages/dispatch`)
                 ├─ Proxy (`platform/packages/proxy`)
                 ├─ Tail (`platform/packages/tail`)
                 └─ Dashboard (`platform/packages/dashboard`)
```

### Major Moving Pieces

#### Framework package (`packages/void`)

The framework package is responsible for local DX and build-time understanding of the app.

It handles:

- Vite plugin composition
- framework detection and deploy preset resolution
- file-based routing
- pages-mode scanning and protocol generation
- codegen for typed routes, actions, queues, and DB types
- migration discovery and local execution
- build packaging and deploy upload
- runtime helpers like `void/db`, `void/kv`, `void/storage`, `void/ai`, `void/isr`, and `void/client`

#### Platform API (`platform/packages/api`)

This is the control plane.

It owns:

- OAuth login for platform users
- projects, deployments, domains, secrets, and usage APIs
- deployment records and rollout state
- binding/resource provisioning
- rollback and retention logic
- queue and cron registration
- administrator routes and views

Platform metadata lives in PostgreSQL, accessed through a Hyperdrive binding.

#### Dispatch (`platform/packages/dispatch`)

Dispatch is the data-plane entrypoint for deployed apps.

It:

- resolves slug/domain routing from KV
- sends worker projects to Workers for Platforms
- serves static/SPA deployments directly from KV/R2
- applies edge caching, redirect rules, header rules, and ISR behavior
- meters every request into Analytics Engine
- relays Cloudflare Queue batches to user workers

#### Proxy (`platform/packages/proxy`)

Proxy is the shared service layer between user apps and platform-owned capabilities.

It handles:

- Workers AI and BYOK provider traffic through AI Gateway
- authenticated remote D1/KV/R2 access during local development
- ISR revalidation forwarding from user workers back to the API

The point of the proxy is that platform-owned resources never need to be exposed directly to user code.

#### Tail (`platform/packages/tail`)

Tail is the runtime log pipeline.

It:

- receives worker tail events
- stores logs in Analytics Engine
- broadcasts live log events through a Durable Object

#### Dashboard (`platform/packages/dashboard`)

The dashboard is the user-facing product surface.

It is a Void app itself, built with Vue pages mode, and it currently mixes:

- direct reads from the platform Postgres database for loader-heavy views
- API calls for mutations, usage metrics, secrets, and domain operations

The user dashboard is a separate deployment. It is not included in the core self-hosted installation.

### Core Data Stores

Void currently uses several different storage systems, each for a different job:

- PostgreSQL via Hyperdrive: platform control-plane data
- `ROUTING` KV: active slug/domain routing, static manifests, queue routing
- `STATIC_ASSETS` KV + `STATIC_ASSETS_R2`: static/SPA deployment assets
- Analytics Engine: request metering and runtime logs
- Per-project Cloudflare resources: D1, KV, R2, Queues, and optionally Hyperdrive-backed Postgres for user apps

### Deployment Flow

There are two deploy shapes: worker deploys and static-only deploys.

#### Worker deploys (`type: "void"` or `"framework"`)

1. The CLI builds the app, detects app type/framework, scans bindings, collects migrations, and packages worker modules plus assets.
2. The CLI uploads the deploy manifest and blobs to `platform/packages/api`.
3. The API creates a deployment row and provisions missing resources.
4. The API uploads a versioned worker named `user-{slug}-{deploymentId}`.
5. The API invokes `POST /__void/migrate` on that new worker.
6. If migrations succeed, the API updates routing KV and active domains to point at the new worker.
7. Dispatch starts sending traffic to the new deployment.
8. Retention cleanup removes old retained deployments beyond the plan limit.

The key invariant is that traffic does not move until migrations succeed.

The current supported deploy manifest version is `3`.

#### Static/SPA deploys (`type: "static"` or `"spa"`)

1. The CLI builds or uploads a static directory.
2. The API content-addresses all assets by hash.
3. Assets smaller than `2 MB` go to `STATIC_ASSETS` KV; larger assets go to `STATIC_ASSETS_R2`.
4. The API writes a per-deployment manifest into routing KV.
5. Routing KV points the slug/domain at `staticDeploymentId` instead of a worker.
6. Dispatch serves the assets directly without creating a Workers for Platforms script.

This makes retained static deployments much cheaper than versioned worker deploys.

### Local Development

Local development is designed to stay close to production, but there are multiple modes.

#### Default Cloudflare mode

- `vite dev` runs through `@cloudflare/vite-plugin`
- D1, KV, and R2 are local emulations
- state persists under `.void/`
- worker code runs in a Cloudflare-like runtime during development

#### Remote bindings mode

When `remote: true` or `VOID_REMOTE=1` is enabled, D1/KV/R2 calls are replaced with proxy-backed remote bindings.

This lets a local dev session talk to real deployed resources while still using the same application code.

#### Non-Cloudflare targets

`target: "node" | "bun" | "deno"` produces a standalone server build.

These targets run an individual application without a Void platform. Platform-specific features like managed Cloudflare bindings do not apply there.

---

## 2. Framework Design

### DX Principles

The framework side of Void is trying to give developers a specific kind of experience:

- Vite is the center of gravity.
- Infrastructure should be inferred from source when possible.
- Local development should run against a runtime that behaves like production.
- Type information should flow from schema to server to client.
- The default path should be simple, but escape hatches must exist.

### Supported App Shapes

Void currently supports four broad ways to build an app.

#### Void apps

These use Void’s own framework conventions:

- `routes/` for API routes
- `pages/` for server-rendered UI
- `middleware/` for global request middleware
- `crons/` for scheduled handlers
- `queues/` for queue consumers
- `db/` for schema and migrations

This is the most opinionated and most integrated mode.

#### Meta-framework apps

Void can also act as the platform layer for supported frameworks.

Current public support is:

- TanStack Start
- React Router
- SvelteKit
- Nuxt
- Astro

In this mode the framework owns routing and rendering, while Void provides deploy packaging, binding inference, Drizzle wiring, auth/queue/cron wrappers where needed, and platform deployment.

There is Vinext-specific source in the framework packages, but it is intentionally on hold and not part of the current public support matrix.

#### Static and SPA projects

If a project has no backend surface, Void can deploy it as:

- `static`
- `spa`

These projects skip the worker path entirely and are served directly from KV/R2.

#### Non-Cloudflare targets

For self-hosting or non-platform usage, Void can also build for Node, Bun, or Deno.

### Core Developer Primitives

The framework API is intentionally small.

#### `voidPlugin()`

`voidPlugin()` is the main entrypoint.

It composes:

- routing
- pages-mode infrastructure
- Drizzle support
- migrations
- prerendering
- Cloudflare runtime integration
- target-specific behavior for non-CF builds

#### Runtime helpers

The main runtime surfaces are:

- `defineHandler`
- `defineMiddleware`
- `defineScheduled`
- `defineQueue`
- `void/db`
- `void/kv`
- `void/storage`
- `void/ai`
- `void/isr`
- `void/client`
- `void/auth`

These are meant to feel like a thin, typed layer over the runtime rather than a second hidden framework.

#### Pages mode

Pages mode is Void’s own server-rendered UI story.

Key traits:

- rendering-framework-agnostic
- server loaders and actions
- named page actions
- nested layouts
- typed forms and action helpers
- SSR on first load, lightweight client navigation after that

The adapters in `@void/{vue,react,svelte,solid}` provide the framework-specific client/runtime layer.

### Conventions Over Config

Void expects a small number of strong directory conventions:

- `routes/`
- `pages/`
- `middleware/`
- `crons/`
- `queues/`
- `db/schema.ts`
- `db/migrations/`
- `public/`

`void.json` exists for targeted overrides, not to recreate infrastructure-by-config.

Important override areas are:

- `target`
- `output`
- `database`
- `inference.bindings`
- `inference.scanDirs`
- `inference.build`
- `inference.appType`
- `routing.revalidate`
- `routing.prerender`
- `worker.compatibility_*`

### Type Pipeline

A large part of the framework value is that types are generated from the app instead of handwritten in parallel.

Today that pipeline includes:

- Drizzle schema as the DB source of truth
- route scanning and route type generation
- page action typing
- queue payload typing
- generated `.void/*.d.ts` files
- typed fetch/action/form helpers

The intended result is that database schema, validators, route inputs, route outputs, and page actions stay mechanically aligned.

### Resource Inference

Void reads application source to infer required Cloudflare resources.

That inference currently covers:

- database usage
- KV usage
- R2 usage
- AI usage
- auth
- queues
- code inside `routes/`, `pages/`, `middleware/`, `crons/`, `queues/`, and optional SSR entries

Inference is deliberately shallow enough to stay understandable. When it is not enough, `void.json` and `wrangler.json(c)` are the escape hatches.

### Escape Hatches

Void should never trap a user.

Current escape hatches include:

- explicit binding overrides
- custom build commands
- custom scan directories
- raw `wrangler.json(c)` for direct Cloudflare deploys
- non-Cloudflare targets
- framework-owned routing/SSR in meta-framework mode

The design goal is progressive disclosure, not forced lock-in.

---

## 3. Platform Features

This section is about features offered to apps after they are deployed on Void.

### Shipped Today

#### Deployment and release management

- one-command deploys from the CLI
- project linking and auth
- app-type auto-detection
- versioned worker deployments
- static/SPA deployments without WfP workers
- rollback to retained deployments
- retained-deployment cleanup by plan
- staging environment support

#### Managed infrastructure

- inferred D1/KV/R2 provisioning
- queue provisioning and relay
- cron trigger registration from `crons/`
- optional PostgreSQL mode for framework apps via Hyperdrive
- secret management
- custom domains
- remote bindings for local development

#### Runtime behavior

- edge asset serving
- ISR and on-demand revalidation
- prerender path support
- redirect and header rules
- request metering
- AI metering and usage limiting
- BYOK provider AI through AI Gateway

#### Product surfaces

- user-facing dashboard
- administrator dashboard
- deployment logs and runtime logs
- project usage views
- plan enforcement and suspension

### Planned / Roadmap

These fit the current architecture but are not fully implemented platform behavior yet.

- GitHub App push-to-deploy
- preview deployments
- preview database copies or forks
- richer deploy-status streaming UX
- per-route observability
- Core Web Vitals collection
- privacy-first product analytics
- error tracking
- better user-facing log exploration and live tailing
- team collaboration, RBAC, and audit logs
- environment promotion flows
- enterprise SSO
- first-class email integrations
- first-class WebSocket support
- integration marketplace / provider packages

### What This Platform Is Not Trying to Be

Void is not trying to re-implement every meta-framework feature itself.

The framework side should own the developer-facing fullstack ergonomics where Void is clearly differentiated. The platform side should own managed deployment, routing, metering, and hosted operations. Existing frameworks should remain first-class citizens when users prefer them.
