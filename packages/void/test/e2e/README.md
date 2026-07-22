# `packages/void/test/e2e`

Gated live-account end-to-end tests. These run REAL Cloudflare operations against a REAL account,
so they are **skipped by default** and never run in CI.

## `cloudflare-deploy-live.test.ts`

Runs a real `void deploy --backend cloudflare --provision` of `playground/spa`, verifies the live
worker answers HTTP 200, then deletes the worker and every provisioned resource.

The suite is skipped unless BOTH env vars are set:

| Env var                  | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `VOID_E2E_CF_TOKEN`      | Cloudflare API token that can create + delete Workers Scripts, D1, and KV. |
| `VOID_E2E_CF_ACCOUNT_ID` | Cloudflare account id to deploy into.                                      |

With no env vars the suite SKIPS cleanly (0 run, N skipped) — this is the CI behavior.

Run it manually with your own throwaway credentials:

```sh
# Ensure the CLI is built first (dist/cli/cli.mjs):
vp run build:core

VOID_E2E_CF_TOKEN=... VOID_E2E_CF_ACCOUNT_ID=... vp test run packages/void/test/e2e
```

The worker name is fixed (`void-e2e-cf-deploy`), so a crashed run leaves deterministically named
resources (`void-e2e-cf-deploy`, `void-e2e-cf-deploy-db`, `void-e2e-cf-deploy-kv`) that a rerun — or
`wrangler delete` — can clean up. Teardown runs even when the deploy or an assertion fails.
