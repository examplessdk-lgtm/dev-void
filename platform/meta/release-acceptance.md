# Release acceptance

Local verification and credentialed provider acceptance establish different
boundaries. Record which was performed for the candidate release; a passing
mock or local runtime test is not live deployment evidence.

## Local acceptance

Follow [Testing Void](../../TESTING.md) for builds, typechecking, lint and the
complete SDK/platform suite. Exercise the full packed-consumer matrix against
the actual public-package tarballs:

```sh
vp run build
VOID_PACKED_SUITE=full node .github/scripts/packed-consumer.mjs
```

The matrix tests npm and pnpm, public Vite, real initialization and frozen
reinstalls, all four Pages adapters, Markdown, development, preview, KV,
assets, hydration and navigation. Use the documented selectors for focused
reruns, not as a substitute for release coverage.

Use disposable PostgreSQL for concurrency and schema-compatibility checks.
Upgrade a populated database from the immutable previous runtime and verify
preserved users, projects and encrypted secrets before testing the old runtime
against the upgraded schema. An empty fresh database does not prove upgrade
or rollback compatibility. Respect the runtime safety floor after arming
deployment-admission or legacy Sandbox-drain protocols.

## Live signoff

Select a disposable account, domain, database and protected credentials for
these checks. Review the resource plan before provisioning; keep unrelated
account resources outside the test.

1. Run the gated [native Cloudflare suite](../../packages/void/test/e2e/README.md)
   on Workers Free. Include a Pages app and inspect data, logs, routing rules,
   failed-candidate secret rotation, rollback and an existing-Worker handoff.
2. Run the packaged `void platform install --plan`, review its account and
   resource names, then install into an eligible disposable platform account.
   Complete actual GitHub OAuth login and have a second developer connect and
   deploy an app.
3. Exercise the documented minimal runtime token, R2 uploads, D1/KV,
   queue/cron, AI and ISR. A health response alone is insufficient.
4. Interrupt and resume installation or upgrade. Recover local installation
   records on another machine, recreate a missing API Worker from the complete
   saved keyring, and verify existing project secrets still decrypt.
5. Verify compatible runtime rollback and roll-forward. For a legacy Sandbox
   installation, verify maintenance login, bounded draining, provider-side
   container termination and rejection of unsafe runtimes before restoring
   traffic.
6. Verify disable/enable and both uninstall retention modes. Check retained
   resources and confirm unrelated account resources remain intact.

Record the candidate commit, artifact digest, nonsecret resource identifiers,
results and times outside this reusable checklist. Keep credentials in the
secret manager. This document records a procedure, not a completed signoff.
