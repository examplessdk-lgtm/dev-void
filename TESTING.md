# Testing Void

## Local verification

Run the smallest relevant test target while developing:

```sh
vp test run packages/void
vp run check
```

Run the complete SDK and platform verification before handing off a finished change:

```sh
vpr test:all
```

`vpr test:all` formats, lints, builds, typechecks, and tests the merged monorepo. Investigate slow
or hanging tests when they occur instead of routinely increasing timeouts.

## Native Cloudflare live E2E tests

Live tests are opt-in. They provision or update real resources and can write data, enqueue messages,
invoke AI, and start scheduled work. They must not run as part of the ordinary local or CI test
suite.

### Do not use the local fixtures as configuration

`playground-local/` is ignored scratch space. It may contain an operator's account IDs, resource
IDs, Worker names, generated output, Access tokens, and an ad hoc validator. Those values are not
portable and must never be copied into tracked documentation or treated as the canonical E2E
setup.

Each operator should create their own fixture in `playground-local/` or copy a tracked
`playground/` app there. Keep all account-specific configuration in that ignored copy. Run deploy
commands from the fixture's project root; `--dir` selects a static output directory but does not
change the project root.

### Choose reusable, account-local names

Pick a short namespace unique to the operator or test account, such as a team or username. Reuse
stable names across runs:

```text
void-e2e-<namespace>-static
void-e2e-<namespace>-kitchen
void-e2e-<namespace>-websockets
void-e2e-<namespace>-framework
void-e2e-<namespace>-sandbox
```

Use lowercase letters, numbers, and hyphens. Keep the namespace short because Cloudflare combines
Worker and version-preview alias names under a 63-character hostname limit. Resource names should
derive from the same namespace so the deploy adopts the operator's existing test resources instead
of colliding with another operator.

Do not use a production Worker or production resource name. E2E automation must never delete
Workers, databases, buckets, namespaces, queues, versions, or other remote resources. Live checks
may leave uniquely named test records and objects behind. Any eventual cleanup must be a separate,
explicit, manually reviewed operation against exact resource IDs.

### Select the Cloudflare account

Authenticate and inspect the accounts available to Wrangler:

```sh
wrangler login
wrangler whoami
```

Use the intended test account rather than an account name embedded in a script. Pin it by either:

- letting `void init` write `account_id` to the ignored fixture's `wrangler.jsonc`; or
- setting `CLOUDFLARE_ACCOUNT_ID` in the current shell.

When a version has no preview URL, also set `CLOUDFLARE_WORKERS_SUBDOMAIN` to the account's
workers.dev subdomain. For `https://my-worker.my-team.workers.dev`, the value is `my-team`. The
account name shown in the dashboard is not necessarily the workers.dev subdomain.

Never commit account IDs, resource IDs, API tokens, or Access credentials. CI should receive them
through repository secrets or variables.

### Cloudflare Access

Prefer an unprotected or explicitly bypassed hostname for the baseline deployment suite. In an
Access application, **Allow + Everyone** still requires the requester to authenticate. A genuinely
public E2E hostname uses **Bypass + Everyone** and needs no Access credentials.

For a separate Access-protected readiness test:

- locally, set `CF_ACCESS_TOKEN` to the short-lived JWT returned by
  `cloudflared access token --app=https://<worker>.<account-subdomain>.workers.dev`;
- in CI, use an admitted `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` service-token pair.

Void sends these credentials only to its guarded readiness request. Do not put them in
`wrangler.jsonc`, `.env`, fixture source, command-line arguments, or tracked files.

### Baseline smoke test

From the ignored fixture's root, initialize it for the operator's account and deploy through the
same path a user runs:

```sh
void init
void deploy --platform cloudflare
```

For a static fixture whose output already exists:

```sh
void deploy --dir <output-directory> --platform cloudflare
```

At minimum, verify that the reported URL serves the new build and that a second deploy safely
updates the same Worker. Static coverage should also exercise headers, redirects, rewrites, and
404 handling. A failed readiness check must leave or restore the previous production version.

### Full feature matrix

Run deeper fixtures only after the baseline succeeds:

| Fixture      | Expected coverage                                                      |
| ------------ | ---------------------------------------------------------------------- |
| Kitchen sink | SSR/hydration, D1, KV, R2, queues, cron, ISR, auth, and Workers AI     |
| WebSockets   | Durable Object migrations, typed WebSocket routing, and socket traffic |
| Framework    | At least one detected third-party framework build and deployment       |
| Static       | Assets, headers, redirects, rewrites, ignores, and 404 handling        |
| Sandbox      | Containers and Sandbox runtime; paid-plan test only                    |

The default matrix must remain Workers Free-compatible. Do not run the Sandbox/Containers fixture
unless the selected account is known to have Workers Paid and the operator intentionally opted into
that test. An app that does not use a paid feature must not emit a paid binding or perform an
entitlement probe.

Record the Worker names and URLs in ignored local state or pass them to a validator as environment
variables. A reusable validator must derive hostnames from those inputs; it must not hardcode an
employee's account ID, workers.dev subdomain, dated Worker names, or a token file path.
