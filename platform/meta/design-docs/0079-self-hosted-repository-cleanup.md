---
title: Self-hosted Platform Repository Cleanup
status: implemented
created: 2026-09-15
---

# Self-hosted Platform Repository Cleanup

The framework and platform now share this repository. Make the checked-in
documentation, contributor setup, and developer tooling useful to people who
fork the repository and operate their own Void platform.

## Scope

Remove obsolete private-repository plans, personal access arrangements, and
environment-specific inventories. Preserve useful design rationale as clearly
labelled historical records. Document the current architecture and the supported
source-build and self-hosted workflows using explanation, example, and behavior.

Keep the distinction between the self-hosted core and the optional services used
by Void Cloud explicit. Workspace `private: true` flags prevent npm publication;
they do not describe source availability. Intentional hosted endpoints, wire
identifiers, compatibility aliases, and resource ownership checks remain valid.
This sweep does not rewrite Git history, alter hosted account settings, or deploy.

## Reviewable Changes

- [x] Remove the unused private package registry configuration.
- [x] Make uncredentialed CI runnable in forks and isolate first-party deployment assumptions.
- [x] Replace obsolete repository-split and roadmap material with current architecture and an archive index.
- [x] Remove private operational details and update reusable developer scripts.
- [x] Rewrite platform/package guidance and add a source-development guide for forks.
- [x] Sweep remaining documentation, examples, agent guidance, and comments for obsolete private-platform assumptions.
- [x] Verify links, builds, typechecking, relevant tests, and the final full suite.

Changes were committed separately by concern: registry setup, signup behavior,
onboarding, developer tooling, CI, documentation, and historical records.

## Verification

- `vp run build:all` passed across packages, platform apps, and playgrounds.
- `vp run build:core` passed after final source formatting.
- `vp run build:docs` passed; the new development guide's section anchors were checked in the generated HTML.
- `vp run check` passed across all 29 workspaces.
- `vp lint`, `vp run lint:platform`, and `vp fmt --check` passed.
- Final `vp test run`: 417 test files passed, 7,961 tests passed, and 6 skipped, in 71.86 seconds.
- Focused regressions cover independent signup allowlists, installation-specific email identity, explicit smoke destinations, operator health forwarding, and Access tokens tied to their selected API origin.
- Fork CI runner and compatibility-baseline cases were checked locally and the workflow YAML parsed successfully.
- Final source review found no remaining P1/P2 issues within this cleanup's scope.

The production, staging, smoke-deployment, and npm release workflow files were
handled by a concurrent workflow task. Its changes were preserved; this sweep's
CI edits are limited to uncredentialed checks and the configurable schema
compatibility baseline. No hosted account settings or deployed resources were
changed by this cleanup.

The remaining private-repository terminology describes users' GitHub repositories
and the authorization needed to access them. Workspace publishing flags,
service-to-service routes, and intentional hosted compatibility identifiers
remain part of the implementation.
