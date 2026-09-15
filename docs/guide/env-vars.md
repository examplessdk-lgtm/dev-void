---
outline: deep
---

# Environment Variables

Declare your environment variables in `env.ts`. Void uses that schema to give you types, validate values, and check for missing keys before deployment:

1. **Runtime validation** — declared keys are validated on first access; missing/invalid values produce a clear error
2. **TypeScript** — `env.X` and `c.env.X` become typed automatically (no manual interface to maintain)
3. **Deploy safety** — `void deploy` refuses to upload if a required key is missing from `.env*` files or remote secrets

## `env.ts` (recommended)

Place an `env.ts` at your project root and call `defineEnv` once:

::: tip Scaffolded on `void init`
If your project has `.env` or `.env.example`, `void init` creates an `env.ts` from those keys. It recognizes booleans, URLs, and small integers; other values start as strings. Review the generated types and add any validation your app needs.
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

Keys matching Vite's `envPrefix` (normally `VITE_`) are available in client code. Other keys are server-only. If a client module references a server-only key, the build stops and points to the source location. The runtime also rejects that access.

If your project sets a custom `envPrefix` (e.g. `'PUBLIC_'` or an array like `['PUBLIC_', 'NEXT_PUBLIC_']`) in `vite.config.ts`, the build guard honours it automatically. Schema keys that match any configured prefix pass the client check.

### Build-time constant folding

During a production build, Void replaces static reads of public environment variables with their values. This lets the bundler remove branches that can't run, as it does with Vite's `import.meta.env`.

```ts
// source
import { env } from 'void/env';
if (env.MODE === 'production') {
  initAnalytics();
}

// production client bundle (after folding + DCE)
initAnalytics();
```

Rules:

- **Client bundles only.** Server / SSR / worker code keeps the full runtime proxy so secrets, runtime-injected vars, and HMR keep working.
- **Prefix-gated.** Only keys matching Vite's `envPrefix` (default `VITE_`, honours custom string or array config) are ever folded — server-only keys never appear as literals in client output.
- **Static access only.** `env.FOO` and `env["FOO"]` get folded. Dynamic access (`env[key]`), destructuring, and reassignment fall back to the runtime proxy.
- **Values come from** the same source Vite already uses for `import.meta.env`: `.env*` files (respecting `envDir`) plus schema `.default(x)` values for missing keys. Unknown keys are left untouched and the proxy serves them at runtime.
- **Build-only.** Dev keeps going through the proxy so editing `.env.local` takes effect without a full rebuild.
  This optimization runs automatically.

### Vite `define` interop

Vite's `define` replaces expressions at build time without going through `env.ts` validation. If you use both for the same name, compiled client code can see a different value from server code. Void warns when it finds this overlap.

### `envDir`

The Vite plugin respects `envDir` when loading dotenv files for development. The deploy CLI reads production dotenv files from the project root, so keep them there even if local development uses another directory.

### Imports inside `env.ts`

`env.ts` is loaded outside Vite's plugin pipeline — the dev plugin and the deploy CLI both read it through Node's native `import()`. That means only **relative imports** (`./shared/env-keys`) and **bare package names** (`zod`, `valibot`) resolve. Known limitations:

- **tsconfig path aliases are not resolved.** Writing `import { X } from "@/shared/env-keys"` or `import { Y } from "~/foo"` inside `env.ts` fails to load; Void detects this and re-throws with a hint pointing at the offending specifier. Use a relative import instead.
- **Custom Vite plugins don't run.** Anything that needs Vite's transform pipeline (SVG-as-component, GraphQL loaders, virtual modules, etc.) won't apply to `env.ts`. Keep this file to pure TS + schema declarations.

In practice `env.ts` should only import schema helpers from `void/env` and — at most — a shared constants file via a relative path.

## `.env` files

Void follows Vite's dotenv file naming. Deployment treats portable configuration and local secrets differently:

| File                    | Loaded in dev | Shipped by `void deploy` | Shipped by `--platform cloudflare` |
| ----------------------- | ------------- | ------------------------ | ---------------------------------- |
| `.env`                  | yes           | yes (`plain_text`)       | yes (worker `vars`)                |
| `.env.local`            | yes           | no                       | no                                 |
| `.env.production`       | yes           | yes (`plain_text`)       | yes (worker `vars`)                |
| `.env.production.local` | yes           | no                       | `.secret()` keys only (encrypted)  |

