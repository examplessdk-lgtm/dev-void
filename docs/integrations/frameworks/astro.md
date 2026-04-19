---
outline: deep
---

# Astro

[Astro](https://astro.build/) has its own CLI and Cloudflare adapter (`@astrojs/cloudflare`). Add `voidPlugin()` to Astro's Vite config for binding inference, typed DB, and migrations during development.

::: warning Astro 6 required

- [Astro 6+](https://astro.build/blog/astro-6/) is required to use `import { x } from "void/x"` helpers in Astro apps.
- You also need to enable `"nodejs_als"` under `compatibility_flags` in your wrangler config.
  :::

## Setup

### 1. Create a new project

```bash
npm create astro@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D @astrojs/cloudflare void
```

### 3. Configure `astro.config.mjs`

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { voidPlugin } from 'void';

export default defineConfig({
  adapter: cloudflare(),
  vite: { plugins: [voidPlugin()] },
});
```

By default, Astro Cloudflare runtime and `voidPlugin()` migrations share Wrangler's local state at `.wrangler/state/v3`, so no extra persistence configuration is required.

### 4. Create `wrangler.jsonc`

`voidPlugin()` auto-syncs inferred bindings into this file on dev startup:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_als"],
}
```

`nodejs_als` is required for `void/*` runtime helpers (for example `void/db`, `void/kv`) in Astro.

### 5. Deploy

```bash
void auth login
void deploy
```

## Using Void Platform Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with Astro in both local dev and production when using Astro 6+ with `nodejs_als`.

Void-managed auth is not supported in framework mode yet. Use Better Auth's official Astro integration directly for now.

Pages that access runtime bindings must opt out of prerendering:

```astro
---
export const prerender = false;
// now Astro.locals.runtime is available
---
```

### Database

Use `void/db` in API routes and server-side code:

```ts
import type { APIRoute } from 'astro';
import { db } from 'void/db';
import { users } from '@schema';

export const GET: APIRoute = async () => {
  const rows = await db.select().from(users);
  return Response.json(rows);
};
```

### KV Storage

Use `void/kv` in both dev and production:

```ts
import type { APIRoute } from 'astro';
import { kv } from 'void/kv';

export const GET: APIRoute = async () => {
  const settings = await kv.get('app:settings');
  return Response.json(settings);
};
```

### Blob Storage

```ts
import type { APIRoute } from 'astro';
import { storage } from 'void/storage';

export const GET: APIRoute = async () => {
  const avatar = await storage.get('avatars/user-1.png');
  return new Response(avatar);
};
```

### AI

```ts
import type { APIRoute } from 'astro';
import { ai } from 'void/ai';

export const POST: APIRoute = async () => {
  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    prompt: 'Summarize the latest news',
  });
  return Response.json(result);
};
```

### Cron Jobs

```ts
// crons/daily-cleanup.ts
import { defineScheduled } from 'void';

export const cron = '0 0 * * *';

export default defineScheduled(async () => {
  // runs daily at midnight
});
```

### Queue Consumers

```ts
// queues/emails.ts
import { defineQueue } from 'void';

export default defineQueue<{ to: string; subject: string }>(async (batch) => {
  for (const msg of batch.messages) {
    // process each message
    msg.ack();
  }
});
```

### Environment Variables

Void's CLI env features work with Astro — runtime reads do not. Use `env.ts` as the single schema source of truth and read actual values via Astro's own mechanisms.

**What works:**

- `void env check [--remote]` validates `.env*` + remote secret names against your `env.ts`.
- `void deploy` hard-fails before upload if required keys are missing.
- `void env example` generates a managed `.env.example` block from the schema.

**What does NOT work in Astro mode:**

- `import { env } from "void/env"` on both server and client — Astro's adapter resolves `void/env` to the client variant in both contexts, so every non-`VITE_` key throws with "Env key … is not exposed to the client." Use `Astro.locals.runtime.env` or [`astro:env`](https://docs.astro.build/en/guides/environment-variables/) instead.
- Typed `env.d.ts`, the client-leak guard, and constant folding are not wired.

```ts
// env.ts — single schema source of truth
import { defineEnv, string } from 'void/env';
export default defineEnv({ STRIPE_KEY: string() });

// src/pages/api/charge.ts — read via Astro
export const POST: APIRoute = async ({ locals }) => {
  const { STRIPE_KEY } = locals.runtime.env;
  // …
};
```

See the [env guide](../../guide/env-vars.md) for the schema feature set.

## Accessing Bindings Directly

Access bindings via `Astro.locals.runtime.env` (works in both dev and production):

```ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare('SELECT * FROM users').all();
  return Response.json(results);
};
```

In `.astro` pages (remember to set `prerender = false`):

```astro
---
export const prerender = false;
const { DB } = Astro.locals.runtime.env;
const { results } = await DB.prepare("SELECT * FROM users").all();
---
```

::: tip Direct Binding Access
`Astro.locals.runtime.env` is still useful when you need direct access to raw Cloudflare bindings.
:::
