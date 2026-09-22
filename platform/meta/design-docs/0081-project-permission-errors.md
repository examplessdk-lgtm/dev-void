---
title: Actionable project permission errors
status: implemented
created: 2026-09-23
---

# Actionable project permission errors

Project roles are enforced by the API, but several rejected CLI operations show
raw `403 {"error":"forbidden"}` output. Users need the attempted action, the
required access, and a useful next step. Deployment and invitation responses
already provide some guidance; the remaining paths should meet the same standard.

## Contract

- Preserve HTTP statuses and existing machine-readable `error` values. Add a
  separate `message` field to project access denials and expected team errors.
- Derive required access from the checked capability. Do not infer the caller's
  actual role or disclose project/member details in a denied response.
- Cover initial checks and repeated checks under transaction locks. Credential
  scope, inactive builds, suspension, owner-only operations and invitation
  conflicts require different recovery instructions.
- Have CLI and dashboard presentation prefer meaningful messages, with safe
  fallbacks for older APIs. Preserve structured error properties for callers and
  specialized invitation/account guidance. Do not print JSON or HTML as ordinary
  permission-error copy.

## Work and verification

1. Audit API capability checks, direct rejection branches and CLI formatting
   exceptions. Inventory permission-specific UI fallback behavior.
2. Implement additive server messages, consistent CLI formatting and dashboard
   recovery copy without changing permission decisions or widening access.
3. Run focused CLI/dashboard tests and API integration cases covering every
   project capability, owner-only actions, scope rejection and access changes
   during operations. Verify rejected writes do not change project state.
4. Run workspace typechecking, formatting/lint and the final full test suite.
   Investigate failures or slow/hanging tests rather than treating them as green.
5. Update user guidance only where recovery steps or workflows need explanation.

## Progress

- Confirmed raw permission formatting in PlatformApiError and dashboard helpers.
- Found additional formatting bypasses in deployment streams, GitHub commands,
  transaction rechecks, email operations and administrator middleware.
- Added capability-specific API guidance, credential and invitation recovery,
  consistent CLI/dashboard formatting, remote proxy messages, and admin recovery
  links. Existing access decisions, HTTP statuses and JSON error codes remain.
- Regression coverage checks reader mutation denials, owner-only credentials,
  transaction and deployment rechecks, unchanged state after rejected writes,
  old API responses, malformed bodies and command-specific formatting.
- `vp run check` passed. Final `vpr test:all` passed all 563 test files:
  10,840 tests passed and 21 skipped, together with builds, lint and formatting.
  Validation temporarily excluded an obsolete ignored scratch fixture and used a
  fresh kitchen-sink local D1 database; both original fixtures were restored.
- No deployment or package release is part of this change's validation.
