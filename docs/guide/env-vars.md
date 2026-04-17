---
outline: deep
---

# Environment Variables

Void provides typed, validated environment variables via a single `env.ts` file at the root of your project. The schema serves three purposes:

1. **Runtime validation** — declared keys are validated on first access; missing/invalid values produce a clear error
2. **TypeScript** — `env.X` and `c.env.X` become typed automatically (no manual interface to maintain)
3. **Deploy safety** — `void deploy` refuses to upload if a required key is missing from `.env*` files or remote secrets

## `env.ts` (recommended)

Place an `env.ts` at your project root and call `defineEnv` once:

```ts
// env.ts
import { defineEnv, string, number, boolean, oneOf, url } from 'void/env';

export default defineEnv({
  STRIPE_KEY: string(),
  PORT: number().default(3000),
  NODE_ENV: oneOf(['development', 'production']),
  WEBHOOK_URL: url(),
  DEBUG: boolean().optional(),
  VITE_APP_TITLE: string(),
});
```

Then read values from anywhere in your app:

```ts
import { env } from 'void/env';

console.log(env.STRIPE_KEY); // typed as string
console.log(env.PORT); // typed as number
```

`c.env.STRIPE_KEY` inside Hono handlers is also typed once the schema is declared.

### Built-in helpers

`string()`, `number()`, `boolean()`, `url()`, `email()`, `oneOf([...])`, `json<T>()` cover the common cases. Each helper returns a Standard Schema-conformant builder with `.optional()` and `.default(value)` modifiers.

For richer validation (regex, transforms, branded types), drop in any [Standard Schema](https://standardschema.dev) library — valibot, zod, or arktype work out of the box, and you can mix them with the built-ins:

```ts
import * as v from 'valibot';

export default defineEnv({
  STRIPE_KEY: string(), // built-in
  WEBHOOK_URL: v.pipe(v.string(), v.url(), v.endsWith('/webhook')), // valibot
});
```

### Client vs server

Keys prefixed with `VITE_` are exposed to client code (Vite already enforces this at the bundler level). All other keys are server-only — accessing one from a client module throws a clear runtime error pointing at the fix.

## `.env` files

Void uses Vite's standard `.env` convention to populate the schema:

| File                    | Loaded in dev | Shipped on deploy  |
| ----------------------- | ------------- | ------------------ |
| `.env`                  | yes           | yes (`plain_text`) |
| `.env.local`            | yes           | no                 |
| `.env.production`       | yes           | yes (`plain_text`) |
| `.env.production.local` | yes           | no                 |

`.local` files are gitignored by convention — use them for secrets you don't want in source control.

## Production secrets

For values that should never live in a `.env` file (Stripe keys, OAuth secrets, etc.), upload them as encrypted secret bindings on your deployed worker:

```bash
void secret put STRIPE_KEY            # prompts for value
void secret put STRIPE_KEY < key.txt  # from stdin
void secret sync .env.production      # bulk upload from a dotenv file
void secret list
void secret delete STRIPE_KEY
```

Remote secrets count as "present" for deploy validation — `void deploy` checks both `.env*` and the remote secret list before uploading.

## Defaults

Schema defaults from `defineEnv({ PORT: number().default(3000) })` flow into both:

- The typed `env` proxy: `env.PORT` returns `3000` when no value is set.
- Worker bindings (`c.env.PORT`, `process.env.PORT` on Node target): the
  default value is injected as a stringified `var` in dev, in `void deploy`
  manifests, and in prerender bindings, so any code path that reads the raw
  env sees the same fallback.

User-provided `.env` / shell values always win — defaults only fill gaps.

## Validation behavior

| Phase                | Behavior                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Dev server start     | Warns about missing/invalid keys (does not block).                                                               |
| First runtime access | Throws `EnvValidationError` with the failing key and reason.                                                     |
| `void env check`     | Validates `.env` + `.env.production` (and optionally remote secrets with `--remote`); exits non-zero on failure. |
| `void deploy`        | Hard-errors before upload if any required key is missing from the union of `.env*` and remote secrets.           |

Use `void env check --remote` in CI before deploying — it catches missing prod secrets without running a full build.

## Manual type regeneration

Types are auto-generated to `.void/env.d.ts` on dev server start and whenever `env.ts` changes. To regenerate manually (e.g. after a fresh clone):

```bash
void env types
```

## Scaffolding `.env.example`

Generate (or refresh) a `.env.example` from your `env.ts` schema:

```bash
void env example           # creates or refreshes the void-managed block
void env example --force   # silences the "appended block" notice (use in CI)
```

`void env example` manages a marker-delimited block inside `.env.example` — anything outside the markers (custom CI tokens, build flags, comments) is preserved verbatim across refreshes. The block looks like this:

```ini
# >>> void env: managed block — do not edit between markers <<<
# Run `void env example` to refresh.
# required
STRIPE_KEY=
# with defaults
PORT=3000
# >>> end void env <<<
```

On first run, Void writes a fresh `.env.example` containing only the marker block. On subsequent runs, only the lines between the markers are replaced. If the file already exists with no markers, the block is appended at the end and Void prints a one-line notice (suppressed by `--force`).

The managed block is grouped into `required`, `with defaults`, and `optional` sections. Keys defined via `oneOf([...])` get a leading `# enum: A | B | C` comment listing the valid values, and keys with a `.default(x)` are prefilled. Commit the `.env.example` — it's the single source of truth for teammates and coding agents setting up the project.

## Migration from untyped `c.env`

If you don't have an `env.ts`, `c.env.X` continues to work as `unknown` — no breaking change. To opt in, create `env.ts`, declare your keys, and the existing call sites become typed automatically. The recommended access pattern for new code is `import { env } from "void/env"`.
