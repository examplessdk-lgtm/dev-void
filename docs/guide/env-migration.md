# Environment migration

The environment model now uses `.env` for local development only and remote secrets for every server-side production value. There are no compatibility shims for the previous four-file behavior.

## 1. Consolidate local development values

Merge the values you still need locally into `.env`:

```text
.env.local
.env.development
.env.development.local
→ .env
```

Delete every `.env.*` file, `.env.example`, and `.dev.vars*` file. Void fails fast when it finds one, rather than silently applying a precedence order.

Ensure `.env` is ignored by Git:

```text
.env
```

## 2. Move production server values remotely

For managed Void projects, upload each non-client schema key:

```sh
void secret put DATABASE_URL
void secret put STRIPE_KEY
```

To migrate a production file in one pass before deleting it:

```sh
void secret sync .env.production
```

The sync command validates every entry against `env.ts`. It rejects undeclared names, invalid values, and client-prefixed names.

For direct Cloudflare deployments, select Cloudflare and use the same commands:

```sh
void connect --platform cloudflare
void secret put DATABASE_URL
void secret put STRIPE_KEY
```

Remove those keys from `vars` in `wrangler.jsonc`. Void now treats any schema-declared server key in Worker `vars` as an error.

## 3. Supply client values at build time

Move `VITE_*` production values to CI/build-shell variables, or make the value an explicit schema default:

```sh
VITE_API_ORIGIN=https://api.example.com void deploy
```

Client values are compiled into browser assets and are public.

## 4. Remove masking modifiers

Change:

```ts
export default defineEnv({
  STRIPE_KEY: string().secret(),
  VITE_API_ORIGIN: url().public(),
});
```

to:

```ts
export default defineEnv({
  STRIPE_KEY: string(),
  VITE_API_ORIGIN: url(),
});
```

Server storage is selected by the absence of the client prefix, not a modifier. Invalid input is redacted uniformly.

## 5. Replace removed commands

`void env example` was removed because `.env.example` created a second dotenv source. Treat `env.ts` as the checked-in list of names, types, defaults, and requiredness.

Then verify:

```sh
void env check
void env check --remote
void deploy
```
