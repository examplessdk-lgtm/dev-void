# @voidcloud/tail

Tail consumer for deployed user workers.

## Behavior

- Receives Cloudflare tail events from the dispatch namespace.
- Parses worker script names into:
  - `projectKey`: `user-{slug}`
  - `deployId`: `dpl_*` when present
- Writes one Analytics Engine row per trace event.

Versioned deploys use script names like `user-my-app-dpl_abc123`. Legacy unversioned names like `user-my-app` are still accepted for older deployments.

## Analytics Engine Schema

| Slot         | Content                   |
| ------------ | ------------------------- |
| `indexes[0]` | `projectKey`              |
| `blobs[0]`   | outcome                   |
| `blobs[1]`   | serialized logs           |
| `blobs[2]`   | serialized exceptions     |
| `blobs[3]`   | request URL               |
| `blobs[4]`   | request method            |
| `blobs[5]`   | response status as string |
| `blobs[6]`   | deploy ID or `""`         |
| `doubles[0]` | event timestamp           |
| `doubles[1]` | response status as number |

## Source Layout

```text
src/index.ts              # tail() handler + parseScriptName()
test/parse-script-name.test.ts
```

## Configuration

- Wired into `packages/dispatch/wrangler.jsonc` via `tail_consumers`
- Writes to the `void_logs` / `void_logs_staging` Analytics Engine datasets
- No public HTTP surface

## Deploy

```bash
vp run --filter @voidcloud/tail deploy --env production
vp run --filter @voidcloud/tail deploy --env staging
```

Deploy this before `dispatch`, since dispatch references it as a tail consumer.
