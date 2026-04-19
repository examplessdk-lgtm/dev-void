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

::: tip Scaffolded on `void init`
If you already have `.env` or `.env.example` files when you run `void init`, Void generates an `env.ts` seeded from those keys. Inference is conservative — values that unambiguously parse as a boolean (`true`/`false`), an `http(s)://` URL, or a small integer get typed accordingly; everything else stays `string()`. The generated file carries a banner comment asking you to review and tighten types before running dev.
:::

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

Keys matching Vite's `envPrefix` (default `VITE_`) are exposed to client code; Vite enforces this at the bundler level. All other keys are server-only — referencing one from a client module fails the build with a file:line:col error from `void:env-client-guard`, and the runtime proxy still throws as a backstop.

If your project sets a custom `envPrefix` (e.g. `'PUBLIC_'` or an array like `['PUBLIC_', 'NEXT_PUBLIC_']`) in `vite.config.ts`, the build guard honours it automatically. Schema keys that match any configured prefix pass the client check.

### Vite `define` interop

Vite's `define` option performs build-time literal replacement (e.g. `define: { 'process.env.VERSION': '"1.0"' }`). It does **not** flow through schema validation or the typed `env` proxy — using both `define` and `defineEnv` for the same name causes silent skew (compiled client code sees the define value, runtime proxy and validation see the schema source). Void emits a warning at config time when this overlap is detected.

### `envDir`

Void honours Vite's `envDir` option for `.env` file loading (both the worker `vars` injection and dev-time validation). Defaults to the project root. The deploy CLI still reads from the project root regardless — keep production `.env` files there.

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

## How it compares

Most frameworks ship _parts_ of an env story — loading, typing, validation, deploy checks — but stitching them together is left to the user. Here's how Void's single `env.ts` stacks up against the tools people reach for today.

| Feature                                         | Void `env.ts` | `@t3-oss/env` | Astro `astro:env` | SvelteKit `$env` | Vite `import.meta.env` | Nuxt `runtimeConfig` | `dotenv` + `zod` (DIY) |
| ----------------------------------------------- | :-----------: | :-----------: | :---------------: | :--------------: | :--------------------: | :------------------: | :--------------------: |
| Single schema file                              |      yes      |      yes      |   yes (config)    |        no        |           no           |       partial        |          yes           |
| Runtime validation                              |      yes      |      yes      |        yes        |        no        |           no           |          no          |          yes           |
| Auto-generated types                            |      yes      |      yes      |        yes        |       yes        |   manual `env.d.ts`    |      yes (aug.)      |         manual         |
| Bring-your-own validator (Standard Schema)      |      yes      |      yes      |        no         |        no        |           no           |          no          |          yes           |
| Built-in helpers without installing a validator |      yes      |      no       |        yes        |        —         |           —            |          —           |           no           |
| Build-time guard against leaking server env     |      yes      |      yes      |        yes        |       yes        |      prefix only       |     prefix only      |           no           |
| Custom `envPrefix` honoured                     |      yes      |      yes      |        n/a        |       n/a        |          yes           |         n/a          |          n/a           |
| Schema defaults flow into runtime bindings      |      yes      |    partial    |        yes        |        no        |           no           |       partial        |         manual         |
| Async validators                                |      yes      |      no       |        no         |        no        |           no           |          no          |          yes           |
| `.env.example` scaffolding from schema          |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| Deploy-time check (local + remote secrets)      |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| Cloudflare secret store integration             |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| Zero-config (auto-discovered, no plugin wiring) |      yes      |      no       |        yes        |       yes        |          yes           |         yes          |           no           |
| Schema scaffolded from existing `.env` files    |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |

### Where Void differs

- **One file, one call.** `defineEnv({...})` is the whole API surface. `@t3-oss/env` is the closest analogue but splits into `server`/`client`/`runtimeEnv` blocks and expects you to hand it `process.env`. Void auto-discovers `env.ts`, loads `.env*` via Vite's own resolver (honouring `envDir`), and wires the result into the plugin, the worker bundle, the CLI, and generated types without extra config.
- **Helpers _and_ Standard Schema, mixable.** Most solutions force a choice: either Zod-only (t3-env, many DIY setups), or a bespoke helper DSL with no escape hatch (Astro, SvelteKit). Void ships `string()`, `number()`, `boolean()`, `url()`, `email()`, `oneOf()`, `json<T>()` so a small project pulls in zero validator dependencies, and any [Standard Schema](https://standardschema.dev) library (valibot, zod, arktype) drops into the same object for richer rules.
- **Build-time leak prevention with source locations.** The `void:env-client-guard` plugin walks client module graphs and fails the build with a file:line:col pointer when a non-prefixed key is imported from the browser bundle. Frameworks like Next.js and Vite only enforce this through the _prefix convention_ — a renamed variable silently leaks. Void enforces both the prefix rule and the schema's server/client split.
- **Defaults propagate everywhere.** `PORT: number().default(3000)` fills the typed proxy, the worker `vars` block in dev, the deploy manifest, and the prerender bindings — so `process.env.PORT`, `c.env.PORT`, and `env.PORT` all return `3000` when unset. t3-env and Nuxt only surface defaults in the typed object; the raw `process.env` still reads `undefined`.
- **Deploy is the enforcement point.** `void deploy` unions `.env*` with the remote secret list and hard-fails on any missing required key _before_ upload. No competing solution in the table treats deploy as a validation gate — the closest substitute is a handwritten CI script calling `zod.parse(process.env)`, which doesn't know about the target platform's remote secrets.
- **`.env.example` is generated, not maintained by hand.** `void env example` writes a marker-delimited block grouped into `required`, `with defaults`, `optional`, with enum hints for `oneOf` keys. Everything outside the markers (team CI tokens, comments) survives refresh. No other tool in the comparison ships this.
- **Async validators.** A validator can return a `Promise` — useful for probing a URL, fetching a JWKS, or resolving a secret reference at startup. t3-env and schema-based systems assume synchronous parsing.
- **Onboarding from an existing `.env`.** `void init` detects pre-existing dotenv files and writes a seeded `env.ts` with conservative type inference (boolean/URL/number/string) and a banner comment prompting you to tighten the guesses. Every other solution in the table requires you to hand-write the schema from scratch even when your team already has a `.env.example` committed.

### When to pick something else

- You're on **pure Next.js/Nuxt/SvelteKit** without a Void worker — use the framework-native option plus `@t3-oss/env` if you want validation. Void's value compounds when the same schema drives dev, typegen, client-guard, worker bindings, and deploy.
- You explicitly want **build-time constant folding** (e.g. `import.meta.env.MODE` tree-shaking `if (MODE === 'production')` branches). Void's `env` is a runtime proxy — it gives you types and validation, not static replacement. Use Vite's `define` for the narrow cases where folding matters, and keep `defineEnv` for everything else. Void warns when a `define` key collides with a schema key.
