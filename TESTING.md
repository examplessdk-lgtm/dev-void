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

## Browser readiness and Windows CI

Use `waitForIslandsHydrated` from `test/browser-helpers.ts` before asserting island state or
interacting with islands. Pass the expected minimum count when checking a multi-island fixture.
Each island imports and hydrates independently, so a selector matching one hydrated island does
not establish that its siblings are ready. The helper rejects empty or partially hydrated pages;
`packages/void/test/integration/browser-helpers.test.ts` covers these cases.

For SPA navigation, wait for a client readiness signal before setting the document marker and
clicking. The Nuxt and SvelteKit playgrounds expose `h1[data-hydrated="true"]` after client startup.
`networkidle` and server-rendered HTML do not establish router readiness. Keep the document-marker
assertion so a full reload still fails the test. These suites attach recent browser console,
navigation, failed-request, HMR, and dev-server output to failures.

Give real subprocess tests a measured, suite-local timeout. The Drizzle drift suite can launch
three processes per case and uses 30 seconds on Windows and 10 seconds elsewhere. Ordinary unit
tests retain their default timeout. `waitForServer` already scales its timeout on Windows;
callers should pass an unscaled value and leave enough hook time for that wait and setup.

Windows integration tests also use `maxConcurrency: 2`. `maxWorkers` caps files, not concurrent
tests inside each file: two CI workers with Vitest's default concurrency of five can open ten
isolated browser contexts at once. The Windows cap reduces that to four without serializing
files or changing Linux/macOS concurrency. Do not retry browser navigation to hide
`ERR_NO_BUFFER_SPACE`; it reports a Windows socket resource failure, not a readiness timeout.

The Windows setup hook prints one resource snapshot per integration file at the first failed
test, before suite teardown. It records memory, the largest processes, dynamic TCP port ranges,
and connection counts by state/PID. Collection is read-only, limited to ten seconds and 64 KiB,
and retains partial output if it fails. Concurrent failures share the snapshot. It does not log
environment variables, process command lines, or remote addresses, and does not replace the
original test failure. Use this evidence to distinguish port, queue, and memory pressure rather
than assuming every socket error is port exhaustion.

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

Authenticate and inspect the accounts available to Void:

```sh
void cloudflare login
void cloudflare status
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
