---
outline: deep
---

# Environment Variables

Void uses Vite's standard `.env` convention for environment variables.

## `.env` (committed)

Non-secret configuration. All variables are injected into the worker `env` object. Variables prefixed with `VITE_` are also available on `import.meta.env` in client code.

```
API_URL=https://api.example.com
VITE_APP_TITLE=My App
```

Access in route handlers via `c.env`:

```ts
export const GET = defineHandler((c) => {
  const apiUrl = c.env.API_URL;
  return { apiUrl };
});
```

## `.env.local` (gitignored)

Secrets for local development. This file should be added to `.gitignore` and never committed.

```
GITHUB_SECRET=your-github-client-secret
STRIPE_KEY=sk_test_...
```

To push local secrets to production, use [`void secret sync`](../reference/cli#void-secret-sync).

## How it works

**Dev** (`vite dev`): All `.env` files are loaded, including `.env.local` and `.env.production.local`. Secrets are available locally via `c.env`.

**Deploy** (`void deploy`): only `.env` and `.env.production` are included in the deploy manifest as `plain_text` bindings. `.local` files such as `.env.local` and `.env.production.local` are excluded because they are meant for local secrets only.

**Production secrets**: Use [`void secret put`](../reference/cli#void-secret-put) or [`void secret sync`](../reference/cli#void-secret-sync) to set secret bindings on your deployed worker. These are stored as encrypted `secret_text` bindings, not plain text.