`.local` files are gitignored by convention — use them for secrets you don't want in source control.

For direct Cloudflare deploys, mark sensitive keys with `.secret()`. Void reads their production values, uploads them as encrypted secrets, and removes them from plaintext Worker vars. Shell values take precedence.

Unmarked values in `.env` and `.env.production` remain plaintext. Unmarked local and shell values aren't deployed. See [Cloudflare deployment](/integrations/cloudflare#databases-and-secrets).

### Dotenv variable expansion

Values can reference other keys defined in the same (or earlier-precedence) `.env` file using `${VAR}` or `$VAR`:

```ini
# .env
BASE_URL=https://api.example.com
API_URL=${BASE_URL}/v1        # → "https://api.example.com/v1"
BUILD=$BASE_URL/build.json    # bare form also works
LITERAL=\$NOT_EXPANDED        # → "$NOT_EXPANDED" (backslash-escape)
```

Nested references resolve transitively (`A=${B}`, `B=${C}`, `C=value` → `A=value`). Cycles are detected and leave the raw literal (Void emits a warning rather than looping). Missing references expand to the empty string.

Void resolves references against values in your dotenv files, not arbitrary shell variables. The typed `env` API, CLI validation, deploy, and setup use the same expansion rules. This keeps machine-specific shell values from appearing unexpectedly in generated configuration.

## Production secrets

To store production credentials such as Stripe keys or OAuth secrets, upload them with the CLI:

```bash
void secret put STRIPE_KEY            # prompts for value
void secret put STRIPE_KEY < key.txt  # from stdin
void secret sync .env.production      # bulk upload from a dotenv file
void secret list
void secret delete STRIPE_KEY
```

These commands follow the platform saved in `.void/project.json`: they use the hosted secret store for Void projects and Cloudflare's encrypted Worker secret APIs for direct Cloudflare projects. Secret values are never printed, and direct Cloudflare commands use the account and Worker name pinned in root `wrangler.jsonc`.

Remote secrets count as "present" for deploy validation — `void deploy` checks both `.env*` and the remote secret list before uploading.

On direct Cloudflare deploys, a built-in schema helper's `.secret()` modifier also enables automatic upload. Values can come from `.env`, `.env.production`, `.env.production.local`, or the deploy process environment. Void removes them from Worker vars and records them as required secrets.

Existing remote-only secrets are preserved, optional missing values stay absent, and deployment doesn't delete remote secrets. Warnings based on a key's name or value don't make it a secret; mark it explicitly.

For auth-enabled apps, both Void Cloud and `void deploy --platform cloudflare` manage `BETTER_AUTH_SECRET` automatically: they preserve an existing encrypted secret and generate one only when missing.

## Defaults

Schema defaults from `defineEnv({ PORT: number().default(3000) })` flow into:

- The typed `env` proxy: `env.PORT` returns `3000` when no value is set.
- Worker bindings (`c.env.PORT`, `process.env.PORT` on Node target): the
  default value is injected as a stringified `var` in dev, in `void deploy`
  manifests, and in prerender bindings, so any code path that reads the raw
  env sees the same fallback.
- Client-exposed keys (`VITE_*` by default, or your configured `envPrefix`):
  defaults are added to Vite's client env, so browser code reading
  `env.VITE_APP_TITLE` sees the same fallback.

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

## Secret redaction

Env validation errors, dev-server warnings, and CLI reports automatically replace secret-looking values with `<redacted>` before they surface. This keeps tokens out of Discord screenshots, GitHub issues, and CI logs when you paste an `EnvValidationError` stack.

Void decides which values to redact in this order:

1. **Explicit override.** The built-in helpers support `.secret()` and `.public()` modifiers, and they win over every heuristic:

   ```ts
   export default defineEnv({
     STRIPE_KEY: string().secret(), // always redacted
     PUBLIC_KEY: string().public(), // never redacted (opts out of the KEY heuristic)
     PORT: number(),
   });
   ```

   Third-party Standard Schema validators (valibot, zod, arktype) can't carry this flag — they fall back to the heuristics below.

2. **Key-name heuristic.** Values for keys matching `/KEY|TOKEN|SECRET|PASSWORD|PASS(WD)?|CREDENTIAL|PRIVATE|AUTH|BEARER|APIKEY|DSN/i` are redacted by default.

