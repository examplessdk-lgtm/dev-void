# `packages/void/test/e2e`

Gated live-account end-to-end tests. These run REAL Cloudflare operations against a REAL account, so
they **skip unless credentials are present**. Locally that means exporting the env vars below; in CI
they run on **pushes to `main`** (see [In CI](#in-ci)).

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

With no env vars the suite SKIPS cleanly (0 run, N skipped).

### Running it

```sh
# Ensure the CLI is built first (dist/cli/cli.mjs):
vp run build:core

VOID_E2E_CF_TOKEN=... VOID_E2E_CF_ACCOUNT_ID=... vp test run packages/void/test/e2e
```

### In CI

`VOID_E2E_CF_TOKEN` and `VOID_E2E_CF_ACCOUNT_ID` are **environment secrets** on the `cloudflare-e2e`
GitHub Environment (not repo secrets), and a dedicated `live-e2e` job in `.github/workflows/ci.yml`
consumes them — the main `test` job carries no creds at all. Two layers keep the account token off
untrusted code:

- The `live-e2e` job runs only on a direct push to `main` (`github.event_name == 'push' && github.ref
== 'refs/heads/main'`), so `pull_request` runs, tag pushes, and `workflow_call` (release) skip it.
- The `cloudflare-e2e` environment's deployment branch policy allows `main` **only**, enforced by
  GitHub server-side on the run's ref. A `pull_request` run's ref is `refs/pull/<n>/merge`, so it can
  never reach the secret **even if a PR edits this workflow** — the expression-level gate alone would
  be bypassable that way; the environment ref-check is the real boundary.

So the credentialed live deploy runs on every merge to `main`; everywhere else the creds are empty and
the suite SKIPS (the `test` job still imports the file and skips it). The `live-e2e` job itself is
fail-closed — a preflight step errors if either credential is empty (a missing, deleted, or
not-yet-rotated secret), so a misconfigured gate is loud instead of a silent green skip. Each
`live-e2e` run also gets `VOID_E2E_RUN_ID = <run-id>-<attempt>` for the unique per-run resource names
below.

### Resource naming & cleanup

Each run derives a UNIQUE resource name — `void-e2e-cf-deploy-<suffix>` — so overlapping runs never
collide on remote resources. The suffix is `VOID_E2E_RUN_ID` (CI: `<run-id>-<attempt>`) or, locally, a
timestamp + random. Derived names mirror the provisioner: `<name>-db` (D1), `<name>-kv` (KV). The
shared `void-e2e-cf-deploy-` prefix keeps every resource greppable, so an orphan from a hard-killed run
is easy to find and `wrangler delete`. A pre-run ownership gate refuses to start if the run's names
already exist (failing closed on any lookup it cannot confirm), so the test never adopts or deletes a
resource it does not own. Teardown runs even when the deploy or an assertion fails.

> **Local concurrency:** unique names isolate _remote_ resources, but a run also snapshots and
> overwrites the shared `playground/spa/wrangler.jsonc` and builds in place. Do **not** run two live
> e2e invocations against the same checkout at once — they would race that file. CI is unaffected (each
> runner is an isolated checkout, and only the single `main`-push `live-e2e` job deploys). The deploy
> test also asserts the returned host's worker label equals this run's `WORKER_NAME`, so a clobbered
> overlay fails loudly instead of validating another run's worker.
