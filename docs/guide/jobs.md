---
outline: deep
---

# Cron Jobs

Void supports cron-triggered jobs from a top-level `crons/` directory.

## Job files

Create files in `crons/**/*.ts` (`.mts`, `.js`, `.mjs` also supported).

Each job file must export:

- `export const cron = "<expression>"` (or an array of expressions)
- a default handler (recommended: wrapped with `defineScheduled`)

Example:

```ts
// crons/hourly-heartbeat.ts
import { defineScheduled } from 'void';

export const cron = '0 * * * *';

export default defineScheduled(async (controller, env) => {
  await env.KV.put('jobs:last-heartbeat', controller.scheduledTime.toString());
});
```

### Multiple schedules

A single job file can export an array of cron expressions:

```ts
// crons/cleanup.ts
import { defineScheduled } from 'void';

export const cron = ['0 * * * *', '30 * * * *'];

export default defineScheduled(async (controller, env) => {
  // Runs at :00 and :30 every hour
});
```

## `defineScheduled`

`defineScheduled(fn)` is a typed identity helper for scheduled jobs.

Handler signature:

```ts
(controller: ScheduledController, env: CloudEnv['Bindings'], ctx: ExecutionContext) =>
  unknown | Promise<unknown>;
```

Notes:

- Jobs are matched by exact cron string.
- Job modules are lazy-loaded at runtime.
- Files or directories starting with `_` are ignored.
- Missing `cron` export causes an error during scan/build.

## Local development

Cron triggers do not fire on their schedule during local dev — this is a Cloudflare Workers / miniflare limitation, not specific to Void. To exercise a job locally, POST to the dev-only endpoint Void exposes:

```
POST /__void/scheduled
Content-Type: application/json
{ "cron": "<expression>", "scheduledTime": <unix_ms> }
```

The `cron` value must match a string you exported from a `crons/*.ts` file — that's how the dispatcher routes to the right handler. Returns `{ "ok": true }` on success.

```bash
curl -X POST http://localhost:5173/__void/scheduled \
  -H "Content-Type: application/json" \
  -d '{"cron":"0 * * * *","scheduledTime":'"$(date +%s000)"'}'
```

### Auth

The endpoint enforces a token via the `x-void-internal` header:

- **Framework mode (Nuxt, React Router, etc.):** the check is skipped if neither `__VOID_PROXY_TOKEN` nor `CRON_SECRET` is set in the environment. In typical local dev, no header is needed.
- **Default Void mode:** the check always runs. Set `__VOID_PROXY_TOKEN` in `.dev.vars` and pass it as the header:

  ```bash
  # .dev.vars
  __VOID_PROXY_TOKEN=dev-trigger
  ```

  ```bash
  curl -X POST http://localhost:5173/__void/scheduled \
    -H "Content-Type: application/json" \
    -H "x-void-internal: dev-trigger" \
    -d '{"cron":"0 * * * *","scheduledTime":'"$(date +%s000)"'}'
  ```

## Deployment behavior

On deploy, Void includes all discovered job schedules in the deploy manifest and configures worker cron triggers automatically.
