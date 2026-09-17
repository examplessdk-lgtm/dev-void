# Design archive

These records preserve the reasoning behind Void's framework and platform.
They include technical proposals, implementation plans, incident analyses and
decisions that were later revised. Keep commercial strategy, pricing research,
competitor analysis and private operational inventories out of this archive.

A document's date and status describe the decision when it was recorded.
These records are not a current roadmap or an operator runbook. Retain the
reasoning and constraints that still explain code; completed task checklists,
copied implementations and review transcripts belong in Git history.

For current behavior, start with:

- [Self-host a Void platform](../../../docs/guide/self-hosted-platform.md)
- [Platform Administration](../../../docs/guide/platform-administration.md)
- [Platform architecture](../architecture.md)
- [Platform development](../../README.md)

Source paths in these records use the unified repository layout: public packages
are under `packages/`, and platform implementations are under
`platform/packages/`. Some proposed files, APIs and line numbers no longer
exist. Example hostnames use `example.com` and `example.net`; each installation
configures its own domains and resources. No archived command should be treated
as an instruction to modify a live installation.

## Useful starting points

| Topic                 | Records                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original architecture | [Original design](./0001-design.md)                                                                                                                                                                  |
| Platform data         | [PostgreSQL migration](./0015-platform-d1-to-planetscale.md), [secret storage](./0058-project-secret-storage-transition.md)                                                                          |
| Builds and GitHub     | [Build design](./0010-builds.md), [implementation decisions](./0011-builds-implementation-plan.md), [identity linking](./0074-github-deploy-identity-linking.md), [build logs](./0076-build-logs.md) |
| Serving and routing   | [Asset fallback](./0066-wfp-asset-r2-fallback.md), [direct R2 uploads](./0068-direct-r2-asset-upload.md), [route-aware ISR](./0077-route-aware-isr-ttl.md)                                           |
| Custom domains        | [Record presentation](./0072-custom-domain-verification-ux-improvements.md), [HTTP certificate validation](./0073-custom-domain-http-dcv-migration.md)                                               |
| Administration        | [Operator CLI](./0078-platform-operator-cli.md)                                                                                                                                                      |
| Email                 | [Transport, consent and setup decisions](./0078-email-cf-native.md)                                                                                                                                  |
| Legacy Sandboxes      | [Container ownership and teardown](./0067-cross-script-do-host-architecture.md)                                                                                                                      |

## Reading revisions

Later decisions can supersede only part of an earlier design. For example,
[0065](./0065-cloudflare-asset-dedupe-poisoning.md) records an asset upload issue
and rejected workarounds; [0066](./0066-wfp-asset-r2-fallback.md) adds the serving
fallback. Similarly, the HTTP certificate validation design supersedes the
earlier TXT validation choice without removing hostname ownership checks.

Preserve these distinctions when changing code. Keep useful design records at
their existing paths so source comments and links continue to resolve. Record
new decisions separately, and update maintained guides when behavior changes.
