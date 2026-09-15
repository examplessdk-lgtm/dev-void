# Meta-Framework Integration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Date:** 2026-02-16
**Status:** Implemented

---

## Overview

Void supports two modes: **default mode** (Hono-based routing, full feature set) and **framework mode** (framework handles routing/SSR, Void handles bindings, migrations, deployment).

Framework mode is **auto-detected** via `detectFramework()` — no manual `framework` option needed. Detection looks for framework-specific dependencies in `package.json`.

---

## Architecture

```
Default Mode:
  voidPlugin() → [routingPlugin, dbTypesPlugin, migrationPlugin, ...cloudflare({ config: { main, bindings } })]

Framework Mode:
  voidPlugin() → [dbTypesPlugin, migrationPlugin, ...cloudflare({ viteEnvironment: { name: "ssr" }, config: { bindings } })]
```

Key differences in framework mode:

- **No routing plugin** — framework owns routing
- **No entry.ts generation** — framework controls worker entry
- **No `config.main`** — framework provides this
- **`viteEnvironment: { name: "ssr" }`** — hooks into framework's environment
- **Expanded binding scan dirs** — scans `src/`, `app/`, `routes/`, `server/`

What IS included in framework mode:

- Binding inference (expanded scan dirs)
- Migration plugin (auto-apply on dev startup)
- DB type codegen
- Deploy CLI
- CF plugin with workerd runtime

---

## Binding Access in Frameworks

Framework server functions use `cloudflare:workers` for binding access:

```ts
import { env } from 'cloudflare:workers';

async function getUsers() {
  'use server';
  const result = await env.DB.prepare('SELECT * FROM users').all();
  return result.results;
}
```

The binding inference AST walker detects `env.DB`, `env.KV`, `env.STORAGE` from this import style.

---

## Supported Frameworks

| Framework       | Detection                       | Environment Name | Status      |
| --------------- | ------------------------------- | ---------------- | ----------- |
| TanStack Start  | `@tanstack/react-start` in deps | `"ssr"`          | Implemented |
| React Router v7 | `@react-router/dev` in deps     | `"ssr"`          | Implemented |
| SolidStart      | `solid-start` in deps           | TBD              | Planned     |

---

## Plugin Composition

```ts
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin';
import react from '@vitejs/plugin-react';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [tanstackStart(), react(), voidPlugin()],
  // framework mode auto-detected — no explicit option needed
});
```

---

See [0026-multi-framework-support.md](./0026-multi-framework-support.md) for the expanded design covering Class A/B/C frameworks.

Updated thoughts (preserved for context):

There should be 3 different types of frameworks:

- Class A: frameworks that ship as a vite plugin, and deploy to CF via CF's
  vite plugin. e.g. Tanstack Start, React Router. Already covered above.
- Class B: frameworks that ship as a vite plugin, but comes with its own
  adapter: SvelteKit
- Class C: frameworks that come with their own CLIs + adapters - Nuxt (via
  Nitro), Astro

The goal is to for `void deploy` to support all of them.

Frameworks won't get support for features that rely on worker codegen, e.g. auth, queues and crons.

For class A, the void plugin, by depending on cloudflare plugin, handles local dev env, and also ensures correct manifest generation.

Class A & B will include `voidPlugin()` in their Vite config, in order to enjoy a subset of void features such as auto binding inference, `import { db } from 'void/db'` with type safety.

Class C frameworks will handle everything all the way to the produced bundle
and wrangler config. They do not include the `voidPlugin()` in the Vite config at all. `void deploy` will have a preset for known frameworks in this category and will generate the right wrangler.json internally automatically. Since there will be no binding inference, users will be required to explciitly declare
needed bindings in `void.json`. Basically, Void is only a deploy CLI for frameworks in this category and provide no DX support.
