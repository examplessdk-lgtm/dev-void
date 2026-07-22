# `packages/void/test/e2e`

Gated live-account end-to-end tests. These run REAL Cloudflare operations against a REAL account,
so they are **skipped by default** and never run in CI.

## `cloudflare-deploy-live.test.ts`

Deploys `playground/spa` (D1 + KV + cron) to the target account via `void deploy --backend cloudflare`,
verifies the live worker answers HTTP 200, then deletes the worker and every resource it created.

It does **not** drive `--provision`: that path fails closed in non-interactive shells by design (a
spawned CLI has no TTY, and CI cannot commit back the ids a create would mint). So the test plays the
provisioner's role itself — it creates the id-bearing D1 + KV directly with `wrangler … create`,
writes their real ids into the app's root config exactly as `--provision` would, then runs the
CI-safe `void deploy --backend cloudflare` (no `--provision`). That exercises the real
build → tamper-guard → remote-migrations → `wrangler deploy` pipeline end to end.

### Prerequisites

The suite is skipped unless BOTH env vars are set:

| Env var                  | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `VOID_E2E_CF_TOKEN`      | Cloudflare API token that can create + delete Workers Scripts, D1, and KV. |
| `VOID_E2E_CF_ACCOUNT_ID` | Cloudflare account id to deploy into.                                      |

The token needs, on that account, **Workers Scripts: Edit**, **D1: Edit**, and **Workers KV Storage:
Edit** (Edit implies read, covering the ownership/teardown list calls). Cron triggers ride along with
the worker deploy — no extra permission.

The account must also have a **workers.dev subdomain** already registered (with its wildcard TLS cert
provisioned). Without one, `wrangler deploy` uploads the worker but cannot publish a public URL, and
the HTTP-200 assertion has nothing to hit. Opening the Workers & Pages dashboard once registers a
subdomain automatically; a freshly-registered subdomain takes a few minutes for its cert to go live,
during which the first run may see a TLS handshake failure — rerun once the cert is ready.

With no env vars the suite SKIPS cleanly (0 run, N skipped) — this is the CI behavior.

### Running it

```sh
# Ensure the CLI is built first (dist/cli/cli.mjs):
vp run build:core

VOID_E2E_CF_TOKEN=... VOID_E2E_CF_ACCOUNT_ID=... vp test run packages/void/test/e2e
```

The worker name is fixed (`void-e2e-cf-deploy`), so a crashed run leaves deterministically named
resources (`void-e2e-cf-deploy`, `void-e2e-cf-deploy-db`, `void-e2e-cf-deploy-kv`) that a rerun — or
`wrangler delete` — can clean up. A pre-run ownership gate refuses to start if any of those names
already exist (failing closed on any lookup it cannot confirm), so the test never adopts or deletes a
resource it does not own. Teardown runs even when the deploy or an assertion fails.
