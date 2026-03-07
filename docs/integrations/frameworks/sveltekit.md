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
import adapter from "@sveltejs/adapter-cloudflare";

export default {
  kit: { adapter: adapter() },
};
```

### 4. Add `voidPlugin()` to `vite.config.ts`

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { voidPlugin } from "void";
import { defineConfig } from "vite";

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

All [Void platform features](../../guide/app-types.md#void-apps) work with SvelteKit. Use them in server load functions, actions, and API routes:

### Database

```ts
// src/routes/users/+page.server.ts
import { db } from "void/db";
import { users } from "@schema";

export async function load() {
  return { users: await db.select().from(users) };
}
```

### Auth

Use `getUser()` from `void/auth` to access the authenticated user in server load functions and actions:

```ts
// src/routes/profile/+page.server.ts
import { getUser } from "void/auth";

export async function load() {
  const user = getUser();
  if (!user) throw redirect(302, "/login");
  return { user };
}
```

See [Authentication](../../guide/auth.md) for setup, providers, and the full API.

### KV Storage

```ts
import { kv } from "void/kv";

export async function load() {
  return { settings: await kv.get("app:settings") };
}
```

### Blob Storage

```ts
import { storage } from "void/storage";

export async function load() {
  return { avatar: await storage.get("avatars/user-1.png") };
}
```

### AI

```ts
import { ai } from "void/ai";

export const actions = {
  summarize: async () => {
    return ai.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "Summarize the latest news",
    });
  },
};
```

### Cron Jobs

```ts
// crons/daily-cleanup.ts
import { defineScheduled } from "void";

export const cron = "0 0 * * *";

export default defineScheduled(async () => {
  // runs daily at midnight
});
```

### Queue Consumers

```ts
// queues/emails.ts
import { defineQueue } from "void";

export default defineQueue<{ to: string; subject: string }>(async (batch) => {
  for (const msg of batch.messages) {
    // process each message
    msg.ack();
  }
});
```

## Accessing Bindings Directly

You can also use SvelteKit's `platform.env` in server hooks and load functions:

```ts
// src/routes/users/+page.server.ts
export async function load({ platform }) {
  const { results } = await platform.env.DB.prepare("SELECT * FROM users").all();
  return { users: results };
}
```

Or the `cloudflare:workers` module:

```ts
import { env } from "cloudflare:workers";

const { results } = await env.DB.prepare("SELECT * FROM users").all();
```
