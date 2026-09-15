---
title: Platform Operator CLI
status: implemented
created: 2026-09-15
---

# Platform Operator CLI

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

Extend `void platform` with all supported administrative operations currently
available through the admin dashboard. Use shared server operations for browser
and terminal clients. Keep installation lifecycle management ownership-aware.

## Interface

The JSON API lives at `/operator/v1`. It requires a dedicated bearer token with
audience `operator`, independently of browser admin cookies and application
deployment tokens. `POST /operator/v1/session` explicitly exchanges a full API
session belonging to an active administrator for a one-hour operator token.
Every request checks the current administrator role and suspension state.
Operator credentials live in separate origin-scoped keychain entries;
`VOID_OPERATOR_TOKEN` supplies headless credentials. No implicit credential
fallback to deployment tokens is permitted for administrative operations.

Operator commands select an explicit `--connection <id-or-url>`, an explicit
`VOID_API_URL`, or the active connection. Repository metadata cannot select the
recipient of operator credentials. Existing lifecycle commands remain intact.

Groups: `auth login|logout|status|token`, `user list|show|plan|suspend|restore|delete`,
`project list|show|delete`, `deployment list|show|cancel|logs`, `build show|logs`,
`signup show|open|restrict|allow|remove`, `invitation list|send|revoke`,
`system overview|health|cli-versions|events|backfill-queue-tokens`, and hosted-only
`worker list|show|rollback|rollback-all|events`.

Reads use GET. Mutations use POST with JSON bodies and accept `dryRun: true` for
validation and a concrete preview with no writes. Lists accept bounded `page`
and `limit` values plus supported filters; responses describe pagination.
Errors return `{ error, message }` with meaningful HTTP statuses. Mutations do
not retry automatically; partial outcomes are explicit. Preview responses use
`{ dryRun: true, action, target, ...details }`.

CLI mutations first request a preview, display the selected origin and affected
objects, and require confirmation unless `--yes` was explicitly supplied.
`--plan` exits after preview. Noninteractive invocations without `--yes` or
`--plan` fail before mutation. `--json` writes structured results to stdout;
diagnostics go to stderr. IDs/path segments and query values are encoded.

## Implementation record

- [x] Authentication, JSON errors/validation, mutation audit, API registration.
- [x] Shared user/project/access operations and tenant API with regression tests.
- [x] Shared deployment/build/system/hosted-worker operations and regression tests.
- [x] CLI parsing, transport, origin-scoped auth, output, previews and log following.
- [x] Help, interactive hints, public documentation, package READMEs and agent guidance.
- [x] Package builds, typechecking, final full test suite and CLI smoke verification.
- [x] Four GPT-6 Astra high reviews, GPT-5.6 Sol high fixes committed individually,
      and repeated review until no P1 findings remain.

## Verification

Run relevant `vp test run` selections during each feature batch and `vp run check`
after batches. Investigate hanging or unusually slow tests immediately. At final
verification run the full test suite, build the distributable CLI/runtime, and
exercise the real CLI against a local API test fixture. Cover credential audience
separation, role revocation, origin selection, JSON failures, malformed arguments,
dry runs without writes, mutation partial failures, log cursors and hosted-only
guards before external calls. Preserve admin browser behavior and native
Cloudflare Free compatibility. Update `README.md`, affected package READMEs,
`docs/reference/cli.md`, the self-hosted guide, `packages/void/skills/void`,
`packages/void/AGENT_PROMPT.md`, and `packages/void/getting-started-prompt.txt`.

## Final verification

Implementation and fixes are committed on `main` with the individual commit history preserved.
The terminal surface adds 37 operator commands alongside the existing platform
lifecycle commands. All reported review findings were addressed in separate
commits, with regression coverage.

- `vp run build:core` passed for the distributable CLI and packaged platform runtime.
- `vp run build:docs` passed.
- `vp run check` passed across all 29 workspaces.
- `vp lint`, `vp run lint:platform`, and `vp fmt --check` passed.
- Final `vp test run`: 413 test files passed, 7,923 tests passed, 6 skipped,
  in 59.33 seconds. This includes subprocess CLI tests against the actual
  operator API backed by the integration database and routing fixtures.
- Two rounds of four GPT-6 Astra/high reviews reported no P1 findings. GPT-5.6
  Sol/high agents fixed the reported P2 issues individually. A final focused
  Astra/high review of the last four commits found no P1 or actionable P2
  regressions.