3. **Value-content heuristic.** Even on neutral keys, values that start with `sk_` / `pk_` / `ghp_` / `xoxb-` / `AKIA` or look like a ≥24-char high-entropy string are redacted. This catches wrong-file typos like `PORT=sk_live_abc123`, where the key is innocent but the value is a Stripe key.

The **key name itself is never masked** — you need it to locate the offending entry.

For local debugging, set `VOID_ENV_UNMASK=1` to show raw values in error output. Void prints a notice when this is enabled. Unset it before sharing logs.

## Using `env.ts` with a meta-framework

All supported frameworks get environment types, validation, checks for server secrets reaching client code, and CLI commands. Public variables are also inlined in production client builds.

| Framework         | `env.ts` typegen | Client leak guard | Constant folding |   `env` on server   |     `env` on client     | `void env check` + deploy gate |
| ----------------- | :--------------: | :---------------: | :--------------: | :-----------------: | :---------------------: | :----------------------------: |
| Void (Pages mode) |       yes        |        yes        |       yes        |         yes         |     yes (`VITE_*`)      |              yes               |
| TanStack Start    |       yes        |        yes        |       yes        |         yes         |     yes (`VITE_*`)      |              yes               |
| React Router v7   |       yes        |        yes        |       yes        | yes (in `loader()`) |     yes (`VITE_*`)      |              yes               |
| SvelteKit         |       yes        |        yes        |       yes        | yes (runtime proxy) |     yes (`VITE_*`)      |              yes               |
| Nuxt              |       yes        |        yes        |       yes        |         yes         |     yes (`VITE_*`)      |              yes               |
| Analog            |       yes        |        yes        |       yes        |         yes         |     yes (`VITE_*`)      |              yes               |
| Astro             |       yes        |        yes        |       yes        |         yes         | yes (`envPrefix`-gated) |              yes               |

What you always get, regardless of framework:

- `void env check [--remote]` validates `.env*` files + remote secret names against the schema.
- `void deploy` hard-fails before upload when any required key is missing.
- `void env example` generates the marker-delimited `.env.example` block.
- `void init` scaffolds `env.ts` from existing dotenv files.
- Typed `.void/env.d.ts` so `env.X` autocompletes in editors.
- `void:env-client-guard` fails the build with a file:line:col error when a server-only key is referenced from a client module.
- Build-time constant folding for `envPrefix`-matched reads in the client bundle.

In Nuxt, Analog, and Astro, `import { env } from "void/env"` reads Worker bindings at request time. You can also keep using your framework's native environment API where it suits your app.

## Migration from untyped `c.env`

If you don't have an `env.ts`, `c.env.X` continues to work as `unknown` — no breaking change. To opt in, create `env.ts`, declare your keys, and the existing call sites become typed automatically. The recommended access pattern for new code is `import { env } from "void/env"`.

## How it compares

`void/env` is part of Void rather than a standalone environment library. It connects your schema to local development, the build, and deployment. The table below compares that integration with other approaches.

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
| Automatic secret redaction in validation errors |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| Cloudflare secret store integration             |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| Zero-config (auto-discovered, no plugin wiring) |      yes      |      no       |        yes        |       yes        |          yes           |         yes          |           no           |
| Schema scaffolded from existing `.env` files    |      yes      |      no       |        no         |        no        |           no           |          no          |           no           |
| `${VAR}` expansion, no `process.env` leakage    |      yes      |      no       |        no         |        no        |    partial (leaks)     |          no          |      needs plugin      |

### What the integration provides

- **A shared schema.** `env.ts` supplies the types and validation used by the plugin, Worker, CLI, and generated declarations.
- **Built-in helpers and custom validators.** Start with `string()`, `number()`, or the other helpers. Use a Standard Schema validator when a field needs more detailed rules.
- **Checks before deployment.** Void checks required keys against dotenv values and remote secret names before uploading.
- **Client and server separation.** Client references to server-only keys stop the build with a source location. Public values can be inlined without embedding server secrets.
- **Consistent defaults.** Defaults fill missing values in the typed API, Worker vars, deploy manifest, and prerender bindings.
- **Generated examples.** `void env example` updates a marked section of `.env.example` while preserving your team's comments and other keys.
- **Async validation.** Validators can return promises, for example to resolve a secret reference at startup.
- **Setup from existing files.** `void init` can create an initial schema from your dotenv files for you to review.
