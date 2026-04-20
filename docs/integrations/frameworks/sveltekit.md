---
outline: deep
---

# SvelteKit

[SvelteKit](https://svelte.dev/docs/kit) uses Vite internally with its own Cloudflare adapter (`@sveltejs/adapter-cloudflare`). Add `voidPlugin()` to the Vite config for binding inference, typed DB, and migrations during development.

## Setup

### 1. Create a new project

```bash
npx sv create my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D @sveltejs/adapter-cloudflare void
```

### 3. Configure `svelte.config.js`

```js
import adapter from '@sveltejs/adapter-cloudflare';

export default {
  kit: { adapter: adapter() },
};
```

### 4. Add `voidPlugin()` to `vite.config.ts`

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { voidPlugin } from 'void';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [voidPlugin(), sveltekit()],
});
```

### 5. Create `wrangler.jsonc`

SvelteKit's adapter reads bindings from `wrangler.jsonc` for local dev. `voidPlugin()` auto-syncs inferred bindings into this file on dev startup, so you only need the base config:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
}
```

### 6. Deploy

```bash
void auth login
void deploy
```

## Using Void Platform Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with SvelteKit. Use them in server load functions, actions, and API routes:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official SvelteKit integration directly for now.

### Database

```ts
// src/routes/users/+page.server.ts
import { db } from 'void/db';
import { users } from '@schema';

export async function load() {
  return { users: await db.select().from(users) };
}
```

### KV Storage

```ts
import { kv } from 'void/kv';

export async function load() {
  return { settings: await kv.get('app:settings') };
}
```

### Blob Storage

```ts
import { storage } from 'void/storage';

export async function load() {
  return { avatar: await storage.get('avatars/user-1.png') };
}
```

### AI

```ts
import { ai } from 'void/ai';

export const actions = {
  summarize: async () => {
    return ai.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: 'Summarize the latest news',
    });
  },
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

Void gives you a typed env layer: declare keys in `env.ts`, read them via `import { env } from "void/env"`, and get schema validation at build + deploy time plus a client-leak guard that fails the build if a server-only key reaches the browser. See the [env vars guide](../../guide/env-vars.md) for the full feature set.

SvelteKit-specific notes:

- Server-side reads work through a hook Void injects into `src/hooks.server.ts` — `import { env } from "void/env"` inside `+page.server.ts` / `+server.ts` works with no extra wiring.
- SvelteKit's `$env/static/*` and `$env/dynamic/*` APIs still work and are a better fit when you want separate `private` / `public` namespaces or `$env/static/private` validated at build time. Void's `env` doesn't displace them — pick per call site.

## Accessing Bindings Directly

You can also use SvelteKit's `platform.env` in server hooks and load functions:

```ts
// src/routes/users/+page.server.ts
export async function load({ platform }) {
  const { results } = await platform.env.DB.prepare('SELECT * FROM users').all();
  return { users: results };
}
```

Or the `cloudflare:workers` module:

```ts
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
